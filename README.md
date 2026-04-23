# FeiSync

Sync your Obsidian notes to Feishu (Lark) Drive.

[中文说明](README_zh.md)

---

## Features

- **One-way sync**: Upload Obsidian notes to Feishu Drive with local files as the source of truth
- **Incremental sync**: Skip unchanged files based on SHA-256 content hash to save bandwidth
- **Multi-folder sync**: Configure multiple local folders mapped to different Feishu folders independently
- **Manual sync**: Trigger sync via command palette or ribbon icon
- **Auto sync** (optional): Watch for file changes and upload automatically with debouncing
- **Scheduled sync** (optional): Auto-sync at configurable intervals (1–1440 minutes)
- **Download from Feishu**: Pull files from cloud to local, with conflict detection via hash comparison
- **Delete sync** (optional): Remove cloud files when local files are deleted or renamed
- **Ignore rules**: `.feisync-ignore.md` file with gitignore-compatible syntax
- **File tree browser**: Browse Feishu folders and view complete recursive file trees with metadata
- **Sync log viewer**: Built-in log modal showing upload, skip, delete, download, and error events
- **User OAuth**: Personal cloud space access without IP whitelist
- **Proxy support** (optional): Reverse proxy for restricted networks
- **Chunked upload**: Large files uploaded in 4MB chunks, no size limit
- **Rate limiting & retry**: Built-in 5 QPS rate limiter with configurable retry attempts
- **Concurrency control**: Configurable max concurrent uploads (1–10)

> **Important**: This plugin performs **one-way sync** (Obsidian → Feishu). If you modify files directly in Feishu and then sync from Obsidian, the cloud changes will be overwritten by the local version. Use **"Download from Feishu"** to pull cloud changes to local first.

---

## Installation

### Requirements

- Obsidian 0.15.0+ (Desktop only)
- A Feishu enterprise account

### Steps

1. Copy the plugin folder to `.obsidian/plugins/` in your vault
2. Restart Obsidian
3. Enable "FeiSync" in Community Plugins settings

---

## Quick Start

### 1. Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and log in
2. Click "Create Enterprise App"
3. Note down **App ID** and **App Secret** from "Credentials & Basic Info"

### 2. Configure App Permissions

Add these permissions in "Permission Management" and then publish a new version:

| Permission | Identifier | Purpose |
|------------|------------|---------|
| Cloud Space | `drive:drive` | File and folder CRUD operations |
| Export Documents (Readonly) | `drive:export:readonly` | Export/download online documents |
| Download File | `drive:file:download` | Download cloud file content |
| Online Document | `docx:document` | Access online documents |
| Import Document | `docs:document:import` | Import Markdown as Feishu docs |
| Export Document | `docs:document:export` | Export Feishu docs to other formats |

### 3. Configure Web App (OAuth)

1. Go to app → "App Features" → "Web App"
2. Add a web app with:
   - **Desktop Homepage**: `https://localhost`
   - **Redirect URL**: `http://localhost:9527/callback`

### 4. Configure Plugin

1. Open **Settings → FeiSync**
2. Enter **App ID** and **App Secret**
3. Add folder mappings:
   - **Auto mode**: Automatically create/manage folders under a root Feishu folder
   - **Custom mode**: Specify an exact Feishu folder token
4. Click **"Start Authorization"** and complete OAuth in your browser
5. (Optional) Enable auto sync, scheduled sync, or delete sync

### 5. Sync

- Click the **cloud-upload ribbon icon** for a menu with sync/download/settings
- Use the **Command Palette** (`Ctrl+P` / `Cmd+P`):
  - `FeiSync: Sync now`
  - `FeiSync: Download from feishu`
  - `FeiSync: View sync log`

---

## Folder Mapping Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Auto** | Plugin automatically creates a subfolder under the configured Feishu root folder. The folder token is managed internally. | Simple setup, one-click sync |
| **Custom** | You specify the exact Feishu folder token. Use the built-in **Browse Feishu Folder** button to navigate and select. | Precise control over cloud location |

---

## Ignore Rules

Create `.feisync-ignore.md` in your vault root. Syntax is compatible with `.gitignore`:

```
# Ignore directories
attachments/
node_modules/

# Ignore by extension
*.log
*.tmp

# Ignore anywhere in the tree
**/.DS_Store

# Un-ignore (exception)
!important.md
```

Changes to this file are picked up automatically on the next sync.

---

## Plugin Settings

| Setting | Default | Description |
|---------|---------|-------------|
| App ID | — | Feishu app identifier |
| App secret | — | Feishu app secret |
| Sync folder mappings | — | One or more local→remote folder pairs |
| Auto sync on change | Off | Watch local files and sync after a debounce |
| Debounce interval | 5s | Delay after file change before auto-sync |
| Scheduled sync | Off | Auto-sync at fixed time intervals |
| Sync interval | 30min | Interval for scheduled sync |
| Delete sync | On | Remove cloud files when local files are deleted |
| Max concurrent uploads | 3 | Parallel upload limit (1–10) |
| Max retry attempts | 3 | API call retry attempts on failure |
| Proxy URL | — | Optional reverse proxy for `open.feishu.cn` |

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
├── main.ts                 # Plugin entry, lifecycle, commands, coordination
├── settings.ts             # Settings UI, config management, sync log modal
├── feishuAuth.ts           # OAuth & token management (tenant + user tokens)
├── feishuApi.ts            # Feishu Drive API wrapper
│                           #   - Folder/file CRUD
│                           #   - Upload (full + chunked)
│                           #   - Download, export, import
│                           #   - Rate limiting (5 QPS)
│                           #   - Retry logic with exponential backoff
├── syncEngine.ts           # Sync engine
│                           #   - Incremental sync (SHA-256 hash-based)
│                           #   - Concurrent upload pool
│                           #   - Delete sync & rename handling
│                           #   - Multi-folder support
│                           #   - Download from Feishu with conflict check
├── fileWatcher.ts          # Local file monitoring
│                           #   - Create/modify/delete/rename events
│                           #   - Debounced sync trigger
├── feishuFolderBrowser.ts  # Interactive folder browser + recursive file tree modal
├── syncFolderConfig.ts     # Multi-folder config model & validation
├── ignoreFilter.ts         # .feisync-ignore.md parser (gitignore-compatible)
├── fileTypeUtils.ts        # File type detection for Feishu API
├── logger.ts               # Unified logging with namespace support
├── manifest.json           # Plugin metadata
├── styles.css              # Plugin UI styles
├── esbuild.config.js       # Build configuration
└── package.json
```

---

## Feishu APIs Used

### Authentication

| API | Method | Purpose |
|-----|--------|---------|
| `/open-apis/auth/v3/tenant_access_token/internal` | POST | App-level access token |
| `/open-apis/auth/v3/app_access_token/internal` | POST | App token for OAuth |
| `/open-apis/authen/v1/authorize` | GET | OAuth authorization page |
| `/open-apis/authen/v2/oauth/token` | POST | Exchange code for user token |
| `/open-apis/authen/v1/user_info` | GET | Get authorized user info |
| `/open-apis/authen/v1/oidc/access_token` | POST | Refresh user access token |

### File & Folder Operations

| API | Method | Purpose |
|-----|--------|---------|
| `/open-apis/drive/v1/files` | GET | List folder contents |
| `/open-apis/drive/v1/files/create_folder` | POST | Create folder |
| `/open-apis/drive/v1/files/{token}` | DELETE | Delete file/folder |
| `/open-apis/drive/v1/files/upload_all` | POST | Upload file (≤20MB) |
| `/open-apis/drive/v1/files/upload_prepare` | POST | Chunked upload initialization |
| `/open-apis/drive/v1/files/upload_block` | POST | Upload chunk (4MB) |
| `/open-apis/drive/v1/files/upload_finish` | POST | Complete chunked upload |
| `/open-apis/drive/v1/files/{token}/download` | GET | Download cloud file |
| `/open-apis/drive/v1/export_tasks` | POST | Create export task |
| `/open-apis/drive/v1/export_tasks/{token}` | GET | Query export task result |
| `/open-apis/drive/v1/import_tasks` | POST | Create import task |
| `/open-apis/drive/v1/import_tasks/{token}` | GET | Query import task result |
| `/open-apis/drive/v1/media/batch_get_tmp_download_url` | POST | Get batch download URLs |
| `/open-apis/drive/v1/metas/batch_query` | POST | Batch query file metadata |

---

## Commands

| Command | ID | Action |
|---------|-----|--------|
| **Sync now** | `feisync:sync` | Trigger one-way upload sync |
| **Download from feishu** | `feisync:download` | Pull cloud files to local |
| **View sync log** | `feisync:log` | Open settings and view sync history |

Ribbon icon (`cloud-upload`) provides a quick menu with the same actions plus **Open settings**.

---

## Data Safety Notes

- **One-way sync overwrite risk**: If a file is modified in Feishu and then you run "Sync now" from Obsidian, the cloud version will be deleted and replaced with the local (older) version. Always use **"Download from feishu"** first if you edited files in the cloud.
- **Delete sync**: When enabled, deleting a local file will also delete its cloud counterpart. This can be disabled in settings.
- **Hash-based detection**: The plugin uses SHA-256 hashes to detect changes. Files with identical content will be skipped even if their modification times differ.

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
