# FeiSync

一个 Obsidian 插件，用于将本地笔记同步到飞书（Feishu/Lark）Drive。

## 功能

- **单向同步**：以本地文件为准，将 Obsidian 笔记同步到飞书 Drive
- **增量同步**：基于文件内容哈希跳过未修改文件，只上传有变化的文件
- **指定文件夹同步**：只同步您选择的本地文件夹
- **手动同步**：通过命令面板或 Ribbon 图标手动触发同步
- **自动同步**（可选）：监听文件变化，自动上传修改后的文件
- **定时同步**（可选）：按固定间隔自动执行同步
- **用户 OAuth 授权**：通过用户授权同步到个人云空间，无需 IP 白名单，文件可在飞书客户端查看
- **从飞书下载**：支持将飞书云端的文件下载到本地
- **代理服务器支持**（可选）：网络受限环境可通过反向代理访问飞书 API
- **分片上传**：大文件自动分片上传，无大小上限
- **同步删除**：本地文件删除时可选同步删除云端文件

---

## 安装

### 前置要求

- Obsidian 0.15.0 或更高版本（仅桌面端）
- 一个飞书企业账号（自建应用需要企业版）

### 安装步骤

1. 将插件文件夹复制到 Obsidian 仓库的 `.obsidian/plugins/` 目录下
2. 重启 Obsidian，进入「设置」→「社区插件」，找到 "FeiSync" 并启用

---

## 使用指南

### 第一步：创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app) 并登录
2. 点击「创建企业自建应用」
3. 填写应用名称和描述，创建应用
4. 记录 **App ID** 和 **App Secret**（在「凭证与基础信息」页面中）

### 第二步：配置应用权限

进入应用 →「权限管理」，搜索并添加以下权限：

| 权限名称 | 权限标识 | 用途 |
|----------|----------|------|
| 查看、评论和编辑新版文档 | `docx:document` | 读写文档内容 |
| 导入文档 | `docs:document:import` | 将 Markdown 导入为飞书文档 |
| 查看、编辑和管理云空间 | `drive:drive` | 云空间文件和文件夹操作 |
| 导出文档 | `drive:export:readonly` | 从飞书下载/导出文档 |
| 获取文档内容 | `docs:document:export` | 下载在线文档 |

> **重要**：添加权限后，需要创建应用版本并发布，权限才会生效。路径：「版本管理与发布」→「创建版本」→ 填写版本号和更新说明 → 发布。

### 第三步：配置网页应用（OAuth 用户授权）

> **这是最关键的一步！** 用户授权允许插件以用户身份访问个人云空间，同步的文件可以在飞书客户端中直接查看。**使用用户授权后，无需配置 IP 白名单，也无需搭建代理服务器即可直连飞书。**

1. 在飞书开放平台，进入应用 →「应用功能」→「网页应用」
2. 点击「添加网页应用」，填写以下信息：
   - **桌面端主页**：随意填写，如 `https://localhost`
   - **重定向 URL**：填写 `http://localhost:9527/callback`
3. 保存配置

> **重定向 URL 必须为 `http://localhost:9527/callback`**，插件会在本地启动一个临时 HTTP 服务器监听 9527 端口来接收授权回调。请确保此 URL 与飞书开放平台中配置的完全一致，否则授权会失败。

### 第四步：配置插件

1. 在 Obsidian 中打开「设置」→「FeiSync」
2. **飞书 App ID**：填入第一步获取的 App ID
3. **飞书 App Secret**：填入第一步获取的 App Secret
4. **本地同步文件夹**：选择要同步到飞书的本地文件夹
5. **飞书目标文件夹 Token**（可选）：填入飞书 Drive 中目标文件夹的 token。留空则自动在根目录创建 "ObsidianSync" 文件夹
   > 文件夹 Token 可以直接在文件夹网页版 URL 的 code 字段获取，例如：`https://feishu.cn/drive/folder/fldcnXXXXXX` 中的 `fldcnXXXXXX`

### 第五步：用户授权

> **推荐首先完成此步骤！** 使用用户授权后，插件将以您的身份访问飞书，无需 IP 白名单，同步的文件属于您个人。

1. 确保已完成第三步的网页应用配置
2. 在插件设置页面的「飞书用户授权」区域，点击「开始授权」
3. 浏览器会自动打开飞书授权页面，登录并同意授权
4. 授权成功后浏览器会显示"授权成功"，页面可关闭
5. 插件自动获取令牌，设置页面会显示"用户已授权"状态

> 用户令牌有效期内可自动刷新，无需重复授权。如需更换账号，点击「解除授权」后重新授权。

### 完成！

完成以上步骤后，您就可以开始同步了。点击设置页面的「立即同步」按钮，或使用命令面板执行 "FeiSync: Sync now"。

---

## 代理服务器（可选）

> **代理服务器是可选的！** 如果您已完成用户 OAuth 授权，插件可以直连飞书 API，无需代理。只有在网络受限（无法直连 `open.feishu.cn`）的环境下，才需要搭建代理服务器。

### 什么时候需要代理？

- 您的网络无法直接访问 `open.feishu.cn`（如公司内网限制）
- 您想通过代理服务器统一管理出口 IP

### 什么时候不需要代理？

- 您的网络可以正常访问飞书（大多数家庭和办公网络都可以）
- 您已通过用户 OAuth 授权（推荐方式）

### 搭建代理服务器

#### 服务器要求

可以使用 IPv6 入口、IPv4 出口的服务器。

| 项目 | 要求 |
|------|------|
| 公网 IPv4 地址 | 必须（飞书白名单仅支持 IPv4 出口） |
| 操作系统 | Debian/Ubuntu/CentOS 等主流 Linux |
| Nginx | 1.18+ |
| 防火墙开放端口 | 8080（TCP） |

#### 1. 安装 Nginx

```bash
# Debian/Ubuntu
sudo apt update && sudo apt install nginx -y

# CentOS/RHEL
sudo yum install nginx -y
```

#### 2. 创建代理配置文件

```bash
sudo nano /etc/nginx/sites-available/feishu-proxy
```

粘贴以下内容：

```nginx
server {
    listen 8080;
    listen [::]:8080;  # 同时监听 IPv6，方便本地通过 IPv6 访问
    server_name _;

    # CORS 头（允许跨域）
    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type' always;

    location / {
        # 处理 OPTIONS 预检请求
        if ($request_method = 'OPTIONS') {
            return 204;
        }

        # 强制使用 IPv4 DNS 解析，确保通过 IPv4 连接飞书
        # 飞书白名单仅支持 IPv4，如果服务器有 IPv6 出口需要此配置
        resolver 8.8.8.8 ipv6=off valid=300s;
        resolver_timeout 5s;

        # 反向代理到飞书 API
        proxy_pass https://open.feishu.cn/;
        proxy_http_version 1.1;
        proxy_set_header Host open.feishu.cn;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 确保请求体正确转发（尤其是上传文件和 DELETE 请求）
        proxy_buffering off;
        proxy_ssl_server_name on;
        proxy_connect_timeout 30s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

> **关键配置说明**：
> - `Access-Control-Allow-Methods` 必须包含 `DELETE`，飞书文件删除 API 使用 DELETE 请求
> - `resolver 8.8.8.8 ipv6=off` 强制 IPv4 解析，确保 Nginx 用 IPv4 访问飞书（匹配白名单）
> - `proxy_buffering off` 确保上传文件时请求体正确转发

#### 3. 启用配置并启动 Nginx

```bash
# 创建软链接启用站点
sudo ln -s /etc/nginx/sites-available/feishu-proxy /etc/nginx/sites-enabled/

# 移除默认站点（避免冲突）
sudo rm -f /etc/nginx/sites-enabled/default

# 测试配置语法
sudo nginx -t

# 重启 Nginx
sudo systemctl restart nginx

# 检查运行状态
sudo systemctl status nginx
```

#### 4. 配置防火墙

```bash
# Ubuntu/Debian (ufw)
sudo ufw allow 8080/tcp
sudo ufw reload

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

> 如果使用云服务器（阿里云、腾讯云、AWS 等），还需要在云平台控制台的**安全组**中，入方向开放 8080 端口。

#### 5. 验证代理服务器

```bash
# 在服务器本地测试
curl -X POST http://localhost:8080/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"您的AppID","app_secret":"您的AppSecret"}'

# 成功响应示例：
# {"code":0,"msg":"ok","tenant_access_token":"xxx","expire":7200}
```

### 在插件中配置代理

1. 在插件设置中，开启「使用代理服务器」开关
2. **代理服务器地址**：填入代理服务器地址，格式为 `http://服务器IP:8080`
   - 使用 IPv4：`http://1.2.3.4:8080`
   - 使用 IPv6：`http://[2001:db8::1]:8080`
   - 使用域名：`http://proxy.example.com:8080`
3. 点击「测试连接」验证代理和飞书 API 连通性

> 关闭代理开关后，插件将直连飞书 API。无需清除代理地址，下次开启会自动使用。

### IP 白名单（仅在需要使用 tenant_access_token 时配置）

> **使用用户 OAuth 授权后无需配置 IP 白名单！** IP 白名单仅在以下情况需要：
> - 未进行用户授权，使用应用的 tenant_access_token 访问飞书
> - 通过代理服务器使用 tenant_access_token

飞书开放平台**仅支持 IPv4 白名单，不支持 IPv6**。

1. 获取您代理服务器的公网 IPv4 地址：
   ```bash
   curl -4 ifconfig.me
   ```
2. 登录 [飞书开放平台](https://open.feishu.cn/app)，选择您的应用
3. 进入「开发配置」→「IP 白名单」
4. 添加服务器的公网 IPv4 地址
5. 一般会立即生效

---

## 使用

### 手动同步

- **命令面板**：按 `Ctrl/Cmd + P`，输入 "FeiSync: Sync now"，回车执行
- **Ribbon 图标**：点击左侧栏的云上传图标，选择「立即同步」

### 自动同步

1. 在设置中开启「自动同步」选项
2. 设置同步间隔（分钟），防止频繁同步
3. 开启后，监控文件夹内的文件修改会在指定间隔后自动上传

### 定时同步

1. 在设置中开启「定时同步」选项
2. 设置同步间隔（分钟）
3. 插件将按固定间隔自动执行全量同步

### 从飞书下载

- **命令面板**：输入 "FeiSync: Download from Feishu"
- **Ribbon 图标**：点击云上传图标，选择「从飞书下载」

### 查看日志

- 在插件设置页面点击「查看日志」按钮
- 或打开 Obsidian 开发者工具（`Ctrl+Shift+I`），在控制台中查看 `[FeiSync]` 前缀的日志

---

## 使用的飞书 API

| API | 方法 | 用途 |
|-----|------|------|
| `/open-apis/auth/v3/tenant_access_token/internal` | POST | 获取应用访问凭证 |
| `/open-apis/auth/v3/app_access_token/internal` | POST | 获取应用凭证（OAuth 流程） |
| `/open-apis/authen/v1/authorize` | GET | OAuth 用户授权页面 |
| `/open-apis/authen/v2/oauth/token` | POST | 授权码换令牌 / 刷新令牌 |
| `/open-apis/drive/v1/files` | GET | 列出文件夹内容 |
| `/open-apis/drive/v1/files/create_folder` | POST | 创建文件夹 |
| `/open-apis/drive/v1/files/{token}` | DELETE | 删除文件 |
| `/open-apis/drive/v1/medias/upload_all` | POST | 全量上传文件（≤20MB） |
| `/open-apis/drive/v1/medias/upload_prepare` | POST | 分片预上传 |
| `/open-apis/drive/v1/medias/upload_block` | POST | 分片上传 |
| `/open-apis/drive/v1/medias/upload_finish` | POST | 完成分片上传 |
| `/open-apis/drive/v1/files/{token}/download` | GET | 下载文件 |
| `/open-apis/drive/v1/export_tasks` | POST | 创建文档导出任务 |
| `/open-apis/drive/v1/import_tasks` | POST | 创建文档导入任务 |

---

## 常见问题

### 用户授权相关问题

**Q: 一定要搭建代理服务器吗？**
不需要！完成用户 OAuth 授权后，插件可以直连飞书 API。代理服务器只在网络受限（无法直连 `open.feishu.cn`）时才需要。

**Q: 一定要配置 IP 白名单吗？**
不需要！使用用户 OAuth 授权时，请求以用户身份发起，不受 IP 白名单限制。IP 白名单只在未进行用户授权、使用 tenant_access_token 时才需要。

**Q: 授权失败怎么办？**
- 确保飞书开放平台的**重定向 URL** 已正确配置为 `http://localhost:9527/callback`（注意是 `http` 不是 `https`）
- 确保本地 9527 端口没有被其他程序占用
- 授权页面打开后需在 3 分钟内完成操作

**Q: 关闭代理开关后需要重新授权吗？**
不需要。代理开关只影响 API 请求的路径，与用户授权无关。关闭代理后，请求将直连飞书。

### 连接测试失败

- **代理不可达**：检查代理服务器是否运行、防火墙是否放行端口、云服务器安全组是否开放
- **凭证验证失败**：检查 App ID 和 App Secret 是否正确，应用是否已发布
- **飞书 API 连接失败**：
  - 使用用户授权：检查网络是否能直连 `open.feishu.cn`
  - 未使用用户授权：确认服务器 IPv4 地址已添加到飞书 IP 白名单（不支持 IPv6）

### 同步失败

- **用户未授权**：需要在设置中完成 OAuth 授权流程
- **权限不足**：确认应用已添加 `drive:drive` 等权限并已发布新版本
- **授权已失效**：刷新令牌过期，请在设置中重新授权

### 代理服务器相关问题

| 问题 | 排查方式 |
|------|----------|
| Nginx 启动失败 | `sudo nginx -t` 检查配置语法，查看 `/var/log/nginx/error.log` |
| 端口被占用 | `sudo lsof -i :8080` 或 `sudo ss -tlnp \| grep :8080` |
| 外部无法访问 | 检查防火墙、云安全组、Nginx 监听地址 |
| 飞书返回 403 | 确认 IPv4 已加白名单，等待 5-10 分钟生效 |
| DELETE 请求 404 | 确认 Nginx 配置中 `Access-Control-Allow-Methods` 包含 `DELETE` |

---

## 开发

### 构建

```bash
npm install
npm run build
```

### 监听模式（开发）

```bash
npm run dev
```

### 项目结构

| 文件 | 说明 |
|------|------|
| `main.ts` | 插件主入口 |
| `settings.ts` | 设置界面 |
| `feishuAuth.ts` | 飞书认证模块（tenant_access_token + OAuth user_access_token） |
| `feishuApi.ts` | 飞书 Drive API 封装（文件上传、下载、删除、文件夹管理等） |
| `syncEngine.ts` | 同步引擎（增量同步、上传、下载、删除策略） |
| `fileWatcher.ts` | 本地文件监控（防抖调度） |

---

## 注意事项

- **推荐使用用户授权**：用户授权无需 IP 白名单，同步文件属于个人，可在飞书客户端查看
- **代理是可选的**：网络正常时无需代理，直连飞书即可
- **增量同步**：插件通过文件内容哈希判断是否需要上传，未修改的文件会自动跳过
- **单向同步**：本插件以本地文件为准，不会自动将飞书的修改拉取到本地（但支持手动从飞书下载）
- **权限要求**：确保飞书应用已申请相关权限并已发布
- **IP 白名单仅 IPv4**：飞书开放平台的 IP 白名单不支持 IPv6（仅在未使用用户授权时需要配置）
- **数据安全**：App Secret 和用户令牌存储在本地插件数据中，请妥善保管

## License

MIT
