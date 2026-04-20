/**
 * 飞书 Drive API 封装模块
 * 负责文件夹管理和文件上传
 */

import { FeishuAuthManager } from './feishuAuth';

const FEISHU_DRIVE_API_BASE = 'https://open.feishu.cn/open-apis/drive/v1';
const FEISHU_DOC_API_BASE = 'https://open.feishu.cn/open-apis/doc/v1';

// 请求超时时间（毫秒）
const REQUEST_TIMEOUT = 30000;

// 文件夹/文件元数据结构
export interface FeishuFileMeta {
  token: string;
  name: string;
  type: 'file' | 'folder' | 'docx' | 'sheet' | string;
  parentToken?: string;
  size?: number;
  createdTime?: number;
  modifiedTime?: number;
}

// API 响应基础结构
interface FeishuApiResponse<T = any> {
  code: number;
  msg: string;
  data?: T;
}

/**
 * 飞书 Drive API 封装类
 */
export class FeishuApiClient {
  private authManager: FeishuAuthManager;

  constructor(authManager: FeishuAuthManager) {
    this.authManager = authManager;
  }

  /**
   * 获取认证头
   */
  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.authManager.getAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * 带超时的 fetch 请求
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number = REQUEST_TIMEOUT
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 确保目标文件夹存在，如果不存在则创建
   * @param folderPath 本地相对路径（例如 'Notes/Projects'）
   * @param rootFolderToken 飞书根文件夹token（如果为空，则使用默认根）
   * @returns 最深层文件夹的 token
   */
  async ensureFolderPath(folderPath: string, rootFolderToken?: string): Promise<string> {
    if (!folderPath || folderPath.trim() === '') {
      return rootFolderToken || '';
    }

    const parts = folderPath.split('/').filter(p => p.trim() !== '');
    let currentToken = rootFolderToken || '';

    for (const part of parts) {
      currentToken = await this.findOrCreateFolder(part, currentToken);
    }

    return currentToken;
  }

  /**
   * 在父文件夹下查找或创建子文件夹
   */
  private async findOrCreateFolder(folderName: string, parentToken: string): Promise<string> {
    // 先尝试查找是否已存在
    const existing = await this.findFolderByName(folderName, parentToken);
    if (existing) {
      return existing.token;
    }

    // 不存在则创建
    return await this.createFolder(folderName, parentToken);
  }

  /**
   * 根据名称和父token查找文件夹
   */
  async findFolderByName(folderName: string, parentToken: string): Promise<FeishuFileMeta | null> {
    try {
      // 列出父文件夹内容
      const files = await this.listFolderContents(parentToken);
      return files.find(f => f.name === folderName && f.type === 'folder') || null;
    } catch (error) {
      console.error('[Flybook] 查找文件夹失败:', error);
      return null;
    }
  }

  /**
   * 列出文件夹内容
   */
  async listFolderContents(folderToken: string): Promise<FeishuFileMeta[]> {
    try {
      // 如果 folderToken 为空，则获取根目录列表
      const endpoint = folderToken
        ? `${FEISHU_DRIVE_API_BASE}/files/${folderToken}/children`
        : `${FEISHU_DRIVE_API_BASE}/files`;

      const headers = await this.getHeaders();
      const response = await this.fetchWithTimeout(endpoint, {
        method: 'GET',
        headers,
      });

      const data: FeishuApiResponse = await response.json();
      if (data.code !== 0) {
        throw new Error(`API 错误: ${data.msg}`);
      }

      // 解析响应数据（根据实际 API 响应格式调整）
      const files = data.data?.files || [];
      return files.map((f: any) => ({
        token: f.token || f.file_token,
        name: f.name,
        type: f.type || (f.mime_type?.includes('folder') ? 'folder' : 'file'),
        parentToken: folderToken,
        size: f.size,
        createdTime: f.created_time ? parseInt(f.created_time) : undefined,
        modifiedTime: f.updated_time ? parseInt(f.updated_time) : undefined,
      }));
    } catch (error) {
      console.error('[Flybook] 列出文件夹内容失败:', error);
      throw error;
    }
  }

  /**
   * 创建文件夹
   * 飞书创建文件夹的 API 端点：POST /drive/v1/files/create_folder
   */
  async createFolder(folderName: string, parentToken: string): Promise<string> {
    // 输入校验
    if (!folderName || folderName.trim() === '') {
      throw new Error('文件夹名称不能为空');
    }

    try {
      const headers = await this.getHeaders();
      // 飞书创建文件夹的 API 端点：POST /drive/v1/files/create_folder
      const endpoint = `${FEISHU_DRIVE_API_BASE}/files/create_folder`;

      const body: any = {
        name: folderName,
        folder_type: 'doc',
      };

      if (parentToken) {
        body.parent_token = parentToken;
      }

      const response = await this.fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data: FeishuApiResponse<{ file_token: string }> = await response.json();
      if (data.code !== 0) {
        throw new Error(`创建文件夹失败: ${data.msg}`);
      }

      return data.data?.file_token || '';
    } catch (error) {
      console.error('[Flybook] 创建文件夹失败:', error);
      throw error;
    }
  }

  /**
   * 上传文件到指定文件夹
   * @param fileContent 文件内容（ArrayBuffer 或 Uint8Array）
   * @param fileName 文件名
   * @param parentFolderToken 父文件夹 token
   * @param size 文件大小（字节）
   * @returns 上传文件的 token
   */
  async uploadFile(
    fileContent: ArrayBuffer | Uint8Array,
    fileName: string,
    parentFolderToken: string,
    size: number
  ): Promise<string> {
    // 输入校验
    if (!fileContent || fileContent.byteLength === 0) {
      throw new Error('文件内容不能为空');
    }
    if (!fileName || fileName.trim() === '') {
      throw new Error('文件名不能为空');
    }
    if (typeof size !== 'number' || size <= 0) {
      throw new Error('文件大小无效');
    }

    try {
      const token = await this.authManager.getAccessToken();

      // 构建 FormData
      const formData = new FormData();
      formData.append('file_name', fileName);
      formData.append('parent_type', 'folder'); // 上传到文件夹
      formData.append('parent_node', parentFolderToken);
      formData.append('size', size.toString());

      // 创建 Blob
      const blob = new Blob([fileContent]);
      formData.append('file', blob, fileName);

      const response = await this.fetchWithTimeout(
        `${FEISHU_DRIVE_API_BASE}/medias/upload_all`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          body: formData,
        },
        60000 // 上传文件使用更长超时（60秒）
      );

      const data: FeishuApiResponse<{ file_token: string }> = await response.json();
      if (data.code !== 0) {
        throw new Error(`上传文件失败: ${data.msg}`);
      }

      return data.data?.file_token || '';
    } catch (error) {
      console.error('[Flybook] 上传文件失败:', error);
      throw error;
    }
  }

  /**
   * 删除文件
   */
  async deleteFile(fileToken: string): Promise<void> {
    // 输入校验
    if (!fileToken || fileToken.trim() === '') {
      throw new Error('文件 token 不能为空');
    }

    try {
      const headers = await this.getHeaders();
      const endpoint = `${FEISHU_DRIVE_API_BASE}/files/${fileToken}`;

      const response = await this.fetchWithTimeout(endpoint, {
        method: 'DELETE',
        headers,
      });

      const data: FeishuApiResponse = await response.json();
      if (data.code !== 0) {
        throw new Error(`删除文件失败: ${data.msg}`);
      }
    } catch (error) {
      console.error('[Flybook] 删除文件失败:', error);
      throw error;
    }
  }

  /**
   * 查找文件（根据名称和父文件夹）
   */
  async findFileByName(fileName: string, parentToken: string): Promise<FeishuFileMeta | null> {
    try {
      const files = await this.listFolderContents(parentToken);
      return files.find(f => f.name === fileName && f.type === 'file') || null;
    } catch (error) {
      console.error('[Flybook] 查找文件失败:', error);
      return null;
    }
  }

  /**
   * 检查文件大小是否在限制范围内
   */
  checkFileSize(sizeInBytes: number): boolean {
    const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
    return sizeInBytes <= MAX_SIZE;
  }
}