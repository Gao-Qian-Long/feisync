# 飞书API认证模块设计

## 概述

该模块负责使用飞书开放平台提供的 App ID 和 App Secret 获取 `tenant_access_token`，并管理令牌的生命周期（缓存、刷新）。所有后续的飞书API调用都需要在 `Authorization` 头中携带此令牌。

## 接口

### 认证管理器类

```typescript
export class FeishuAuthManager {
  private appId: string;
  private appSecret: string;
  private cachedToken: string | null = null;
  private tokenExpiry: number | null = null; // 过期时间戳（毫秒）

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * 获取有效的 tenant_access_token。
   * 如果缓存中存在未过期的令牌，则直接返回；
   * 否则调用飞书API获取新令牌。
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
    this.cachedToken = null;
    this.tokenExpiry = null;
    return await this.fetchNewToken();
  }

  /**
   * 调用飞书认证端点获取令牌
   */
  private async fetchNewToken(): Promise<string> {
    const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
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
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.code !== 0) {
        throw new Error(`Feishu API error: ${data.msg}`);
      }

      const token = data.tenant_access_token;
      // 令牌有效期为2小时（7200秒），我们提前5分钟过期以保安全
      this.cachedToken = token;
      this.tokenExpiry = Date.now() + (7200 - 300) * 1000;

      return token;
    } catch (error) {
      console.error('Failed to fetch tenant_access_token:', error);
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
}
```

## 集成到主插件

主插件将持有 `FeishuAuthManager` 实例，并在需要调用飞书API时获取令牌。

### 插件中的使用示例

```typescript
import { FeishuAuthManager } from './feishuAuth';

export default class FlybookPlugin extends Plugin {
  settings: FlybookPluginSettings;
  authManager: FeishuAuthManager | null = null;

  // 在设置变更时更新 authManager
  updateAuthManager() {
    if (this.settings.appId && this.settings.appSecret) {
      this.authManager = new FeishuAuthManager(
        this.settings.appId,
        this.settings.appSecret
      );
    } else {
      this.authManager = null;
    }
  }

  // 测试连接功能
  async testConnection(): Promise<boolean> {
    if (!this.authManager) {
      return false;
    }
    try {
      const token = await this.authManager.getAccessToken();
      // 可选：调用一个简单的API验证令牌，例如查询租户信息
      const isValid = await this.validateToken(token);
      return isValid;
    } catch (error) {
      console.error('Connection test failed:', error);
      return false;
    }
  }

  private async validateToken(token: string): Promise<boolean> {
    const url = 'https://open.feishu.cn/open-apis/tenant/v2/tenant/query';
    const response = await fetch(url, {
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
  }
}
```

## 错误处理

- **网络错误**：捕获 `fetch` 异常，通知用户检查网络连接。
- **凭证错误**：飞书API返回 `code != 0` 时，提示用户检查 App ID 和 App Secret。
- **令牌过期**：通过 `isTokenValid` 检查，自动刷新。

## 配置存储

AuthManager 本身不持久化令牌，因为令牌有效期较短。插件每次启动时都需要重新获取令牌（除非缓存仍在内存中）。Obsidian 插件在重启后内存状态会丢失，因此每次启动后第一次 API 调用都会触发一次令牌获取。

## 安全考虑

- App Secret 以明文形式存储在插件设置中（Obsidian 的 `data.json` 文件中）。虽然 Obsidian 仓库通常位于用户本地，但仍需提醒用户不要公开仓库内容。
- 令牌仅在内存中缓存，不会写入磁盘。
- 所有 API 调用均使用 HTTPS。

## 下一步

1. 在 `feishuApi.ts` 中实现 AuthManager。
2. 在主插件中集成，并在设置变更时更新 AuthManager 实例。
3. 实现“测试连接”按钮，调用 `testConnection` 方法。