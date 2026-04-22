# 文件上传功能设计

## 概述

该模块负责将本地文件作为**普通文件**上传到飞书 Drive 的指定文件夹中。插件以本地文件为准，覆盖云端已有文件（通过删除后重新上传实现）。

## 核心设计决策

1. **上传为普通文件**：使用 `upload_all` API，`parent_type` 设为 `explorer`，文件会上传到云空间作为普通文件，而非云文档。
2. **文件大小限制**：
   - 全量上传：单个文件 ≤20MB
   - 分片上传：>20MB 文件使用分片上传，无大小上限
3. **覆盖策略**：如果云端存在同名文件，先删除旧文件，再上传新文件。
4. **并发控制**：支持配置最大并发上传数，默认 3。

## API 端点

### 全量上传（≤20MB）

```
POST https://open.feishu.cn/open-apis/drive/v1/files/upload_all
```

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `file_name` | string | 是 | 文件名，最大 250 字符 |
| `parent_type` | string | 是 | 固定填 `explorer`，表示上传到云空间 |
| `parent_node` | string | 是 | 目标文件夹的 token |
| `size` | number | 是 | 文件大小（字节），最大 20971520（20MB） |
| `file_type` | string | 是 | 文件类型（docx/xlsx/sheet 等） |
| `file` | binary | 是 | 文件的二进制内容 |

### 分片上传（>20MB）

#### 1. 预上传

```
POST https://open.feishu.cn/open-apis/drive/v1/files/upload_prepare
```

#### 2. 分片上传

```
POST https://open.feishu.cn/open-apis/drive/v1/files/upload_block
```

#### 3. 完成上传

```
POST https://open.feishu.cn/open-apis/drive/v1/files/upload_finish
```

## 实现

### 文件大小检查

```typescript
checkFileSize(sizeInBytes: number): boolean {
  const limitBytes = 20 * 1024 * 1024; // 20MB
  return sizeInBytes <= limitBytes;
}
```

### 上传流程

```typescript
async uploadFile(
  fileContent: ArrayBuffer | Uint8Array,
  fileName: string,
  parentFolderToken: string,
  size: number
): Promise<string> {
  // 1. 检查文件大小
  if (this.checkFileSize(size)) {
    // 2a. 全量上传
    return await this.uploadFileAll(fileContent, fileName, parentFolderToken, size);
  } else {
    // 2b. 分片上传
    return await this.uploadFileChunked(fileContent, fileName, parentFolderToken, size);
  }
}
```

## 云端文件查重优化

### 问题

传统方案对每个新文件调用 `findFileByName()` API 查询云端是否有同名文件，时间复杂度 O(n)。

### 优化方案

在 `syncFolder()` 开始时预获取云端文件列表，后续查重用内存查找替代 API 调用，时间复杂度 O(1)。

```typescript
// syncFolder() 中
let cloudFiles: FeishuFileMeta[] | undefined;
if (localFiles.length > 0) {
  cloudFiles = await this.apiClient.listFolderContents(targetFolderToken);
}

// syncFile() 中
const existingFile = cloudFiles
  ? cloudFiles.find(f => f.name === file.name || ...)
  : await this.apiClient.findFileByName(file.name, parentFolderToken);
```

## 文件覆盖策略

由于飞书 API 不支持直接覆盖同名文件，采用以下策略：

1. **查找同名文件**：优先使用预获取的云端文件列表，否则调用 `listFolderContents`。
2. **删除旧文件**：如果存在，调用 `deleteFile` 删除旧文件。
3. **上传新文件**：调用 `uploadFile` 上传新文件。

### 错误处理

| 错误类型 | 处理方式 |
|----------|----------|
| IP 白名单限制（99991401） | 提示用户，继续上传为新文件 |
| 文件已不存在（1061007） | 静默处理，视为删除成功 |
| 其他删除错误 | 记录警告，继续上传新文件 |

## 支持的文件类型

插件支持以下类型的文件上传：

| 类型 | 扩展名 | file_type |
|------|--------|-----------|
| 文本文件 | `md`, `txt`, `json`, `yml`, `yaml` 等 | `file` |
| Word 文档 | `docx`, `doc` | `docx` |
| Excel 表格 | `xlsx`, `xls` | `sheet` |
| PowerPoint | `pptx`, `ppt` | `docx` |
| PDF | `pdf` | `file` |
| 图片 | `png`, `jpg`, `gif`, `webp` | `file` |
| 压缩包 | `zip`, `rar`, `7z` | `file` |

## 速率限制

- 飞书 API 限制：5 QPS
- 实现：RateLimiter 使用 Promise 链互斥锁实现线程安全限流

```typescript
class RateLimiter {
  private timestamps: number[] = [];
  private lock: Promise<void> = Promise.resolve();

  async acquire(): Promise<void> {
    this.lock = this.lock.then(async () => {
      // 清理超出窗口的时间戳
      this.timestamps = this.timestamps.filter(t => Date.now() - t < this.windowMs);
      
      if (this.timestamps.length >= this.maxRequests) {
        // 等待直到最早的请求超出窗口
        const waitTime = this.windowMs - (Date.now() - this.timestamps[0]) + 10;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      this.timestamps.push(Date.now());
    });
    await this.lock;
  }
}
```

## 注意事项

1. **使用 user_access_token**：优先使用用户令牌上传，文件会存储在用户的个人云空间。
2. **代理支持**：如果配置了代理服务器，所有请求通过代理转发。
3. **上传频率限制**：飞书 API 限制 5 QPS，10000 次/天。
