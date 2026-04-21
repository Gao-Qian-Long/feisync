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
   * 使用飞书文档导入方式同步 Markdown 文件
   */
  private async uploadSingleFile(file: TFile, parentFolderToken: string): Promise<void> {
    // 判断是否为二进制文件格式
    const binaryExtensions = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'zip', 'rar'];
    const ext = file.extension.toLowerCase();
    const isBinaryFile = binaryExtensions.indexOf(ext) !== -1;

    // 读取文件内容
    // 二进制文件使用 readBinary()，文本文件使用 read()
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

    // 检查文件大小
    const fileSize = content instanceof ArrayBuffer ? content.byteLength : (content as string).length;
    if (!this.apiClient.checkFileSize(fileSize)) {
      throw new Error(`文件大小超过20MB限制`);
    }

    // 使用导入方式创建飞书文档
    // 文件名作为文档标题，保持扩展名便于识别类型
    const documentTitle = file.name;

    console.log(`[Flybook] 开始导入文件到飞书文档: ${documentTitle}`);

    try {
      // 使用 importFileAsDocument 方法导入文件
      const docToken = await this.apiClient.importFileAsDocument(
        content,
        file.name,
        parentFolderToken
      );

      console.log(`[Flybook] 文档导入成功，token: ${docToken}`);

      // 如果有目标文件夹，将导入的文档移动到目标文件夹
      if (parentFolderToken) {
        try {
          console.log(`[Flybook] 准备移动文档 ${docToken} 到文件夹 ${parentFolderToken}`);
          await this.apiClient.moveFile(docToken, 'docx', parentFolderToken);
          console.log(`[Flybook] 文档已移动到目标文件夹: ${parentFolderToken}`);
        } catch (moveError) {
          console.warn(`[Flybook] 移动文档到目标文件夹失败:`, moveError);
          // 不抛出错误，因为导入本身已经成功了
        }
      }

    } catch (error) {
      console.error(`[Flybook] 导入文件 ${file.name} 失败:`, error);
      throw error;
    }
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