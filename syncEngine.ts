/**
 * 同步引擎
 * 负责协调文件扫描、上传和飞书Drive操作
 * 支持增量同步：基于文件内容哈希跳过未修改文件
 */

import { Vault, TFile, TFolder } from 'obsidian';
import FlybookPlugin from './main';
import { FeishuApiClient } from './feishuApi';
import { Notice } from 'obsidian';

export interface SyncResult {
  success: boolean;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
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
 * @param content 文件内容（字符串或 ArrayBuffer）
 * @returns SHA-256 哈希的十六进制字符串
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
   * 执行一次完整同步（增量）
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      errors: [],
    };

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

    // 3. 扫描本地文件夹
    const localFiles = this.scanLocalFolder(localFolderPath);
    if (localFiles.length === 0) {
      new Notice('同步完成：没有需要同步的文件');
      return result;
    }

    // 4. 加载同步记录
    const syncRecords = await this.plugin.loadSyncRecords();

    // 5. 逐个处理文件
    new Notice(`开始同步 ${localFiles.length} 个文件...`);

    for (const localFile of localFiles) {
      try {
        const uploaded = await this.syncFile(localFile, localFolderPath, targetFolderToken, syncRecords);
        if (uploaded) {
          result.uploadedCount++;
        } else {
          result.skippedCount++;
        }
      } catch (error) {
        result.failedCount++;
        const errorMsg = `同步文件 ${localFile.path} 失败: ${(error as Error).message}`;
        result.errors.push(errorMsg);
        console.error('[Flybook]', errorMsg);
      }
    }

    // 6. 保存同步记录
    await this.plugin.saveSyncRecords(syncRecords);

    // 7. 汇总结果
    if (result.failedCount === 0) {
      result.success = true;
      const parts: string[] = [];
      if (result.uploadedCount > 0) parts.push(`上传 ${result.uploadedCount} 个`);
      if (result.skippedCount > 0) parts.push(`跳过 ${result.skippedCount} 个`);
      if (parts.length === 0) parts.push('无变化');
      new Notice(`同步完成！${parts.join('，')}`);
    } else {
      result.success = false;
      new Notice(`同步完成：成功 ${result.uploadedCount} 个，跳过 ${result.skippedCount} 个，失败 ${result.failedCount} 个`);
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
      console.log(`[Flybook] 文件已变化，重新上传: ${file.path} (旧哈希: ${existingRecord.hash.substring(0, 8)}..., 新哈希: ${currentHash.substring(0, 8)}...)`);
    } else {
      console.log(`[Flybook] 新文件，上传: ${file.path}`);
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

    // 检查文件大小
    if (!this.apiClient.checkFileSize(fileSize)) {
      throw new Error('文件大小超过20MB限制');
    }

    // 如果有同步记录，先删除云端旧文件
    if (existingRecord) {
      try {
        console.log(`[Flybook] 删除云端旧文件: ${existingRecord.cloudToken} (类型: ${existingRecord.cloudType})`);
        await this.apiClient.deleteFile(existingRecord.cloudToken, existingRecord.cloudType);
        console.log(`[Flybook] 旧文件已删除`);
      } catch (deleteError) {
        console.warn(`[Flybook] 删除旧文件失败，继续上传新版本:`, deleteError);
      }
    } else {
      // 没有同步记录（新文件），但云端可能存在同名文件（手动上传或记录丢失）
      // 尝试查找并删除
      try {
        const existingFile = await this.apiClient.findFileByName(file.name, parentFolderToken);
        if (existingFile) {
          console.log(`[Flybook] 云端存在同名文件但无同步记录，删除: ${existingFile.token}`);
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
      console.log('[Flybook] 找到已存在的文件夹:', defaultFolderName, existing.token);
      return existing.token;
    }

    console.log('[Flybook] 创建默认文件夹:', defaultFolderName);
    const newToken = await this.apiClient.createFolder(defaultFolderName, rootFolderToken);
    return newToken;
  }

  /**
   * 验证 API 客户端是否已配置
   */
  isConfigured(): boolean {
    return this.plugin.settings.appId !== '' && this.plugin.settings.appSecret !== '';
  }
}
