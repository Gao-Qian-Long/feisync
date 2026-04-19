# 文件上传功能设计

## 概述

该模块负责将本地文件上传到飞书Drive的指定文件夹中。根据需求，我们以本地文件为准，覆盖云端已有文件（如果需要的话）。上传过程需要处理文件分块、重试、进度通知等。

## 飞书API端点

根据现有文档，我们有以下可能的端点：

1. **`POST /drive/v1/medias/upload_all`**：上传媒体文件（图片、视频、文件）到某个云文档中。限制：文件 ≤20MB，`parent_type` 需指定为文档类型。
2. **分块上传**：`POST /drive/v1/medias/upload_prepare` + 分块上传 + 完成上传。适用于大文件。
3. **导入任务**：`POST /drive/v1/import_tasks` 用于导入外部文件，可能支持更多格式。

但我们的目标是上传到普通文件夹（而非云文档）。可能需要使用 **“创建文件”** 接口，其中 `type` 为 `file`，并通过 `folder_token` 指定父文件夹。

由于文档不全，我们假设存在一个类似 `POST /drive/v1/files` 的接口，用于在文件夹中创建文件。

## 设计决策

考虑到 Obsidian 笔记通常为 Markdown 文件（大小一般 <1MB），我们可以先实现简单的小文件上传（≤20MB）。若文件超过 20MB，则报错。

我们选择使用 `upload_all` 端点（如果支持文件夹）或寻找更合适的 API。为了不影响设计，我们抽象出一个 **上传器接口**，便于后续替换实现。

## 上传器接口

```typescript
export interface FileUploader {
  /**
   * 上传本地文件到飞书Drive的指定文件夹。
   * @param localFilePath 本地文件绝对路径
   * @param remoteFileName 远程文件名（可不同于本地文件名）
   * @param parentFolderToken 父文件夹token
   * @returns 上传文件的 token
   */
  uploadFile(
    localFilePath: string,
    remoteFileName: string,
    parentFolderToken: string
  ): Promise<string>;

  /**
   * 检查文件大小是否支持。
   */
  checkFileSize(sizeInBytes: number): boolean;
}
```

## 基于 `upload_all` 的实现

假设 `upload_all` 支持将文件上传到文件夹（`parent_type: "folder"`），实现如下：

```typescript
export class FeishuMediaUploader implements FileUploader {
  private authManager: FeishuAuthManager;

  constructor(authManager: FeishuAuthManager) {
    this.authManager = authManager;
  }

  async uploadFile(
    localFilePath: string,
    remoteFileName: string,
    parentFolderToken: string
  ): Promise<string> {
    const token = await this.authManager.getAccessToken();
    const fileBuffer = await fs.promises.readFile(localFilePath);
    const size = fileBuffer.length;

    if (!this.checkFileSize(size)) {
      throw new Error(`File size ${size} bytes exceeds limit 20MB`);
    }

    const formData = new FormData();
    formData.append('file_name', remoteFileName);
    formData.append('parent_type', 'folder'); // 假设支持
    formData.append('parent_node', parentFolderToken);
    formData.append('size', size.toString());
    formData.append('file', new Blob([fileBuffer]), remoteFileName);

    const response = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        // Content-Type 将由浏览器设置，包含 multipart/form-data 边界
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    if (result.code !== 0) {
      throw new Error(`Feishu API error: ${result.msg}`);
    }

    return result.data.file_token;
  }

  checkFileSize(sizeInBytes: number): boolean {
    return sizeInBytes <= 20 * 1024 * 1024; // 20 MB
  }
}
```

**注意**：在 Node.js 环境中（Obsidian 插件环境），`FormData` 和 `Blob` 可能不可用。需要使用 `fs` 读取文件，并可能使用 `node-fetch` 或 `axios` 发送 multipart 请求。Obsidian 插件环境基于 Electron，提供了 `window.fetch` 和 `FormData`，因此上述代码可能可以运行。

## 错误处理

- 网络错误：重试最多3次，每次间隔递增。
- 令牌过期：由 `authManager` 自动刷新。
- 文件大小超限：抛出明确错误，提示用户。

## 上传进度

可以为大文件提供进度提示，但鉴于小文件场景，可暂不实现。

## 文件覆盖策略

飞书API可能不支持直接覆盖同名文件。我们需要先检查目标文件夹中是否存在同名文件，如果存在，则可能需要先删除再上传，或使用版本更新。根据需求“以本地文件为准”，我们采用 **删除后重新上传** 的策略。

因此，上传前需要调用“列出文件夹文件”接口，查找同名文件，获取其 token，然后调用“删除文件”接口。

## 同步协调

上传模块应与其他模块协作：

1. 文件夹管理器确保目标文件夹存在。
2. 文件扫描器获取本地文件列表。
3. 上传器逐个上传文件。

## 下一步

1. 验证飞书Drive文件上传API的确切端点及参数。
2. 实现文件删除、列出文件的辅助方法。
3. 集成到同步引擎中。
4. 编写测试。