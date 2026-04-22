# FeiSync

Sync your notes to Feishu (Lark) Drive.

[中文说明](README_zh.md)

---

## Features

- **One-way sync**: Upload Obsidian notes to Feishu Drive, local files as source of truth
- **Incremental sync**: Skip unchanged files based on content hash
- **Multi-folder sync**: Configure multiple local folders mapped to different Feishu folders
- **Manual sync**: Trigger sync via command palette or Ribbon icon
- **Auto sync** (optional): Watch for file changes and auto-upload
- **Scheduled sync** (optional): Auto-sync at fixed intervals
- **User OAuth**: Personal cloud space access without IP whitelist
- **Download from Feishu**: Pull files from cloud to local
- **Proxy support** (optional): Reverse proxy for restricted networks
- **Chunked upload**: Large files uploaded in 4MB chunks, no size limit
- **Delete sync**: Optionally delete cloud files when local files are removed
- **Ignore rules**: `.feisync-ignore.md` file with gitignore-compatible syntax

---

## Installation

### Requirements

- Obsidian 0.15.0+ (Desktop only)
- A Feishu enterprise account

### Steps

1. Copy plugin folder to `.obsidian/plugins/` in your vault
2. Restart Obsidian
3. Enable "FeiSync" in Community Plugins settings

---

## Quick Start

### 1. Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and login
2. Click "Create Enterprise App"
3. Note down **App ID** and **App Secret** from "Credentials & Basic Info"

### 2. Configure App Permissions

Add these permissions in "Permission Management":

| Permission | Identifier | Purpose |
|------------|------------|---------|
| View/Comment/Edit Docs | `docx:document` | Read/write document content |
| Import Documents | `docs:document:import` | Import Markdown as Feishu docs |
| Cloud Space | `drive:drive` | File and folder operations |
| Export Documents | `drive:export:readonly` | Download/export documents |

> Publish a new version after adding permissions for them to take effect.

### 3. Configure Web App (OAuth)

1. Go to app → "App Features" → "Web App"
2. Add a web app with:
   - **Desktop Homepage**: `https://localhost`
   - **Redirect URL**: `http://localhost:9527/callback`

### 4. Configure Plugin

1. Open "Settings" → "FeiSync"
2. Enter App ID and App Secret
3. Add folder mappings
4. Click "Start Authorization" and complete OAuth in browser

### 5. Sync!

Use "Sync now" or command palette.

---

## Ignore Rules

Create `.feisync-ignore.md` in vault root:

```
# Ignore directories
attachments/
node_modules/

# Ignore by extension
*.log
*.tmp

# Ignore anywhere
**/.DS_Store

# Un-ignore
!important.md
```

---

## Proxy Server (Optional)

Only needed if you cannot directly access `open.feishu.cn`.

### Nginx Config

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

## Architecture

```
feisync/
├── main.ts                 # Plugin entry, command registration, coordination
├── settings.ts             # Settings UI, config management
├── feishuAuth.ts           # Authentication (tenant_access_token + OAuth user_access_token)
├── feishuApi.ts            # Feishu Drive API wrapper
│                           #   - Folder/file CRUD
│                           #   - Upload (full + chunked)
│                           #   - Download
│                           #   - Rate limiting (5 QPS)
│                           #   - Retry logic
├── syncEngine.ts           # Sync engine
│                           #   - Incremental sync (hash-based)
│                           #   - Concurrent upload
│                           #   - Delete sync
│                           #   - Multi-folder support
├── fileWatcher.ts          # Local file monitoring
│                           #   - Create/modify/delete/rename events
│                           #   - Debounced sync
├── syncFolderConfig.ts     # Multi-folder config management
├── ignoreFilter.ts         # .feisync-ignore.md parser (gitignore-compatible)
├── logger.ts               # Unified logging
├── feishuFolderBrowser.ts  # Feishu folder browser modal
├── fileTypeUtils.ts        # File type detection
├── manifest.json           # Plugin metadata
├── versions.json           # Version compatibility
├── esbuild.config.js       # Build configuration
└── package.json
```

---

## Feishu APIs Used

### Authentication

| API | Method | Purpose |
|-----|--------|---------|
| `/open-apis/auth/v3/tenant_access_token/internal` | POST | Get app access token |
| `/open-apis/auth/v3/app_access_token/internal` | POST | Get app token (OAuth) |
| `/open-apis/authen/v1/authorize` | GET | OAuth authorization page |
| `/open-apis/authen/v2/oauth/token` | POST | Exchange code for token |

### File Operations

| API | Method | Purpose |
|-----|--------|---------|
| `/open-apis/drive/v1/files` | GET | List folder contents |
| `/open-apis/drive/v1/files/create_folder` | POST | Create folder |
| `/open-apis/drive/v1/files/{token}` | DELETE | Delete file |
| `/open-apis/drive/v1/files/upload_all` | POST | Upload file (≤20MB) |
| `/open-apis/drive/v1/files/upload_prepare` | POST | Chunked upload init |
| `/open-apis/drive/v1/files/upload_block` | POST | Upload chunk |
| `/open-apis/drive/v1/files/upload_finish` | POST | Complete chunked upload |
| `/open-apis/drive/v1/files/{token}/download` | GET | Download cloud file |
| `/open-apis/drive/v1/export_tasks` | POST/GET | Export online docs |

---

## Development

```bash
npm install
npm run build      # Production build
npm run dev        # Watch mode
```

---

## License

MIT
