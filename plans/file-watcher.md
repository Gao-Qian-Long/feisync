# 本地文件监控模块设计

## 概述

该模块负责监控用户指定的本地文件夹，当文件发生变化（创建、修改、删除、重命名）时，自动触发同步到飞书 Drive。

## Obsidian 事件系统

Obsidian 提供了 `Vault` 事件，可通过 `this.app.vault.on(event, callback)` 监听：

| 事件 | 说明 | 处理 |
|------|------|------|
| `create` | 文件或文件夹创建 | 忽略文件夹，触发同步 |
| `modify` | 文件内容修改 | 触发同步 |
| `delete` | 文件或文件夹删除 | 同步删除云端文件（可选） |
| `rename` | 文件或文件夹重命名 | 删除旧云端文件 |

## 忽略规则集成

FileWatcher 使用 IgnoreFilter 检查文件是否应该被忽略：

```typescript
private shouldIgnore(file: TAbstractFile): boolean {
  // .feisyncignore 文件本身不被忽略
  if (file.name === FEISYNC_IGNORE_FILE) {
    return false;
  }
  
  // 检查忽略规则
  return this.ignoreFilter.shouldIgnore(file.path);
}
```

## 多文件夹监控

支持同时监控多个配置的文件夹：

```typescript
private isInWatchedPath(file: TAbstractFile): boolean {
  if (this.watchedPaths.length === 0) {
    return false;
  }

  const relativePath = file.path.replace(/\\/g, '/');
  return this.watchedPaths.some(watchedPath => {
    const normalizedWatchedPath = watchedPath.replace(/\\/g, '/').replace(/\/$/, '');
    if (relativePath === normalizedWatchedPath) {
      return true;
    }
    return relativePath.startsWith(normalizedWatchedPath + '/');
  });
}
```

## 防抖策略

为了避免频繁触发同步，使用防抖机制：

- **延迟时间**：由设置中的 `syncInterval` 控制（分钟转毫秒）
- **按路径防抖**：同一文件的多次变化只触发一次同步
- **自动取消**：新变化会取消旧的待处理同步

```typescript
private scheduleSync(action: string, ...paths: string[]): void {
  const key = paths.join('|');
  
  // 取消旧的定时器
  if (this.debounceTimers.has(key)) {
    clearTimeout(this.debounceTimers.get(key)!);
  }
  
  const delayMs = this.plugin.settings.syncInterval * 60 * 1000;
  
  const timer = setTimeout(async () => {
    this.debounceTimers.delete(key);
    await this.plugin.sync();
  }, delayMs);
  
  this.debounceTimers.set(key, timer);
}
```

## 重命名事件处理

重命名事件需要同时处理旧路径和新路径：

```typescript
private onFileRename(file: TAbstractFile, oldPath: string): void {
  // 新路径在监控范围内
  if (this.isInWatchedPath(file)) {
    // 触发同步（会上传到新位置）
    this.scheduleSync('rename', file.path);
  }
  
  // 旧路径在监控范围内
  if (this.wasInWatchedPath(oldPath)) {
    // 触发删除旧云端文件
    this.handleRename(oldPath, file.path);
  }
}
```

## 与插件集成

```typescript
// main.ts
async onload(): Promise<void> {
  // 初始化文件监控器
  this.fileWatcher = new FileWatcher(this);
  
  // 如果设置了自动同步，则启动监控
  const enabledConfigs = getEnabledConfigs(this.settings.syncFolders || []);
  if (this.settings.autoSyncOnChange && enabledConfigs.length > 0) {
    await this.fileWatcher.updateConfig('', true);
  }
}

async onunload(): Promise<void> {
  // 停止监控
  this.fileWatcher?.stop();
}

// 设置变更时更新监控配置
async updateWatchedFolders(): Promise<void> {
  await this.fileWatcher.updateConfig('', this.settings.autoSyncOnChange);
}
```

## 事件处理流程

```
┌─────────────────────────────────────────────────────────────┐
│                    Vault 事件触发                            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 检查文件是否在监控路径内                                      │
│  - 路径标准化（反斜杠转正斜杠）                              │
│  - 支持多文件夹监控                                          │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │ 在监控路径内                 │ 不在监控路径内
              ▼                             ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│ 检查文件是否应被忽略        │   │ 忽略，不触发同步           │
│ - .feisyncignore 规则     │   └───────────────────────────┘
│ - 特定文件（如 .DS_Store）│
└───────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│ 调度同步（防抖）                                              │
│ - 按路径作为 key                                             │
│ - 新事件取消旧事件                                           │
└─────────────────────────────────────────────────────────────┘
```

## 注意事项

1. **文件夹事件**：文件夹创建/删除事件目前被忽略，仅同步文件。
2. **同步范围**：仅监控配置中启用的文件夹及其子文件夹。
3. **性能考虑**：防抖机制避免频繁同步。
4. **定时同步**：与 FileWatcher 独立的定时同步机制，不受防抖影响。
