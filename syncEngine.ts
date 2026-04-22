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
import { Notice, ProgressBarComponent } from 'obsidian';
import { SyncLogEntry } from './settings';
import { IgnoreFilter, loadIgnoreFilter, FEISYNC_IGNORE_FILE } from './ignoreFilter';
import { SyncFolderConfig, getEnabledConfigs, createSyncFolderConfig, validateSyncFolderConfig } from './syncFolderConfig';
import { isBinaryFile, isTextFile } from './fileTypeUtils';
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
          reject(error);
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
      } catch (error) {
        const errMsg = (error as Error).message || '';
        result.errors.push(`映射 "${folderConfig.localPath}" 同步失败: ${errMsg}`);
        log.error(`映射 "${folderConfig.localPath}" 同步失败:`, error);
      }
    }

    // 4. 汇总结果
    result.success = result.failedCount === 0;

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

    return result;
  }

  /**
   * 旧版单文件夹同步（向后兼容）
   */
  private async syncLegacy(result: SyncResult): Promise<SyncResult> {
    const { localFolderPath, feishuRootFolderToken, syncOnDelete } = this.plugin.settings;

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

    // 4. 加载同步记录
    const syncRecords = await this.plugin.loadSyncRecords();

    // 5. 构建本地文件路径集合（用于检测删除）
    const localFilePaths = new Set(localFiles.map(f => f.path));

    // 6. 处理删除
    if (syncOnDelete) {
      await this.handleDeletedFiles(syncRecords, localFilePaths, localFolderPath, result);
    }

    // 7. 并发上传文件
    if (localFiles.length === 0 && result.deletedCount === 0) {
      new Notice('同步完成：没有需要同步的文件');
      this.addLog('info', '', '同步完成：没有需要同步的文件');
      await this.plugin.saveSyncRecords(syncRecords);
      return result;
    }

    new Notice(`开始同步 ${localFiles.length} 个文件...`);
    this.addLog('info', '', `开始同步 ${localFiles.length} 个文件`);

    // 预先获取云端文件列表（用于新文件查重）
    let cloudFiles: FeishuFileMeta[] | undefined;
    if (localFiles.length > 0) {
      try {
        cloudFiles = await this.apiClient.listFolderContents(targetFolderToken);
        log.debug(`预获取云端文件列表完成，共 ${cloudFiles.length} 个文件/文件夹`);
      } catch (error) {
        log.warn('预获取云端文件列表失败，将使用逐文件查重:', error);
        cloudFiles = undefined;
      }
    }

    await this.uploadFiles(localFiles, localFolderPath, targetFolderToken, syncRecords, result, undefined, cloudFiles);

    // 8. 保存同步记录
    await this.plugin.saveSyncRecords(syncRecords);

    // 9. 汇总结果
    result.success = result.failedCount === 0;
    this.reportResult(result);

    return result;
  }

  /**
   * 同步单个文件夹映射
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

    const { syncOnDelete } = this.plugin.settings;

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

    // 3. 加载同步记录
    const syncRecords = await this.plugin.loadSyncRecords();

    // 4. 构建本地文件路径集合（用于检测删除）
    const localFilePaths = new Set(localFiles.map(f => f.path));

    // 5. 处理删除（只处理属于此映射的记录）
    if (syncOnDelete) {
      await this.handleDeletedFiles(syncRecords, localFilePaths, folderConfig.localPath, result, folderConfig.id);
    }

    // 6. 预先获取云端文件列表（用于新文件查重，避免每个文件单独调用 API）
    let cloudFiles: FeishuFileMeta[] | undefined;
    let ipDeniedError: boolean = false;
    if (localFiles.length > 0) {
      try {
        cloudFiles = await this.apiClient.listFolderContents(targetFolderToken);
        log.debug(`预获取云端文件列表完成，共 ${cloudFiles.length} 个文件/文件夹`);
      } catch (error) {
        const errMsg = (error as Error).message || '';
        if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
          ipDeniedError = true;
          log.warn('飞书应用 IP 白名单限制，预获取云端文件列表失败');
          new Notice('飞书应用 IP 白名单限制，部分功能可能受限', 10000);
        } else {
          log.warn('预获取云端文件列表失败，将使用逐文件查重:', error);
        }
        cloudFiles = undefined;
      }
    }

    // 如果是 IP 白名单错误，记录到结果中
    if (ipDeniedError) {
      result.errors.push('飞书应用 IP 白名单限制，无法执行完整同步');
      this.addLog('warn', '', 'IP 白名单限制警告');
    }

    // 7. 并发上传文件
    if (localFiles.length === 0 && result.deletedCount === 0) {
      this.addLog('info', '', `映射 "${folderConfig.localPath}": 没有需要同步的文件`);
      return result;
    }

    new Notice(`同步 "${folderConfig.localPath}": ${localFiles.length} 个文件...`);

    await this.uploadFiles(localFiles, folderConfig.localPath, targetFolderToken, syncRecords, result, folderConfig.id, cloudFiles);

    // 7. 更新映射的上次同步时间
    folderConfig.lastSyncTime = Date.now();
    folderConfig.lastSyncFileCount = localFiles.length;

    // 8. 保存同步记录
    await this.plugin.saveSyncRecords(syncRecords);

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
   * 处理已删除的文件
   */
  private async handleDeletedFiles(
    syncRecords: Record<string, FileSyncRecord>,
    localFilePaths: Set<string>,
    localFolderPath: string,
    result: SyncResult,
    folderConfigId?: string
  ): Promise<void> {
    const recordsToDelete: string[] = [];
    for (const [filePath, record] of Object.entries(syncRecords)) {
      // 只处理属于指定映射的记录
      if (folderConfigId && record.folderConfigId && record.folderConfigId !== folderConfigId) {
        continue;
      }
      // 只处理在监控文件夹下的记录
      if (!filePath.startsWith(localFolderPath + '/') && filePath !== localFolderPath) {
        continue;
      }
      if (!localFilePaths.has(filePath)) {
        try {
          log.info(`本地文件已删除，同步删除云端: ${filePath}`);
          await this.apiClient.deleteFile(record.cloudToken, record.cloudType);
          recordsToDelete.push(filePath);
          result.deletedCount++;
          this.addLog('delete', filePath, `云端文件已删除 (token: ${record.cloudToken})`);
        } catch (error) {
          const errMsg = (error as Error).message || '';
          if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
            const ipMsg = `删除云端文件 ${filePath} 失败：飞书应用 IP 白名单限制`;
            result.errors.push(ipMsg);
            this.addLog('error', filePath, ipMsg);
            log.warn(ipMsg);
            new Notice('飞书应用 IP 白名单限制，无法删除云端文件', 8000);
            recordsToDelete.push(filePath);
          } else {
            const msg = `删除云端文件 ${filePath} 失败: ${errMsg}`;
            result.errors.push(msg);
            this.addLog('error', filePath, msg);
            log.warn(msg);
          }
        }
      }
    }
    // 从同步记录中移除已删除的文件
    for (const key of recordsToDelete) {
      delete syncRecords[key];
    }
  }

  /**
   * 并发上传文件
   * @param cloudFiles 可选的预获取云端文件列表（用于新文件查重，避免每个文件单独调用 API）
   */
  private async uploadFiles(
    localFiles: TFile[],
    localFolderPath: string,
    targetFolderToken: string,
    syncRecords: Record<string, FileSyncRecord>,
    result: SyncResult,
    folderConfigId?: string,
    cloudFiles?: FeishuFileMeta[]
  ): Promise<void> {
    const pool = new ConcurrencyPool(this.plugin.settings.maxConcurrentUploads);
    let authError: Error | null = null;

    const uploadPromises = localFiles.map(file =>
      pool.run(async () => {
        if (authError) return;
        try {
          const uploaded = await this.syncFile(file, localFolderPath, targetFolderToken, syncRecords, folderConfigId, cloudFiles);
          if (uploaded) {
            result.uploadedCount++;
          } else {
            result.skippedCount++;
          }
        } catch (error) {
          const errMsg = (error as Error).message || '';
          if (errMsg.includes('授权已失效') || errMsg.includes('重新授权')) {
            authError = error as Error;
            result.failedCount++;
            result.errors.push(`授权已失效，同步中止: ${errMsg}`);
            this.addLog('error', file.path, errMsg);
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
  }

  /**
   * 同步单个文件（增量判断）
   * @param cloudFiles 可选的预获取云端文件列表（用于新文件查重）
   * @returns true 表示文件已上传，false 表示文件被跳过（未变化）
   */
  private async syncFile(
    file: TFile,
    localFolderPath: string,
    targetFolderToken: string,
    syncRecords: Record<string, FileSyncRecord>,
    folderConfigId?: string,
    cloudFiles?: FeishuFileMeta[]
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
    // file.path 格式如 "folder/sub/file.md"，pathParts = ["folder", "sub", "file.md"]
    // - pathParts.length === 1：文件直接在根目录，不需要创建子文件夹
    // - 否则：pathParts.slice(1, -1) 取中间部分作为子路径（如 "sub"），确保路径存在
    const relativePath = file.path;
    const pathParts = relativePath.split('/');
    let parentFolderToken: string;

    if (pathParts.length === 1) {
      parentFolderToken = targetFolderToken;
    } else {
      const subPath = pathParts.slice(1, -1).join('/');
      parentFolderToken = await this.apiClient.ensureFolderPath(subPath, targetFolderToken);
    }

    // 查找已有的同步记录（兼容多种 recordKey 格式）
    let recordKey = folderConfigId ? `${folderConfigId}::${file.path}` : file.path;
    let existingRecord = syncRecords[recordKey];

    // 兼容旧格式：如果找不到，尝试其他格式
    if (!existingRecord) {
      for (const [key, record] of Object.entries(syncRecords)) {
        if (key.endsWith(`::${file.path}`) || key === file.path) {
          existingRecord = record;
          recordKey = key;
          break;
        }
      }
    }

    // 增量判断：内容哈希相同 + 父目录相同
    if (existingRecord && existingRecord.hash === currentHash && existingRecord.parentFolderToken === parentFolderToken) {
      // 内容未变化，跳过上传（不再检查云端存在性，避免不必要的 API 调用和网络延迟）
      log.debug(`文件未变化，跳过: ${file.path}`);
      return false;
    }

    // 内容变化或为新文件
    if (existingRecord) {
      log.info(`文件已变化，重新上传: ${file.path}`);
      this.addLog('upload', file.path, `文件已变化 (旧哈希: ${existingRecord.hash.substring(0, 8)}...)`);
    } else {
      log.info(`新文件，上传: ${file.path}`);
      this.addLog('upload', file.path, '新文件');
    }

    // 执行上传
    const { fileToken, fileType } = await this.uploadFileContent(
      file,
      content,
      parentFolderToken,
      existingRecord,
      cloudFiles
    );

    // 更新同步记录
    syncRecords[recordKey] = {
      hash: currentHash,
      lastSyncTime: Date.now(),
      cloudToken: fileToken,
      cloudType: fileType,
      parentFolderToken: parentFolderToken,
      folderConfigId: folderConfigId,
    };

    return true;
  }

  /**
   * 上传文件内容到飞书
   */
  private async uploadFileContent(
    file: TFile,
    content: string | ArrayBuffer,
    parentFolderToken: string,
    existingRecord: FileSyncRecord | undefined,
    cloudFiles?: FeishuFileMeta[]
  ): Promise<{ fileToken: string; fileType: string }> {
    const fileSize = content instanceof ArrayBuffer ? content.byteLength : new Blob([content]).size;

    if (!this.apiClient.checkFileSize(fileSize)) {
      throw new Error('文件大小超过限制');
    }

    // 如果有同步记录，先删除云端旧文件
    if (existingRecord) {
      try {
        await this.apiClient.deleteFile(existingRecord.cloudToken, existingRecord.cloudType);
        log.debug('旧文件已删除');
      } catch (deleteError) {
        const errMsg = (deleteError as Error).message || '';
        if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
          log.warn('删除旧文件失败（IP 白名单限制），将上传为新文件');
          new Notice('飞书 IP 白名单限制，无法删除旧版本文件', 8000);
        } else if (errMsg.includes('1061007') || errMsg.includes('1061001') || errMsg.includes('file has been delete') || errMsg.includes('unknown error')) {
          // 1061007: 文件不存在，1061001: 未知错误（可能是并发导致文件已删除）
          log.debug('旧文件已不存在或无法删除，视为删除成功');
        } else {
          log.warn('删除旧文件失败，继续上传:', deleteError);
        }
      }
    } else {
      // 没有同步记录（新文件），云端可能存在同名文件
      // 优先使用预获取的云端文件列表（性能优化），无列表时回退到 API 查询
      const existingFile = cloudFiles
        ? cloudFiles.find(f =>
            (f.name === file.name || f.name === file.name.replace(/\.[^.]+$/, '')) &&
            (f.type === 'file' || f.type === 'docx' || f.type === 'sheet')
          )
        : await this.apiClient.findFileByName(file.name, parentFolderToken);
      if (existingFile) {
        try {
          await this.apiClient.deleteFile(existingFile.token, existingFile.type);
        } catch (deleteError) {
          log.warn('删除同名文件失败，继续上传:', deleteError);
        }
      }
    }

    // 上传文件
    const fileBuffer = content instanceof ArrayBuffer
      ? content
      : new TextEncoder().encode(content as string).buffer;

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
   * 处理文件重命名
   */
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const syncRecords = await this.plugin.loadSyncRecords();

    // 尝试多种 recordKey 格式查找旧记录
    let oldRecord: FileSyncRecord | undefined;
    let oldRecordKey: string | undefined;

    // 先尝试不带 folderConfigId 的 key
    if (syncRecords[oldPath]) {
      oldRecord = syncRecords[oldPath];
      oldRecordKey = oldPath;
    } else {
      // 尝试带 folderConfigId 前缀的 key
      for (const [key, record] of Object.entries(syncRecords)) {
        if (key.endsWith(`::${oldPath}`) || key === oldPath) {
          oldRecord = record;
          oldRecordKey = key;
          break;
        }
      }
    }

    if (oldRecord) {
      try {
        await this.apiClient.deleteFile(oldRecord.cloudToken, oldRecord.cloudType);
        log.info(`重命名：已删除旧路径云端文件 ${oldPath}`);
        this.addLog('delete', oldPath, `重命名为 ${newPath}，删除旧云端文件`);
      } catch (deleteError) {
        const errMsg = (deleteError as Error).message || '';
        if (errMsg.includes('99991401') || errMsg.includes('denied by app setting')) {
          log.warn(`重命名 ${oldPath} → ${newPath}：删除旧文件失败（IP 白名单限制）`);
          new Notice('飞书 IP 白名单限制，无法删除旧版本文件', 8000);
          this.addLog('warn', oldPath, `重命名时删除旧云端文件失败（IP 白名单限制）`);
        } else if (errMsg.includes('1061007') || errMsg.includes('1061001') || errMsg.includes('file has been delete') || errMsg.includes('unknown error')) {
          // 1061007: 文件不存在，1061001: 未知错误（可能是并发导致文件已删除）
          log.debug(`重命名：旧云端文件 ${oldPath} 已不存在或无法删除，视为删除成功`);
        } else {
          log.warn(`重命名 ${oldPath} → ${newPath}：删除旧云端文件失败，继续重命名流程:`, deleteError);
          this.addLog('warn', oldPath, `删除旧云端文件失败: ${(deleteError as Error).message}`);
        }
      }
      if (oldRecordKey) {
        delete syncRecords[oldRecordKey];
      }
    }

    await this.plugin.saveSyncRecords(syncRecords);
  }

  /**
   * 处理文件删除
   */
  async handleDelete(filePath: string): Promise<void> {
    if (!this.plugin.settings.syncOnDelete) {
      return;
    }

    const syncRecords = await this.plugin.loadSyncRecords();

    // 尝试多种 recordKey 格式
    let record: FileSyncRecord | undefined;
    let recordKey: string | undefined;

    if (syncRecords[filePath]) {
      record = syncRecords[filePath];
      recordKey = filePath;
    } else {
      for (const [key, rec] of Object.entries(syncRecords)) {
        if (key.endsWith(`::${filePath}`) || key === filePath) {
          record = rec;
          recordKey = key;
          break;
        }
      }
    }

    if (record) {
      try {
        await this.apiClient.deleteFile(record.cloudToken, record.cloudType);
        log.info(`已删除云端文件: ${filePath}`);
        this.addLog('delete', filePath, '本地文件已删除，同步删除云端文件');
      } catch (error) {
        log.warn('删除云端文件失败:', error);
        this.addLog('error', filePath, `删除云端文件失败: ${(error as Error).message}`);
      }
      if (recordKey) {
        delete syncRecords[recordKey];
      }
      await this.plugin.saveSyncRecords(syncRecords);
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
          } catch (e) {
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
          } catch (e) {
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
