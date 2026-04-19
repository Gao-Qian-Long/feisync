# 飞书Drive文件夹管理模块设计

## 概述

该模块负责在飞书Drive中创建、列出、查找文件夹，并维护本地路径与飞书文件夹token之间的映射关系。

## 核心概念

- **飞书Drive根文件夹**：每个用户/租户有一个云空间，其中包含文件和文件夹。根文件夹的token可能是固定的（例如`0`或空值）。我们假设可以通过某个API获取根文件夹的列表。
- **文件夹token**：每个文件夹有一个唯一的标识符（如`fldcnxxxxxxxxx`），用于在API中引用。
- **路径映射**：插件需要将本地文件夹路径映射到飞书Drive中的文件夹token，以便在上传文件时确定父目录。

## 假设的API

根据飞书开放平台文档，我们假设存在以下API端点（具体细节可能需要后续验证）：

1. **创建文件夹**：`POST /open-apis/drive/v1/files` 或类似，参数包含 `type: "folder"`、`name`、`parent_token`。
2. **列出文件夹内容**：`GET /open-apis/drive/v1/files/:folder_token/children` 或类似。
3. **搜索文件夹**：通过文件名和父token查找现有文件夹。

由于文档未明确，我们将设计一个抽象层，允许以后替换具体的API实现。

## 文件夹管理器类

```typescript
export interface FeishuFolder {
  token: string;
  name: string;
  type: 'folder' | 'file';
  parentToken?: string;
}

export class FeishuFolderManager {
  private authManager: FeishuAuthManager;

  constructor(authManager: FeishuAuthManager) {
    this.authManager = authManager;
  }

  /**
   * 确保飞书Drive中存在与本地路径对应的文件夹结构。
   * @param localPath 本地相对路径（例如 'Notes/Projects'）
   * @param rootFolderToken 飞书根文件夹token（如果未提供，使用默认根文件夹）
   * @returns 最深层文件夹的token
   */
  async ensureFolderPath(localPath: string, rootFolderToken?: string): Promise<string> {
    const parts = localPath.split('/').filter(p => p.trim() !== '');
    let currentToken = rootFolderToken || await this.getDefaultRootFolderToken();

    for (const part of parts) {
      currentToken = await this.findOrCreateFolder(part, currentToken);
    }
    return currentToken;
  }

  /**
   * 在父文件夹下查找或创建子文件夹。
   */
  private async findOrCreateFolder(folderName: string, parentToken: string): Promise<string> {
    const existing = await this.findFolderByName(folderName, parentToken);
    if (existing) {
      return existing.token;
    }
    return await this.createFolder(folderName, parentToken);
  }

  /**
   * 根据名称和父token查找文件夹。
   */
  private async findFolderByName(folderName: string, parentToken: string): Promise<FeishuFolder | null> {
    // 实现：调用列出文件夹内容的API，遍历查找匹配名称的文件夹
    // 暂定返回 null
    return null;
  }

  /**
   * 创建文件夹。
   */
  private async createFolder(folderName: string, parentToken: string): Promise<string> {
    // 实现：调用飞书创建文件夹API
    // 返回新文件夹的token
    throw new Error('Not implemented');
  }

  /**
   * 获取默认根文件夹token（例如用户云空间的根）。
   */
  private async getDefaultRootFolderToken(): Promise<string> {
    // 实现：调用API获取根文件夹token，或使用预设值（如空字符串表示根）
    // 如果用户设置了自定义根文件夹token，则返回该值
    return '';
  }
}
```

## 集成到同步引擎

同步引擎在开始同步前，先调用 `ensureFolderPath` 获取目标文件夹token，然后在该文件夹下上传文件。

## 错误处理

- 文件夹创建失败：可能是权限不足、名称重复或网络问题。应抛出错误并通知用户。
- 文件夹查找失败：假设文件夹不存在，则创建。

## 缓存

为了提高性能，可以将已创建的文件夹token缓存到内存中（映射：本地路径 -> token）。Obsidian插件重启后缓存失效，需要重新创建文件夹（但飞书Drive中已存在的文件夹会被重复创建吗？）。为了避免重复创建，我们可以在每次同步时先尝试查找现有文件夹。

## 下一步

1. 查阅飞书Drive API 官方文档，确认创建文件夹和列出文件夹的具体端点。
2. 实现 `findFolderByName` 和 `createFolder` 方法。
3. 编写单元测试（如果项目包含测试）。
4. 在主插件中集成文件夹管理器。