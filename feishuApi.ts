/**
 * 飞书 Drive API 封装模块
 * 负责文件夹管理、文件上传（含分片）、下载、速率限制与重试
 */

import { requestUrl } from 'obsidian';
import type { RequestUrlParam } from 'obsidian';
import { FeishuAuthManager } from './feishuAuth';
import { createLogger } from './logger';
import { getFeishuFileType } from './fileTypeUtils';

const log = createLogger('FeishuApi');

// 请求超时时间（毫秒）
const REQUEST_TIMEOUT = 30000;
// 飞书 API 速率限制：5 QPS
const API_RATE_LIMIT_QPS = 5;
// 速率限制窗口（毫秒）
const RATE_LIMIT_WINDOW = 1000;

// 飞书 API 通用响应结构
interface FeishuApiResponse {
  code: number;
  msg: string;
  data?: unknown;
  [key: string]: unknown;
}

// 文件夹/文件元数据结构
export interface FeishuFileMeta {
  token: string;
  name: string;
  type: string;
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
  /** 使用 Promise 链实现互斥锁，避免并发请求同时通过 timestamps.length 检查 */
  private lock: Promise<void> = Promise.resolve();

  constructor(maxRequests: number = API_RATE_LIMIT_QPS, windowMs: number = RATE_LIMIT_WINDOW) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * 等待直到可以发送请求（线程安全）
   */
  async acquire(): Promise<void> {
    // 将本次等待操作追加到锁链尾部，等待前面的操作完成后再执行本轮检查
    this.lock = this.lock.then(async () => {
      const now = Date.now();
      // 清理超出时间窗口的时间戳
      this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

      if (this.timestamps.length >= this.maxRequests) {
        // 需要等待直到最早的请求超出窗口
        const oldestInWindow = this.timestamps[0];
        const waitTime = Math.max(0, this.windowMs - (now - oldestInWindow)) + 10; // 额外10ms缓冲
        log.debug(`速率限制：等待 ${waitTime}ms`);
        await new Promise(resolve => activeWindow.setTimeout(resolve, waitTime));
      }
      // 无论是否等待，都记录本次请求的时间戳
      this.timestamps.push(Date.now());
    });
    await this.lock;
  }
}

// 不重试的错误模式：认证错误、权限错误、参数错误、文件已删除、IP 限制
const NO_RETRY_PATTERNS = ['1061007', 'file has been delete', '99991401', 'is denied by app setting', 'invalid', 'unauthorized', 'permission', '参数', '权限'];

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

      const shouldNotRetry = NO_RETRY_PATTERNS.some(p => msg.toLowerCase().includes(p));
      if (shouldNotRetry) {
        break;
      }

      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt); // 指数退避：1s, 2s, 4s
        log.warn(`${description}失败 (尝试 ${attempt + 1}/${maxRetries + 1})，${delay}ms 后重试: ${msg}`);
        await new Promise(resolve => activeWindow.setTimeout(resolve, delay));
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
  /** 文件夹路径锁：防止并发 ensureFolderPath 创建重复文件夹 */
  private folderLocks: Map<string, Promise<string>> = new Map();

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
   * - 如果用户已授权，始终使用 user_access_token（不受 IP 白名单限制，文件所有者为用户本人）
   * - 如果用户未授权，使用 tenant_access_token（受 IP 白名单限制，文件所有者为应用）
   * - 一旦用户授权过，不再回退到 tenant_access_token，避免文件所有者不一致和 IP 白名单问题
   * @param requireUserToken 是否强制要求 user_access_token（下载等操作需要）
   */
  private async getHeaders(requireUserToken: boolean = false): Promise<Record<string, string>> {
    let token: string;

    if (this.authManager.isUserAuthorized()) {
      try {
        token = await this.authManager.getUserAccessToken();
      } catch (error) {
        // 用户已授权但 token 获取/刷新失败，不再回退到 tenant_access_token
        // 因为回退会导致：1) IP 白名单限制 (99991401) 2) 文件所有者变为应用而非用户
        log.error('获取 user_access_token 失败，需要重新授权:', error);
        throw new Error('用户授权已失效，请在设置中重新进行飞书 OAuth 授权');
      }
    } else if (this.authManager.wasUserAuthorized()) {
      // 用户曾经授权过但 token 已失效（被清除），不应回退到 tenant_access_token
      throw new Error('用户授权已失效，请在设置中重新进行飞书 OAuth 授权');
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
   * 带超时和速率限制的 requestUrl 请求
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit & { body?: FormData | string | ArrayBuffer | Record<string, unknown> | Blob },
    timeout: number = REQUEST_TIMEOUT
  ): Promise<FeishuApiResponse> {
    // 速率限制
    await this.rateLimiter.acquire();

    const method = (options.method || 'GET');
    const headers: Record<string, string> = {};
    if (options.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(options.headers)) {
        for (const [k, v] of options.headers) { headers[k] = v; }
      } else {
        Object.assign(headers, options.headers);
      }
    }

    // 判断是否为 FormData 上传
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;

    let body: ArrayBuffer | string | undefined = undefined;
    if (isFormData) {
      // requestUrl 不支持 FormData，需要手动构建 multipart
      const formData = options.body as FormData;
      const boundary = '----FeiSyncBoundary' + Date.now().toString(16);
      const parts: ArrayBuffer[] = [];
      const encoder = new TextEncoder();

      const entries: [string, Blob | string][] = [];
      formData.forEach((value, key) => { entries.push([key, value]); });

      for (const [key, value] of entries) {
        parts.push(encoder.encode(`--${boundary}\r\n`));
        if (value instanceof Blob) {
          const fileName = value instanceof File ? value.name : 'file';
          const mimeType = value.type || 'application/octet-stream';
          parts.push(encoder.encode(
            `Content-Disposition: form-data; name="${key}"; filename="${fileName}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
          ));
          parts.push(await value.arrayBuffer());
          parts.push(encoder.encode('\r\n'));
        } else {
          parts.push(encoder.encode(
            `Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
          ));
        }
      }
      parts.push(encoder.encode(`--${boundary}--\r\n`));

      // 合并所有 parts
      const totalLen = parts.reduce((acc, p) => acc + p.byteLength, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const p of parts) {
        combined.set(new Uint8Array(p), offset);
        offset += p.byteLength;
      }

      body = combined.buffer;
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (options.body) {
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    // 生成请求追踪 ID，便于代理端与插件端日志对照排查
    const requestId = `fs-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    headers['X-Request-ID'] = requestId;

    const requestParams: RequestUrlParam = {
      url,
      method,
      headers,
      body,
      throw: false,
    };

    try {
      // 使用 Promise.race 实现客户端超时保护
      // 注意：requestUrl 无法取消，超时后仅抛错终止当前逻辑，底层请求仍在后台执行
      const fetchPromise = requestUrl(requestParams);
      const timeoutPromise = new Promise<never>((_, reject) => {
        activeWindow.setTimeout(() => reject(new Error(`请求超时（${timeout}ms）`)), timeout);
      });
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      const responseText = typeof response.text === 'string' ? response.text : JSON.stringify(response.json);

      // requestUrl 对 4xx/5xx 不会自动抛出，但保险起见检查 status
      if (response.status >= 400) {
        // 代理层错误：帮助用户快速定位是代理问题还是飞书 API 问题
        if (this.proxyUrl && (response.status === 502 || response.status === 503 || response.status === 504)) {
          throw new Error(
            `代理服务器错误 (HTTP ${response.status})：代理无法连接到飞书 API。` +
            `请检查代理服务是否正常运行，以及代理服务器能否访问 open.feishu.cn`
          );
        }
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errorData = response.json as Record<string, unknown>;
          errorMsg = `HTTP ${response.status}: ${JSON.stringify(errorData)}`;
          log.error('API 错误详情:', errorData);
        } catch {
          errorMsg = `HTTP ${response.status}: ${responseText.substring(0, 500)}`;
          log.error('API 错误原始响应:', responseText);
        }
        throw new Error(errorMsg);
      }

      try {
        return response.json as FeishuApiResponse;
      } catch {
        throw new Error(`JSON 解析失败: ${responseText.substring(0, 200)}`);
      }
    } catch (error) {
      if ((error as Error).message?.startsWith('HTTP ')) {
        throw error;
      }
      // requestUrl 网络错误等
      throw new Error(`请求失败: ${(error as Error).message}`);
    }
  }

  /**
   * 带重试和速率限制的 API 请求
   */
  private async apiRequest(
    url: string,
    options: RequestInit & { body?: FormData | string | ArrayBuffer | Record<string, unknown> | Blob },
    timeout: number = REQUEST_TIMEOUT,
    description: string = 'API 请求'
  ): Promise<FeishuApiResponse> {
    return withRetry(
      () => this.fetchWithTimeout(url, options, timeout),
      this.maxRetryAttempts,
      description
    );
  }

  // ==================== 文件夹操作 ====================

  /**
   * 确保目标文件夹存在，如果不存在则创建
   * 使用锁机制防止并发调用创建重复文件夹
   */
  async ensureFolderPath(folderPath: string, rootFolderToken?: string): Promise<string> {
    if (!folderPath || folderPath.trim() === '') {
      return rootFolderToken || '';
    }

    // 使用锁机制：同一个 folderPath+rootFolderToken 只允许一个并发操作
    const lockKey = `${rootFolderToken || ''}/${folderPath}`;
    const existingLock = this.folderLocks.get(lockKey);
    if (existingLock) {
      return existingLock;
    }

    const lockPromise = this._doEnsureFolderPath(folderPath, rootFolderToken);
    this.folderLocks.set(lockKey, lockPromise);

    try {
      return await lockPromise;
    } finally {
      this.folderLocks.delete(lockKey);
    }
  }

  private async _doEnsureFolderPath(folderPath: string, rootFolderToken?: string): Promise<string> {
    const parts = folderPath.split('/').filter(p => p.trim() !== '');
    let currentToken = rootFolderToken || '';

    for (const part of parts) {
      currentToken = await this.findOrCreateFolder(part, currentToken);
    }

    return currentToken;
  }

  /**
   * 在父文件夹下查找或创建子文件夹
   * 使用锁机制防止并发创建同名文件夹
   */
  private async findOrCreateFolder(folderName: string, parentToken: string): Promise<string> {
    const lockKey = `create:${parentToken}/${folderName}`;
    const existingLock = this.folderLocks.get(lockKey);
    if (existingLock) {
      return existingLock;
    }

    const lockPromise = this._doFindOrCreateFolder(folderName, parentToken);
    this.folderLocks.set(lockKey, lockPromise);

    try {
      return await lockPromise;
    } finally {
      this.folderLocks.delete(lockKey);
    }
  }

  private async _doFindOrCreateFolder(folderName: string, parentToken: string): Promise<string> {
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
      log.error('查找文件夹失败:', error);
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

        const listData = data.data as {
          files?: Array<{
            token?: string;
            file_token?: string;
            name: string;
            type?: string;
            mime_type?: string;
            size?: number;
            created_time?: string;
            updated_time?: string;
          }>;
          next_page_token?: string;
        } | undefined;
        const files = listData?.files || [];
        for (const f of files) {
          allFiles.push({
            token: f.token || f.file_token || '',
            name: f.name,
            type: f.type || (f.mime_type?.includes('folder') ? 'folder' : 'file'),
            parentToken: folderToken,
            size: f.size,
            createdTime: f.created_time ? parseInt(f.created_time) : undefined,
            modifiedTime: f.updated_time ? parseInt(f.updated_time) : undefined,
          });
        }

        pageToken = listData?.next_page_token || '';
      } while (pageToken);

      return allFiles;
    } catch (error) {
      log.error('列出文件夹内容失败:', error);
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

      const body: Record<string, unknown> = {
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

      // API 响应字段是 token，不是 file_token
      const folderData = data.data as { token?: string } | undefined;
      const folderToken = folderData?.token || '';
      if (!folderToken) {
        throw new Error('创建文件夹成功但未返回 token');
      }
      return folderToken;
    } catch (error) {
      log.error('创建文件夹失败:', error);
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
   * 全量上传文件到云空间（≤20MB）
   * 使用 /drive/v1/files/upload_all 接口（官方推荐用于上传文件到云空间）
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

      // 根据文件扩展名确定 file_type
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const fileType = getFeishuFileType(ext);
      log.info(`上传文件到云空间: ${fileName}, file_type=${fileType}, size=${(size / 1024).toFixed(1)}KB`);

      const formData = new FormData();
      formData.append('file_name', fileName);
      formData.append('parent_type', 'explorer');
      formData.append('parent_node', parentFolderToken);
      formData.append('size', size.toString());
      formData.append('file_type', fileType);

      const blob = new Blob([fileContent]);
      formData.append('file', blob, fileName);

      const data = await this.apiRequest(
        this.getApiUrl('/open-apis/drive/v1/files/upload_all'),
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

      const uploadData = data.data as { file_token?: string } | undefined;
      const fileToken = uploadData?.file_token || '';
      log.debug(`上传成功: ${fileName} → token=${fileToken}`);
      return fileToken;
    } catch (error) {
      log.error('上传文件失败:', error);
      throw error;
    }
  }

  /**
   * 分片上传文件到云空间（>20MB）
   * 飞书分片上传流程：
   * 1. 预上传（创建上传会话）
   * 2. 逐片上传
   * 3. 完成上传
   * 使用 /drive/v1/files/ 系列接口（官方推荐用于上传文件到云空间）
   */
  private async uploadFileChunked(
    fileContent: ArrayBuffer | Uint8Array,
    fileName: string,
    parentFolderToken: string,
    size: number
  ): Promise<string> {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB 每片

    try {
      // 根据文件扩展名确定 file_type
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const fileType = getFeishuFileType(ext);

      // 步骤1：预上传
      const headers = await this.getHeaders();
      const preUploadBody = {
        file_name: fileName,
        parent_type: 'explorer',
        parent_node: parentFolderToken,
        size: size,
        block_size: CHUNK_SIZE,
        file_type: fileType,
      };

      log.info(`分片上传预请求: ${fileName}, file_type=${fileType}, 大小: ${(size / 1024 / 1024).toFixed(2)}MB`);

      const preUploadData = await this.apiRequest(
        this.getApiUrl('/open-apis/drive/v1/files/upload_prepare'),
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

      const prepareData = preUploadData.data as { upload_id?: string; block_num?: number } | undefined;
      const uploadId = prepareData?.upload_id;
      const blockNums = prepareData?.block_num || 0;

      if (!uploadId) {
        throw new Error('分片预上传成功但未返回 upload_id');
      }

      log.debug(`分片上传会话已创建，upload_id: ${uploadId}, 分片数: ${blockNums}`);

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
          this.getApiUrl('/open-apis/drive/v1/files/upload_block'),
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
        log.debug(`分片 ${i + 1}/${blockNums} 上传完成`);
      }

      // 步骤3：完成上传
      const completeHeaders = await this.getHeaders();
      const completeBody = {
        upload_id: uploadId,
        block_num: blockNums,
        block_seq_list: blockSeqList,
      };

      const completeData = await this.apiRequest(
        this.getApiUrl('/open-apis/drive/v1/files/upload_finish'),
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

      const completeResult = completeData.data as { file_token?: string } | undefined;
      const fileToken = completeResult?.file_token || '';
      log.info(`分片上传完成，file_token: ${fileToken}`);
      return fileToken;
    } catch (error) {
      log.error('分片上传失败:', error);
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

    log.debug(`downloadFile 开始: token=${fileToken}, type=${fileType}`);

    // 在线文档需要先导出再下载
    if (['docx', 'sheet', 'bitable', 'doc', 'slides'].includes(fileType)) {
      log.debug(`检测到在线文档类型 ${fileType}，使用导出流程`);
      return this.exportAndDownload(fileToken, fileType);
    }

    // 先尝试 /files/ 端点，失败则回退到 /medias/ 端点
    let lastError: Error | null = null;

    // 策略1: /files/{token}/download（适用于云空间原生文件）
    try {
      log.debug(`尝试 /files/ 端点下载...`);
      const result = await this.downloadWithRetry(
        `/open-apis/drive/v1/files/${fileToken}/download`,
        'files'
      );
      log.debug(`/files/ 端点下载成功，大小: ${result.byteLength} bytes`);
      return result;
    } catch (filesError) {
      lastError = filesError as Error;
      log.debug(`/files/ 端点失败: ${lastError.message}`);
    }

    // 策略2: /medias/{token}/download（适用于素材文件）
    try {
      log.debug(`尝试 /medias/ 端点下载...`);
      const result = await this.downloadWithRetry(
        `/open-apis/drive/v1/medias/${fileToken}/download`,
        'medias'
      );
      log.debug(`/medias/ 端点下载成功，大小: ${result.byteLength} bytes`);
      return result;
    } catch (mediasError) {
      const mediasErr = mediasError as Error;
      log.debug(`/medias/ 端点也失败: ${mediasErr.message}`);
    }

    const errorMsg = `下载文件失败（/files/ 和 /medias/ 端点均失败）: /files/ 错误: ${lastError?.message}`;
    log.error(errorMsg);
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

        const endpoint = this.getApiUrl(apiPath);
        log.debug(`下载请求: ${endpoint} (尝试 ${attempt + 1}/${this.maxRetryAttempts + 1})`);

        const response = await requestUrl({
          url: endpoint,
          method: 'GET',
          headers,
          throw: false,
        });

        log.debug(`响应状态: ${response.status}`);

        if (response.status >= 400) {
          let errorMsg = `HTTP ${response.status}`;
          try {
            const errorData = response.json as { msg?: string } & Record<string, unknown>;
            log.debug(`错误响应内容: ${JSON.stringify(errorData).substring(0, 500)}`);
            errorMsg = `HTTP ${response.status}: ${errorData.msg || JSON.stringify(errorData)}`;
          } catch {
            // 不是 JSON 错误响应
          }
          throw new Error(errorMsg);
        }

        // requestUrl 的 arrayBuffer 属性直接获取二进制数据
        const result = response.arrayBuffer;
        log.debug(`下载成功，大小: ${result.byteLength} bytes`);
        return result;
      } catch (error) {
        lastError = error as Error;
        const msg = lastError.message || '';

        // 不重试 4xx 错误（除了 429 限流）
        if (msg.includes('HTTP 4') && !msg.includes('HTTP 429')) {
          log.debug(`${endpointName} 端点 ${msg}，不再重试`);
          break;
        }

        if (attempt < this.maxRetryAttempts) {
          const delay = 1000 * Math.pow(2, attempt);
          log.debug(`${endpointName} 端点下载失败 (尝试 ${attempt + 1}/${this.maxRetryAttempts + 1})，${delay}ms 后重试: ${msg}`);
          await new Promise(resolve => activeWindow.setTimeout(resolve, delay));
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

    log.debug(`创建导出任务: token=${fileToken}, type=${fileType}, exportType=${exportType}`);

    // 步骤1: 创建导出任务
    const headers = await this.getHeaders(true); // 导出必须使用 user_access_token
    const exportBody: Record<string, unknown> = {
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
        await this.authManager.notifyTokenChange();

        throw new Error(`导出权限不足 (99991679)：当前授权缺少 drive:export:readonly 或 docs:document:export 权限。已清除旧授权，请在设置中重新授权，授权时会自动请求新权限`);
      }
      
      throw new Error(`创建导出任务失败: ${errorMsg}`);
    }

    const exportCreateData = createData.data as { ticket?: string } | undefined;
    const ticket = exportCreateData?.ticket;
    if (!ticket) {
      throw new Error('创建导出任务成功但未返回 ticket');
    }

    log.debug(`导出任务已创建，ticket: ${ticket}`);

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

      const pollResult = pollData.data as {
        result?: {
          job_status: number;
          file_token?: string;
          job_error_msg?: string;
        };
      } | undefined;
      const result = pollResult?.result;
      if (!result) {
        await new Promise(resolve => activeWindow.setTimeout(resolve, 2000));
        continue;
      }

      if (result.job_status === 0) {
        exportFileToken = result.file_token ?? null;
        break;
      } else if (result.job_status === 1 || result.job_status === 2) {
        log.debug(`导出任务进行中 (status: ${result.job_status})...`);
        await new Promise(resolve => activeWindow.setTimeout(resolve, 2000));
        continue;
      } else {
        throw new Error(`导出失败: ${result.job_error_msg || '未知错误'} (status: ${result.job_status})`);
      }
    }

    if (!exportFileToken) {
      throw new Error('导出任务超时');
    }

    log.debug(`导出完成，file_token: ${exportFileToken}`);

    // 步骤3: 下载导出文件
    return this.downloadWithRetry(
      `/open-apis/drive/v1/export_tasks/file/${exportFileToken}/download`,
      'export'
    );
  }

  // ==================== 文件删除 ====================

  /**
   * 删除文件
   * 如果文件已不存在（错误码 1061007），视为删除成功
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
        // 错误码 1061007 表示文件已被删除，视为成功
        if (data.code === 1061007) {
          log.info(`文件 ${fileToken} 已不存在（已被删除），视为删除成功`);
          return;
        }
        throw new Error(`删除文件失败: ${data.msg}`);
      }

      log.info(`文件 ${fileToken} 删除成功`);
    } catch (error) {
      // 捕获 HTTP 404 且包含 "file has been delete" 的情况，也视为成功
      const errMsg = (error as Error).message || '';
      if (errMsg.includes('1061007') || errMsg.includes('file has been delete')) {
        log.info(`文件 ${fileToken} 已不存在（已被删除），视为删除成功`);
        return;
      }
      log.error('删除文件失败:', error);
      throw error;
    }
  }

  // ==================== 文件查找 ====================

  /**
   * 查找文件（根据名称和父文件夹）
   * 注意：飞书导出的文件可能去除了扩展名，因此同时匹配原名和无扩展名形式
   */
  async findFileByName(fileName: string, parentToken: string): Promise<FeishuFileMeta | null> {
    try {
      const files = await this.listFolderContents(parentToken);
      // 飞书导出的文件可能被去除了扩展名，尝试两种形式匹配
      const nameWithoutExtension = fileName.replace(/\.[^.]+$/, '');
      const supportedTypes = new Set(['file', 'docx', 'doc', 'sheet', 'bitable', 'slides']);
      return files.find(f =>
        (f.name === fileName || f.name === nameWithoutExtension) &&
        supportedTypes.has(f.type)
      ) || null;
    } catch (error) {
      log.error('查找文件失败:', error);
      return null;
    }
  }

  /**
   * 检查云端文件是否仍然存在
   * 通过在父文件夹中查找同名文件来验证（飞书没有通过 file_token 直接查文件元数据的 API）
   * 同时匹配文件名和 token，两者任一匹配即视为存在
   * 注意：授权错误会向上抛出，调用方应区分"文件不存在"和"检查出错"
   */
  async checkFileExists(fileToken: string, parentFolderToken: string, fileName: string): Promise<boolean> {
    try {
      const files = await this.listFolderContents(parentFolderToken);
      const supportedTypes = new Set(['file', 'docx', 'doc', 'sheet', 'bitable', 'slides']);
      // 匹配条件：token 相同 或 同名同类型
      return files.some(f => f.token === fileToken || (f.name === fileName && supportedTypes.has(f.type)));
    } catch (error) {
      const errMsg = (error as Error).message || '';
      // 授权错误：向上抛出，让调用方中止操作
      if (errMsg.includes('授权已失效') || errMsg.includes('重新授权')) {
        throw error;
      }
      // 其他错误（如网络问题），保守地认为文件可能已不存在
      log.warn('检查文件存在性失败:', error);
      return false;
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 检查文件大小是否在限制范围内
   * @returns true = 可直接全量上传(≤20MB), false = 需要分片上传
   */
  checkFileSize(sizeInBytes: number): boolean {
    const limitBytes = 20 * 1024 * 1024; // 20MB
    return sizeInBytes <= limitBytes;
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

      // extra 字段官方仅记录 {"drive_route_token":"xxx"} 格式，用于关联已存在的云文档
      // 此处导入场景无需传入 extra，保留注释供后续核实
      // formData.append('extra', JSON.stringify({ drive_route_token: 'xxx' }));

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

      const importUploadData = uploadData.data as { file_token?: string } | undefined;
      const fileToken = importUploadData?.file_token;
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
      log.error('导入文件失败:', error);
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

    const body: Record<string, unknown> = {
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

    const importData = data.data as {
      ticket?: string;
      result?: { ticket?: string };
    } | undefined;
    const ticket = importData?.ticket || importData?.result?.ticket;
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

      const importPollData = data.data as {
        result?: {
          job_status: number;
          token?: string;
          job_error_msg?: string;
        };
      } | undefined;
      const result = importPollData?.result;
      if (!result) {
        await new Promise(resolve => activeWindow.setTimeout(resolve, 1000));
        continue;
      }

      const jobStatus = result.job_status;
      if (jobStatus === 0) {
        return result.token ?? '';
      } else if (jobStatus === 1 || jobStatus === 2) {
        await new Promise(resolve => activeWindow.setTimeout(resolve, 2000));
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
      log.error('移动文件失败:', error);
      throw error;
    }
  }
}
