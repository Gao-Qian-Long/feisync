/**
 * 同步引擎
 * 负责协调文件扫描、上传和飞书Drive操作
 */

import { Vault, TFile, TFolder } from 'obsidian';
import FlybookPlugin from './main';
import { FeishuApiClient, FeishuFileMeta } from './feishuApi';
import { Notice } from 'obsidian';

export interface SyncResult {
  success: boolean;
  uploadedCount: number;
  failedCount: number;
  errors: string[];
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
   * 执行一次完整同步
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      uploadedCount: 0,
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
      // 尝试查找或创建默认的 ObsidianSync 文件夹
      targetFolderToken = await this.ensureDefaultFolder();
    }

    // 3. 扫描本地文件夹
    const localFiles = this.scanLocalFolder(localFolderPath);
    if (localFiles.length === 0) {
      new Notice('同步完成：没有需要同步的文件');
      return result;
    }

    // 4. 逐个上传文件
    new Notice(`开始同步 ${localFiles.length} 个文件...`);

    for (const localFile of localFiles) {
      try {
        await this.uploadFile(localFile, localFolderPath, targetFolderToken);
        result.uploadedCount++;
      } catch (error) {
        result.failedCount++;
        const errorMsg = `上传文件 ${localFile.path} 失败: ${(error as Error).message}`;
        result.errors.push(errorMsg);
        console.error('[Flybook]', errorMsg);
      }
    }

    // 5. 汇总结果
    if (result.failedCount === 0) {
      result.success = true;
      new Notice(`同步完成！成功上传 ${result.uploadedCount} 个文件`);
    } else {
      result.success = false;
      new Notice(`同步完成：成功 ${result.uploadedCount} 个，失败 ${result.failedCount} 个`);
    }

    return result;
  }

  /**
   * 扫描本地文件夹，获取所有文件列表
   */
  private scanLocalFolder(folderPath: string): TFile[] {
    const files: TFile[] = [];

    // 获取文件夹对象
    const folder = this.vault.getFolderByPath(folderPath);
    if (!folder) {
      console.warn('[Flybook] 本地文件夹不存在:', folderPath);
      return files;
    }

    // 递归收集所有文件
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
   * 上传单个文件到飞书
   */
  private async uploadFile(file: TFile, localFolderPath: string, targetFolderToken: string): Promise<void> {
    // 计算相对于监控文件夹的路径
    const relativePath = file.path;
    const pathParts = relativePath.split('/');

    // 如果文件直接在监控文件夹根目录，则没有子路径
    if (pathParts.length === 1) {
      // 文件在根目录，直接上传到目标文件夹
      await this.uploadSingleFile(file, targetFolderToken);
    } else {
      // 文件在子文件夹中，需要创建对应的子文件夹结构
      const subPath = pathParts.slice(1, -1).join('/'); // 去掉文件名和第一个路径（监控文件夹名）
      const folderToken = await this.apiClient.ensureFolderPath(subPath, targetFolderToken);
      await this.uploadSingleFile(file, folderToken);
    }
  }

  /**
   * 上传单个文件（不处理子文件夹）
   */
  private async uploadSingleFile(file: TFile, parentFolderToken: string): Promise<void> {
    // 读取文件内容
    const content = await this.vault.readBinary(file);

    // 检查文件大小
    if (!this.apiClient.checkFileSize(content.byteLength)) {
      throw new Error(`文件大小超过20MB限制`);
    }

    // 检查是否已存在同名文件
    const existingFile = await this.apiClient.findFileByName(file.name, parentFolderToken);
    if (existingFile) {
      console.log(`[Flybook] 文件已存在，将执行覆盖: ${file.name}`);
      await this.apiClient.deleteFile(existingFile.token);
    }

    // 上传文件
    await this.apiClient.uploadFile(
      content,
      file.name,
      parentFolderToken,
      content.byteLength
    );

    console.log('[Flybook] 上传成功:', file.name);
  }

  /**
   * 确保存在默认的 ObsidianSync 文件夹
   */
  private async ensureDefaultFolder(): Promise<string> {
    const defaultFolderName = 'ObsidianSync';
    const rootFolderToken = ''; // 空表示根目录

    // 尝试查找是否已存在
    const existing = await this.apiClient.findFolderByName(defaultFolderName, rootFolderToken);
    if (existing) {
      console.log('[Flybook] 找到已存在的文件夹:', defaultFolderName, existing.token);
      return existing.token;
    }

    // 不存在则创建
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