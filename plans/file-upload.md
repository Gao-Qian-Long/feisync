# 文件上传功能设计

## 概述

该模块负责将本地文件作为**普通文件**上传到飞书 Drive 的指定文件夹中。插件以本地文件为准，覆盖云端已有文件（通过删除后重新上传实现）。

## 核心设计决策

1. **上传为普通文件**：使用 `upload_all` API，`parent_type` 设为 `explorer`，文件会上传到云空间作为普通文件，而非云文档。
2. **文件大小限制**：飞书 API 限制单个文件 ≤20MB。
3. **覆盖策略**：如果云端存在同名文件，先删除旧文件，再上传新文件。

## API 端点

```
POST https://open.feishu.cn/open-apis/drive/v1/medias/upload_all
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `file_name` | string | 是 | 文件名，最大 250 字符 |
| `parent_type` | string | 是 | 固定填 `explorer`，表示上传到云空间 |
| `parent_node` | string | 是 | 目标文件夹的 token |
| `size` | number | 是 | 文件大小（字节），最大 20971520（20MB） |
| `file` | binary | 是 | 文件的二进制内容 |

### 响应

上传成功后，返回 `file_token`，可用于下载或获取文件元信息。

## 实现

### FeishuApiClient.uploadFile()

```typescript
async uploadFile(
  fileContent: ArrayBuffer | Uint8Array,
  fileName: string,
  parentFolderToken: string,
  size: number
): Promise<string> {
  const token = await this.authManager.getAccessToken();

  const formData = new FormData();
  formData.append('file_name', fileName);
  formData.append('parent_type', 'explorer');  // 关键：上传为普通文件
  formData.append('parent_node', parentFolderToken);
  formData.append('size', size.toString());

  const blob = new Blob([fileContent]);
  formData.append('file', blob, fileName);

  const response = await fetch(
    this.getApiUrl('/open-apis/drive/v1/medias/upload_all'),
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    }
  );

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`上传文件失败: ${data.msg}`);
  }

  return data.data.file_token;
}
```

## 文件覆盖策略

由于飞书 API 不支持直接覆盖同名文件，采用以下策略：

1. **查找同名文件**：调用 `listFolderContents` 获取文件夹内容，查找同名文件。
2. **删除旧文件**：如果存在，调用 `deleteFile` 删除旧文件。
3. **上传新文件**：调用 `uploadFile` 上传新文件。

### FeishuApiClient.deleteFile()

```typescript
async deleteFile(fileToken: string, fileType: string = 'file'): Promise<void> {
  const headers = await this.getHeaders();
  // 注意：type 是查询参数
  const endpoint = this.getApiUrl(
    `/open-apis/drive/v1/files/${fileToken}?type=${fileType}`
  );

  const data = await this.fetchWithTimeout(endpoint, {
    method: 'DELETE',
    headers,
  });

  if (data.code !== 0) {
    throw new Error(`删除文件失败: ${data.msg}`);
  }
}
```

## 文件大小检查

```typescript
checkFileSize(sizeInBytes: number): boolean {
  const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
  return sizeInBytes <= MAX_SIZE;
}
```

## 同步引擎中的使用

```typescript
private async uploadSingleFile(file: TFile, parentFolderToken: string): Promise<void> {
  // 1. 读取文件内容
  const content = await this.vault.read(file);
  const fileSize = new Blob([content]).size;

  // 2. 检查文件大小
  if (!this.apiClient.checkFileSize(fileSize)) {
    throw new Error('文件大小超过20MB限制');
  }

  // 3. 检查云端是否已存在同名文件
  const existingFile = await this.apiClient.findFileByName(file.name, parentFolderToken);

  if (existingFile) {
    // 4a. 删除旧文件
    await this.apiClient.deleteFile(existingFile.token, existingFile.type);
  }

  // 5. 上传新文件
  const fileBuffer = new TextEncoder().encode(content).buffer;
  await this.apiClient.uploadFile(
    new Uint8Array(fileBuffer),
    file.name,
    parentFolderToken,
    fileSize
  );
}
```

## 支持的文件类型

插件支持以下类型的文件上传：

| 类型 | 扩展名 | 读取方式 |
|------|--------|----------|
| 文本文件 | `md`, `txt`, `json`, `yml`, `yaml` 等 | `vault.read()` |
| 二进制文件 | `docx`, `doc`, `xlsx`, `xls`, `pdf`, `png`, `jpg`, `gif`, `zip` 等 | `vault.readBinary()` |

## 错误处理

- **文件大小超限**：抛出明确错误。
- **网络错误**：由调用方处理重试。
- **令牌过期**：由 `authManager` 自动刷新。
- **删除失败**：记录警告，但继续上传新文件。

## 注意事项

1. **使用 user_access_token**：优先使用用户令牌上传，文件会存储在用户的个人云空间。
2. **代理支持**：如果配置了代理服务器，所有请求通过代理转发。
3. **上传频率限制**：飞书 API 限制 5 QPS，10000 次/天。
