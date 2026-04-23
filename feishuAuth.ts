/**
 * 飞书 API 认证模块
 * 负责使用 App ID 和 App Secret 获取 tenant_access_token
 * 以及实现 user_access_token 的 OAuth 授权流程
 */

import { requestUrl } from 'obsidian';
import * as http from 'http';
import { createLogger } from './logger';

const log = createLogger('FeishuAuth');

const TOKEN_EXPIRY_BUFFER_SECONDS = 300; // 提前5分钟过期

// 用户 token 信息接口
export interface UserTokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;  // 毫秒时间戳
  openId?: string;
  unionId?: string;
}

// Token 存储接口
interface TokenStorage {
  set(key: string, value: string): void;
  getString(key: string): string;
}

export class FeishuAuthManager {
  private appId: string;
  private appSecret: string;
  private proxyUrl: string; // 代理服务器地址，留空则直连
  private cachedToken: string | null = null;
  private tokenExpiry: number | null = null; // 毫秒时间戳
  
  // 用户授权相关
  private userTokenInfo: UserTokenInfo | null = null;
  private oauthState: string = '';  // OAuth 状态码，用于防止 CSRF 攻击
  private callbackCancelFn: (() => void) | null = null; // 用于取消本地回调等待
  private onTokenChange: (() => Promise<void>) | null = null; // token 变化时的回调（用于持久化）
  private refreshPromise: Promise<UserTokenInfo> | null = null; // 刷新锁，防止并发刷新
  private _wasUserAuthorized: boolean = false; // 标记用户是否曾经授权过（即使 token 失效也为 true）

  constructor(appId: string, appSecret: string, proxyUrl: string = '', onTokenChange?: () => Promise<void>) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.proxyUrl = proxyUrl;
    this.onTokenChange = onTokenChange ?? null;
  }

  /**
   * 更新凭证（当设置变更时调用）
   */
  updateCredentials(appId: string, appSecret: string, proxyUrl: string = ''): void {
    this.appId = appId;
    this.appSecret = appSecret;
    this.proxyUrl = proxyUrl;
    this.clearCache();
  }

  /**
   * 仅在凭证确实变更时才更新，避免不必要的 token 刷新
   * @returns true 表示凭证已变更并更新，false 表示未变更
   */
  updateCredentialsIfNeeded(appId: string, appSecret: string, proxyUrl: string = ''): boolean {
    if (this.appId === appId && this.appSecret === appSecret && this.proxyUrl === proxyUrl) {
      return false;
    }
    this.appId = appId;
    this.appSecret = appSecret;
    this.proxyUrl = proxyUrl;
    this.clearCache();
    return true;
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
   * 获取有效的 tenant_access_token
   * 如果缓存中存在未过期的令牌，则直接返回；否则调用飞书API获取新令牌
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }
    return await this.fetchNewToken();
  }

  /**
   * 获取 app_access_token（用于 OAuth 流程）
   * app_access_token 与 tenant_access_token 不同
   */
  async getAppAccessToken(): Promise<string> {
    const url = this.getApiUrl('/open-apis/auth/v3/app_access_token/internal');
    
    const payload = {
      app_id: this.appId,
      app_secret: this.appSecret,
    };

    const response = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    const data = response.json;
    if (data.code !== 0) {
      throw new Error(`获取 app_access_token 失败: ${data.msg} (code: ${data.code})`);
    }

    return data.app_access_token;
  }

  /**
   * 强制刷新令牌（例如凭证更改后）
   */
  async refreshToken(): Promise<string> {
    this.clearCache();
    return await this.fetchNewToken();
  }

  /**
   * 调用飞书认证端点获取令牌
   */
  private async fetchNewToken(): Promise<string> {
    const url = this.getApiUrl('/open-apis/auth/v3/tenant_access_token/internal');
    const payload = {
      app_id: this.appId,
      app_secret: this.appSecret,
    };

    // 检查凭证是否为空
    if (!this.appId || !this.appSecret) {
      throw new Error('飞书凭证未配置，请检查 App ID 和 App Secret');
    }

    const MAX_RETRIES = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await requestUrl({
          url,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          throw: false,
        });

        const data = response.json;
        if (data.code !== 0) {
          throw new Error(`飞书 API 错误: ${data.msg} (code: ${data.code})`);
        }

        const token = data.tenant_access_token as string;
        // 从 API 响应中读取令牌有效期（秒），如无则默认 7200 秒（2小时）
        const expireSeconds = typeof data.expire === 'number' ? data.expire : 7200;
        // 提前5分钟过期以确保安全，但保留至少60秒有效时间
        const tokenLifetimeSeconds = Math.max(60, expireSeconds - TOKEN_EXPIRY_BUFFER_SECONDS);
        this.cachedToken = token;
        this.tokenExpiry = Date.now() + tokenLifetimeSeconds * 1000;

        return token;
      } catch (error) {
        lastError = error as Error;
        log.warn(`获取 tenant_access_token 失败 (尝试 ${attempt + 1}/${MAX_RETRIES + 1}):`, error);
        // 如果不是最后一次尝试，等待片刻后重试
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // 递增延迟
        }
      }
    }

    // 所有尝试都失败
    log.error('获取 tenant_access_token 失败，已重试', MAX_RETRIES, '次');
    let errorMessage = lastError?.message || '未知错误';
    if (lastError instanceof TypeError && errorMessage.includes('Failed to fetch')) {
      errorMessage = `网络请求失败，请检查网络连接、代理设置以及飞书 API 端点可达性。原始错误: ${errorMessage}`;
    }
    throw new Error(`获取飞书访问令牌失败: ${errorMessage}`);
  }

  /**
   * 检查缓存令牌是否仍然有效
   */
  private isTokenValid(): boolean {
    if (!this.cachedToken || !this.tokenExpiry) {
      return false;
    }
    return Date.now() < this.tokenExpiry;
  }

  /**
   * 清除缓存（用于登出或凭证更改）
   */
  clearCache(): void {
    this.cachedToken = null;
    this.tokenExpiry = null;
  }

  /**
   * 检查凭证是否已配置
   */
  isConfigured(): boolean {
    return !!this.appId && !!this.appSecret;
  }

  // ==================== 用户授权相关方法 ====================

  /**
   * 生成 OAuth 授权 URL
   * @param redirectUri 回调 URI（用户会被重定向到这个地址）
   * @returns 授权 URL
   */
  generateOAuthUrl(redirectUri: string = 'http://localhost:9527/callback'): string {
    // 生成随机 state 用于防止 CSRF 攻击
    this.oauthState = this.generateRandomString(32);
    
    // 请求必要的权限范围
    // drive:drive - 访问云文档/云空间
    // drive:export:readonly - 导出云文档（下载在线文档需要）
    // drive:file:download - 下载云空间文件
    // docx:document - 访问和编辑新版文档
    // docs:document:import - 导入文档
    // docs:document:export - 导出文档（导出在线文档需要）
    const scope = 'drive:drive drive:export:readonly drive:file:download docx:document docs:document:import docs:document:export offline_access';
    
    const params = new URLSearchParams({
      app_id: this.appId,
      redirect_uri: redirectUri,
      state: this.oauthState,
      response_type: 'code',
      scope: scope,
    });
    
    const url = this.getApiUrl('/open-apis/authen/v1/authorize') + '?' + params.toString();
    log.info('OAuth 授权 URL:', url);
    return url;
  }

  /**
   * 启动本地回调服务器，自动捕获飞书 OAuth 回调中的授权码
   * @param port 监听端口（默认 9527）
   * @returns 捕获到的授权码
   */
  async startLocalCallbackServer(port: number = 9527): Promise<string> {
    return new Promise((resolve, reject) => {
      let server: http.Server | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let resolved = false; // 防止浏览器重复请求导致多次处理

      const cleanup = () => {
        this.callbackCancelFn = null;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (server) {
          server.close(() => {
            log.debug(`本地回调服务器已关闭（端口 ${port}）`);
          });
          server = null;
        }
      };

      // 注册取消函数，供外部主动中断
      this.callbackCancelFn = () => {
        cleanup();
        if (!resolved) {
          resolved = true;
          reject(new Error('授权已取消'));
        }
      };

      server = http.createServer((req, res) => {
        // 如果已经处理过，直接返回，不再重复处理
        if (resolved) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<p>授权已完成，请关闭此页面。</p>');
          return;
        }

        try {
          const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
          const code = reqUrl.searchParams.get('code');
          const state = reqUrl.searchParams.get('state');
          const error = reqUrl.searchParams.get('error');

          // 飞书返回了错误
          if (error) {
            const errorDesc = reqUrl.searchParams.get('error_description') || '未知错误';
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h1>授权失败</h1><p>${error}: ${errorDesc}</p><p>请返回 Obsidian 查看详情。</p>`);
            resolved = true;
            cleanup();
            reject(new Error(`飞书授权错误: ${error} - ${errorDesc}`));
            return;
          }

          // 没有 code（如 favicon.ico 等请求，忽略即可）
          if (!code) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
          }

          // 校验 state，防止 CSRF
          if (state !== this.oauthState) {
            res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>授权失败</h1><p>State 校验失败，可能存在安全风险。请返回 Obsidian 重试。</p>');
            resolved = true;
            cleanup();
            reject(new Error('OAuth state 校验失败'));
            return;
          }

          // 成功捕获 code
          resolved = true;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<h1 style="color:green">授权成功！</h1>' +
            '<p>您已完成飞书授权，可以关闭此页面并返回 Obsidian 继续使用。</p>' +
            '<script>setTimeout(() => window.close(), 3000)</script>'
          );
          cleanup();
          resolve(code);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>服务器错误</h1><p>处理回调时发生异常，请返回 Obsidian 重试。</p>');
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });

      // 超时处理：3 分钟未收到回调则关闭服务器
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('等待授权回调超时（3分钟），请重新尝试授权'));
      }, 3 * 60 * 1000);

      server.listen(port, () => {
        log.info(`本地回调服务器已启动，监听 http://localhost:${port}/callback`);
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${port} 已被占用，请检查是否有其他进程占用了该端口`));
        } else {
          reject(new Error(`启动本地回调服务器失败: ${err.message}`));
        }
      });
    });
  }

  /**
   * 主动取消正在等待的本地回调服务器
   */
  abortLocalCallbackServer(): void {
    if (this.callbackCancelFn) {
      this.callbackCancelFn();
    }
  }

  /**
   * 使用授权码获取用户访问令牌
   * @param code 授权码（用户授权后获得）
   * @param redirectUri 授权时使用的回调地址，必须与生成 URL 时一致
   * @returns 用户令牌信息
   */
  async exchangeCodeForUserToken(code: string, redirectUri: string = 'http://localhost:9527/callback'): Promise<UserTokenInfo> {
    const url = this.getApiUrl('/open-apis/authen/v2/oauth/token');

    const payload = {
      grant_type: 'authorization_code',
      client_id: this.appId,
      client_secret: this.appSecret,
      code: code,
      redirect_uri: redirectUri,
    };

    log.info('正在交换授权码获取用户令牌...');

    const response = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    const data = response.json;
    log.debug('OAuth 响应:', JSON.stringify(data, null, 2));

    if (data.code !== 0) {
      throw new Error(`获取用户令牌失败: ${data.msg || data.error_description} (code: ${data.code || data.error})`);
    }

    // 兼容 v2 接口的两种返回结构：data.data.xxx 或 data.xxx
    const result = data.data || data;
    const expiresIn = typeof result.expires_in === 'number' ? result.expires_in : 7200;
    const effectiveExpirySeconds = Math.max(60, expiresIn - TOKEN_EXPIRY_BUFFER_SECONDS);
    const tokenInfo: UserTokenInfo = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + effectiveExpirySeconds * 1000,
      openId: result.open_id || '',
      unionId: result.union_id || '',
    };

    this.userTokenInfo = tokenInfo;
    this._wasUserAuthorized = true;
    log.info('用户令牌获取成功，有效期至:', new Date(tokenInfo.expiresAt).toLocaleString());
    try {
      await this.onTokenChange?.();
    } catch (err) {
      log.error('Token 持久化回调失败:', err);
    }

    return tokenInfo;
  }

  /**
   * 刷新用户访问令牌
   * @returns 新的用户令牌信息
   */
  async refreshUserToken(): Promise<UserTokenInfo> {
    if (!this.userTokenInfo || !this.userTokenInfo.refreshToken) {
      throw new Error('没有可刷新的用户令牌');
    }

    const url = this.getApiUrl('/open-apis/authen/v2/oauth/token');

    const payload = {
      grant_type: 'refresh_token',
      refresh_token: this.userTokenInfo.refreshToken,
      client_id: this.appId,
      client_secret: this.appSecret,
    };

    log.info('正在刷新用户令牌...');

    const response = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    const data = response.json;
    if (data.code !== 0) {
      throw new Error(`刷新用户令牌失败: ${data.msg} (code: ${data.code})`);
    }

    // 兼容 v2 接口的两种返回结构：data.data.xxx 或 data.xxx
    const result = data.data || data;
    const expiresIn = typeof result.expires_in === 'number' ? result.expires_in : 7200;
    const effectiveExpirySeconds = Math.max(60, expiresIn - TOKEN_EXPIRY_BUFFER_SECONDS);
    const tokenInfo: UserTokenInfo = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + effectiveExpirySeconds * 1000,
      openId: result.open_id || '',
      unionId: result.union_id || '',
    };

    this.userTokenInfo = tokenInfo;
    log.info('用户令牌刷新成功，有效期至:', new Date(tokenInfo.expiresAt).toLocaleString());
    try {
      await this.onTokenChange?.();
    } catch (err) {
      log.error('Token 持久化回调失败:', err);
    }

    return tokenInfo;
  }

  /**
   * 获取有效的用户访问令牌
   * 如果用户令牌不存在或已过期，自动刷新
   * 注意：飞书 refresh_token 是一次性的，刷新成功后旧 token 立即失效
   * 使用刷新锁防止并发请求导致 refresh_token 被重复使用（20064 错误）
   */
  async getUserAccessToken(): Promise<string> {
    // 如果没有用户令牌，抛出错误
    if (!this.userTokenInfo) {
      throw new Error('用户未授权，请先进行 OAuth 授权');
    }

    // 检查是否即将过期（5分钟内），如果快过期了先刷新
    if (Date.now() > this.userTokenInfo.expiresAt - 5 * 60 * 1000) {
      // 刷新锁：如果已有刷新操作在进行中，等待它完成而不是再次刷新
      if (!this.refreshPromise) {
        log.debug('用户令牌即将过期，尝试刷新...');
        this.refreshPromise = this.doRefreshUserToken().finally(() => {
          this.refreshPromise = null; // 刷新完成后释放锁
        });
      } else {
        log.debug('已有刷新操作进行中，等待完成...');
      }

      try {
        await this.refreshPromise;
      } catch (error) {
        // 刷新失败，错误已在 doRefreshUserToken 中处理
        throw error;
      }

      // 刷新后检查 token 是否仍可用（可能已被清除需要重新授权）
      if (!this.userTokenInfo) {
        throw new Error('用户令牌已过期且刷新失败，请重新授权');
      }
    }

    return this.userTokenInfo.accessToken;
  }

  /**
   * 执行用户令牌刷新（内部方法，含错误处理）
   * 刷新失败时清除用户令牌，防止后续请求继续使用失效的 refresh_token
   */
  private async doRefreshUserToken(): Promise<UserTokenInfo> {
    try {
      return await this.refreshUserToken();
    } catch (error) {
      const errMsg = (error as Error).message || '';
      log.error('刷新用户令牌失败:', error);

      if (errMsg.includes('invalid_grant') || errMsg.includes('revoked') || errMsg.includes('20064')) {
        // refresh_token 已被撤销，需要重新授权
        log.warn('refresh_token 已失效，需要重新授权');
        this.clearUserToken();
        await this.notifyTokenChange();
        throw new Error('用户令牌已过期且刷新失败，请重新授权');
      }

      throw new Error('用户令牌已过期，请重新授权');
    }
  }

  /**
   * 检查用户是否已授权
   * 只要存在 token 信息（含 refresh_token）即视为已授权，
   * 过期后可通过 refresh_token 自动续期，无需重新授权
   */
  isUserAuthorized(): boolean {
    return this.userTokenInfo !== null && !!this.userTokenInfo.refreshToken;
  }

  /**
   * 检查用户是否曾经授权过（即使 token 已失效）
   * 用于区分"从未授权"和"授权过但失效"两种状态
   * 一旦用户授权过，不应回退到 tenant_access_token
   */
  wasUserAuthorized(): boolean {
    return this._wasUserAuthorized;
  }

  /**
   * 清除用户授权信息（登出）
   */
  clearUserToken(): void {
    this.userTokenInfo = null;
    this.oauthState = '';
    log.info('用户授权信息已清除');
  }

  /**
   * 生成密码学安全的随机字符串（用于 OAuth state）
   */
  private generateRandomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[array[i] % chars.length];
    }
    return result;
  }

  /**
   * 通知 token 变化（供外部调用，避免直接访问私有属性）
   */
  async notifyTokenChange(): Promise<void> {
    await this.onTokenChange?.();
  }

  /**
   * 保存用户令牌到本地存储（供下次启动时恢复）
   */
  saveUserTokenToStorage(storage: TokenStorage): void {
    if (this.userTokenInfo) {
      storage.set('feishuUserToken', JSON.stringify(this.userTokenInfo));
      log.info('用户令牌已保存');
    }
  }

  /**
   * 从本地存储恢复用户令牌
   * 即使 access_token 已过期，只要有 refresh_token 就恢复，
   * 后续调用 getUserAccessToken() 会自动刷新
   */
  loadUserTokenFromStorage(storage: TokenStorage): void {
    const saved = storage.getString('feishuUserToken');
    if (saved) {
      try {
        const tokenInfo = JSON.parse(saved) as UserTokenInfo;
        if (tokenInfo.refreshToken) {
          this.userTokenInfo = tokenInfo;
          this._wasUserAuthorized = true;
          const status = tokenInfo.expiresAt > Date.now() ? '有效' : '已过期，将自动刷新';
          log.info(`用户令牌已从存储恢复（${status}）`);
        } else {
          log.debug('存储的令牌无 refresh_token，无法自动续期');
        }
      } catch (error) {
        log.error('解析保存的用户令牌失败:', error);
      }
    }
  }

  /**
   * 从数据对象加载用户令牌（用于从插件 loadData 恢复）
   * 即使 access_token 已过期，只要有 refresh_token 就恢复
   */
  loadUserTokenFromData(tokenInfo: UserTokenInfo): void {
    if (tokenInfo.refreshToken) {
      this.userTokenInfo = tokenInfo;
      this._wasUserAuthorized = true;
      const status = tokenInfo.expiresAt > Date.now() ? '有效' : '已过期，将自动刷新';
      log.info(`用户令牌已恢复（${status}）`);
    } else {
      log.debug('恢复的令牌无 refresh_token，无法自动续期');
    }
  }

  /**
   * 获取用户令牌信息（用于保存到存储）
   */
  getUserTokenInfo(): UserTokenInfo | null {
    return this.userTokenInfo;
  }
}

/**
 * 验证令牌是否有效（通过调用一个简单的API）
 * @param token 访问令牌
 * @param proxyUrl 代理服务器地址（可选）
 */
export async function validateToken(token: string, proxyUrl: string = ''): Promise<boolean> {
  // 获取 API URL（支持代理）
  let url = 'https://open.feishu.cn/open-apis/tenant/v2/tenant/query';
  if (proxyUrl) {
    const baseUrl = proxyUrl.replace(/\/$/, '');
    url = `${baseUrl}/open-apis/tenant/v2/tenant/query`;
  }

  try {
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      throw: false,
    });

    const data = response.json;
    return data.code === 0;
  } catch (error) {
    log.error('验证令牌失败:', error);
    return false;
  }
}