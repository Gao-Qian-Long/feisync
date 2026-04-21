/**
 * 飞书 Drive API 封装模块
 * 负责文件夹管理、文件上传（含分片）、下载、速率限制与重试
 */

import { FeishuAuthManager } from './feishuAuth';

// 请求超时时间（毫秒）
const REQUEST_TIMEOUT = 30000;
// 飞书 API 速率限制：5 QPS
const API_RATE_LIMIT_QPS = 5;
// 速率限制窗口（毫秒）
const RATE_LIMIT_WINDOW = 1000;

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

/**
 * 速率限制器
 * 确保 API 调用不超过飞书限制（5 QPS）
 */
class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = API_RATE_LIMIT_QPS, windowMs: number = RATE_LIMIT_WINDOW) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * 等待直到可以发送请求
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    // 清理超出时间窗口的时间戳
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      // 需要等待直到最早的请求超出窗口
      const oldestInWindow = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldestInWindow) + 10; // 额外10ms缓冲
      if (waitTime > 0) {
        console.log(`[Flybook] 速率限制：等待 ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      // 递归重试
      return this.acquire();
    }

    this.timestamps.push(Date.now());
  }
}

/**
 * 带重试的请求执行器
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  description: string = 'API 请求'
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      const msg = lastError.message || '';

      // 不重试的错误：认证错误、权限错误、参数错误
      const noRetryPatterns = ['HTTP 4', 'invalid', 'unauthorized', 'permission', '参数', '权限'];
      const shouldNotRetry = noRetryPatterns.some(p => msg.toLowerCase().includes(p.toLowerCase()));
      if (shouldNotRetry && attempt > 0) {
        break;
      }

      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt); // 指数退避：1s, 2s, 4s
        console.warn(`[Flybook] ${description}失败 (尝试 ${attempt + 1}/${maxRetries + 1})，${delay}ms 后重试:`, msg);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`${description}失败（已重试 ${maxRetries} 次）: ${lastError?.message || '未知错误'}`);
}

/**
 * 飞书 Drive API 封装类
 */
export class FeishuApiClient {
  private authManager: FeishuAuthManager;
  private proxyUrl: string; // 代理服务器地址，留空则直连
  private rateLimiter: RateLimiter;
  private maxRetryAttempts: number;

  constructor(authManager: FeishuAuthManager, proxyUrl: string = '', maxRetries: number = 3) {
    this.authManager = authManager;
    this.proxyUrl = proxyUrl;
    this.rateLimiter = new RateLimiter();
    this.maxRetryAttempts = maxRetries;
  }

  /**
   * 更新代理配置
   */
  updateProxyUrl(proxyUrl: string): void {
    this.proxyUrl = proxyUrl;
  }

  /**
   * 更新重试次数
   */
  updateMaxRetries(maxRetries: number): void {
    this.maxRetryAttempts = maxRetries;
  }

  /**
   * 获取完整的 API URL（如果配置了代理则使用代理）
   */
  private getApiUrl(path: string): string {
    if (this.proxyUrl) {
      const baseUrl = this.proxyUrl.replace(/\/$/, '');
      const apiPath = path.startsWith('/') ? path : '/' + path;
      return `${baseUrl}${apiPath}`;
    }
    return `https://open.feishu.cn${path}`;
  }

  /**
   * 获取认证头
   * 优先使用 user_access_token（如果已授权），否则使用 tenant_access_token
   * @param requireUserToken 是否强制要求 user_access_token（下载等操作需要）
   */
  private async getHeaders(requireUserToken: boolean = false): Promise<Record<string, string>> {
    let token: string;

    if (this.authManager.isUserAuthorized()) {
      try {
        token = await this.authManager.getUserAccessToken();
      } catch (error) {
        if (requireUserToken) {
          // 下载等操作必须使用 user_access_token，不能回退
          throw new Error('此操作需要用户授权，请在设置中重新进行飞书 OAuth 授权');
        }
        console.warn('[Flybook] 获取 user_access_token 失败，回退到 tenant_access_token:', error);
        token = await this.authManager.getAccessToken();
      }
    } else {
      if (requireUserToken) {
        throw new Error('此操作需要用户授权，请在设置中完成飞书 OAuth 授权');
      }
      token = await this.authManager.getAccessToken();
    }

    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * 带超时和速率限制的 fetch 请求
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number = REQUEST_TIMEOUT
  ): Promise<any> {
    // 速率限制
    await this.rateLimiter.acquire();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      const responseText = await response.text();

      if (!response.ok) {
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errorData = JSON.parse(responseText);
          errorMsg = `HTTP ${response.status}: ${JSON.stringify(errorData)}`;
          console.error('[Flybook] API 错误详情:', errorData);
        } catch {
          errorMsg = `HTTP ${response.status}: ${responseText.substring(0, 500)}`;
          console.error('[Flybook] API 错误原始响应:', responseText);
        }
        throw new Error(errorMsg);
      }

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
   * 带重试和速率限制的 API 请求
   */
  private async apiRequest(
    url: string,
    options: RequestInit,
    timeout: number = REQUEST_TIMEOUT,
    description: string = 'API 请求'
  ): Promise<any> {
    return withRetry(
      () => this.fetchWithTimeout(url, options, timeout),
      this.maxRetryAttempts,
      description
    );
  }

  // ==================== 文件夹操作 ====================

  /**
   * 确保目标文件夹存在，如果不存在则创建
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
    const existing = await this.findFolderByName(folderName, parentToken);
    if (existing) {
      return existing.token;
    }
    return await this.createFolder(folderName, parentToken);
  }

  /**
   * 根据名称和父token查找文件夹
   */
  async findFolderByName(folderName: string, parentToken: string): Promise<FeishuFileMeta | null> {
    try {
      const files = await this.listFolderContents(parentToken);
      return files.find(f => f.name === folderName && f.type === 'folder') || null;
    } catch (error) {
      console.error('[Flybook] 查找文件夹失败:', error);
      return null;
    }
  }

  /**
   * 列出文件夹内容（支持分页）
   */
  async listFolderContents(folderToken: string): Promise<FeishuFileMeta[]> {
    try {
      const allFiles: FeishuFileMeta[] = [];
      let pageToken = '';

      do {
        let path: string;
        if (folderToken) {
          path = `/open-apis/drive/v1/files?folder_token=${folderToken}&page_size=50`;
          if (pageToken) {
            path += `&page_token=${pageToken}`;
          }
        } else {
          path = '/open-apis/drive/v1/files?page_size=50';
          if (pageToken) {
            path += `&page_token=${pageToken}`;
          }
        }

        const endpoint = this.getApiUrl(path);
        const headers = await this.getHeaders();
        const data = await this.apiRequest(endpoint, {
          method: 'GET',
          headers,
        }, REQUEST_TIMEOUT, '列出文件夹内容');

        if (data.code !== 0) {
          throw new Error(`API 错误: ${data.msg}`);
        }

        const files = data.data?.files || [];
        for (const f of files) {
          allFiles.push({
            token: f.token || f.file_token,
            name: f.name,
            type: f.type || (f.mime_type?.includes('folder') ? 'folder' : 'file'),
            parentToken: folderToken,
            size: f.size,
            createdTime: f.created_time ? parseInt(f.created_time) : undefined,
            modifiedTime: f.updated_time ? parseInt(f.updated_time) : undefined,
          });
        }

        pageToken = data.data?.next_page_token || '';
      } while (pageToken);

      return allFiles;
    } catch (error) {
      console.error('[Flybook] 列出文件夹内容失败:', error);
      throw error;
    }
  }

  /**
   * 创建文件夹
   */
  async createFolder(folderName: string, parentToken: string): Promise<string> {
    if (!folderName || folderName.trim() === '') {
      throw new Error('文件夹名称不能为空');
    }

    try {
      const headers = await this.getHeaders();
      const endpoint = this.getApiUrl('/open-apis/drive/v1/files/create_folder');

      const body: any = {
        name: folderName,
        folder_token: parentToken || '',
      };

      const data = await this.apiRequest(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, REQUEST_TIMEOUT, '创建文件夹');

      if (data.code !== 0) {
        throw new Error(`创建文件夹失败: ${data.msg}`);
      }

      return data.data?.file_token || '';
    } catch (error) {
      console.error('[Flybook] 创建文件夹失败:', error);
      throw error;
    }
  }

  // ==================== 文件上传 ====================

  /**
   * 上传文件（自动选择全量或分片上传）
   * @param fileContent 文件内容
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
    if (!fileContent || fileContent.byteLength === 0) {
      throw new Error('文件内容不能为空');
    }
    if (!fileName || fileName.trim() === '') {
      throw new Error('文件名不能为空');
    }
    if (typeof size !== 'number' || size <= 0) {
      throw new Error('文件大小无效');
    }

    // 大于 20MB 使用分片上传
    const CHUNKED_UPLOAD_THRESHOLD = 20 * 1024 * 1024;
    if (size > CHUNKED_UPLOAD_THRESHOLD) {
      return this.uploadFileChunked(fileContent, fileName, parentFolderToken, size);
    }

    return this.uploadFileAll(fileContent, fileName, parentFolderToken, size);
  }

  /**
   * 全量上传文件（≤20MB）
   */
  private async uploadFileAll(
    fileContent: ArrayBuffer | Uint8Array,
    fileName: string,
    parentFolderToken: string,
    size: number
  ): Promise<string> {
    try {
      const headers = await this.getHeaders();
      delete headers['Content-Type'];

      const formData = new FormData();
      formData.append('file_name', fileName);
      formData.append('parent_type', 'explorer');
      formData.append('parent_node', parentFolderToken);
      formData.append('size', size.toString());

      const blob = new Blob([fileContent]);
      formData.append('file', blob, fileName);

      const data = await this.apiRequest(
        this.getApiUrl('/open-apis/drive/v1/medias/upload_all'),
        {
          method: 'POST',
          headers,
          body: formData,
        },
        60000,
        `上传文件 ${fileName}`
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
   * 分片上传文件（>20MB）
   * 飞书分片上传流程：
   * 1. 预上传（创建上传会话）
   * 2. 逐片上传
   * 3. 完成上传
   */
  private async uploadFileChunked(
    fileContent: ArrayBuffer | Uint8Array,
    fileName: string,
    parentFolderToken: string,
    size: number
  ): Promise<string> {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB 每片

    try {
      // 步骤1：预上传
      const headers = await this.getHeaders();
      const preUploadBody = {
        file_name: fileName,
        parent_type: 'explorer',
        parent_node: parentFolderToken,
        size: size,
        block_size: CHUNK_SIZE,
      };

      console.log(`[Flybook] 分片上传预请求: ${fileName}, 大小: ${(size / 1024 / 1024).toFixed(2)}MB`);

      const preUploadData = await this.apiRequest(
        this.getApiUrl('/open-apis/drive/v1/medias/upload_prepare'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(preUploadBody),
        },
        REQUEST_TIMEOUT,
        `分片预上传 ${fileName}`
      );

      if (preUploadData.code !== 0) {
        throw new Error(`分片预上传失败: ${preUploadData.msg}`);
      }

      const uploadId = preUploadData.data?.upload_id;
      const blockNums = preUploadData.data?.block_num || 0;

      if (!uploadId) {
        throw new Error('分片预上传成功但未返回 upload_id');
      }

      console.log(`[Flybook] 分片上传会话已创建，upload_id: ${uploadId}, 分片数: ${blockNums}`);

      // 步骤2：逐片上传
      const uint8Content = fileContent instanceof Uint8Array ? fileContent : new Uint8Array(fileContent);
      const blockSeqList: number[] = [];

      for (let i = 0; i < blockNums; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, size);
        const chunk = uint8Content.slice(start, end);

        const uploadHeaders = await this.getHeaders();
        delete uploadHeaders['Content-Type'];

        const formData = new FormData();
        formData.append('upload_id', uploadId);
        formData.append('seq', i.toString());

        const blob = new Blob([chunk]);
        formData.append('file', blob, `${fileName}.part${i}`);

        const chunkData = await this.apiRequest(
          this.getApiUrl('/open-apis/drive/v1/medias/upload_block'),
          {
            method: 'POST',
            headers: uploadHeaders,
            body: formData,
          },
          120000, // 分片上传使用更长超时
          `上传分片 ${i + 1}/${blockNums} ${fileName}`
        );

        if (chunkData.code !== 0) {
          throw new Error(`上传分片 ${i + 1} 失败: ${chunkData.msg}`);
        }

        blockSeqList.push(i);
        console.log(`[Flybook] 分片 ${i + 1}/${blockNums} 上传完成`);
      }

      // 步骤3：完成上传
      const completeHeaders = await this.getHeaders();
      const completeBody = {
        upload_id: uploadId,
        block_num: blockNums,
        block_seq_list: blockSeqList,
      };

      const completeData = await this.apiRequest(
        this.getApiUrl('/open-apis/drive/v1/medias/upload_finish'),
        {
          method: 'POST',
          headers: completeHeaders,
          body: JSON.stringify(completeBody),
        },
        REQUEST_TIMEOUT,
        `完成分片上传 ${fileName}`
      );

      if (completeData.code !== 0) {
        throw new Error(`完成分片上传失败: ${completeData.msg}`);
      }

      const fileToken = completeData.data?.file_token || '';
      console.log(`[Flybook] 分片上传完成，file_token: ${fileToken}`);
      return fileToken;
    } catch (error) {
      console.error('[Flybook] 分片上传失败:', error);
      throw error;
    }
  }

  // ==================== 文件下载 ====================

  /**
   * 下载文件内容
   * 根据文件类型自动选择正确的下载端点：
   * - 普通文件(file) → /files/{token}/download
   * - 在线文档(docx/sheet/bitable) → 先导出再下载
   * - 素材(file_token 来自 medias 上传) → /medias/{token}/download
   *
   * 所有端点都直接返回文件二进制流
   * @param fileToken 文件 token
   * @param fileType 文件类型（file/docx/sheet/bitable 等）
   * @returns 文件内容的 ArrayBuffer
   */
  async downloadFile(fileToken: string, fileType: string = 'file'): Promise<ArrayBuffer> {
    if (!fileToken || fileToken.trim() === '') {
      throw new Error('文件 token 不能为空');
    }

    console.log(`[Flybook][DEBUG] downloadFile 开始: token=${fileToken}, type=${fileType}`);

    // 在线文档需要先导出再下载
    if (['docx', 'sheet', 'bitable', 'doc', 'slides'].includes(fileType)) {
      console.log(`[Flybook][DEBUG] 检测到在线文档类型 ${fileType}，使用导出流程`);
      return this.exportAndDownload(fileToken, fileType);
    }

    // 先尝试 /files/ 端点，失败则回退到 /medias/ 端点
    let lastError: Error | null = null;

    // 策略1: /files/{token}/download（适用于云空间原生文件）
    try {
      console.log(`[Flybook][DEBUG] 尝试 /files/ 端点下载...`);
      const result = await this.downloadWithRetry(
        `/open-apis/drive/v1/files/${fileToken}/download`,
        'files'
      );
      console.log(`[Flybook][DEBUG] /files/ 端点下载成功，大小: ${result.byteLength} bytes`);
      return result;
    } catch (filesError) {
      lastError = filesError as Error;
      console.warn(`[Flybook][DEBUG] /files/ 端点失败: ${lastError.message}`);
    }

    // 策略2: /medias/{token}/download（适用于素材文件）
    try {
      console.log(`[Flybook][DEBUG] 尝试 /medias/ 端点下载...`);
      const result = await this.downloadWithRetry(
        `/open-apis/drive/v1/medias/${fileToken}/download?file_type=${fileType}`,
        'medias'
      );
      console.log(`[Flybook][DEBUG] /medias/ 端点下载成功，大小: ${result.byteLength} bytes`);
      return result;
    } catch (mediasError) {
      const mediasErr = mediasError as Error;
      console.warn(`[Flybook][DEBUG] /medias/ 端点也失败: ${mediasErr.message}`);
    }

    const errorMsg = `下载文件失败（/files/ 和 /medias/ 端点均失败）: /files/ 错误: ${lastError?.message}`;
    console.error('[Flybook]', errorMsg);
    throw new Error(errorMsg);
  }

  /**
   * 带重试的下载请求（处理二进制响应）
   */
  private async downloadWithRetry(
    apiPath: string,
    endpointName: string
  ): Promise<ArrayBuffer> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetryAttempts; attempt++) {
      try {
        const headers = await this.getHeaders();

        await this.rateLimiter.acquire();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        const endpoint = this.getApiUrl(apiPath);
        console.log(`[Flybook][DEBUG] 下载请求: ${endpoint} (尝试 ${attempt + 1}/${this.maxRetryAttempts + 1})`);

        const response = await fetch(endpoint, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        console.log(`[Flybook][DEBUG] 响应状态: ${response.status} ${response.statusText}`);
        console.log(`[Flybook][DEBUG] 响应 Content-Type: ${response.headers.get('content-type')}`);

        if (!response.ok) {
          let errorMsg = `HTTP ${response.status}`;
          try {
            const errorText = await response.text();
            console.log(`[Flybook][DEBUG] 错误响应内容: ${errorText.substring(0, 500)}`);
            const errorData = JSON.parse(errorText);
            errorMsg = `HTTP ${response.status}: ${errorData.msg || JSON.stringify(errorData)}`;
          } catch {
            // 不是 JSON 错误响应
          }
          throw new Error(errorMsg);
        }

        const contentLength = response.headers.get('content-length');
        console.log(`[Flybook][DEBUG] Content-Length: ${contentLength || 'unknown'}`);

        return await response.arrayBuffer();
      } catch (error) {
        lastError = error as Error;
        const msg = lastError.message || '';

        // 不重试 4xx 错误（除了 429 限流）
        if (msg.includes('HTTP 4') && !msg.includes('HTTP 429')) {
          console.warn(`[Flybook][DEBUG] ${endpointName} 端点 ${msg}，不再重试`);
          break;
        }

        if (attempt < this.maxRetryAttempts) {
          const delay = 1000 * Math.pow(2, attempt);
          console.warn(`[Flybook][DEBUG] ${endpointName} 端点下载失败 (尝试 ${attempt + 1}/${this.maxRetryAttempts + 1})，${delay}ms 后重试:`, msg);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`${endpointName} 端点下载失败（已重试 ${this.maxRetryAttempts} 次）: ${lastError?.message || '未知错误'}`);
  }

  /**
   * 导出在线文档并下载
   * 流程：创建导出任务 → 轮询结果 → 下载导出文件
   */
  private async exportAndDownload(fileToken: string, fileType: string): Promise<ArrayBuffer> {
    // 确定导出格式
    const exportTypeMap: Record<string, string> = {
      'docx': 'docx',
      'doc': 'docx',
      'sheet': 'xlsx',
      'bitable': 'xlsx',
      'slides': 'pptx',
    };
    const exportType = exportTypeMap[fileType] || 'docx';

    console.log(`[Flybook][DEBUG] 创建导出任务: token=${fileToken}, type=${fileType}, exportType=${exportType}`);

    // 步骤1: 创建导出任务
    const headers = await this.getHeaders(true); // 导出必须使用 user_access_token
    const exportBody: Record<string, any> = {
      token: fileToken,
      type: fileType,
      file_extension: exportType,
    };

    const createData = await this.apiRequest(
      this.getApiUrl('/open-apis/drive/v1/export_tasks'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(exportBody),
      },
      REQUEST_TIMEOUT,
      '创建导出任务'
    );

    if (createData.code !== 0) {
      const errorCode = createData.code;
      const errorMsg = createData.msg || '';
      
      // 权限不足错误 (99991679)：用户 token 缺少导出权限
      // 需要重新授权以获取 drive:export:readonly 和 docs:document:export scope
      if (errorCode === 99991679) {
        // 清除旧 token，强制用户重新授权
        this.authManager.clearUserToken();
        this.authManager['onTokenChange']?.();
        
        throw new Error(`导出权限不足 (99991679)：当前授权缺少 drive:export:readonly 或 docs:document:export 权限。已清除旧授权，请在设置中重新授权，授权时会自动请求新权限`);
      }
      
      throw new Error(`创建导出任务失败: ${errorMsg}`);
    }

    const ticket = createData.data?.ticket;
    if (!ticket) {
      throw new Error('创建导出任务成功但未返回 ticket');
    }

    console.log(`[Flybook][DEBUG] 导出任务已创建，ticket: ${ticket}`);

    // 步骤2: 轮询导出任务
    let exportFileToken: string | null = null;
    for (let i = 0; i < 30; i++) {
      const pollData = await this.apiRequest(
        this.getApiUrl(`/open-apis/drive/v1/export_tasks/${ticket}?token=${fileToken}`),
        { method: 'GET', headers },
        REQUEST_TIMEOUT,
        '查询导出任务'
      );

      if (pollData.code !== 0) {
        throw new Error(`查询导出任务失败: ${pollData.msg}`);
      }

      const result = pollData.data?.result;
      if (!result) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (result.job_status === 0) {
        exportFileToken = result.file_token;
        break;
      } else if (result.job_status === 1 || result.job_status === 2) {
        console.log(`[Flybook][DEBUG] 导出任务进行中 (status: ${result.job_status})...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      } else {
        throw new Error(`导出失败: ${result.job_error_msg || '未知错误'} (status: ${result.job_status})`);
      }
    }

    if (!exportFileToken) {
      throw new Error('导出任务超时');
    }

    console.log(`[Flybook][DEBUG] 导出完成，file_token: ${exportFileToken}`);

    // 步骤3: 下载导出文件
    return this.downloadWithRetry(
      `/open-apis/drive/v1/export_tasks/file/${exportFileToken}/download`,
      'export'
    );
  }

  // ==================== 文件删除 ====================

  /**
   * 删除文件
   */
  async deleteFile(fileToken: string, fileType: string = 'file'): Promise<void> {
    if (!fileToken || fileToken.trim() === '') {
      throw new Error('文件 token 不能为空');
    }

    try {
      const headers = await this.getHeaders();
      const endpoint = this.getApiUrl(`/open-apis/drive/v1/files/${fileToken}?type=${fileType}`);

      const data = await this.apiRequest(endpoint, {
        method: 'DELETE',
        headers,
      }, REQUEST_TIMEOUT, `删除文件 ${fileToken}`);

      if (data.code !== 0) {
        throw new Error(`删除文件失败: ${data.msg}`);
      }

      console.log(`[Flybook] 文件删除成功`);
    } catch (error) {
      console.error('[Flybook] 删除文件失败:', error);
      throw error;
    }
  }

  // ==================== 文件查找 ====================

  /**
   * 查找文件（根据名称和父文件夹）
   */
  async findFileByName(fileName: string, parentToken: string): Promise<FeishuFileMeta | null> {
    try {
      const files = await this.listFolderContents(parentToken);
      const localNameWithoutExt = fileName.replace(/\.[^.]+$/, '');
      return files.find(f =>
        (f.name === fileName || f.name === localNameWithoutExt) &&
        (f.type === 'file' || f.type === 'docx' || f.type === 'sheet')
      ) || null;
    } catch (error) {
      console.error('[Flybook] 查找文件失败:', error);
      return null;
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 检查文件大小是否在限制范围内（分片上传无上限）
   */
  checkFileSize(sizeInBytes: number): boolean {
    // 使用分片上传后理论上无大小限制，但单次全量上传限制 20MB
    return true;
  }

  /**
   * 通过导入方式创建文档（将 Markdown 作为飞书文档导入）
   */
  async importFileAsDocument(
    fileContent: string | ArrayBuffer | Uint8Array,
    fileName: string,
    parentFolderToken: string = ''
  ): Promise<string> {
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
      const headers = await this.getHeaders();
      delete headers['Content-Type'];

      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const fileExtension = ext;

      const formData = new FormData();
      formData.append('file_name', fileName);
      formData.append('parent_type', 'ccm_import_open');
      formData.append('parent_node', '');
      const fileSize = fileContent instanceof ArrayBuffer
        ? fileContent.byteLength
        : fileContent instanceof Uint8Array
          ? fileContent.length
          : new Blob([fileContent]).size;
      formData.append('size', fileSize.toString());

      const extraParams = {
        obj_type: 'docx',
        file_extension: fileExtension
      };
      formData.append('extra', JSON.stringify(extraParams));

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

      const blob = new Blob([fileContent], { type: mimeType });
      formData.append('file', blob, fileName);

      const uploadData = await this.apiRequest(
        this.getApiUrl('/open-apis/drive/v1/medias/upload_all'),
        {
          method: 'POST',
          headers,
          body: formData,
        },
        60000,
        `导入上传 ${fileName}`
      );

      if (uploadData.code !== 0) {
        throw new Error(`上传文件失败: ${uploadData.msg}`);
      }

      const fileToken = uploadData.data?.file_token;
      if (!fileToken) {
        throw new Error('上传文件成功但未返回 file_token');
      }

      const ticket = await this.createImportTask(
        fileToken,
        fileExtension,
        'docx',
        fileName,
        parentFolderToken || undefined
      );

      const docToken = await this.pollImportTask(ticket);
      return docToken;
    } catch (error) {
      console.error('[Flybook] 导入文件失败:', error);
      throw error;
    }
  }

  /**
   * 创建导入任务
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

    const body: Record<string, any> = {
      file_extension: fileExtension,
      file_token: fileToken,
      type: type,
    };

    if (fileName) {
      body.name = fileName;
    }

    if (folderToken && folderToken.trim() !== '') {
      body.point = {
        mount_type: 1,
        mount_key: folderToken
      };
      if (!body.name) {
        body.name = 'Untitled';
      }
    }

    const data = await this.apiRequest(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, REQUEST_TIMEOUT, '创建导入任务');

    if (data.code !== 0) {
      throw new Error(`创建导入任务失败: ${data.msg}`);
    }

    const ticket = data.data?.ticket || data.data?.result?.ticket;
    if (!ticket) {
      throw new Error('创建导入任务成功但未返回 ticket');
    }

    return ticket;
  }

  /**
   * 轮询导入任务状态
   */
  private async pollImportTask(ticket: string, maxAttempts: number = 30): Promise<string> {
    const headers = await this.getHeaders();

    for (let i = 0; i < maxAttempts; i++) {
      const data = await this.apiRequest(
        this.getApiUrl(`/open-apis/drive/v1/import_tasks/${ticket}`),
        {
          method: 'GET',
          headers,
        },
        REQUEST_TIMEOUT,
        '查询导入任务'
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
        return result.token;
      } else if (jobStatus === 1 || jobStatus === 2) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      } else {
        throw new Error(`导入失败: ${result.job_error_msg || '未知错误'} (status: ${jobStatus})`);
      }
    }

    throw new Error('导入任务超时');
  }

  /**
   * 将文档移动到指定文件夹
   */
  async moveFile(fileToken: string, fileType: string, folderToken: string): Promise<void> {
    if (!fileToken || fileToken.trim() === '') {
      throw new Error('文件 token 不能为空');
    }
    if (!folderToken || folderToken.trim() === '') {
      return;
    }

    try {
      const headers = await this.getHeaders();
      const endpoint = this.getApiUrl(`/open-apis/drive/v1/files/${fileToken}/move`);

      const body = {
        type: fileType,
        folder_token: folderToken
      };

      const data = await this.apiRequest(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, REQUEST_TIMEOUT, `移动文件 ${fileToken}`);

      if (data.code !== 0) {
        throw new Error(`移动文件失败: ${data.msg}`);
      }
    } catch (error) {
      console.error('[Flybook] 移动文件失败:', error);
      throw error;
    }
  }
}
