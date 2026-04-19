/**
 * 飞书 API 认证模块
 * 负责使用 App ID 和 App Secret 获取 tenant_access_token
 */

const FEISHU_AUTH_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const TOKEN_EXPIRY_BUFFER_SECONDS = 300; // 提前5分钟过期

export class FeishuAuthManager {
  private appId: string;
  private appSecret: string;
  private cachedToken: string | null = null;
  private tokenExpiry: number | null = null; // 毫秒时间戳

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * 更新凭证（当设置变更时调用）
   */
  updateCredentials(appId: string, appSecret: string): void {
    this.appId = appId;
    this.appSecret = appSecret;
    this.clearCache();
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
    const url = FEISHU_AUTH_URL;
    const payload = {
      app_id: this.appId,
      app_secret: this.appSecret,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      if (data.code !== 0) {
        throw new Error(`飞书 API 错误: ${data.msg} (code: ${data.code})`);
      }

      const token = data.tenant_access_token as string;
      // 从 API 响应中读取令牌有效期（秒），如无则默认 7200 秒（2小时）
      const expireSeconds = data.expire || 7200;
      // 提前5分钟过期以确保安全
      const tokenLifetimeSeconds = expireSeconds - TOKEN_EXPIRY_BUFFER_SECONDS;
      this.cachedToken = token;
      this.tokenExpiry = Date.now() + tokenLifetimeSeconds * 1000;

      return token;
    } catch (error) {
      console.error('[Flybook] 获取 tenant_access_token 失败:', error);
      throw error;
    }
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
}

/**
 * 验证令牌是否有效（通过调用一个简单的API）
 */
export async function validateToken(token: string): Promise<boolean> {
  const url = 'https://open.feishu.cn/open-apis/tenant/v2/tenant/query';
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.code === 0;
  } catch (error) {
    console.error('[Flybook] 验证令牌失败:', error);
    return false;
  }
}