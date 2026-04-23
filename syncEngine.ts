/**
 * 同步引擎
 * 负责协调文件扫描、上传、下载、删除和飞书Drive操作
 * 支持增量同步：基于文件内容哈希跳过未修改文件
 * 支持并发上传、删除同步、从飞书下载
 * 支持多文件夹映射同步、.feisyncignore 过滤
 */

import { Vault, TFile, TFolder } from 'obsidian';
import FeiSyncPlugin from './main';
import { FeishuFileMeta } from './feishuApi';
import { FeishuApiClient } from './feishuApi';
import { Notice } from 'obsidian';
import { SyncLogEntry } from './settings';
import { IgnoreFilter, loadIgnoreFilter, FEISYNC_IGNORE_FILE } from './ignoreFilter';
import { SyncFolderConfig, getEnabledConfigs } from './syncFolderConfig';
import { isBinaryFile } from './fileTypeUtils';
import { createLogger } from './logger';

const log = createLogger('SyncEngine');

export interface SyncResult {
  success: boolean;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  deletedCount: number;
  downloadedCount: number;
  errors: string[];
}

/** 单个文件的同步记录 */
export interface FileSyncRecord {
  /** 文件内容哈希（SHA-256 hex） */
  hash: string;
  /** 上次同步成功的时间戳（毫秒） */
  lastSyncTime: number;
  /** 云端文件的 token（用于删除旧文件） */
  cloudToken: string;
  /** 云端文件类型（如 'file', 'docx' 等） */
  cloudType: string;
  /** 云端父文件夹 token */
  parentFolderToken: string;
  /** 所属映射的 ID（多文件夹同步时用于区分） */
  folderConfigId?: string;
}

/**
 * 计算文件内容的 SHA-256 哈希
 */
async function computeHash(content: string | ArrayBuffer): Promise<string> {
  let buffer: ArrayBuffer;
  if (typeof content === 'string') {
    buffer = new TextEncoder().encode(content).buffer;
  } else {
    buffer = content;
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 并发控制器 - 限制同时执行的任务数
 */
class ConcurrencyPool {
  private running = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(private maxConcurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = async () => {
        this.running++;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.running--;
          this.next();
        }
      };

      if (this.running < this.maxConcurrency) {
        task();
      } else {
        this.queue.push(task);
      }
    });
  }

  private next(): void {
    if (this.queue.length > 0 && this.running < this.maxConcurrency) {
      const task = this.queue.shift();
      task?.();
    }
  }
}

/**
 * 同步引擎类
 */
export class SyncEngine {
  private plugin: FeiSyncPlugin;
  private apiClient: FeishuApiClient;
  private vault: Vault;
  private ignoreFilter: IgnoreFilter = new IgnoreFilter();

  constructor(plugin: FeiSyncPlugin, apiClient: FeishuApiClient) {
    this.plugin = plugin;
    this.apiClient = apiClient;
    this.vault = plugin.app.vault;
  }

  /**
   * 添加同步日志
   */
  private addLog(action: SyncLogEntry['action'], filePath: string, message: string): void {
    const entry: SyncLogEntry = {
      timestamp: Date.now(),
      action,
      filePath,
      message,
    };
    this.plugin.settings.syncLog.push(entry);
    // 限制日志条数为最近 500 条
    if (this.plugin.settings.syncLog.length > 500) {
      this.plugin.settings.syncLog = this.plugin.settings.syncLog.slice(-500);
    }
  }

  /**
   * 加载忽略过滤器
   */
  async reloadIgnoreFilter(): Promise<void> {
    this.ignoreFilter = await loadIgnoreFilter(this.vault);
    log.info(`忽略过滤器已加载，${this.ignoreFilter.ruleCount} 条规则`);
  }

  /**
   * 执行一次完整同步（增量 + 删除）
   * 支持多文件夹映射同步
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      deletedCount: 0,
      downloadedCount: 0,
      errors: [],
    };

    // 1. 加载忽略过滤器
    await this.reloadIgnoreFilter();

    // 2. 获取已启用的文件夹映射
    const enabledConfigs = getEnabledConfigs(this.plugin.settings.syncFolders || []);

    // 兼容旧配置：如果没有 syncFolders 但有 localFolderPath，使用旧逻辑
    if (enabledConfigs.length === 0 && this.plugin.settings.localFolderPath) {
      log.info('使用旧版单文件夹同步模式');
      return this.syncLegacy(result);
    }

    if (enabledConfigs.length === 0) {
      result.success = false;
      result.errors.push('未配置同步文件夹映射');
      new Notice('同步失败：未配置同步文件夹映射');
      return result;
    }

    log.info(`开始多文件夹同步，共 ${enabledConfigs.length} 个映射`);

    // 用于标记是否已显示关键错误提示（避免重复显示 Notice）
    let criticalErrorShown = false;

    // 3. 遍历每个映射执行同步
    for (const folderConfig of enabledConfigs) {
      log.info(`--- 同步映射: "${folderConfig.localPath}" → remote="${folderConfig.remoteFolderToken || '(auto)'}" ---`);

      try {
        const folderResult = await this.syncFolder(folderConfig);
        // 合并结果
        result.uploadedCount += folderResult.uploadedCount;
        result.skippedCount += folderResult.skippedCount;
        result.failedCount += folderResult.failedCount;
        result.deletedCount += folderResult.deletedCount;
        result.errors.push(...folderResult.errors);

        // 如果映射同步失败且包含关键错误（如 IP 白名单），立即中止
        if (!folderResult.success && folderResult.errors.some(e => e.includes('IP 白名单') || e.includes('99991401'))) {
          log.warn(`检测到关键错误，中止后续同步`);
          result.success = false;
          criticalErrorShown = true;
          break;
        }
      } catch (error) {
        const errMsg = (error as Error).message || '';
        result.errors.push(`映射 "${folderConfig.localPath}" 同步失败: ${errMsg}`);
        log.error(`映射 "${folderConfig.localPath}" 同步失败:`, error);

        // 关键错误立即中止
        if (errMsg.includes('99991401') || errMsg.includes('denied by app setting') || errMsg.includes('IP 白名单')) {
          result.success = false;
          criticalErrorShown = true;
          break;
        }
      }
    }

    // 4. 汇总结果（只有成功或非关键失败才显示"同步完成"）
    result.success = result.failedCount === 0 && !result.errors.some(e => e.includes('IP 白名单') || e.includes('99991401'));

    // 如果关键错误已在子方法中显示过提示，这里不再重复显示
    if (!result.success && !criticalErrorShown) {
      const msg = `同步中止：${result.errors[result.errors.length - 1] || '发生错误'}`;
      new Notice(msg, 8000);
      this.addLog('error', '', msg);
    } else if (result.success) {
      const parts: string[] = [];
      if (result.uploadedCount > 0) parts.push(`上传 ${result.uploadedCount} 个`);
      if (result.skippedCount > 0) parts.push(`跳过 ${result.skippedCount} 个`);
      if (result.deletedCount > 0) parts.push(`删除 ${result.deletedCount} 个`);
      if (parts.length === 0) parts.push('无变化');
      const msg = `同步完成！${parts.join('，')}`;
      new Notice(msg);
      this.addLog('info', '', msg);
    }

    return result;
  }

  /**
   * 旧版单文件夹同步（云端优先模式，向后兼容）
   */
  private async syncLegacy(result: SyncResult): Promise<SyncResult> {
    const { localFolderPath, feishuRootFolderToken } = this.plugin.settings;

    // 1. 验证配置
    if (!localFolderPath) {
      result.success = false;
      result.errors.push('未配置本地同步文件夹路径');
      new Notice('同步失败：未配置本地同步文件夹路径');
      return result;
    }

    // 2. 获取飞书目标文件夹
    let targetFolderToken = feishuRootFolderToken;
    if (!targetFolderToken) {
      targetFolderToken = await this.ensureDefaultFolder();
    }

    // 3. 扫描本地文件夹（应用过滤）
    const localFiles = this.scanLocalFolder(localFolderPath);
    log.info(`扫描到 ${localFiles.length} 个文件（已应用忽略规则）`);

    // 4. 获取云端文件列表
    let cloudFiles: FeishuFileMeta[] = [];
    try {
      cloudFiles = await this.apiClient.listFolderContents(targetFolderToken);
      log.debug(`云端文件列表获取完成，共 ${cloudFiles.length} 个文件/文件夹`);
    } catch (error) {
      const errMsg = (error as Error).message || '';
      if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
        log.error('飞书应用 IP 白名单限制，无法获取云端文件列表');
        new Notice('同步中止：飞书应用 IP 白名单限制，请在开放平台添加当前 IP', 10000);
        result.errors.push('飞书应用 IP 白名单限制，无法执行同步');
        result.success = false;
        return result;
      }
      log.warn('获取云端文件列表失败，将只上传新文件:', error);
    }

    // 5. 处理删除（检测云端有但本地没有的文件，删除云端）
    if (this.plugin.settings.syncOnDelete && cloudFiles.length > 0) {
      await this.handleCloudDeletedFiles(localFiles, cloudFiles, localFolderPath, result);
    }

    // 6. 并发上传文件
    if (localFiles.length === 0 && result.deletedCount === 0) {
      new Notice('同步完成：没有需要同步的文件');
      this.addLog('info', '', '同步完成：没有需要同步的文件');
      return result;
    }

    new Notice(`开始同步 ${localFiles.length} 个文件...`);
    this.addLog('info', '', `开始同步 ${localFiles.length} 个文件`);

    await this.uploadFiles(localFiles, localFolderPath, targetFolderToken, result, cloudFiles);

    // 7. 汇总结果
    result.success = result.failedCount === 0;

    // 如果有 IP 白名单等关键错误，不显示"同步完成"
    if (!result.success) {
      const msg = `同步中止：${result.errors[result.errors.length - 1] || '发生错误'}`;
      new Notice(msg, 8000);
      this.addLog('error', '', msg);
    } else {
      this.reportResult(result);
    }

    return result;
  }

  /**
   * 同步单个文件夹映射（云端优先模式）
   */
  private async syncFolder(folderConfig: SyncFolderConfig): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      deletedCount: 0,
      downloadedCount: 0,
      errors: [],
    };

    // 1. 获取飞书目标文件夹
    let targetFolderToken: string;
    if (folderConfig.mode === 'custom' && folderConfig.remoteFolderToken) {
      targetFolderToken = folderConfig.remoteFolderToken;
      log.debug(`使用自定义 token: ${targetFolderToken.substring(0, 12)}...`);
    } else {
      // 自动模式：在统一根目录下创建同名文件夹
      targetFolderToken = await this.ensureFolderForMapping(folderConfig);
    }

    // 2. 扫描本地文件夹（应用过滤）
    const localFiles = this.scanLocalFolder(folderConfig.localPath);
    log.info(`映射 "${folderConfig.localPath}": 扫描到 ${localFiles.length} 个文件`);

    // 3. 获取云端文件列表
    let cloudFiles: FeishuFileMeta[] = [];
    try {
      cloudFiles = await this.apiClient.listFolderContents(targetFolderToken);
      log.debug(`云端文件列表获取完成，共 ${cloudFiles.length} 个文件/文件夹`);
    } catch (error) {
      const errMsg = (error as Error).message || '';
      if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
        log.error('飞书应用 IP 白名单限制，无法获取云端文件列表');
        new Notice('同步中止：飞书应用 IP 白名单限制，请在开放平台添加当前 IP', 10000);
        result.errors.push('飞书应用 IP 白名单限制，无法执行同步');
        result.success = false;
        return result;
      }
      log.warn('获取云端文件列表失败，将只上传新文件:', error);
    }

    // 4. 处理删除（检测云端有但本地没有的文件，删除云端）
    if (this.plugin.settings.syncOnDelete && cloudFiles.length > 0) {
      await this.handleCloudDeletedFiles(localFiles, cloudFiles, folderConfig.localPath, result);
    }

    // 5. 并发上传文件
    if (localFiles.length === 0 && result.deletedCount === 0) {
      this.addLog('info', '', `映射 "${folderConfig.localPath}": 没有需要同步的文件`);
      return result;
    }

    log.info(`映射 "${folderConfig.localPath}": 开始上传 ${localFiles.length} 个文件到 ${targetFolderToken.substring(0, 12)}...`);
    new Notice(`同步 "${folderConfig.localPath}": ${localFiles.length} 个文件...`);

    try {
      await this.uploadFiles(localFiles, folderConfig.localPath, targetFolderToken, result, cloudFiles);
      log.info(`映射 "${folderConfig.localPath}": 上传完成，上传=${result.uploadedCount}，跳过=${result.skippedCount}，失败=${result.failedCount}`);
    } catch (error) {
      const errMsg = (error as Error).message || String(error);
      log.error(`映射 "${folderConfig.localPath}": 上传异常: ${errMsg}`);
      result.errors.push(`映射 "${folderConfig.localPath}" 上传异常: ${errMsg}`);
      result.success = false;
    }

    // 6. 如果发生关键错误，不更新同步时间，表示同步未完成
    if (!result.success) {
      return result;
    }

    // 7. 更新映射的上次同步时间
    folderConfig.lastSyncTime = Date.now();
    folderConfig.lastSyncFileCount = localFiles.length;

    return result;
  }

  /**
   * 确保映射对应的飞书文件夹存在
   * 自动模式：在统一根目录下创建同名文件夹
   */
  private async ensureFolderForMapping(folderConfig: SyncFolderConfig): Promise<string> {
    // 获取统一根目录
    let rootToken = this.plugin.settings.feishuRootFolderToken;
    if (!rootToken) {
      rootToken = await this.ensureDefaultFolder();
    }

    // 在根目录下查找或创建同名文件夹
    const folderName = folderConfig.localPath.split('/').pop() || folderConfig.localPath;
    const existing = await this.apiClient.findFolderByName(folderName, rootToken);
    if (existing) {
      log.debug(`飞书文件夹已存在: ${folderName} (token: ${existing.token})`);
      return existing.token;
    }

    const newToken = await this.apiClient.createFolder(folderName, rootToken);
    log.info(`已创建飞书文件夹: ${folderName} (token: ${newToken})`);
    return newToken;
  }

  /**
   * 处理云端已删除的文件（本地优先模式）
   * 遍历云端文件列表，检查本地是否存在，不存在则删除云端文件
   */
  private async handleCloudDeletedFiles(
    localFiles: TFile[],
    cloudFiles: FeishuFileMeta[],
    localFolderPath: string,
    result: SyncResult
  ): Promise<void> {
    // 构建本地文件名集合（包含去扩展名形式，匹配飞书可能的命名差异）
    const localFileNames = new Set<string>();
    for (const f of localFiles) {
      localFileNames.add(f.name);
      localFileNames.add(f.name.replace(/\.[^.]+$/, ''));
    }

    for (const cloudFile of cloudFiles) {
      // 只处理文件，不处理文件夹
      if (cloudFile.type === 'folder') {
        continue;
      }

      // 检查云端文件名是否在本地存在
      if (!localFileNames.has(cloudFile.name)) {
        try {
          log.info(`云端文件 ${cloudFile.name} 在本地不存在，删除云端`);
          await this.apiClient.deleteFile(cloudFile.token, cloudFile.type);
          result.deletedCount++;
          this.addLog('delete', `${localFolderPath}/${cloudFile.name}`, `云端文件已删除`);
        } catch (error) {
          const errMsg = (error as Error).message || '';
          if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
            const ipMsg = `删除云端文件 ${cloudFile.name} 失败：飞书应用 IP 白名单限制`;
            result.errors.push(ipMsg);
            this.addLog('error', cloudFile.name, ipMsg);
            log.warn(ipMsg);
            new Notice('飞书应用 IP 白名单限制，无法删除云端文件', 8000);
          } else {
            const msg = `删除云端文件 ${cloudFile.name} 失败: ${errMsg}`;
            result.errors.push(msg);
            this.addLog('error', cloudFile.name, msg);
            log.warn(msg);
          }
        }
      }
    }
  }

  /**
   * 并发上传文件（云端优先模式）
   * @param cloudFiles 云端文件列表（必须提供）
   */
  private async uploadFiles(
    localFiles: TFile[],
    localFolderPath: string,
    targetFolderToken: string,
    result: SyncResult,
    cloudFiles: FeishuFileMeta[]
  ): Promise<void> {
    const pool = new ConcurrencyPool(this.plugin.settings.maxConcurrentUploads);
    let authError: Error | null = null;
    let ipDeniedError = false;
    let shouldStop = false; // 共享停止标志，避免竞态

    const uploadPromises = localFiles.map(file =>
      pool.run(async () => {
        if (shouldStop) return;
        try {
          const uploaded = await this.syncFile(file, localFolderPath, targetFolderToken, cloudFiles);
          if (uploaded) {
            result.uploadedCount++;
          } else {
            result.skippedCount++;
          }
        } catch (error) {
          if (shouldStop) return;
          const errMsg = (error as Error).message || '';
          if (errMsg.includes('授权已失效') || errMsg.includes('重新授权')) {
            authError = error as Error;
            shouldStop = true;
            result.failedCount++;
            result.errors.push(`授权已失效，同步中止: ${errMsg}`);
            this.addLog('error', file.path, errMsg);
            return;
          }
          if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
            ipDeniedError = true;
            shouldStop = true;
            result.failedCount++;
            result.errors.push(`飞书应用 IP 白名单限制，同步中止`);
            this.addLog('error', file.path, 'IP 白名单限制');
            new Notice('同步中止：飞书应用 IP 白名单限制', 8000);
            return;
          }
          result.failedCount++;
          const errorMsg = `同步文件 ${file.path} 失败: ${errMsg}`;
          result.errors.push(errorMsg);
          this.addLog('error', file.path, errMsg);
          log.error(errorMsg);
        }
      })
    );

    await Promise.all(uploadPromises);

    if (authError) {
      result.success = false;
      new Notice('同步失败：用户授权已失效，请重新授权', 8000);
      this.addLog('error', '', '同步因授权失效而中止');
    }
    if (ipDeniedError) {
      result.success = false;
      this.addLog('error', '', '同步因 IP 白名单限制而中止');
    }
  }

  /**
   * 同步单个文件（云端优先模式）
   * 直接在云端文件列表中查找同名文件，比较哈希决定是否上传
   * @param cloudFiles 云端文件列表（必须提供）
   * @returns true 表示文件已上传，false 表示文件被跳过（未变化）
   */
  private async syncFile(
    file: TFile,
    _localFolderPath: string,
    targetFolderToken: string,
    cloudFiles: FeishuFileMeta[]
  ): Promise<boolean> {
    // 使用白名单模式判断二进制文件
    const ext = file.extension.toLowerCase();
    const isBinary = isBinaryFile(ext);

    log.debug(`同步文件: ${file.path}, 扩展名=${ext}, 二进制=${isBinary}`);

    // 读取文件内容
    let content: string | ArrayBuffer;
    try {
      if (isBinary) {
        content = await this.vault.readBinary(file);
      } else {
        content = await this.vault.read(file);
      }
    } catch (error) {
      throw new Error(`读取文件失败: ${(error as Error).message}`);
    }

    // 计算文件内容哈希
    const currentHash = await computeHash(content);

    // 计算相对于监控文件夹的路径，确定目标文件夹
    const relativePath = file.path;
    const pathParts = relativePath.split('/');
    let parentFolderToken: string;

    if (pathParts.length === 1) {
      parentFolderToken = targetFolderToken;
    } else {
      const subPath = pathParts.slice(1, -1).join('/');
      parentFolderToken = await this.apiClient.ensureFolderPath(subPath, targetFolderToken);
    }

    // 在云端文件列表中查找同名文件
    // 注意：cloudFiles 是根文件夹的文件列表，子文件夹中的文件需要单独获取
    let searchFiles = cloudFiles;
    if (pathParts.length > 1) {
      // 文件在子文件夹中，获取子文件夹的文件列表
      try {
        searchFiles = await this.apiClient.listFolderContents(parentFolderToken);
      } catch (error) {
        log.warn(`获取子文件夹 ${parentFolderToken} 的文件列表失败，当作新文件处理:`, error);
        searchFiles = [];
      }
    }
    const cloudFile = searchFiles.find(f =>
      (f.name === file.name || f.name === file.name.replace(/\.[^.]+$/, '')) &&
      (f.type === 'file' || f.type === 'docx' || f.type === 'sheet')
    );

    // 如果云端有同名文件，下载并比较哈希
    if (cloudFile) {
      try {
        const cloudContent = await this.apiClient.downloadFile(cloudFile.token, cloudFile.type);
        const cloudHash = await computeHash(cloudContent);

        if (cloudHash === currentHash) {
          // 哈希相同，内容未变化，跳过上传
          log.debug(`文件未变化，跳过: ${file.path}`);
          return false;
        }

        // 哈希不同，文件已变化，需要重新上传
        log.info(`文件已变化，重新上传: ${file.path}`);
        this.addLog('upload', file.path, `文件已变化 (云端哈希: ${cloudHash.substring(0, 8)}...)`);

        // 删除旧文件并上传新文件
        await this.apiClient.deleteFile(cloudFile.token, cloudFile.type);
        const { fileToken } = await this.uploadFileContent(file, content, parentFolderToken);
        log.debug(`文件重新上传成功，token: ${fileToken}`);
        return true;
      } catch (error) {
        // 下载或比较失败，先删除旧文件再重新上传（避免云端出现重复文件）
        log.warn(`检查云端文件失败，先删除旧文件再上传: ${file.path}`, error);
        try {
          await this.apiClient.deleteFile(cloudFile.token, cloudFile.type);
        } catch (deleteError) {
          log.warn(`删除旧云端文件失败，继续上传:`, deleteError);
        }
        await this.uploadFileContent(file, content, parentFolderToken);
        return true;
      }
    }

    // 云端没有同名文件，上传新文件
    log.info(`新文件，上传: ${file.path}`);
    this.addLog('upload', file.path, '新文件');

    const { fileToken } = await this.uploadFileContent(file, content, parentFolderToken);
    log.debug(`新文件上传成功，token: ${fileToken}`);
    return true;
  }

  /**
   * 上传文件内容到飞书（纯上传，不处理删除逻辑）
   */
  private async uploadFileContent(
    file: TFile,
    content: string | ArrayBuffer,
    parentFolderToken: string
  ): Promise<{ fileToken: string; fileType: string }> {
    const fileSize = content instanceof ArrayBuffer ? content.byteLength : new Blob([content]).size;

    if (!this.apiClient.checkFileSize(fileSize)) {
      throw new Error('文件大小超过限制');
    }

    // 上传文件
    const fileBuffer = content instanceof ArrayBuffer
      ? content
      : new TextEncoder().encode(content as string).buffer as ArrayBuffer;

    const fileToken = await this.apiClient.uploadFile(
      new Uint8Array(fileBuffer),
      file.name,
      parentFolderToken,
      fileSize
    );

    log.debug(`文件上传成功，token: ${fileToken}`);
    return { fileToken, fileType: 'file' };
  }

  /**
   * 处理文件重命名（云端优先模式）
   * 在云端文件列表中查找旧文件名，删除旧文件
   */
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    // 确定文件所属的映射
    const enabledConfigs = getEnabledConfigs(this.plugin.settings.syncFolders || []);
    let targetFolderToken: string | null = null;

    for (const config of enabledConfigs) {
      if (oldPath.startsWith(config.localPath + '/') || oldPath === config.localPath) {
        targetFolderToken = config.remoteFolderToken || null;
        if (!targetFolderToken) {
          targetFolderToken = await this.ensureFolderForMapping(config);
        }
        break;
      }
    }

    // 旧版兼容：如果没找到映射，尝试使用 feishuRootFolderToken
    if (!targetFolderToken) {
      targetFolderToken = this.plugin.settings.feishuRootFolderToken;
      if (!targetFolderToken) {
        targetFolderToken = await this.ensureDefaultFolder();
      }
    }

    // 获取云端文件列表，查找旧文件
    const oldFileName = oldPath.split('/').pop() || oldPath;
    try {
      const cloudFiles = await this.apiClient.listFolderContents(targetFolderToken);
      const oldCloudFile = cloudFiles.find(f =>
        f.name === oldFileName || f.name === oldFileName.replace(/\.[^.]+$/, '')
      );

      if (oldCloudFile && oldCloudFile.type !== 'folder') {
        try {
          await this.apiClient.deleteFile(oldCloudFile.token, oldCloudFile.type);
          log.info(`重命名：已删除旧路径云端文件 ${oldFileName}`);
          this.addLog('delete', oldPath, `重命名为 ${newPath}，删除旧云端文件`);
        } catch (deleteError) {
          const errMsg = (deleteError as Error).message || '';
          if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
            log.warn(`重命名 ${oldPath} → ${newPath}：删除旧文件失败（IP 白名单限制）`);
            new Notice('飞书 IP 白名单限制，无法删除旧版本文件', 8000);
            this.addLog('error', oldPath, `重命名时删除旧云端文件失败（IP 白名单限制）`);
          } else if (errMsg.includes('1061007') || errMsg.includes('1061001') || errMsg.includes('file has been delete') || errMsg.includes('unknown error')) {
            log.debug(`重命名：旧云端文件 ${oldFileName} 已不存在或无法删除，视为删除成功`);
          } else {
            log.warn(`重命名 ${oldPath} → ${newPath}：删除旧云端文件失败，继续重命名流程:`, deleteError);
            this.addLog('error', oldPath, `删除旧云端文件失败: ${(deleteError as Error).message}`);
          }
        }
      }
    } catch (error) {
      log.warn(`重命名 ${oldPath} → ${newPath}：获取云端文件列表失败`, error);
    }
  }

  /**
   * 处理文件删除（云端优先模式）
   * 在云端文件列表中查找该文件，删除云端文件
   */
  async handleDelete(filePath: string): Promise<void> {
    if (!this.plugin.settings.syncOnDelete) {
      return;
    }

    // 确定文件所属的映射
    const enabledConfigs = getEnabledConfigs(this.plugin.settings.syncFolders || []);
    let targetFolderToken: string | null = null;

    for (const config of enabledConfigs) {
      if (filePath.startsWith(config.localPath + '/') || filePath === config.localPath) {
        targetFolderToken = config.remoteFolderToken || null;
        if (!targetFolderToken) {
          targetFolderToken = await this.ensureFolderForMapping(config);
        }
        break;
      }
    }

    // 旧版兼容：如果没找到映射，尝试使用 feishuRootFolderToken
    if (!targetFolderToken) {
      targetFolderToken = this.plugin.settings.feishuRootFolderToken;
      if (!targetFolderToken) {
        targetFolderToken = await this.ensureDefaultFolder();
      }
    }

    // 获取云端文件列表，查找该文件
    const fileName = filePath.split('/').pop() || filePath;
    try {
      const cloudFiles = await this.apiClient.listFolderContents(targetFolderToken);
      const cloudFile = cloudFiles.find(f =>
        f.name === fileName || f.name === fileName.replace(/\.[^.]+$/, '')
      );

      if (cloudFile && cloudFile.type !== 'folder') {
        try {
          await this.apiClient.deleteFile(cloudFile.token, cloudFile.type);
          log.info(`已删除云端文件: ${fileName}`);
          this.addLog('delete', filePath, '本地文件已删除，同步删除云端文件');
        } catch (error) {
          const errMsg = (error as Error).message || '';
          if (errMsg.includes('1061007') || errMsg.includes('1061001') || errMsg.includes('file has been delete') || errMsg.includes('unknown error')) {
            // 文件不存在，忽略
            log.debug(`删除云端文件 ${fileName} 失败：文件已不存在`);
          } else {
            log.warn(`删除云端文件 ${fileName} 失败:`, error);
            this.addLog('error', filePath, `删除云端文件失败: ${errMsg}`);
          }
        }
      }
    } catch (error) {
      log.warn(`删除云端文件 ${fileName}：获取云端文件列表失败`, error);
    }
  }

  /**
   * 从飞书下载文件到本地
   */
  async downloadFromFeishu(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      deletedCount: 0,
      downloadedCount: 0,
      errors: [],
    };

    // 支持多文件夹下载
    const enabledConfigs = getEnabledConfigs(this.plugin.settings.syncFolders || []);

    if (enabledConfigs.length > 0) {
      for (const config of enabledConfigs) {
        let targetFolderToken = config.remoteFolderToken;
        if (!targetFolderToken) {
          targetFolderToken = await this.ensureFolderForMapping(config);
        }
        new Notice(`从飞书下载 "${config.localPath}"...`);
        try {
          await this.downloadFolder(targetFolderToken, config.localPath, result);
        } catch (error) {
          result.failedCount++;
          result.errors.push(`下载 "${config.localPath}" 失败: ${(error as Error).message}`);
        }
      }
    } else {
      // 旧版兼容
      const { localFolderPath, feishuRootFolderToken } = this.plugin.settings;
      if (!localFolderPath) {
        result.success = false;
        result.errors.push('未配置本地同步文件夹路径');
        new Notice('下载失败：未配置本地同步文件夹路径');
        return result;
      }
      let targetFolderToken = feishuRootFolderToken;
      if (!targetFolderToken) {
        targetFolderToken = await this.ensureDefaultFolder();
      }
      new Notice('开始从飞书下载文件...');
      try {
        await this.downloadFolder(targetFolderToken, localFolderPath, result);
      } catch (error) {
        result.failedCount++;
        result.errors.push(`下载失败: ${(error as Error).message}`);
      }
    }

    if (result.failedCount === 0) {
      const msg = `下载完成！下载 ${result.downloadedCount} 个，跳过 ${result.skippedCount} 个`;
      new Notice(msg);
      this.addLog('info', '', msg);
    } else {
      result.success = false;
      const msg = `下载完成：下载 ${result.downloadedCount}，跳过 ${result.skippedCount}，失败 ${result.failedCount}`;
      new Notice(msg);
      this.addLog('info', '', msg);
    }

    return result;
  }

  /**
   * 递归下载文件夹内容
   */
  private async downloadFolder(
    folderToken: string,
    localPath: string,
    result: SyncResult
  ): Promise<void> {
    let files;
    try {
      files = await this.apiClient.listFolderContents(folderToken);
    } catch (error) {
      log.warn('列出文件夹内容失败:', error);
      return;
    }

    log.debug(`downloadFolder: folderToken=${folderToken}, 找到 ${files.length} 个项目`);

    for (const file of files) {
      if (file.type === 'folder') {
        const subLocalPath = localPath ? `${localPath}/${file.name}` : file.name;
        const folder = this.vault.getFolderByPath(subLocalPath);
        if (!folder) {
          try {
            await this.vault.createFolder(subLocalPath);
          } catch {
            // 文件夹可能已存在
          }
        }
        await this.downloadFolder(file.token, subLocalPath, result);
      } else {
        try {
          await this.downloadSingleFile(file, localPath, result);
        } catch (error) {
          const errMsg = (error as Error).message || '';
          if (errMsg.includes('99991679') || errMsg.includes('drive:export:readonly')) {
            result.failedCount++;
            const skipMsg = `跳过在线文档 ${file.name}（导出权限不足，请重新授权）`;
            result.errors.push(skipMsg);
            this.addLog('error', `${localPath}/${file.name}`, skipMsg);
            new Notice('飞书导出权限不足，请重新授权', 0);
          } else {
            result.failedCount++;
            const errorMsg = `下载文件 ${file.name} 失败: ${errMsg}`;
            result.errors.push(errorMsg);
            this.addLog('error', `${localPath}/${file.name}`, errMsg);
            log.error(errorMsg);
          }
        }
      }
    }
  }

  /**
   * 根据文件类型确定下载后的本地文件名
   */
  private getLocalFileName(remoteName: string, remoteType: string): string {
    const extensionMap: Record<string, string> = {
      'docx': '.docx',
      'doc': '.docx',
      'sheet': '.xlsx',
      'bitable': '.xlsx',
      'slides': '.pptx',
    };

    const ext = extensionMap[remoteType];
    if (ext && !remoteName.toLowerCase().endsWith(ext)) {
      return remoteName + ext;
    }
    return remoteName;
  }

  /**
   * 下载单个文件
   */
  private async downloadSingleFile(
    remoteFile: { token: string; name: string; type: string; size?: number },
    localPath: string,
    result: SyncResult
  ): Promise<void> {
    const localName = this.getLocalFileName(remoteFile.name, remoteFile.type);
    const filePath = localPath ? `${localPath}/${localName}` : localName;

    log.debug(`下载文件: name=${remoteFile.name}, type=${remoteFile.type}, filePath=${filePath}`);

    const localFile = this.vault.getAbstractFileByPath(filePath);
    if (localFile instanceof TFile) {
      const localContent = await this.vault.readBinary(localFile);
      const localHash = await computeHash(localContent);
      const remoteContent = await this.apiClient.downloadFile(remoteFile.token, remoteFile.type);
      const remoteHash = await computeHash(remoteContent);

      if (localHash === remoteHash) {
        result.skippedCount++;
        this.addLog('skip', filePath, '本地与云端内容相同，跳过');
        return;
      }

      await this.vault.modifyBinary(localFile, remoteContent);
      result.downloadedCount++;
      this.addLog('download', filePath, '本地文件已更新（覆盖）');
      log.info(`文件已更新: ${filePath}`);
    } else {
      const content = await this.apiClient.downloadFile(remoteFile.token, remoteFile.type);
      const parentPath = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentPath) {
        const parentFolder = this.vault.getFolderByPath(parentPath);
        if (!parentFolder) {
          try {
            await this.vault.createFolder(parentPath);
          } catch {
            // 可能已存在
          }
        }
      }
      await this.vault.createBinary(filePath, new Uint8Array(content));
      result.downloadedCount++;
      this.addLog('download', filePath, '新文件已下载');
      log.info(`新文件已下载: ${filePath}`);
    }
  }

  /**
   * 扫描本地文件夹，获取所有文件列表（应用忽略规则）
   */
  private scanLocalFolder(folderPath: string): TFile[] {
    const files: TFile[] = [];
    const folder = this.vault.getFolderByPath(folderPath);
    if (!folder) {
      log.warn('本地文件夹不存在:', folderPath);
      return files;
    }
    this.collectFiles(folder, files);
    return files;
  }

  /**
   * 递归收集文件夹中的所有文件（应用忽略规则）
   */
  private collectFiles(folder: TFolder, files: TFile[]): void {
    for (const child of folder.children) {
      if (child instanceof TFile) {
        // 跳过 .feisyncignore 文件本身
        if (child.name === FEISYNC_IGNORE_FILE) {
          continue;
        }
        // 应用忽略规则
        if (this.ignoreFilter.hasRules && this.ignoreFilter.shouldIgnore(child.path, false)) {
          log.debug(`忽略文件: ${child.path}`);
          continue;
        }
        files.push(child);
      } else if (child instanceof TFolder) {
        // 应用忽略规则（目录级别）
        if (this.ignoreFilter.hasRules && this.ignoreFilter.shouldIgnoreFolder(child.path)) {
          log.debug(`忽略目录: ${child.path}`);
          continue;
        }
        this.collectFiles(child, files);
      }
    }
  }

  /**
   * 确保存在默认的 ObsidianSync 文件夹
   */
  private async ensureDefaultFolder(): Promise<string> {
    const defaultFolderName = 'ObsidianSync';
    const rootFolderToken = '';
    const existing = await this.apiClient.findFolderByName(defaultFolderName, rootFolderToken);
    if (existing) {
      return existing.token;
    }
    return await this.apiClient.createFolder(defaultFolderName, rootFolderToken);
  }

  /**
   * 汇报同步结果
   */
  private reportResult(result: SyncResult): void {
    if (result.failedCount === 0) {
      const parts: string[] = [];
      if (result.uploadedCount > 0) parts.push(`上传 ${result.uploadedCount} 个`);
      if (result.skippedCount > 0) parts.push(`跳过 ${result.skippedCount} 个`);
      if (result.deletedCount > 0) parts.push(`删除 ${result.deletedCount} 个`);
      if (parts.length === 0) parts.push('无变化');
      const msg = `同步完成！${parts.join('，')}`;
      new Notice(msg);
      this.addLog('info', '', msg);
    } else {
      const msg = `同步完成：上传 ${result.uploadedCount}，跳过 ${result.skippedCount}，删除 ${result.deletedCount}，失败 ${result.failedCount}`;
      new Notice(msg);
      this.addLog('info', '', msg);
    }
  }

  /**
   * 验证 API 客户端是否已配置
   */
  isConfigured(): boolean {
    return this.plugin.settings.appId !== '' && this.plugin.settings.appSecret !== '';
  }
}
