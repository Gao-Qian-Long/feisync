# 飞书 Drive 文件夹管理模块设计

## 概述

该模块负责在飞书 Drive 中创建、列出、查找文件夹，并维护本地路径与飞书文件夹 token 之间的映射关系。

## 核心概念

- **飞书 Drive 根文件夹**：每个用户/租户有一个云空间，其中包含文件和文件夹。
- **文件夹 token**：每个文件夹有一个唯一的标识符（如 `fldcnxxxxxxxxx`），用于在 API 中引用。
- **路径映射**：插件需要将本地文件夹路径映射到飞书 Drive 中的文件夹 token，以便在上传文件时确定父目录。

## API 端点

### 1. 获取根文件夹元数据

```
GET https://open.feishu.cn/open-apis/drive/explorer/v2/root_folder/meta
```

返回根文件夹的 token、ID 和所有者信息。

### 2. 列出文件夹内容

```
GET https://open.feishu.cn/open-apis/drive/v1/files?folder_token={folderToken}
```

返回指定文件夹中的文件和文件夹列表。

### 3. 创建文件夹

```
POST https://open.feishu.cn/open-apis/drive/v1/files/create_folder
```

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `name` | string | 是 | 文件夹名称 |
| `folder_token` | string | 是 | 父文件夹 token，为空表示根目录 |

## 实现

### FeishuApiClient

#### listFolderContents()

列出指定文件夹的内容：

```typescript
async listFolderContents(folderToken: string): Promise<FeishuFileMeta[]> {
  const path = folderToken
    ? `/open-apis/drive/v1/files?folder_token=${folderToken}`
    : '/open-apis/drive/v1/files';
  
  const data = await this.fetchWithTimeout(
    this.getApiUrl(path),
    { method: 'GET', headers: await this.getHeaders() }
  );

  return data.data.files.map((f: any) => ({
    token: f.token || f.file_token,
    name: f.name,
    type: f.type,
    parentToken: folderToken,
  }));
}
```

#### createFolder()

创建新文件夹：

```typescript
async createFolder(folderName: string, parentToken: string): Promise<string> {
  const body = {
    name: folderName,
    folder_token: parentToken || '',
  };

  const data = await this.fetchWithTimeout(
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

#### findFolderByName()

根据名称和父 token 查找文件夹：

```typescript
async findFolderByName(folderName: string, parentToken: string): Promise<FeishuFileMeta | null> {
  const files = await this.listFolderContents(parentToken);
  return files.find(f => f.name === folderName && f.type === 'folder') || null;
}
```

#### ensureFolderPath()

确保目标文件夹路径存在，如果不存在则创建：

```typescript
async ensureFolderPath(folderPath: string, rootFolderToken?: string): Promise<string> {
  const parts = folderPath.split('/').filter(p => p.trim() !== '');
  let currentToken = rootFolderToken || '';

  for (const part of parts) {
    currentToken = await this.findOrCreateFolder(part, currentToken);
  }

  return currentToken;
}
```

## 文件夹映射策略

1. **同步开始时**：扫描本地文件夹结构。
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

## 错误处理

- **文件夹创建失败**：可能是权限不足、名称重复或网络问题。
- **文件夹查找失败**：假设文件夹不存在，尝试创建。

## 缓存策略

为了减少 API 调用，可以将已创建的文件夹 token 缓存到内存中。但考虑到同步频率不高，且飞书 API 有速率限制，暂不实现复杂缓存。

## 注意事项

1. **使用 user_access_token**：使用用户令牌操作用户个人云空间中的文件夹。
2. **父文件夹权限**：用户需要对目标文件夹有编辑权限。
