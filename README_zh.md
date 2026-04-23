# FeiSync

将你的 Obsidian 笔记同步到飞书（Lark）云盘。

[English](README.md)

---

## 功能特性

- **单向同步**：将 Obsidian 笔记上传到飞书云盘，本地文件为唯一数据源
- **增量同步**：基于 SHA-256 内容哈希跳过未更改的文件，节省带宽
- **多文件夹同步**：配置多个本地文件夹，分别映射到不同的飞书云盘目录
- **手动同步**：通过命令面板或功能区图标触发同步
- **自动同步**（可选）：监听文件变化，防抖后自动上传
- **定时同步**（可选）：按固定时间间隔自动同步（1–1440 分钟）
- **从飞书下载**：将云端文件拉取到本地，支持哈希冲突检测
- **删除同步**（可选）：删除本地文件时同步删除云端文件
- **忽略规则**：支持 `.feisync-ignore.md` 文件，采用 gitignore 兼容语法
- **文件树浏览器**：浏览飞书文件夹，并以树形结构查看完整的递归文件列表及元数据
- **同步日志查看器**：内置日志弹窗，展示上传、跳过、删除、下载和错误事件
- **用户 OAuth**：无需配置 IP 白名单即可访问个人云空间
- **代理支持**（可选）：适用于受限网络环境的反向代理
- **分片上传**：大文件以 4MB 分片上传，无大小限制
- **速率限制与重试**：内置 5 QPS 速率限制器，支持可配置的重试次数
- **并发控制**：可配置的最大并发上传数（1–10）

> **重要提示**：本插件执行的是**单向同步**（Obsidian → 飞书）。如果你直接在飞书中修改了文件，然后又在 Obsidian 中执行"立即同步"，云端修改会被本地（旧）版本覆盖。如需采纳云端修改，请先使用**"从飞书下载"**功能。

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

在"权限管理"中添加以下权限，然后发布新版本使其生效：

| 权限 | 标识 | 用途 |
|------|------|------|
| 云空间 | `drive:drive` | 文件和文件夹的增删改查 |
| 导出文档（只读） | `drive:export:readonly` | 导出/下载在线文档 |
| 下载文件 | `drive:file:download` | 下载云空间文件内容 |
| 在线文档 | `docx:document` | 访问在线文档 |
| 导入文档 | `docs:document:import` | 将 Markdown 导入为飞书文档 |
| 导出文档 | `docs:document:export` | 将飞书文档导出为其他格式 |

### 3. 配置 Web 应用（OAuth）

1. 进入应用 → "应用功能" → "网页"
2. 添加网页应用，设置：
   - **桌面端主页**：`https://localhost`
   - **重定向 URL**：`http://localhost:9527/callback`

### 4. 配置插件

1. 打开**设置 → FeiSync**
2. 输入 **App ID** 和 **App Secret**
3. 添加文件夹映射：
   - **自动模式**：插件自动在配置的飞书根目录下创建子文件夹，Token 由插件内部管理
   - **自定义模式**：指定精确的飞书文件夹 Token，可使用内置的**浏览飞书目录**按钮导航选择
4. 点击**"开始授权"**并在浏览器中完成 OAuth
5. （可选）启用自动同步、定时同步或删除同步

### 5. 同步

- 点击** cloud-upload 功能区图标**，弹出菜单可选择同步/下载/打开设置
- 使用**命令面板**（`Ctrl+P` / `Cmd+P`）：
  - `FeiSync: 立即同步`
  - `FeiSync: 从飞书下载`
  - `FeiSync: 查看同步日志`

---

## 文件夹映射模式

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| **自动** | 插件自动在配置的飞书根目录下创建子文件夹，文件夹 Token 由内部管理 | 简单配置，一键同步 |
| **自定义** | 你指定精确的飞书文件夹 Token。可使用内置的**浏览飞书目录**按钮导航并选择 | 精确控制云端存储位置 |

---

## 忽略规则

在仓库根目录创建 `.feisync-ignore.md` 文件，语法与 `.gitignore` 兼容：

```
# 忽略目录
attachments/
node_modules/

# 按扩展名忽略
*.log
*.tmp

# 忽略任意位置的匹配项
**/.DS_Store

# 取消忽略（例外）
!important.md
```

修改此文件后，下次同步时会自动生效。

---

## 插件设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| App ID | — | 飞书应用标识符 |
| App secret | — | 飞书应用密钥 |
| 同步文件夹映射 | — | 一个或多个本地→远程文件夹配对 |
| 文件变化时自动同步 | 关闭 | 监听本地文件变化，防抖后自动同步 |
| 防抖间隔 | 5秒 | 文件变化后触发自动同步的延迟 |
| 定时同步 | 关闭 | 按固定时间间隔自动同步 |
| 同步间隔 | 30分钟 | 定时同步的时间间隔 |
| 删除同步 | 开启 | 删除本地文件时同步删除云端文件 |
| 最大并发上传数 | 3 | 并行上传限制（1–10） |
| 最大重试次数 | 3 | API 调用失败时的重试次数 |
| 代理 URL | — | 可选的反向代理地址，用于访问 `open.feishu.cn` |

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
├── main.ts                 # 插件入口、生命周期、命令注册、模块协调
├── settings.ts             # 设置界面、配置管理、同步日志弹窗
├── feishuAuth.ts           # OAuth 与 Token 管理（tenant + user token）
├── feishuApi.ts            # 飞书 Drive API 封装
│                           #   - 文件夹/文件增删改查
│                           #   - 上传（全量 + 分片）
│                           #   - 下载、导出、导入
│                           #   - 速率限制（5 QPS）
│                           #   - 指数退避重试机制
├── syncEngine.ts           # 同步引擎
│                           #   - 增量同步（基于 SHA-256 哈希）
│                           #   - 并发上传池
│                           #   - 删除同步与重命名处理
│                           #   - 多文件夹支持
│                           #   - 从飞书下载（含冲突检测）
├── fileWatcher.ts          # 本地文件监控
│                           #   - 创建/修改/删除/重命名事件
│                           #   - 防抖同步触发
├── feishuFolderBrowser.ts  # 交互式文件夹浏览器 + 递归文件树弹窗
├── syncFolderConfig.ts     # 多文件夹配置模型与验证
├── ignoreFilter.ts         # .feisync-ignore.md 解析器（gitignore 兼容）
├── fileTypeUtils.ts        # 面向飞书 API 的文件类型检测
├── logger.ts               # 统一日志模块，支持命名空间
├── manifest.json           # 插件元数据
├── styles.css              # 插件 UI 样式
├── esbuild.config.js       # 构建配置
└── package.json
```

---

## 使用的飞书 API

### 认证

| API | 方法 | 用途 |
|-----|------|------|
| `/open-apis/auth/v3/tenant_access_token/internal` | POST | 获取应用级访问凭证 |
| `/open-apis/auth/v3/app_access_token/internal` | POST | 获取应用凭证（OAuth） |
| `/open-apis/authen/v1/authorize` | GET | OAuth 授权页面 |
| `/open-apis/authen/v2/oauth/token` | POST | 用授权码交换用户 Token |
| `/open-apis/authen/v1/user_info` | GET | 获取已授权用户信息 |
| `/open-apis/authen/v1/oidc/access_token` | POST | 刷新用户访问 Token |

### 文件与文件夹操作

| API | 方法 | 用途 |
|-----|------|------|
| `/open-apis/drive/v1/files` | GET | 列出文件夹内容 |
| `/open-apis/drive/v1/files/create_folder` | POST | 创建文件夹 |
| `/open-apis/drive/v1/files/{token}` | DELETE | 删除文件/文件夹 |
| `/open-apis/drive/v1/files/upload_all` | POST | 上传文件（≤20MB） |
| `/open-apis/drive/v1/files/upload_prepare` | POST | 分片上传初始化 |
| `/open-apis/drive/v1/files/upload_block` | POST | 上传分片（4MB） |
| `/open-apis/drive/v1/files/upload_finish` | POST | 完成分片上传 |
| `/open-apis/drive/v1/files/{token}/download` | GET | 下载云端文件 |
| `/open-apis/drive/v1/export_tasks` | POST | 创建导出任务 |
| `/open-apis/drive/v1/export_tasks/{token}` | GET | 查询导出任务结果 |
| `/open-apis/drive/v1/import_tasks` | POST | 创建导入任务 |
| `/open-apis/drive/v1/import_tasks/{token}` | GET | 查询导入任务结果 |
| `/open-apis/drive/v1/media/batch_get_tmp_download_url` | POST | 批量获取临时下载链接 |
| `/open-apis/drive/v1/metas/batch_query` | POST | 批量查询文件元数据 |

---

## 命令列表

| 命令 | ID | 操作 |
|---------|-----|--------|
| **立即同步** | `feisync:sync` | 触发单向上传同步 |
| **从飞书下载** | `feisync:download` | 将云端文件拉取到本地 |
| **查看同步日志** | `feisync:log` | 打开设置并查看同步历史 |

功能区图标（`cloud-upload`）提供快捷菜单，包含上述操作以及**打开设置**。

---

## 数据安全说明

- **单向同步覆盖风险**：如果你在飞书中直接修改了文件，随后又在 Obsidian 中执行"立即同步"，云端版本将被删除并替换为本地（旧）版本。如需采纳云端修改，请先使用**"从飞书下载"**。
- **删除同步**：开启后，删除本地文件也会同步删除云端对应文件。可在设置中关闭此功能。
- **基于哈希的检测**：插件使用 SHA-256 哈希检测文件变化。内容完全相同的文件即使修改时间不同，也会被跳过。

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
