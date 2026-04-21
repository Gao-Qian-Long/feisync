/**
 * 同步引擎
 * 负责协调文件扫描、上传、下载、删除和飞书Drive操作
 * 支持增量同步：基于文件内容哈希跳过未修改文件
 * 支持并发上传、删除同步、从飞书下载
 */

import { Vault, TFile, TFolder } from 'obsidian';
import FlybookPlugin from './main';
import { FeishuApiClient } from './feishuApi';
import { Notice, ProgressBarComponent } from 'obsidian';
import { SyncLogEntry } from './settings';

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
  private plugin: FlybookPlugin;
  private apiClient: FeishuApiClient;
  private vault: Vault;

  constructor(plugin: FlybookPlugin, apiClient: FeishuApiClient) {
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
   * 执行一次完整同步（增量 + 删除）
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

    // 3. 扫描本地文件夹
    const localFiles = this.scanLocalFolder(localFolderPath);

    // 4. 加载同步记录
    const syncRecords = await this.plugin.loadSyncRecords();

    // 5. 构建本地文件路径集合（用于检测删除）
    const localFilePaths = new Set(localFiles.map(f => f.path));

    // 6. 处理删除：检查同步记录中有但本地已不存在的文件
    if (syncOnDelete) {
      const recordsToDelete: string[] = [];
      for (const [filePath, record] of Object.entries(syncRecords)) {
        // 只处理在监控文件夹下的记录
        if (!filePath.startsWith(localFolderPath + '/') && filePath !== localFolderPath) {
          continue;
        }
        if (!localFilePaths.has(filePath)) {
          try {
            console.log(`[Flybook] 本地文件已删除，同步删除云端: ${filePath}`);
            await this.apiClient.deleteFile(record.cloudToken, record.cloudType);
            recordsToDelete.push(filePath);
            result.deletedCount++;
            this.addLog('delete', filePath, `云端文件已删除 (token: ${record.cloudToken})`);
          } catch (error) {
            const msg = `删除云端文件 ${filePath} 失败: ${(error as Error).message}`;
            result.errors.push(msg);
            this.addLog('error', filePath, msg);
            console.warn('[Flybook]', msg);
          }
        }
      }
      // 从同步记录中移除已删除的文件
      for (const key of recordsToDelete) {
        delete syncRecords[key];
      }
    }

    // 7. 并发上传文件
    if (localFiles.length === 0 && result.deletedCount === 0) {
      new Notice('同步完成：没有需要同步的文件');
      this.addLog('info', '', '同步完成：没有需要同步的文件');
      await this.plugin.saveSyncRecords(syncRecords);
      await this.plugin.saveSettings();
      return result;
    }

    new Notice(`开始同步 ${localFiles.length} 个文件...`);
    this.addLog('info', '', `开始同步 ${localFiles.length} 个文件`);

    const pool = new ConcurrencyPool(this.plugin.settings.maxConcurrentUploads);
    const uploadPromises = localFiles.map(file =>
      pool.run(async () => {
        try {
          const uploaded = await this.syncFile(file, localFolderPath, targetFolderToken, syncRecords);
          if (uploaded) {
            result.uploadedCount++;
          } else {
            result.skippedCount++;
          }
        } catch (error) {
          result.failedCount++;
          const errorMsg = `同步文件 ${file.path} 失败: ${(error as Error).message}`;
          result.errors.push(errorMsg);
          this.addLog('error', file.path, (error as Error).message);
          console.error('[Flybook]', errorMsg);
        }
      })
    );

    await Promise.all(uploadPromises);

    // 8. 保存同步记录
    await this.plugin.saveSyncRecords(syncRecords);
    await this.plugin.saveSettings();

    // 9. 汇总结果
    if (result.failedCount === 0) {
      result.success = true;
      const parts: string[] = [];
      if (result.uploadedCount > 0) parts.push(`上传 ${result.uploadedCount} 个`);
      if (result.skippedCount > 0) parts.push(`跳过 ${result.skippedCount} 个`);
      if (result.deletedCount > 0) parts.push(`删除 ${result.deletedCount} 个`);
      if (parts.length === 0) parts.push('无变化');
      new Notice(`同步完成！${parts.join('，')}`);
      this.addLog('info', '', `同步完成：${parts.join('，')}`);
    } else {
      result.success = false;
      const msg = `同步完成：上传 ${result.uploadedCount}，跳过 ${result.skippedCount}，删除 ${result.deletedCount}，失败 ${result.failedCount}`;
      new Notice(msg);
      this.addLog('info', '', msg);
    }

    return result;
  }

  /**
   * 同步单个文件（增量判断）
   * @returns true 表示文件已上传，false 表示文件被跳过（未变化）
   */
  private async syncFile(
    file: TFile,
    localFolderPath: string,
    targetFolderToken: string,
    syncRecords: Record<string, FileSyncRecord>
  ): Promise<boolean> {
    // 判断是否为二进制文件格式
    const binaryExtensions = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'zip', 'rar'];
    const ext = file.extension.toLowerCase();
    const isBinaryFile = binaryExtensions.indexOf(ext) !== -1;

    // 读取文件内容
    let content: string | ArrayBuffer;
    try {
      if (isBinaryFile) {
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

    // 查找已有的同步记录
    const recordKey = file.path;
    const existingRecord = syncRecords[recordKey];

    // 增量判断：哈希相同且云端文件夹未变 → 跳过
    if (existingRecord && existingRecord.hash === currentHash && existingRecord.parentFolderToken === parentFolderToken) {
      console.log(`[Flybook] 文件未变化，跳过: ${file.path}`);
      return false;
    }

    // 文件有变化或为新文件，需要上传
    if (existingRecord) {
      console.log(`[Flybook] 文件已变化，重新上传: ${file.path}`);
      this.addLog('upload', file.path, `文件已变化 (旧哈希: ${existingRecord.hash.substring(0, 8)}...)`);
    } else {
      console.log(`[Flybook] 新文件，上传: ${file.path}`);
      this.addLog('upload', file.path, '新文件');
    }

    // 执行上传（含删除旧文件逻辑）
    const { fileToken, fileType } = await this.uploadFileContent(
      file,
      content,
      parentFolderToken,
      existingRecord
    );

    // 更新同步记录
    syncRecords[recordKey] = {
      hash: currentHash,
      lastSyncTime: Date.now(),
      cloudToken: fileToken,
      cloudType: fileType,
      parentFolderToken: parentFolderToken,
    };

    return true;
  }

  /**
   * 上传文件内容到飞书
   * 如果存在旧记录，先删除旧文件再上传
   */
  private async uploadFileContent(
    file: TFile,
    content: string | ArrayBuffer,
    parentFolderToken: string,
    existingRecord: FileSyncRecord | undefined
  ): Promise<{ fileToken: string; fileType: string }> {
    const fileSize = content instanceof ArrayBuffer ? content.byteLength : new Blob([content]).size;

    if (!this.apiClient.checkFileSize(fileSize)) {
      throw new Error('文件大小超过限制');
    }

    // 如果有同步记录，先删除云端旧文件
    if (existingRecord) {
      try {
        await this.apiClient.deleteFile(existingRecord.cloudToken, existingRecord.cloudType);
        console.log(`[Flybook] 旧文件已删除`);
      } catch (deleteError) {
        console.warn(`[Flybook] 删除旧文件失败，继续上传新版本:`, deleteError);
      }
    } else {
      // 没有同步记录（新文件），但云端可能存在同名文件
      try {
        const existingFile = await this.apiClient.findFileByName(file.name, parentFolderToken);
        if (existingFile) {
          try {
            await this.apiClient.deleteFile(existingFile.token, existingFile.type);
          } catch (deleteError) {
            console.warn(`[Flybook] 删除同名文件失败，继续上传:`, deleteError);
          }
        }
      } catch (error) {
        console.warn(`[Flybook] 检查云端文件存在性失败，继续上传:`, error);
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

    console.log(`[Flybook] 文件上传成功，token: ${fileToken}`);
    return { fileToken, fileType: 'file' };
  }

  /**
   * 处理文件重命名
   * 删除旧路径的云端文件，上传新路径
   */
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const syncRecords = await this.plugin.loadSyncRecords();
    const oldRecord = syncRecords[oldPath];

    if (oldRecord) {
      // 删除旧路径的云端文件
      try {
        await this.apiClient.deleteFile(oldRecord.cloudToken, oldRecord.cloudType);
        console.log(`[Flybook] 重命名：已删除旧路径云端文件 ${oldPath}`);
        this.addLog('delete', oldPath, `重命名为 ${newPath}，删除旧云端文件`);
      } catch (error) {
        console.warn(`[Flybook] 删除旧路径云端文件失败:`, error);
      }
      // 移除旧记录
      delete syncRecords[oldPath];
    }

    // 新文件会在下次同步时自动上传
    // 如果启用了自动同步，立即触发
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
    const record = syncRecords[filePath];

    if (record) {
      try {
        await this.apiClient.deleteFile(record.cloudToken, record.cloudType);
        console.log(`[Flybook] 已删除云端文件: ${filePath}`);
        this.addLog('delete', filePath, `本地文件已删除，同步删除云端文件`);
      } catch (error) {
        console.warn(`[Flybook] 删除云端文件失败:`, error);
        this.addLog('error', filePath, `删除云端文件失败: ${(error as Error).message}`);
      }
      delete syncRecords[filePath];
      await this.plugin.saveSyncRecords(syncRecords);
    }
  }

  /**
   * 从飞书下载文件到本地
   * 将飞书目标文件夹下的所有文件下载到本地同步文件夹
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
    this.addLog('info', '', '开始从飞书下载文件');

    try {
      await this.downloadFolder(targetFolderToken, localFolderPath, result);
    } catch (error) {
      result.failedCount++;
      result.errors.push(`下载失败: ${(error as Error).message}`);
      this.addLog('error', '', `下载失败: ${(error as Error).message}`);
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
      console.warn(`[Flybook] 列出文件夹内容失败:`, error);
      return;
    }

    console.log(`[Flybook][DEBUG] downloadFolder: folderToken=${folderToken}, 找到 ${files.length} 个项目`);
    for (const f of files) {
      console.log(`[Flybook][DEBUG]   - ${f.name} (type=${f.type}, token=${f.token})`);
    }

    for (const file of files) {
      if (file.type === 'folder') {
        // 递归下载子文件夹
        const subLocalPath = localPath ? `${localPath}/${file.name}` : file.name;
        // 确保本地子文件夹存在
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
        // 下载文件
        try {
          await this.downloadSingleFile(file, localPath, result);
        } catch (error) {
          const errMsg = (error as Error).message || '';
          // 权限不足导致的导出失败，给出明确提示而非标记为普通错误
          if (errMsg.includes('99991679') || errMsg.includes('drive:export:readonly') || errMsg.includes('docs:document:export')) {
            result.failedCount++;
            const skipMsg = `跳过在线文档 ${file.name}（导出权限不足，请在插件设置中重新点击"授权"按钮获取新权限。确保飞书开发者后台已开通 drive:export:readonly 和 docs:document:export 权限）`;
            result.errors.push(skipMsg);
            this.addLog('error', `${localPath}/${file.name}`, skipMsg);
            console.warn('[Flybook]', skipMsg);
            new Notice(`飞书导出权限不足，请重新授权`, 0);
          } else {
            result.failedCount++;
            const errorMsg = `下载文件 ${file.name} 失败: ${errMsg}`;
            result.errors.push(errorMsg);
            this.addLog('error', `${localPath}/${file.name}`, errMsg);
            console.error('[Flybook]', errorMsg);
          }
        }
      }
    }
  }

  /**
   * 根据文件类型确定下载后的本地文件名（添加扩展名）
   */
  private getLocalFileName(remoteName: string, remoteType: string): string {
    // 在线文档在飞书中的 name 通常不含扩展名，需要根据导出格式补上
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

    console.log(`[Flybook][DEBUG] downloadSingleFile: name=${remoteFile.name}, type=${remoteFile.type}, token=${remoteFile.token}, filePath=${filePath}`);

    // 检查本地是否已有该文件
    const localFile = this.vault.getAbstractFileByPath(filePath);
    if (localFile instanceof TFile) {
      // 比较哈希决定是否跳过
      const localContent = await this.vault.readBinary(localFile);
      const localHash = await computeHash(localContent);
      // 下载云端文件计算哈希
      const remoteContent = await this.apiClient.downloadFile(remoteFile.token, remoteFile.type);
      const remoteHash = await computeHash(remoteContent);

      if (localHash === remoteHash) {
        result.skippedCount++;
        this.addLog('skip', filePath, '本地与云端内容相同，跳过');
        return;
      }

      // 内容不同，覆盖本地
      await this.vault.modifyBinary(localFile, remoteContent);
      result.downloadedCount++;
      this.addLog('download', filePath, '本地文件已更新（覆盖）');
      console.log(`[Flybook] 文件已更新: ${filePath}`);
    } else {
      // 本地不存在，创建新文件
      const content = await this.apiClient.downloadFile(remoteFile.token, remoteFile.type);

      // 确保父文件夹存在
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
      console.log(`[Flybook] 新文件已下载: ${filePath}`);
    }
  }

  /**
   * 扫描本地文件夹，获取所有文件列表
   */
  private scanLocalFolder(folderPath: string): TFile[] {
    const files: TFile[] = [];
    const folder = this.vault.getFolderByPath(folderPath);
    if (!folder) {
      console.warn('[Flybook] 本地文件夹不存在:', folderPath);
      return files;
    }
    this.collectFiles(folder, files);
    return files;
  }

  /**
   * 递归收集文件夹中的所有文件
   */
  private collectFiles(folder: TFolder, files: TFile[]): void {
    for (const child of folder.children) {
      if (child instanceof TFile) {
        files.push(child);
      } else if (child instanceof TFolder) {
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
   * 验证 API 客户端是否已配置
   */
  isConfigured(): boolean {
    return this.plugin.settings.appId !== '' && this.plugin.settings.appSecret !== '';
  }
}
