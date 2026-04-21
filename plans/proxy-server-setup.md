# 飞书 API 代理服务器搭建指南

## 概述

由于 Obsidian 桌面应用存在 CORS（跨域资源共享）限制，直接从客户端调用飞书 API 会被浏览器安全策略阻止。本指南将帮助您搭建一个 Nginx 反向代理服务器，用于中转飞书 API 请求。

**重要**：飞书开放平台仅支持 **IPv4 白名单**，请确保您的服务器拥有公网 IPv4 地址。

---

## 一、服务器要求

| 项目 | 要求 |
|------|------|
| 公网 IPv4 地址 | 必须（用于飞书白名单） |
| 公网 IPv6 地址 | 可选（用于本地访问） |
| 操作系统 | Debian/Ubuntu/CentOS 等主流 Linux |
| Nginx | 1.18+ |
| 防火墙开放端口 | 8080（TCP） |

---

## 二、安装 Nginx

### Debian/Ubuntu

```bash
sudo apt update
sudo apt install nginx
```

### CentOS/RHEL

```bash
sudo yum install nginx
```

### 验证安装

```bash
nginx -v
```

---

## 三、创建代理配置文件

### 1. 创建配置文件

```bash
sudo nano /etc/nginx/sites-available/feishu-proxy
```

### 2. 粘贴以下配置

```nginx
server {
    listen 8080;
    listen [::]:8080;  # IPv6 支持
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
        # 如果服务器有 IPv6 但飞书只支持 IPv4 白名单，需要这样配置
        resolver 8.8.8.8 ipv6=off valid=300s;
        resolver_timeout 5s;

        # 反向代理到飞书 API
        proxy_pass https://open.feishu.cn/;
        proxy_http_version 1.1;
        proxy_set_header Host open.feishu.cn;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 关键配置：确保 POST/PUT/DELETE 请求体正确转发
        proxy_buffering off;
        proxy_ssl_server_name on;
        proxy_connect_timeout 30s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

### 3. 配置说明

| 配置项 | 说明 |
|--------|------|
| `Access-Control-Allow-Methods` | 必须包含 `DELETE` 方法，飞书文档块删除 API 使用 DELETE 请求 |
| `proxy_buffering off` | 禁用缓冲，确保 POST/PUT/DELETE 请求体正确转发 |
| `proxy_send_timeout 60s` | 增加超时时间，文档操作可能需要更长时间 |
| `proxy_read_timeout 60s` | 增加读取超时时间 |

### 4. 保存并退出

按 `Ctrl+O` 保存，`Enter` 确认，`Ctrl+X` 退出。

---

## 四、启用配置并重启 Nginx

### 1. 创建软链接

```bash
sudo ln -s /etc/nginx/sites-available/feishu-proxy /etc/nginx/sites-enabled/
```

### 2. 禁用默认站点（如有冲突）

```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

### 3. 测试配置语法

```bash
sudo nginx -t
```

### 4. 重启 Nginx

```bash
sudo systemctl restart nginx
```

### 5. 检查服务状态

```bash
sudo systemctl status nginx
```

---

## 五、配置防火墙

### 使用 ufw（Debian/Ubuntu）

```bash
sudo ufw allow 8080/tcp
sudo ufw reload
```

### 使用 firewalld（CentOS/RHEL）

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

### 云服务器安全组

如果使用云服务器（如阿里云、腾讯云、AWS 等），请在云平台控制台的安全组设置中，**入方向**开放 **8080 端口**。

---

## 六、验证代理服务器

### 1. 在服务器本地测试（认证 API）

```bash
curl -X POST http://localhost:8080/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"您的AppID","app_secret":"您的AppSecret"}'
```

### 2. 从本地电脑测试

将 `YOUR_SERVER_IP` 替换为服务器 IP（IPv4 或 IPv6）：

```bash
# 使用 IPv4
curl -X POST http://服务器IPv4地址:8080/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"您的AppID","app_secret":"您的AppSecret"}'

# 使用 IPv6
curl -X POST http://[服务器IPv6地址]:8080/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"您的AppID","app_secret":"您的AppSecret"}'
```

### 3. 成功响应示例

```json
{"code":0,"msg":"ok","tenant_access_token":"xxx","expire":7200}
```

---

## 七、配置飞书 IP 白名单

飞书开放平台**仅支持 IPv4 白名单**，不支持 IPv6。

### 1. 获取服务器 IPv4 地址

在服务器上执行：

```bash
curl -4 ifconfig.me
```

### 2. 添加到飞书白名单

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 选择您的应用
3. 进入「开发配置」→「IP 白名单」
4. 添加服务器的公网 IPv4 地址
5. 保存并等待生效（约 5-10 分钟）

---

## 八、配置飞书应用权限

### 需要的权限

在飞书开放平台为应用添加以下权限：

| 权限名称 | 权限标识 | 说明 |
|----------|----------|------|
| 查看、评论和编辑新版文档 | `docx:document` | 读写文档内容 |
| 只读新版文档 | `docx:document:readonly` | 读取文档内容 |
| 上传、下载文件或图片 | `drive:drive` | 云空间文件操作 |

### 添加权限步骤

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 选择您的应用 → **权限管理**
3. 点击「添加权限」，搜索并添加上述权限
4. 保存配置
5. **重要**：创建新版本并发布应用，权限才会生效

### 用户重新授权

发布新版本后，之前授权的用户需要**重新授权**才能获得新权限。

---

## 九、常见问题排查

### 问题 1：Nginx 启动失败

```bash
# 查看错误日志
sudo cat /var/log/nginx/error.log | tail -30

# 检查配置语法
sudo nginx -t
```

### 问题 2：端口被占用

```bash
# 查看端口占用
sudo lsof -i :8080
# 或
sudo ss -tlnp | grep :8080
```

### 问题 3：无法从外部访问

1. 检查云服务器安全组是否开放 8080 端口
2. 检查服务器防火墙是否放行 8080 端口
3. 确认 Nginx 是否监听正确地址

```bash
# 检查监听状态
sudo ss -tlnp | grep :8080
```

### 问题 4：飞书 API 返回 403

- 确认已将服务器 IPv4 地址添加到飞书 IP 白名单
- 飞书白名单可能需要 5-10 分钟生效

### 问题 5：API 返回 404

- 确认使用的是正确的 HTTP 方法（GET/POST/DELETE）
- 确认 Nginx 配置中的 `Access-Control-Allow-Methods` 包含所需的 HTTP 方法
- 检查 API 路径是否正确

### 问题 6：DELETE 请求返回 "404 page not found"

这是因为原配置文件只允许 `GET, POST, OPTIONS` 方法。请更新配置：
1. 添加 `DELETE` 到 `Access-Control-Allow-Methods`
2. 添加 `proxy_buffering off`
3. 重启 Nginx

---

## 十、完整命令汇总

```bash
# 1. 安装 Nginx
sudo apt update && sudo apt install nginx -y

# 2. 创建配置
sudo nano /etc/nginx/sites-available/feishu-proxy
# （粘贴上述配置内容）

# 3. 启用配置
sudo ln -s /etc/nginx/sites-available/feishu-proxy /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 4. 测试并重启
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl status nginx

# 5. 开放防火墙
sudo ufw allow 8080/tcp

# 6. 获取 IPv4 地址（用于飞书白名单）
curl -4 ifconfig.me

# 7. 本地测试
curl -X POST http://localhost:8080/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"您的AppID","app_secret":"您的AppSecret"}'
```

---

## 十一、后续步骤

代理服务器搭建完成后，需要在 Obsidian Flybook 插件设置中配置代理地址。请使用服务器的 IPv6 地址（用于 Obsidian 访问）和确保 IPv4 地址已添加到飞书白名单（用于飞书 API 通信）。
