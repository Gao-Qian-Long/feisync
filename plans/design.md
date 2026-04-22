# FeiSync 插件设计文档

## 概述

FeiSync 插件将本地 Obsidian 笔记作为**普通文件**同步到飞书 Drive，实现备份和多端访问。插件以本地文件为准，单向同步。

### 主要功能特性

- **多文件夹同步**：支持同时配置多个本地文件夹到飞书的不同目标文件夹
- **忽略规则**：支持 `.feisyncignore` 文件，语法兼容 gitignore
- **统一日志**：分级日志输出，支持 DEBUG/INFO/WARN/ERROR 四级
- **并发控制**：支持配置最大并发上传数，避免 API 限流

## 设置界面设计

### 设置字段

| 字段名 | 类型 | 描述 | 默认值 |
|--------|------|------|--------|
| `appId` | 文本输入 | 飞书开放平台应用的 App ID | 空 |
| `appSecret` | 文本输入（密码类型） | 飞书开放平台应用的 App Secret | 空 |
| `proxyUrl` | 文本输入 | 代理服务器地址（用于中转 API 请求） | 空 |
| `syncFolders` | SyncFolderConfig[] | 多文件夹同步配置列表 | [] |
| `autoSyncOnChange` | 开关 | 是否在本地文件变化时自动同步 | `false` |
| `autoSyncOnDelete` | 开关 | 是否在本地文件删除时同步删除云端文件 | `true` |
| `syncInterval` | 数字输入 | 自动同步间隔（分钟），仅当 `autoSyncOnChange` 开启时有效 | `5` |
| `autoSyncInterval` | 数字输入 | 定时同步间隔（分钟），0 表示禁用定时同步 | `0` |
| `maxConcurrentUploads` | 数字输入 | 最大并发上传数 | `3` |
| `logLevel` | 下拉选择 | 日志级别（DEBUG/INFO/WARN/ERROR） | `DEBUG` |

### 设置存储

```typescript
interface FeiSyncPluginSettings {
  appId: string;
  appSecret: string;
  proxyUrl: string;
  syncFolders: SyncFolderConfig[];
  autoSyncOnChange: boolean;
  autoSyncOnDelete: boolean;
  syncInterval: number;
  autoSyncInterval: number;
  maxConcurrentUploads: number;
  logLevel: LogLevel;
}

interface SyncFolderConfig {
  id: string;
  localPath: string;
  remoteFolderToken: string;
  enabled: boolean;
  mode: 'auto' | 'custom';
  lastSyncTime: number;
  lastSyncFileCount: number;
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
│  │  - OAuth 授权流程     │  │  - createFolder()   │                  │
│  └─────────────────┘  │  - downloadFile()   │                  │
│                      │  - exportDocument()  │                  │
│                      └─────────────────┘                  │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │   FileWatcher    │  │   SyncEngine     │                  │
│  │  - 监听文件变化   │  │  - 扫描本地文件   │                  │
│  │  - 防抖调度      │  │  - 协调上传       │                  │
│  │  - 忽略规则过滤   │  │  - 增量判断       │                  │
│  └─────────────────┘  └─────────────────┘                  │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │   SyncFolderConfig │  │  IgnoreFilter    │                  │
│  │  - 多文件夹映射    │  │  - .feisyncignore │                  │
│  │  - 配置迁移      │  │  - gitignore 兼容  │                  │
│  └─────────────────┘  └─────────────────┘                  │
│  ┌─────────────────┐                                       │
│  │     Logger       │                                       │
│  │  - 分级日志输出   │                                       │
│  │  - 模块化日志器   │                                       │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## 模块说明

### 1. FeishuAuthManager（认证管理）

- 获取并缓存 `tenant_access_token`（应用凭证）
- 管理 `user_access_token`（用户 OAuth 授权）
- 自动刷新过期令牌（refresh_token 机制）
- 支持代理服务器
- 令牌持久化存储和恢复

### 2. FeishuApiClient（API 客户端）

- **文件操作**：`uploadFile()`, `deleteFile()`, `findFileByName()`, `downloadFile()`
- **文件夹操作**：`listFolderContents()`, `createFolder()`, `ensureFolderPath()`
- **文档导入导出**：`importFileAsDocument()`, `exportDocument()`
- **速率限制**：5 QPS 限制，通过 RateLimiter 实现
- **重试机制**：自动重试 recoverable 错误
- **并发控制**：支持配置最大并发数

### 3. FileWatcher（文件监控）

- 监听 Obsidian Vault 的文件变化事件（create/modify/delete/rename）
- 防抖调度同步，避免频繁触发
- 支持启动/停止控制
- 支持多文件夹监控

### 4. SyncEngine（同步引擎）

- 扫描本地文件夹
- 确保飞书目标文件夹存在
- 逐个上传/更新文件
- 增量同步（基于文件内容哈希）
- 云端文件预获取优化（O(1) 查重）

### 5. SyncFolderConfig（多文件夹配置）

- 管理多个本地文件夹到飞书的映射
- 支持自动模式（自动创建同名文件夹）和自定义模式
- 旧配置迁移支持
- 配置验证

### 6. IgnoreFilter（忽略规则）

- 解析 `.feisyncignore` 文件
- 支持 gitignore 兼容语法：
  - 空行和 # 注释
  - `dirname/` 忽略目录
  - `*.ext` 扩展名匹配
  - `**/pattern` 任意深度匹配
  - `!pattern` 否定规则

### 7. Logger（统一日志）

- 分级日志：DEBUG/INFO/WARN/ERROR
- 模块化日志器：`createLogger('ModuleName')`
- 统一前缀：`[FeiSync]`
- 可配置日志级别

## 同步流程

```
1. 扫描本地文件夹（排除忽略文件）
   ↓
2. 预获取云端文件列表（用于 O(1) 查重）
   ↓
3. 遍历本地文件
   ├─ 检查同步记录（基于内容哈希）
   │  ├─ 已存在且未变化 → 跳过
   │  └─ 不存在或已变化 → 继续
   ↓
4. 确定目标文件夹
   ├─ 计算相对路径
   └─ ensureFolderPath 确保路径存在
   ↓
5. 处理云端已有文件
   ├─ 有同步记录 → 删除旧文件
   └─ 无同步记录 → 查找同名文件并删除
   ↓
6. 上传文件
   ├─ ≤20MB → 全量上传
   └─ >20MB → 分片上传
   ↓
7. 保存同步记录
```

## 并发上传控制

使用 ConcurrencyPool 控制并发数：

```typescript
class ConcurrencyPool {
  private running: number = 0;
  private queue: (() => Promise<void>)[] = [];

  async run(fn: () => Promise<void>): Promise<void> {
    if (this.running >= this.maxConcurrent) {
      return new Promise(resolve => {
        this.queue.push(async () => {
          await fn();
          resolve();
        });
      });
    }
    this.running++;
    try {
      await fn();
    } finally {
      this.running--;
      this.processQueue();
    }
  }
}
```

## 错误处理策略

| 错误类型 | 处理方式 |
|----------|----------|
| IP 白名单限制 | 提示用户，显示 Notice，继续上传为新文件 |
| 文件已删除 | 静默处理，视为删除成功 |
| 网络错误 | 自动重试，最多重试 3 次 |
| 令牌过期 | 自动刷新重试 |
| 权限不足 | 提示用户检查权限配置 |
| refresh_token 失效 | 提示用户重新授权 |

## 数据持久化

- **设置**：`plugin.loadData()` / `plugin.saveData()`
- **用户令牌**：存储在 `data.json` 中，包含 accessToken、refreshToken、expiresAt
- **同步记录**：存储文件路径到云端 token 的映射

## 命令和交互

### 命令面板

- **FeiSync: Sync now**：手动触发同步
- **FeiSync: Download from Feishu**：从飞书下载文件
- **FeiSync: Open Settings**：打开设置页面

### Ribbon 图标

点击显示菜单：
- 立即同步
- 从飞书下载
- 打开设置

### 通知

- 同步开始/完成/失败通知
- 错误详情通过日志输出

## 项目文件清单

| 文件 | 说明 |
|------|------|
| `main.ts` | 插件主入口，命令注册和协调 |
| `settings.ts` | 设置界面和配置管理 |
| `feishuAuth.ts` | 飞书认证模块 |
| `feishuApi.ts` | 飞书 Drive API 封装 |
| `syncEngine.ts` | 同步引擎核心逻辑 |
| `fileWatcher.ts` | 本地文件监控 |
| `syncFolderConfig.ts` | 多文件夹配置管理 |
| `ignoreFilter.ts` | 忽略规则过滤器 |
| `logger.ts` | 统一日志模块 |
| `feishuFolderBrowser.ts` | 飞书文件夹浏览器 |
| `fileTypeUtils.ts` | 文件类型识别工具 |
