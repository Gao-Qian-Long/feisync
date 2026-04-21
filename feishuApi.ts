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
  private proxyUrl: string; // 代理服务器地址，留空则直连

  constructor(authManager: FeishuAuthManager, proxyUrl: string = '') {
    this.authManager = authManager;
    this.proxyUrl = proxyUrl;
  }

  /**
   * 更新代理配置
   */
  updateProxyUrl(proxyUrl: string): void {
    this.proxyUrl = proxyUrl;
  }

  /**
   * 获取完整的 API URL（如果配置了代理则使用代理）
   */
  private getApiUrl(path: string): string {
    // 如果配置了代理，使用代理地址
    if (this.proxyUrl) {
      // 移除代理 URL 末尾的斜杠，确保 path 以 / 开头
      const baseUrl = this.proxyUrl.replace(/\/$/, '');
      const apiPath = path.startsWith('/') ? path : '/' + path;
      return `${baseUrl}${apiPath}`;
    }
    // 否则使用飞书直连地址
    return `https://open.feishu.cn${path}`;
  }

  /**
   * 获取认证头
   * 优先使用 user_access_token（如果已授权），否则使用 tenant_access_token
   */
  private async getHeaders(): Promise<Record<string, string>> {
    let token: string;
    
    // 优先使用用户令牌（如果已授权）
    if (this.authManager.isUserAuthorized()) {
      try {
        token = await this.authManager.getUserAccessToken();
        console.log('[Flybook] 使用 user_access_token');
      } catch (error) {
        // 如果获取用户令牌失败，回退到 tenant token
        console.warn('[Flybook] 获取 user_access_token 失败，回退到 tenant_access_token:', error);
        token = await this.authManager.getAccessToken();
      }
    } else {
      token = await this.authManager.getAccessToken();
      console.log('[Flybook] 使用 tenant_access_token');
    }
    
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * 带超时的 fetch 请求
   * @returns 解析后的 JSON 数据
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number = REQUEST_TIMEOUT
  ): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      // 读取响应文本
      const responseText = await response.text();

      // 检查 HTTP 状态
      if (!response.ok) {
        // 尝试解析错误响应
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errorData = JSON.parse(responseText);
          // 包含完整的错误详情
          errorMsg = `HTTP ${response.status}: ${JSON.stringify(errorData)}`;
          console.error('[Flybook] API 错误详情:', errorData);
        } catch {
          errorMsg = `HTTP ${response.status}: ${responseText.substring(0, 500)}`;
          console.error('[Flybook] API 错误原始响应:', responseText);
        }
        throw new Error(errorMsg);
      }

      // 解析 JSON
      try {
        return JSON.parse(responseText);
      } catch (parseError) {
        throw new Error(`JSON 解析失败: ${responseText.substring(0, 200)}`);
      }
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
      // 调试日志：打印查找条件
      console.log('[Flybook] 查找文件夹:', { folderName, parentToken, totalFiles: files.length });
      const found = files.find(f => f.name === folderName && f.type === 'folder');
      if (found) {
        console.log('[Flybook] 找到匹配文件夹:', found);
      } else {
        // 打印所有文件夹，便于调试
        const allFolders = files.filter(f => f.type === 'folder');
        console.log('[Flybook] 所有文件夹:', allFolders);
      }
      return found || null;
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
      // 使用 folder_token 查询参数，根据飞书官方文档
      const path = folderToken
        ? `/open-apis/drive/v1/files?folder_token=${folderToken}`
        : '/open-apis/drive/v1/files';
      const endpoint = this.getApiUrl(path);

      const headers = await this.getHeaders();
      const data = await this.fetchWithTimeout(endpoint, {
        method: 'GET',
        headers,
      });

      if (data.code !== 0) {
        throw new Error(`API 错误: ${data.msg}`);
      }

      // 调试日志：打印 API 响应
      console.log('[Flybook] 列出文件夹内容 API 响应:', JSON.stringify(data.data, null, 2));

      // 解析响应数据（根据实际 API 响应格式调整）
      const files = data.data?.files || [];
      return files.map((f: any) => {
        // 调试日志：打印每个文件的类型信息
        console.log('[Flybook] 文件信息:', { name: f.name, type: f.type, mime_type: f.mime_type });
        return {
          token: f.token || f.file_token,
          name: f.name,
          type: f.type || (f.mime_type?.includes('folder') ? 'folder' : 'file'),
          parentToken: folderToken,
          size: f.size,
          createdTime: f.created_time ? parseInt(f.created_time) : undefined,
          modifiedTime: f.updated_time ? parseInt(f.updated_time) : undefined,
        };
      });
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
      const endpoint = this.getApiUrl('/open-apis/drive/v1/files/create_folder');

      const body: any = {
        name: folderName,
        folder_token: parentToken || '', // 飞书 API 要求 folder_token，为空字符串表示根目录
      };

      const data = await this.fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

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
      formData.append('parent_type', 'explorer'); // 上传到云空间
      formData.append('parent_node', parentFolderToken);
      formData.append('size', size.toString());

      // 创建 Blob
      const blob = new Blob([fileContent]);
      formData.append('file', blob, fileName);

      const data = await this.fetchWithTimeout(
        this.getApiUrl('/open-apis/drive/v1/medias/upload_all'),
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          body: formData,
        },
        60000 // 上传文件使用更长超时（60秒）
      );

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
   * @param fileToken 文件的 token
   * @param fileType 文件类型（如 'file', 'folder', 'docx' 等）
   */
  async deleteFile(fileToken: string, fileType: string = 'file'): Promise<void> {
    // 输入校验
    if (!fileToken || fileToken.trim() === '') {
      throw new Error('文件 token 不能为空');
    }

    try {
      const headers = await this.getHeaders();
      // 飞书删除文件 API 需要 type 查询参数
      const endpoint = this.getApiUrl(`/open-apis/drive/v1/files/${fileToken}?type=${fileType}`);

      console.log(`[Flybook] 删除文件: ${fileToken}, 类型: ${fileType}`);

      const data = await this.fetchWithTimeout(endpoint, {
        method: 'DELETE',
        headers,
      });

      if (data.code !== 0) {
        throw new Error(`删除文件失败: ${data.msg}`);
      }
      
      console.log(`[Flybook] 文件删除成功`);
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
      
      // 去掉本地文件名的扩展名（飞书文档名称通常不带扩展名）
      const localNameWithoutExt = fileName.replace(/\.[^.]+$/, '');
      
      // 优先精确匹配，其次匹配不带扩展名的版本
      return files.find(f => 
        (f.name === fileName || f.name === localNameWithoutExt) && 
        (f.type === 'file' || f.type === 'docx' || f.type === 'sheet')
      ) || null;
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

  /**
   * 创建飞书文档
   * @param title 文档标题
   * @param folderToken 目标文件夹 token，为空则创建在根目录
   * @returns 新建文档的 token
   */
  async createDocument(title: string, folderToken: string = ''): Promise<string> {
    if (!title || title.trim() === '') {
      throw new Error('文档标题不能为空');
    }

    try {
      const headers = await this.getHeaders();
      const endpoint = this.getApiUrl('/open-apis/doc/v2/create');

      // 构建文档结构：创建一个带有标题的空文档
      const content = {
        title: {
          elements: [{
            type: 'textRun',
            textRun: {
              text: title,
              style: {}
            }
          }],
          style: {}
        },
        body: {
          blocks: []
        }
      };

      const body: any = {
        FolderToken: folderToken,
        Content: JSON.stringify(content)
      };

      const data = await this.fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (data.code !== 0) {
        throw new Error(`创建文档失败: ${data.msg}`);
      }

      return data.data?.doc_id || data.data?.token || '';
    } catch (error) {
      console.error('[Flybook] 创建文档失败:', error);
      throw error;
    }
  }

  /**
   * 批量插入文档内容块
   * @param docToken 文档 token
   * @param blocks 要插入的 blocks 数组
   * @param parentBlockId 父块的 ID（通常是文档的根块 ID），默认为文档 token
   */
  async insertDocumentBlocks(docToken: string, blocks: any[], parentBlockId?: string): Promise<void> {
    if (!docToken || docToken.trim() === '') {
      throw new Error('文档 token 不能为空');
    }
    if (!blocks || blocks.length === 0) {
      return;
    }

    try {
      const headers = await this.getHeaders();
      // 正确的 API 路径：POST /open-apis/docx/v1/documents/:document_id/blocks/:block_id/children
      // 如果没有指定 parentBlockId，使用文档 token 作为父块 ID（在文档根节点下创建）
      const blockId = parentBlockId || docToken;
      const endpoint = this.getApiUrl(`/open-apis/docx/v1/documents/${docToken}/blocks/${blockId}/children`);

      // 正确的请求体格式：使用 children 数组和 index 参数
      const body = {
        index: -1,  // -1 表示在末尾插入
        children: blocks
      };

      console.log(`[Flybook] 插入块请求到: ${endpoint}`);
      console.log(`[Flybook] 插入 ${blocks.length} 个块`);

      const data = await this.fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (data.code !== 0) {
        throw new Error(`插入文档内容失败: ${data.msg}`);
      }
    } catch (error) {
      console.error('[Flybook] 插入文档内容失败:', error);
      throw error;
    }
  }

  /**
   * 获取文档所有块
   * @param docToken 文档 token
   * @returns 文档块数组
   */
  async getDocumentBlocks(docToken: string): Promise<any[]> {
    try {
      const headers = await this.getHeaders();
      const endpoint = this.getApiUrl(`/open-apis/docx/v1/documents/${docToken}/blocks?page_size=500`);
      
      const data = await this.fetchWithTimeout(endpoint, {
        method: 'GET',
        headers,
      });
      
      if (data.code !== 0) {
        throw new Error(`获取文档块失败: ${data.msg}`);
      }
      
      // 调试：打印返回的数据结构
      console.log('[Flybook] 获取文档块 API 响应:', JSON.stringify(data.data, null, 2));
      
      return data.data?.items || [];
    } catch (error) {
      console.error('[Flybook] 获取文档块失败:', error);
      throw error;
    }
  }

  /**
   * 删除文档中指定父块的所有子块
   * @param docToken 文档 token
   * @param parentBlockId 父块的 ID（通常是文档的根块 ID）
   * @param childrenCount 子块数量（用于设置正确的 end_index）
   */
  async deleteDocumentBlocks(docToken: string, parentBlockId: string, childrenCount: number = 1): Promise<void> {
    if (!parentBlockId) {
      console.warn('[Flybook] 父块 ID 为空，跳过删除');
      return;
    }
    
    try {
      // 使用正确的 Content-Type
      const headers = await this.getHeaders();
      headers['Content-Type'] = 'application/json; charset=utf-8';
      
      // 正确的 API 路径：DELETE /open-apis/docx/v1/documents/:document_id/blocks/:block_id/children/batch_delete
      const endpoint = this.getApiUrl(`/open-apis/docx/v1/documents/${docToken}/blocks/${parentBlockId}/children/batch_delete`);
      
      // 飞书 API 使用 start_index 和 end_index 来指定删除范围（左闭右开）
      // 要删除所有子块，end_index 应该等于子块数量
      const body = {
        start_index: 0,
        end_index: childrenCount,  // 使用实际的子块数量
      };
      
      console.log(`[Flybook] 发送删除请求到: ${endpoint}`);
      console.log(`[Flybook] 删除参数: start_index=0, end_index=${childrenCount}`);
      
      const data = await this.fetchWithTimeout(endpoint, {
        method: 'DELETE',
        headers,
        body: JSON.stringify(body),
      });
      
      if (data.code !== 0) {
        throw new Error(`删除文档块失败: ${data.msg}`);
      }
      
      console.log('[Flybook] 删除文档块成功');
    } catch (error) {
      console.error('[Flybook] 删除文档块失败:', error);
      throw error;
    }
  }

  /**
   * 更新文档内容（先清空再插入新内容）
   * @param docToken 文档 token
   * @param blocks 新的文档块数组
   */
  async updateDocumentContent(docToken: string, blocks: any[]): Promise<void> {
    try {
      // 1. 获取文档现有块
      console.log(`[Flybook] 获取文档 ${docToken} 现有块...`);
      const existingBlocks = await this.getDocumentBlocks(docToken);
      
      // 2. 找到文档的根块（page 类型，block_type=1）
      // 根据飞书 API，block_type=1 是 page 类型，是文档的根块
      const rootBlock = existingBlocks.find(block => block.block_type === 1);
      
      if (!rootBlock) {
        console.warn('[Flybook] 未找到文档根块，尝试直接插入新内容');
        if (blocks && blocks.length > 0) {
          await this.insertDocumentBlocks(docToken, blocks);
        }
        return;
      }
      
      console.log(`[Flybook] 文档根块 ID: ${rootBlock.block_id}, 类型: ${rootBlock.block_type}, 子块数量: ${rootBlock.children?.length || 0}`);
      
      // 3. 如果有子块，删除它们
      const childrenCount = rootBlock.children?.length || 0;
      if (childrenCount > 0) {
        console.log(`[Flybook] 删除文档 ${childrenCount} 个现有内容块...`);
        await this.deleteDocumentBlocks(docToken, rootBlock.block_id, childrenCount);
      } else {
        console.log('[Flybook] 文档没有现有内容块，跳过删除');
      }
      
      // 4. 插入新内容（使用文档根块 ID 作为父块 ID）
      if (blocks && blocks.length > 0) {
        console.log(`[Flybook] 插入 ${blocks.length} 个新块到根块 ${rootBlock.block_id}...`);
        await this.insertDocumentBlocks(docToken, blocks, rootBlock.block_id);
      }
      
      console.log(`[Flybook] 文档 ${docToken} 内容更新完成`);
    } catch (error) {
      console.error('[Flybook] 更新文档内容失败:', error);
      throw error;
    }
  }

  /**
   * 将 Markdown 文本转换为飞书文档 blocks
   * @param markdownContent Markdown 格式的文本内容
   * @returns 飞书文档 blocks 数组
   */
  markdownToBlocks(markdownContent: string): any[] {
    const blocks: any[] = [];
    const lines = markdownContent.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();

      // 空行创建空段落
      if (trimmedLine === '') {
        blocks.push({
          type: 'paragraph',
          paragraph: {
            elements: [],
            style: {}
          }
        });
        continue;
      }

      // 标题处理
      if (trimmedLine.startsWith('# ')) {
        blocks.push({
          type: 'heading1',
          heading1: {
            elements: [{
              type: 'textRun',
              textRun: {
                text: trimmedLine.substring(2),
                style: {}
              }
            }],
            style: {}
          }
        });
        continue;
      }

      if (trimmedLine.startsWith('## ')) {
        blocks.push({
          type: 'heading2',
          heading2: {
            elements: [{
              type: 'textRun',
              textRun: {
                text: trimmedLine.substring(3),
                style: {}
              }
            }],
            style: {}
          }
        });
        continue;
      }

      if (trimmedLine.startsWith('### ')) {
        blocks.push({
          type: 'heading3',
          heading3: {
            elements: [{
              type: 'textRun',
              textRun: {
                text: trimmedLine.substring(4),
                style: {}
              }
            }],
            style: {}
          }
        });
        continue;
      }

      // 无序列表
      if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
        blocks.push({
          type: 'bullet',
          bullet: {
            elements: [{
              type: 'textRun',
              textRun: {
                text: trimmedLine.substring(2),
                style: {}
              }
            }],
            style: {
              indentLevel: 0
            }
          }
        });
        continue;
      }

      // 有序列表
      const orderedListMatch = trimmedLine.match(/^(\d+)\.\s+(.*)$/);
      if (orderedListMatch) {
        blocks.push({
          type: 'ordered',
          ordered: {
            elements: [{
              type: 'textRun',
              textRun: {
                text: orderedListMatch[2],
                style: {}
              }
            }],
            style: {
              indentLevel: 0
            }
          }
        });
        continue;
      }

      // 代码块（简化处理）
      if (trimmedLine.startsWith('```')) {
        // 跳过代码块标记，实际实现需要配对处理
        continue;
      }

      // 默认作为段落处理
      blocks.push({
        type: 'paragraph',
        paragraph: {
          elements: [{
            type: 'textRun',
            textRun: {
              text: trimmedLine,
              style: {}
            }
          }],
          style: {}
        }
      });
    }

    return blocks;
  }

  /**
   * 通过导入方式创建文档（将 Markdown 作为飞书文档导入）
   * @param fileContent 文件内容（字符串）
   * @param fileName 文件名（包含扩展名）
   * @param parentFolderToken 目标文件夹 token，为空则上传到根目录
   * @returns 导入后创建的文档 token
   */
  async importFileAsDocument(
    fileContent: string | ArrayBuffer | Uint8Array,
    fileName: string,
    parentFolderToken: string = ''
  ): Promise<string> {
    // 检查内容是否为空
    const isEmpty = fileContent instanceof ArrayBuffer || fileContent instanceof Uint8Array
      ? fileContent.byteLength === 0
      : !fileContent || (typeof fileContent === 'string' && fileContent.length === 0);
    if (isEmpty) {
      throw new Error('文件内容不能为空');
    }
    if (!fileName || fileName.trim() === '') {
      throw new Error('文件名不能为空');
    }

    try {
      // 优先使用 user_access_token（如果已授权）
      let token: string;
      if (this.authManager.isUserAuthorized()) {
        try {
          token = await this.authManager.getUserAccessToken();
          console.log('[Flybook] 上传文件使用 user_access_token');
        } catch (error) {
          console.warn('[Flybook] 获取 user_access_token 失败，回退到 tenant_access_token');
          token = await this.authManager.getAccessToken();
        }
      } else {
        token = await this.authManager.getAccessToken();
        console.log('[Flybook] 上传文件使用 tenant_access_token');
      }

      // 确定文件扩展名
      // 原始扩展名用于导入任务API的file_extension校验
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      // 直接使用原始扩展名，让飞书API内部处理转换
      // 注意：飞书导入API的file_extension需要与实际上传文件名后缀一致
      const fileExtension = ext;

      // 步骤1：上传文件获取 file_token
      const formData = new FormData();
      formData.append('file_name', fileName);
      formData.append('parent_type', 'ccm_import_open');
      // 根据飞书文档，导入任务不需要 parent_node
      formData.append('parent_node', '');
      // 计算文件大小（支持 string, ArrayBuffer, Uint8Array）
      const fileSize = fileContent instanceof ArrayBuffer 
        ? fileContent.byteLength 
        : fileContent instanceof Uint8Array 
          ? fileContent.length 
          : new Blob([fileContent]).size;
      formData.append('size', fileSize.toString());
      // extra 参数指定文件扩展名和目标格式
      const extraParams = {
        obj_type: 'docx',
        file_extension: fileExtension
      };
      formData.append('extra', JSON.stringify(extraParams));

      // 调试日志：打印上传参数
      console.log('[Flybook] 上传文件参数:', {
        file_name: fileName,
        parent_type: 'ccm_import_open',
        size: fileSize,
        extra: extraParams,
        fileExtension: fileExtension
      });

      // 根据文件扩展名设置正确的 MIME 类型
      const mimeTypes: Record<string, string> = {
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc': 'application/msword',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls': 'application/vnd.ms-excel',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'pdf': 'application/pdf',
        'txt': 'text/plain',
        'md': 'text/markdown',
        'markdown': 'text/markdown',
      };
      const mimeType = mimeTypes[fileExtension] || 'application/octet-stream';
      
      // 将内容作为文件添加
      const blob = new Blob([fileContent], { type: mimeType });
      formData.append('file', blob, fileName);

      const uploadData = await this.fetchWithTimeout(
        this.getApiUrl('/open-apis/drive/v1/medias/upload_all'),
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          body: formData,
        },
        60000 // 上传使用更长超时
      );

      if (uploadData.code !== 0) {
        throw new Error(`上传文件失败: ${uploadData.msg}`);
      }

      const fileToken = uploadData.data?.file_token;
      if (!fileToken) {
        throw new Error('上传文件成功但未返回 file_token');
      }

      console.log('[Flybook] 文件上传成功，file_token:', fileToken);

      // 步骤2：创建导入任务（传入目标文件夹token）
      const ticket = await this.createImportTask(
        fileToken,
        fileExtension,
        'docx', // 目标格式为 docx（飞书文档）
        fileName,
        parentFolderToken || undefined
      );

      console.log('[Flybook] 导入任务创建成功，ticket:', ticket);

      // 步骤3：等待导入完成（轮询）
      const docToken = await this.pollImportTask(ticket);
      return docToken;
    } catch (error) {
      console.error('[Flybook] 导入文件失败:', error);
      throw error;
    }
  }

  /**
   * 创建导入任务
   * @param fileToken 上传文件的 token
   * @param fileExtension 文件扩展名（如 'md', 'txt'）
   * @param type 目标云文档格式（'docx', 'sheet', 'bitable'）
   * @param fileName 导入后的文档名称（可选）
   * @param folderToken 目标文件夹 token（可选，用于指定导入位置）
   * @returns 导入任务 ID (ticket)
   */
  private async createImportTask(
    fileToken: string,
    fileExtension: string,
    type: string = 'docx',
    fileName?: string,
    folderToken?: string
  ): Promise<string> {
    if (!fileToken || fileToken.trim() === '') {
      throw new Error('file_token 不能为空');
    }
    
    const headers = await this.getHeaders();
    const endpoint = this.getApiUrl('/open-apis/drive/v1/import_tasks');

    // 构建请求体（根据飞书官方 API 文档格式）
    // 参考：https://go.feishu.cn/s/63UU36xkU01
    const body: Record<string, any> = {
      file_extension: fileExtension,
      file_token: fileToken,
      type: type,  // 目标类型，如 'docx', 'sheet'
    };

    // 如果有文件名则添加（可选）
    if (fileName) {
      body.name = fileName;
    }

    // 如果提供了目标文件夹，添加 point 字段
    // mount_type: 1 表示云文档（挂载到文件夹）
    // mount_key: 文件夹 token
    // 注意：需要应用对该文件夹有编辑权限，否则会报 mount_no_permission
    if (folderToken && folderToken.trim() !== '') {
      body.point = {
        mount_type: 1,  // 1 表示云文档
        mount_key: folderToken
      };
      // 同时确保有 name 字段
      if (!body.name) {
        body.name = 'Untitled';
      }
    }

    // 调试日志：打印实际发送的请求
    console.log('[Flybook] 创建导入任务，请求体:', JSON.stringify(body, null, 2));

    const data = await this.fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // 调试日志：打印响应
    console.log('[Flybook] 创建导入任务响应:', JSON.stringify(data, null, 2));

    if (data.code !== 0) {
      throw new Error(`创建导入任务失败: ${data.msg}`);
    }

    // 根据飞书 API 文档，返回的 data.ticket 是导入任务 ID
    const ticket = data.data?.ticket || data.data?.result?.ticket;
    if (!ticket) {
      throw new Error('创建导入任务成功但未返回 ticket');
    }

    return ticket;
  }

  /**
   * 轮询导入任务状态
   * @param ticket 导入任务 ID
   * @returns 导入完成的文档 token
   */
  private async pollImportTask(ticket: string, maxAttempts: number = 30): Promise<string> {
    const headers = await this.getHeaders();

    for (let i = 0; i < maxAttempts; i++) {
      const data = await this.fetchWithTimeout(
        this.getApiUrl(`/open-apis/drive/v1/import_tasks/${ticket}`),
        {
          method: 'GET',
          headers,
        }
      );

      if (data.code !== 0) {
        throw new Error(`查询导入任务失败: ${data.msg}`);
      }

      const result = data.data?.result;
      if (!result) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      const jobStatus = result.job_status;
      if (jobStatus === 0) {
        // 导入成功
        return result.token;
      } else if (jobStatus === 1 || jobStatus === 2) {
        // 进行中，等待后重试
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      } else {
        // 导入失败
        throw new Error(`导入失败: ${result.job_error_msg || '未知错误'} (status: ${jobStatus})`);
      }
    }

    throw new Error('导入任务超时');
  }

  /**
   * 将文档移动到指定文件夹
   * @param fileToken 文档 token
   * @param fileType 文件类型（如 'docx'）
   * @param folderToken 目标文件夹 token
   */
  async moveFile(fileToken: string, fileType: string, folderToken: string): Promise<void> {
    if (!fileToken || fileToken.trim() === '') {
      throw new Error('文件 token 不能为空');
    }
    if (!folderToken || folderToken.trim() === '') {
      // 如果目标文件夹为空，不执行移动
      return;
    }

    try {
      const headers = await this.getHeaders();
      const endpoint = this.getApiUrl(`/open-apis/drive/v1/files/${fileToken}/move`);

      const body = {
        type: fileType,
        folder_token: folderToken
      };

      console.log(`[Flybook] 执行移动文件请求: 文件 ${fileToken} -> 文件夹 ${folderToken}`);
      console.log(`[Flybook] 移动请求体:`, JSON.stringify(body));

      const data = await this.fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      console.log(`[Flybook] 移动文件响应:`, JSON.stringify(data));

      if (data.code !== 0) {
        throw new Error(`移动文件失败: ${data.msg}`);
      }
    } catch (error) {
      console.error('[Flybook] 移动文件失败:', error);
      throw error;
    }
  }
}