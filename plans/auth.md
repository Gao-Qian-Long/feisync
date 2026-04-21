# 飞书 API 认证模块设计

## 概述

该模块负责使用飞书开放平台获取访问令牌，支持两种认证方式：

1. **tenant_access_token（应用访问凭证）**：以应用身份访问，文件存储在应用云空间。
2. **user_access_token（用户访问凭证）**：以用户身份访问，文件存储在用户的个人云空间。

## 认证方式对比

| 特性 | tenant_access_token | user_access_token |
|------|---------------------|-------------------|
| 适用场景 | 应用云空间 | 用户个人云空间 |
| 文件存储位置 | 应用创建的文件夹 | 用户个人文件夹 |
| UI 可见性 | 不可见（仅 API 管理） | 可见（用户可在飞书客户端看到） |
| 权限来源 | 应用权限 | 用户授权 + 应用权限 |
| 刷新方式 | 自动过期刷新 | 需要用户重新授权 |

## API 端点

### 1. 获取 tenant_access_token

```
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
```

### 2. 获取 user_access_token

用户授权流程（通过 OAuth 2.0）：
1. 引导用户访问授权页面
2. 用户授权后，获取 authorization_code
3. 使用 code 换取 user_access_token

## 实现

### FeishuAuthManager

```typescript
export class FeishuAuthManager {
  private appId: string;
  private appSecret: string;
  private proxyUrl: string;
  
  // tenant_access_token 缓存
  private cachedToken: string | null = null;
  private tokenExpiry: number | null = null;

  // user_access_token
  private userAccessToken: string | null = null;
  private userTokenExpiry: number | null = null;

  constructor(appId: string, appSecret: string, proxyUrl: string = '') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.proxyUrl = proxyUrl;
  }

  /**
   * 获取有效的 tenant_access_token
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }
    return await this.fetchTenantToken();
  }

  /**
   * 获取用户访问凭证
   * 如果已授权且未过期，直接返回；否则需要用户重新授权
   */
  async getUserAccessToken(): Promise<string> {
    if (this.isUserTokenValid()) {
      return this.userAccessToken!;
    }
    throw new Error('用户未授权或授权已过期');
  }

  /**
   * 检查用户是否已授权
   */
  isUserAuthorized(): boolean {
    return this.isUserTokenValid();
  }

  /**
   * 检查 tenant token 是否有效
   */
  private isTokenValid(): boolean {
    if (!this.cachedToken || !this.tokenExpiry) {
      return false;
    }
    return Date.now() < this.tokenExpiry;
  }

  /**
   * 检查 user token 是否有效
   */
  private isUserTokenValid(): boolean {
    if (!this.userAccessToken || !this.userTokenExpiry) {
      return false;
    }
    return Date.now() < this.userTokenExpiry;
  }

  /**
   * 获取 tenant_access_token
   */
  private async fetchTenantToken(): Promise<string> {
    const url = this.getApiUrl('/open-apis/auth/v3/tenant_access_token/internal');
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`获取令牌失败: ${data.msg}`);
    }

    // 令牌有效期为 2 小时（7200 秒），提前 5 分钟过期
    this.cachedToken = data.tenant_access_token;
    this.tokenExpiry = Date.now() + (7200 - 300) * 1000;

    return this.cachedToken;
  }

  /**
   * 获取 API URL（支持代理）
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
   * 更新凭证
   */
  updateCredentials(appId: string, appSecret: string, proxyUrl: string): void {
    this.appId = appId;
    this.appSecret = appSecret;
    this.proxyUrl = proxyUrl;
    this.clearCache();
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cachedToken = null;
    this.tokenExpiry = null;
    this.userAccessToken = null;
    this.userTokenExpiry = null;
  }
}
```

## token 选择策略

在调用 API 时，优先使用 user_access_token（如果已授权），否则使用 tenant_access_token：

```typescript
private async getHeaders(): Promise<Record<string, string>> {
  let token: string;
  
  if (this.authManager.isUserAuthorized()) {
    try {
      token = await this.authManager.getUserAccessToken();
    } catch {
      // 获取用户令牌失败，回退到 tenant token
      token = await this.authManager.getAccessToken();
    }
  } else {
    token = await this.authManager.getAccessToken();
  }
  
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}
```

## 令牌持久化

- **tenant_access_token**：不持久化，每次启动时重新获取（有效期 2 小时足够）。
- **user_access_token**：需要持久化，以便下次启动时恢复。使用 `plugin.loadData()` / `plugin.saveData()` 存储。

```typescript
// 恢复用户令牌
async loadUserToken(): Promise<void> {
  const data = await this.loadData();
  if (data?.feshuUserToken) {
    const tokenInfo = JSON.parse(data.feshuUserToken);
    if (tokenInfo.expiresAt > Date.now()) {
      this.authManager.loadUserToken(tokenInfo);
    }
  }
}

// 保存用户令牌
async saveUserToken(): Promise<void> {
  if (this.authManager.isUserAuthorized()) {
    const data = await this.loadData();
    data.feshuUserToken = JSON.stringify(this.authManager.getUserTokenInfo());
    await this.saveData(data);
  }
}
```

## 错误处理

| 错误类型 | 处理方式 |
|----------|----------|
| 网络错误 | 抛出异常，上层处理重试 |
| 凭证错误 | 提示用户检查 App ID 和 App Secret |
| 令牌过期 | 自动刷新 |
| 用户未授权 | 提示用户进行授权 |

## 安全考虑

1. **App Secret**：存储在插件设置中，用户应妥善保管。
2. **令牌**：仅在内存中缓存，不写入磁盘（user_token 除外）。
3. **代理**：如果使用代理，确保代理服务器可信。
4. **HTTPS**：所有 API 调用均通过 HTTPS。
