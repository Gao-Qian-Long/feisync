# Obsidian Flybook

一个 Obsidian 插件，用于将本地笔记同步到飞书（Feishu/Lark）Drive。

## 功能

- **单向同步**：以本地文件为准，将 Obsidian 笔记同步到飞书 Drive
- **指定文件夹同步**：只同步您选择的本地文件夹
- **手动同步**：通过命令面板或 Ribbon 图标手动触发同步
- **自动同步**（可选）：监听文件变化，自动上传修改后的文件
- **用户 OAuth 授权**：同步到用户个人云空间，文件可在飞书客户端查看
- **代理服务器支持**：通过反向代理解决 CORS 限制

---

## 安装

### 前置要求

- Obsidian 0.15.0 或更高版本（仅桌面端）
- 一个飞书企业账号（自建应用需要企业版）
- 一台具有公网 IPv4 地址的服务器（用于搭建代理和配置飞书 IP 白名单）

### 安装步骤

1. 将插件文件夹复制到 Obsidian 仓库的 `.obsidian/plugins/` 目录下
2. 重启 Obsidian，进入「设置」→「社区插件」，找到 "Obsidian Flybook" 并启用

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
| 查看、编辑和管理云空间 | `drive:drive` | 云空间文件和文件夹操作（上传、删除、创建文件夹等） |

> **重要**：添加权限后，需要创建应用版本并发布，权限才会生效。路径：「版本管理与发布」→「创建版本」→ 填写版本号和更新说明 → 发布。

### 第三步：配置 IP 白名单

飞书开放平台**仅支持 IPv4 白名单，不支持 IPv6**。

1. 获取您代理服务器的公网 IPv4 地址：
   ```bash
   curl -4 ifconfig.me
   ```
2. 登录 [飞书开放平台](https://open.feishu.cn/app)，选择您的应用
3. 进入「开发配置」→「IP 白名单」
4. 添加服务器的公网 IPv4 地址
5. 一般会立即生效

### 第四步：配置网页应用（OAuth 用户授权）

用户授权允许插件以用户身份访问个人云空间，同步的文件可以在飞书客户端中直接查看。

1. 在飞书开放平台，进入应用 →「应用功能」→「网页应用」
2. 点击「添加网页应用」，填写以下信息：
   - **桌面端主页**：随意填写，如 `https://localhost`
   - **重定向 URL**：填写 `http://localhost:9527/callback`
3. 保存配置

> 重定向 URL 必须为 `http://localhost:9527/callback`，插件会在本地启动一个临时 HTTP 服务器监听 9527 端口来接收授权回调。

### 第五步：搭建代理服务器

由于 Obsidian 桌面端存在 CORS（跨域资源共享）限制，直接从插件调用飞书 API 会被浏览器安全策略阻止。需要搭建一个 Nginx 反向代理服务器中转请求。

#### 服务器要求
注意可以使用IPV6入口，IPV4出口的服务器。

| 项目 | 要求 |
|------|------|
| 公网 IPv4 地址 | 必须（飞书白名单仅支持 IPv4出口） |
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

### 第六步：配置插件

1. 在 Obsidian 中打开「设置」→「Obsidian Flybook」
2. **飞书 App ID**：填入第一步获取的 App ID
3. **飞书 App Secret**：填入第一步获取的 App Secret
4. **代理服务器地址**：填入代理服务器地址，格式为 `http://服务器IP:8080`
   - 使用 IPv4：`http://1.2.3.4:8080`
   - 使用 IPv6：`http://[2001:db8::1]:8080`
   - 使用域名：`http://proxy.example.com:8080`
5. 点击「代理连接测试」→「测试连接」验证代理和飞书 API 连通性
6. **本地同步文件夹**：选择要同步到飞书的本地文件夹
7. **飞书目标文件夹 Token**（可选）：填入飞书 Drive 中目标文件夹的 token。留空则自动在根目录创建 "ObsidianSync" 文件夹
**文件夹Token可以直接在文件夹网页版URL的code字段获取**

### 第七步：用户授权

要同步到个人云空间（文件可在飞书客户端查看），需要完成 OAuth 授权：

1. 确保已完成第四步的网页应用配置
2. 在插件设置页面的「飞书用户授权」区域，点击「开始授权」
3. 浏览器会自动打开飞书授权页面，登录并同意授权
4. 授权成功后浏览器会显示"授权成功"，页面可关闭
5. 插件自动获取令牌，设置页面会显示"用户已授权"状态

> 用户令牌有效期内可自动刷新，无需重复授权。如需更换账号，点击「解除授权」后重新授权。

---

## 使用

### 手动同步

- **命令面板**：按 `Ctrl/Cmd + P`，输入 "Flybook: Sync now"，回车执行
- **Ribbon 图标**：点击左侧栏的云上传图标，选择「立即同步」

### 自动同步

1. 在设置中开启「自动同步」选项
2. 设置同步间隔（分钟），防止频繁同步
3. 开启后，监控文件夹内的文件修改会在指定间隔后自动上传

### 查看日志

打开 Obsidian 开发者工具（`Ctrl+Shift+I`），在控制台中查看 `[Flybook]` 前缀的日志。

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
| `/open-apis/drive/v1/medias/upload_all` | POST | 上传文件 |
| `/open-apis/drive/v1/import_tasks` | POST | 创建文档导入任务 |
| `/open-apis/drive/v1/import_tasks/{ticket}` | GET | 查询导入任务状态 |

---

## 常见问题

### 连接测试失败

- **代理不可达**：检查代理服务器是否运行、防火墙是否放行端口、云服务器安全组是否开放
- **凭证验证失败**：检查 App ID 和 App Secret 是否正确，应用是否已发布
- **飞书 API 连接失败**：确认服务器 IPv4 地址已添加到飞书 IP 白名单（不支持 IPv6）

### 同步失败

- **用户未授权**：需要在设置中完成 OAuth 授权流程
- **文件大小超限**：飞书 API 限制单个文件 ≤ 20MB
- **权限不足**：确认应用已添加 `drive:drive` 权限并已发布新版本

### OAuth 授权失败

- **端口占用**：确保本地 9527 端口没有被其他程序占用
- **回调地址不匹配**：确认飞书应用的重定向 URL 配置为 `http://localhost:9527/callback`
- **授权超时**：授权页面打开后需在 3 分钟内完成操作

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
| `feishuApi.ts` | 飞书 Drive API 封装（文件上传、删除、文件夹管理等） |
| `syncEngine.ts` | 同步引擎（扫描、上传、覆盖策略） |
| `fileWatcher.ts` | 本地文件监控（防抖调度） |

---

## 注意事项

- **文件大小限制**：飞书 API 限制单个文件 ≤ 20MB
- **单向同步**：本插件以本地文件为准，不会将飞书的修改拉取到本地
- **权限要求**：确保飞书应用已申请相关权限并已发布
- **IP 白名单仅 IPv4**：飞书开放平台的 IP 白名单不支持 IPv6
- **数据安全**：App Secret 和用户令牌存储在本地插件数据中，请妥善保管

## License

MIT
