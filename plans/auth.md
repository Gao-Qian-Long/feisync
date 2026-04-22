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
| 刷新方式 | 自动过期刷新 | refresh_token 自动刷新 |
| IP 白名单 | 需要 | 不需要 |

## API 端点

### 1. 获取 tenant_access_token

```
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
```

### 2. 获取 app_access_token

```
POST https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal
```

### 3. OAuth 用户授权

```
GET https://open.feishu.cn/open-apis/authen/v1/authorize
```

### 4. 授权码换令牌 / 刷新令牌

```
POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
```

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
  private userTokenInfo: UserTokenInfo | null = null;
  private oauthState: string = '';
  private refreshPromise: Promise<UserTokenInfo> | null = null;
  private _wasUserAuthorized: boolean = false;

  constructor(appId: string, appSecret: string, proxyUrl: string = '', onTokenChange?: () => Promise<void>) {
    // ...
  }

  /**
   * 获取有效的 tenant_access_token
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }
    return await this.fetchNewToken();
  }

  /**
   * 获取用户访问凭证（自动刷新）
   */
  async getUserAccessToken(): Promise<string> {
    if (!this.userTokenInfo) {
      throw new Error('用户未授权，请先进行 OAuth 授权');
    }

    // 检查是否即将过期（5分钟内），如果快过期了先刷新
    if (Date.now() > this.userTokenInfo.expiresAt - 5 * 60 * 1000) {
      // 刷新锁：如果已有刷新操作在进行中，等待它完成
      if (!this.refreshPromise) {
        this.refreshPromise = this.doRefreshUserToken().finally(() => {
          this.refreshPromise = null;
        });
      } else {
        await this.refreshPromise;
      }
    }

    return this.userTokenInfo.accessToken;
  }
}
```

## 用户令牌信息结构

```typescript
export interface UserTokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;  // 毫秒时间戳
  openId?: string;
  unionId?: string;
}
```

## OAuth 授权流程

### 1. 生成授权 URL

```typescript
generateOAuthUrl(redirectUri: string = 'http://localhost:9527/callback'): string {
  this.oauthState = this.generateRandomString(32);
  
  const scope = 'drive:drive drive:export:readonly drive:file:download docx:document docs:document:import docs:document:export offline_access';
  
  const params = new URLSearchParams({
    app_id: this.appId,
    redirect_uri: redirectUri,
    state: this.oauthState,
    response_type: 'code',
    scope: scope,
  });
  
  return this.getApiUrl('/open-apis/authen/v1/authorize') + '?' + params.toString();
}
```

### 2. 启动本地回调服务器

```typescript
async startLocalCallbackServer(port: number = 9527): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      
      // 校验 state，防止 CSRF
      if (state !== this.oauthState) {
        reject(new Error('OAuth state 校验失败'));
        return;
      }
      
      if (code) {
        resolve(code);
      }
    });
    
    // 超时处理：3 分钟
    server.listen(port);
  });
}
```

### 3. 交换授权码获取令牌

```typescript
async exchangeCodeForUserToken(code: string, redirectUri: string): Promise<UserTokenInfo> {
  const payload = {
    grant_type: 'authorization_code',
    client_id: this.appId,
    client_secret: this.appSecret,
    code: code,
    redirect_uri: redirectUri,
  };
  
  const response = await requestUrl({
    url: this.getApiUrl('/open-apis/authen/v2/oauth/token'),
    method: 'POST',
    body: JSON.stringify(payload),
  });
  
  const result = response.json.data || response.json;
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + (result.expires_in - 300) * 1000,
    openId: result.open_id,
    unionId: result.union_id,
  };
}
```

## 令牌刷新机制

```typescript
private async doRefreshUserToken(): Promise<UserTokenInfo> {
  try {
    return await this.refreshUserToken();
  } catch (error) {
    const errMsg = (error as Error).message || '';
    
    if (errMsg.includes('invalid_grant') || errMsg.includes('revoked') || errMsg.includes('20064')) {
      // refresh_token 已被撤销，需要重新授权
      this.clearUserToken();
      await this.onTokenChange?.();
      throw new Error('用户令牌已过期且刷新失败，请重新授权');
    }
    
    throw new Error('用户令牌已过期，请重新授权');
  }
}
```

## 令牌选择策略

在调用 API 时，优先使用 user_access_token（如果已授权），否则使用 tenant_access_token：

```typescript
private async getHeaders(): Promise<Record<string, string>> {
  let token: string;
  
  if (this.authManager.wasUserAuthorized()) {
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

```typescript
// 保存用户令牌
saveUserTokenToStorage(storage: any): void {
  if (this.userTokenInfo) {
    storage.set('feishuUserToken', JSON.stringify(this.userTokenInfo));
  }
}

// 从存储恢复用户令牌
loadUserTokenFromStorage(storage: any): void {
  const saved = storage.getString('feishuUserToken');
  if (saved) {
    const tokenInfo = JSON.parse(saved) as UserTokenInfo;
    if (tokenInfo.refreshToken) {
      this.userTokenInfo = tokenInfo;
      this._wasUserAuthorized = true;
    }
  }
}
```

## 错误处理

| 错误类型 | 处理方式 |
|----------|----------|
| 网络错误 | 重试 2 次后抛出异常 |
| 凭证错误 | 提示用户检查 App ID 和 App Secret |
| 令牌过期 | 自动刷新 |
| refresh_token 失效 | 清除令牌，提示重新授权 |
| 用户未授权 | 提示用户进行授权 |

## 安全考虑

1. **App Secret**：存储在插件设置中，用户应妥善保管。
2. **令牌**：仅在内存中缓存，令牌信息写入本地存储。
3. **代理**：如果使用代理，确保代理服务器可信。
4. **HTTPS**：所有 API 调用均通过 HTTPS。
5. **OAuth State**：使用随机字符串防止 CSRF 攻击。
