# FeiSync

将你的 Obsidian 笔记同步到飞书（ Lark ）云盘。

[English](README.md)

---

## 功能特性

- **单向同步**：将 Obsidian 笔记上传到飞书云盘，本地文件为唯一数据源
- **增量同步**：基于内容哈希跳过未更改的文件
- **多文件夹同步**：配置多个本地文件夹，对应不同的飞书云盘目录
- **手动同步**：通过命令面板或功能区图标触发同步
- **自动同步**（可选）：监听文件变化，自动上传
- **定时同步**（可选）：按固定时间间隔自动同步
- **用户 OAuth**：无需配置 IP 白名单即可访问个人云空间
- **从飞书下载**：将云端文件拉取到本地
- **代理支持**（可选）：适用于受限网络环境的反向代理
- **分片上传**：大文件以 4MB 分片上传，无大小限制
- **删除同步**：可选在删除本地文件时同步删除云端文件
- **忽略规则**：支持 `.feisync-ignore.md` 文件，采用 gitignore 兼容语法

---

## 安装

### 环境要求

- Obsidian 0.15.0+（仅支持桌面版）
- 飞书企业账号

### 安装步骤

1. 将插件文件夹复制到仓库的 `.obsidian/plugins/` 目录下
2. 重启 Obsidian
3. 在社区插件设置中启用 "FeiSync"

---

## 快速开始

### 1. 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app) 并登录
2. 点击"创建企业自建应用"
3. 在"凭证与基础信息"中记录 **App ID** 和 **App Secret**

### 2. 配置应用权限

在"权限管理"中添加以下权限：

| 权限 | 标识 | 用途 |
|------|------|------|
| 查看/评论/编辑云空间文档 | `drive:drive` | 文件和文件夹操作 |
| 获取文件元数据 | `drive:file` | 获取文件信息 |
| 上传、下载文件或文件夹 | `drive:file:upload_download` | 文件传输 |
| 上传文件到根目录 | `drive:resource` | 上传文件 |
| 下载文件 | `drive:file:download` | 下载文件 |

> 添加权限后需要发布新版本才能生效。

### 3. 配置 Web 应用（OAuth）

1. 进入应用 → "应用功能" → "网页"
2. 添加网页应用，设置：
   - **桌面端主页**：`https://localhost`
   - **重定向 URL**：`http://localhost:9527/callback`

### 4. 配置插件

1. 打开"设置" → "FeiSync"
2. 输入 App ID 和 App Secret
3. 添加文件夹映射
4. 点击"开始授权"并在浏览器中完成 OAuth

### 5. 开始同步

使用"立即同步"或命令面板触发同步。

---

## 忽略规则

在仓库根目录创建 `.feisync-ignore.md` 文件：

```
# 忽略目录
attachments/
node_modules/

# 按扩展名忽略
*.log
*.tmp

# 忽略任意位置的匹配项
**/.DS_Store

# 取消忽略（优先级更高）
!important.md
```

---

## 代理服务器（可选）

仅在你无法直接访问 `open.feishu.cn` 时需要。

### Nginx 配置

```nginx
server {
    listen 8080;
    server_name _;

    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;

    location / {
        if ($request_method = 'OPTIONS') { return 204; }

        resolver 8.8.8.8 ipv6=off valid=300s;
        resolver_timeout 5s;

        proxy_pass https://open.feishu.cn/;
        proxy_http_version 1.1;
        proxy_set_header Host open.feishu.cn;
        proxy_set_header X-Real-IP $remote_addr;

        proxy_buffering off;
        proxy_ssl_server_name on;
        proxy_connect_timeout 30s;
    }
}
```

---

## 项目架构

```
feisync/
├── main.ts                 # 插件入口，命令注册，模块协调
├── settings.ts             # 设置界面，配置管理
├── feishuAuth.ts           # 认证模块（tenant_access_token + OAuth user_access_token）
├── feishuApi.ts            # 飞书 Drive API 封装
│                           #   - 文件夹/文件 CRUD
│                           #   - 上传（全量 + 分片）
│                           #   - 下载
│                           #   - 速率限制（5 QPS）
│                           #   - 重试机制
├── syncEngine.ts           # 同步引擎
│                           #   - 增量同步（基于哈希）
│                           #   - 并发上传
│                           #   - 删除同步
│                           #   - 多文件夹支持
├── fileWatcher.ts          # 本地文件监控
│                           #   - 创建/修改/删除/重命名事件
│                           #   - 防抖调度
├── syncFolderConfig.ts     # 多文件夹配置管理
├── ignoreFilter.ts         # .feisync-ignore.md 解析器（gitignore 兼容）
├── logger.ts               # 统一日志模块
├── feishuFolderBrowser.ts  # 飞书文件夹浏览器弹窗
├── fileTypeUtils.ts         # 文件类型检测
├── manifest.json           # 插件元数据
├── versions.json           # 版本兼容性
├── esbuild.config.js       # 构建配置
└── package.json
```

---

## 模块关系

```
main.ts
├── FeishuAuthManager (feishuAuth.ts)
│   └── OAuth 授权流程 + Token 管理
├── FeishuApiClient (feishuApi.ts)
│   ├── 速率限制器
│   └── 重试机制
├── SyncEngine (syncEngine.ts)
│   ├── 文件扫描
│   ├── 增量同步
│   └── 下载/删除
├── FileWatcher (fileWatcher.ts)
│   └── 文件事件监听
├── IgnoreFilter (ignoreFilter.ts)
│   └── .feisync-ignore.md 解析
└── FeiSyncSettingTab (settings.ts)
    └── UI 配置界面
```

---

## 使用的飞书 API

### 认证

| API | 方法 | 用途 |
|-----|------|------|
| `/open-apis/auth/v3/tenant_access_token/internal` | POST | 获取应用访问凭证 |
| `/open-apis/auth/v3/app_access_token/internal` | POST | 获取应用凭证（OAuth） |
| `/open-apis/authen/v1/authorize` | GET | OAuth 授权页面 |
| `/open-apis/authen/v2/oauth/token` | POST | 交换授权码获取 Token |

### 文件操作

| API | 方法 | 用途 |
|-----|------|------|
| `/open-apis/drive/v1/files` | GET | 列出文件夹内容 |
| `/open-apis/drive/v1/files/create_folder` | POST | 创建文件夹 |
| `/open-apis/drive/v1/files/{token}` | DELETE | 删除文件 |
| `/open-apis/drive/v1/files/upload_all` | POST | 上传文件（≤20MB） |
| `/open-apis/drive/v1/files/upload_prepare` | POST | 分片上传初始化 |
| `/open-apis/drive/v1/files/upload_block` | POST | 上传分片 |
| `/open-apis/drive/v1/files/upload_finish` | POST | 完成分片上传 |
| `/open-apis/drive/v1/files/{token}/download` | GET | 下载云端文件 |

---

## 开发

```bash
npm install
npm run build      # 生产构建
npm run dev        # 监听模式
```

---

## 许可证

MIT
