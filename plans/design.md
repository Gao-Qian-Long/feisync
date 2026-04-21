# FeiSync 插件设计文档

## 概述

FeiSync 插件将本地 Obsidian 笔记作为**普通文件**同步到飞书 Drive，实现备份和多端访问。插件以本地文件为准，单向同步。

## 设置界面设计

### 设置字段

| 字段名 | 类型 | 描述 | 默认值 |
|--------|------|------|--------|
| `appId` | 文本输入 | 飞书开放平台应用的 App ID | 空 |
| `appSecret` | 文本输入（密码类型） | 飞书开放平台应用的 App Secret | 空 |
| `proxyUrl` | 文本输入 | 代理服务器地址（用于中转 API 请求） | 空 |
| `localFolderPath` | 文本输入 | 本地需要同步的文件夹路径（相对于 Obsidian 仓库根目录） | 空 |
| `feishuRootFolderToken` | 文本输入 | 飞书 Drive 中目标根文件夹的 token（可选）。如果为空，插件将在用户的云空间根目录下创建名为 "ObsidianSync" 的文件夹。 | 空 |
| `autoSyncOnChange` | 开关 | 是否在本地文件变化时自动同步 | `false` |
| `syncInterval` | 数字输入 | 自动同步间隔（分钟），仅当 `autoSyncOnChange` 开启时有效 | `5` |

### 设置存储

```typescript
interface FeiSyncPluginSettings {
  appId: string;
  appSecret: string;
  proxyUrl: string;           // 代理服务器地址
  localFolderPath: string;
  feishuRootFolderToken: string;
  autoSyncOnChange: boolean;
  syncInterval: number;
}
```

## 插件架构

```
┌─────────────────────────────────────────────────────────────┐
│                      FeiSyncPlugin                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  FeishuAuthManager  │  │  FeishuApiClient   │                  │
│  │  - tenant_access_token │  │  - uploadFile()     │                  │
│  │  - user_access_token  │  │  - deleteFile()     │                  │
│  │  - 令牌缓存与刷新      │  │  - listFolder()     │                  │
│  └─────────────────┘  │  - createFolder()   │                  │
│                      └─────────────────┘                  │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │   FileWatcher    │  │   SyncEngine     │                  │
│  │  - 监听文件变化   │  │  - 扫描本地文件   │                  │
│  │  - 防抖调度      │  │  - 协调上传       │                  │
│  └─────────────────┘  └─────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

## 模块说明

### 1. FeishuAuthManager（认证管理）

- 获取并缓存 `tenant_access_token`
- 管理 `user_access_token`（用户授权）
- 自动刷新过期令牌
- 支持代理服务器

### 2. FeishuApiClient（API 客户端）

- **文件操作**：`uploadFile()`, `deleteFile()`, `findFileByName()`
- **文件夹操作**：`listFolderContents()`, `createFolder()`, `ensureFolderPath()`
- 所有 API 调用通过 FeishuAuthManager 获取令牌

### 3. FileWatcher（文件监控）

- 监听 Obsidian Vault 的文件变化事件
- 防抖调度同步，避免频繁触发
- 支持启动/停止控制

### 4. SyncEngine（同步引擎）

- 扫描本地文件夹
- 确保飞书目标文件夹存在
- 逐个上传/更新文件

## 同步流程

```
1. 扫描本地文件夹
   ↓
2. 获取/创建飞书目标文件夹
   ↓
3. 遍历本地文件
   ├─ 检查云端是否存在同名文件
   │  └─ 存在 → 删除旧文件
   └─ 上传新文件
```

## 代理服务器支持

由于飞书 API 不支持 CORS，插件需要通过代理服务器中转请求。

### 代理 URL 配置

```
http://[服务器IPv6地址]:8080
```

### 代理服务器要求

- 支持 HTTP 反向代理
- 支持 DELETE 方法（文件删除 API）
- 正确的 CORS 头配置

详见：`plans/proxy-server-setup.md`

## 命令和交互

### 命令面板

- **FeiSync: Sync now**：手动触发同步

### Ribbon 图标

- 点击显示菜单：
  - 立即同步
  - 打开设置

### 通知

- 同步开始/完成/失败通知
- 错误详情通过控制台输出

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 凭证未配置 | 显示设置提示 |
| 网络错误 | 抛出异常，显示错误消息 |
| 文件大小超限 | 跳过文件，记录警告 |
| 令牌过期 | 自动刷新重试 |

## 数据持久化

- **设置**：`plugin.loadData()` / `plugin.saveData()`
- **用户令牌**：加密存储在 `data.json` 中

## 下一步

1. 完善用户授权流程（OAuth）
2. 添加下载功能（从飞书恢复文件）
3. 支持双向同步
4. 增量同步优化（基于修改时间）
