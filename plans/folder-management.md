# 飞书 Drive 文件夹管理模块设计

## 概述

该模块负责在飞书 Drive 中创建、列出、查找文件夹，并维护本地路径与飞书文件夹 token 之间的映射关系。

## 核心概念

- **飞书 Drive 根文件夹**：每个用户/租户有一个云空间，其中包含文件和文件夹。
- **文件夹 token**：每个文件夹有一个唯一的标识符（如 `fldcnxxxxxxxxx`），用于在 API 中引用。
- **路径映射**：插件需要将本地文件夹路径映射到飞书 Drive 中的文件夹 token，以便在上传文件时确定父目录。

## 多文件夹同步配置

```typescript
interface SyncFolderConfig {
  id: string;                              // 唯一标识符
  localPath: string;                        // 本地文件夹路径
  remoteFolderToken: string;                // 飞书目标文件夹 token
  enabled: boolean;                         // 是否启用
  mode: 'auto' | 'custom';                 // auto=自动创建, custom=指定已有文件夹
  lastSyncTime: number;                     // 上次同步时间
  lastSyncFileCount: number;                // 上次同步文件数
}
```

## API 端点

### 列出文件夹内容

```
GET https://open.feishu.cn/open-apis/drive/v1/files?folder_token={folderToken}
```

返回指定文件夹中的文件和文件夹列表。

### 创建文件夹

```
POST https://open.feishu.cn/open-apis/drive/v1/files/create_folder
```

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `name` | string | 是 | 文件夹名称 |
| `folder_token` | string | 是 | 父文件夹 token，为空表示根目录 |

### 移动文件

```
POST https://open.feishu.cn/open-apis/drive/v1/files/{token}/move
```

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `type` | string | 是 | 文件类型 |
| `folder_token` | string | 是 | 目标文件夹 token |

## 实现

### 列出文件夹内容

```typescript
async listFolderContents(folderToken: string): Promise<FeishuFileMeta[]> {
  const path = folderToken
    ? `/open-apis/drive/v1/files?folder_token=${folderToken}`
    : '/open-apis/drive/v1/files';
  
  const data = await this.apiRequest(
    this.getApiUrl(path),
    { method: 'GET', headers: await this.getHeaders() }
  );

  return data.data.files.map((f: any) => ({
    token: f.token || f.file_token,
    name: f.name,
    type: f.type,
    parentToken: folderToken,
    size: f.size,
    createdTime: f.created_time,
    modifiedTime: f.last_modified_time,
  }));
}
```

### 创建文件夹

```typescript
async createFolder(folderName: string, parentToken: string): Promise<string> {
  const body = {
    name: folderName,
    folder_token: parentToken || '',
  };

  const data = await this.apiRequest(
    this.getApiUrl('/open-apis/drive/v1/files/create_folder'),
    {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify(body),
    }
  );

  return data.data.file_token;
}
```

### 确保文件夹路径存在

递归确保目标文件夹路径存在，如果不存在则创建：

```typescript
async ensureFolderPath(folderPath: string, rootFolderToken?: string): Promise<string> {
  const parts = folderPath.split('/').filter(p => p.trim() !== '');
  let currentToken = rootFolderToken || '';

  for (const part of parts) {
    currentToken = await this.findOrCreateFolder(part, currentToken);
  }

  return currentToken;
}

private async findOrCreateFolder(folderName: string, parentToken: string): Promise<string> {
  // 先查找是否存在
  const files = await this.listFolderContents(parentToken);
  const existing = files.find(f => f.name === folderName && f.type === 'folder');
  
  if (existing) {
    return existing.token;
  }
  
  // 不存在则创建
  return await this.createFolder(folderName, parentToken);
}
```

### 移动文件

```typescript
async moveFile(fileToken: string, fileType: string, targetFolderToken: string): Promise<void> {
  const body = {
    type: fileType,
    folder_token: targetFolderToken,
  };

  const data = await this.apiRequest(
    this.getApiUrl(`/open-apis/drive/v1/files/${fileToken}/move`),
    {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify(body),
    }
  );

  if (data.code !== 0) {
    throw new Error(`移动文件失败: ${data.msg}`);
  }
}
```

## 飞书文件夹浏览器

提供 UI 组件让用户浏览和选择飞书云空间中的文件夹：

```typescript
export class FeishuFolderBrowser {
  private apiClient: FeishuApiClient;
  private currentFolderToken: string = '';
  private folders: FeishuFileMeta[] = [];
  
  async loadFolder(token: string): Promise<void> {
    this.currentFolderToken = token;
    this.folders = await this.apiClient.listFolderContents(token);
    this.folders = this.folders.filter(f => f.type === 'folder');
  }
  
  async createFolder(name: string): Promise<string> {
    return await this.apiClient.createFolder(name, this.currentFolderToken);
  }
}
```

## 文件夹映射策略

1. **同步开始时**：遍历配置的所有文件夹映射。
2. **确保路径存在**：调用 `ensureFolderPath` 确保每个子文件夹在飞书中存在。
3. **获取目标 token**：返回最深层文件夹的 token，用于上传文件。

## 示例流程

```
本地路径：Notes/Projects/MyNotes
目标根文件夹：OShLfop5RlvFhsdmkZsclnmonP6
```

1. 调用 `ensureFolderPath('Notes/Projects/MyNotes', 'OShLfop5RlvFhsdmkZsclnmonP6')`
2. 检查/创建 `Notes` 文件夹 → token: `xxx`
3. 在 `xxx` 下检查/创建 `Projects` 文件夹 → token: `yyy`
4. 在 `yyy` 下检查/创建 `MyNotes` 文件夹 → token: `zzz`
5. 返回 `zzz`，用于上传文件

## 路径处理说明

文件路径格式如 `folder/sub/file.md`：

```typescript
// file.path 格式如 "folder/sub/file.md"
// pathParts = ["folder", "sub", "file.md"]

const pathParts = relativePath.split('/');

// pathParts.length === 1：文件直接在根目录，不需要创建子文件夹
// 否则：pathParts.slice(1, -1) 取中间部分作为子路径
if (pathParts.length === 1) {
  parentFolderToken = targetFolderToken;
} else {
  const subPath = pathParts.slice(1, -1).join('/');  // 去掉首尾
  parentFolderToken = await this.apiClient.ensureFolderPath(subPath, targetFolderToken);
}
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 文件夹创建失败 | 可能是权限不足、名称重复或网络问题 |
| 文件夹查找失败 | 假设文件夹不存在，尝试创建 |
| 移动文件失败 | 回退到删除+上传策略 |

## 注意事项

1. **使用 user_access_token**：使用用户令牌操作用户个人云空间中的文件夹。
2. **父文件夹权限**：用户需要对目标文件夹有编辑权限。
3. **文件夹名称限制**：飞书文件夹名称最大 50 字符。
