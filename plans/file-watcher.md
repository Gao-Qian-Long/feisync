# 本地文件监控模块设计

## 概述

该模块负责监控用户指定的本地文件夹，当文件发生变化（创建、修改、删除、重命名）时，自动触发同步到飞书 Drive。

## Obsidian 事件系统

Obsidian 提供了 `Vault` 事件，可通过 `this.app.vault.on(event, callback)` 监听：

| 事件 | 说明 |
|------|------|
| `create` | 文件或文件夹创建 |
| `modify` | 文件内容修改 |
| `delete` | 文件或文件夹删除 |
| `rename` | 文件或文件夹重命名 |

## 实现

### FileWatcher 类

```typescript
export class FileWatcher {
  private plugin: FeiSyncPlugin;
  private watchedPath: string = '';  // 监控的本地文件夹路径
  private isEnabled: boolean = false;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private vault: Vault;

  // 事件处理函数绑定
  private handleCreate = this.onFileCreate.bind(this);
  private handleModify = this.onFileModify.bind(this);
  private handleDelete = this.onFileDelete.bind(this);
  private handleRename = this.onFileRename.bind(this);

  constructor(plugin: FeiSyncPlugin) {
    this.plugin = plugin;
    this.vault = plugin.app.vault;
  }

  /**
   * 更新监控配置
   */
  updateConfig(watchedPath: string, enabled: boolean): void {
    this.stop();
    this.watchedPath = watchedPath;
    this.isEnabled = enabled;
    if (this.isEnabled && this.watchedPath) {
      this.start();
    }
  }

  /**
   * 启动文件监控
   */
  private start(): void {
    this.vault.on('create', this.handleCreate);
    this.vault.on('modify', this.handleModify);
    this.vault.on('delete', this.handleDelete);
    this.vault.on('rename', this.handleRename);
  }

  /**
   * 停止文件监控
   */
  stop(): void {
    this.vault.off('create', this.handleCreate);
    this.vault.off('modify', this.handleModify);
    this.vault.off('delete', this.handleDelete);
    this.vault.off('rename', this.handleRename);
    
    // 清理防抖定时器
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
  }

  /**
   * 检查文件是否在监控路径内
   */
  private isInWatchedPath(file: TAbstractFile): boolean {
    if (!this.watchedPath) return false;
    
    const normalizedPath = file.path.replace(/\\/g, '/');
    const normalizedWatched = this.watchedPath.replace(/\\/g, '/').replace(/\/$/, '');
    
    return normalizedPath === normalizedWatched || 
           normalizedPath.startsWith(normalizedWatched + '/');
  }

  /**
   * 文件创建事件
   */
  private onFileCreate(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) return;
    if (file instanceof TFolder) return;  // 忽略文件夹
    this.scheduleSync('create', file.path);
  }

  /**
   * 文件修改事件
   */
  private onFileModify(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) return;
    if (file instanceof TFolder) return;
    this.scheduleSync('modify', file.path);
  }

  /**
   * 文件删除事件
   */
  private onFileDelete(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) return;
    this.scheduleSync('delete', file.path);
  }

  /**
   * 文件重命名事件
   */
  private onFileRename(file: TAbstractFile, oldPath: string): void {
    if (this.isInWatchedPath(file)) {
      this.scheduleSync('rename', oldPath, file.path);
    }
  }

  /**
   * 防抖调度同步
   */
  private scheduleSync(action: string, ...paths: string[]): void {
    const key = paths.join('|');
    
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

  /**
   * 立即触发同步
   */
  async triggerImmediateSync(): Promise<void> {
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    await this.plugin.sync();
  }
}
```

## 防抖策略

为了避免频繁触发同步，使用防抖机制：

- **延迟时间**：由设置中的 `syncInterval` 控制（分钟转毫秒）
- **按路径防抖**：同一文件的多次变化只触发一次同步
- **自动取消**：新变化会取消旧的待处理同步

## 与插件集成

```typescript
// main.ts
async onload(): Promise<void> {
  // 初始化文件监控器
  this.fileWatcher = new FileWatcher(this);
  
  // 如果设置了自动同步，则启动监控
  if (this.settings.autoSyncOnChange && this.settings.localFolderPath) {
    this.fileWatcher.updateConfig(this.settings.localFolderPath, true);
  }
}

async onunload(): Promise<void> {
  // 停止监控
  this.fileWatcher?.stop();
}

// 设置变更时更新监控配置
toggleFileWatcher(enable: boolean): void {
  if (enable) {
    this.fileWatcher?.updateConfig(this.settings.localFolderPath, true);
  } else {
    this.fileWatcher?.stop();
  }
}
```

## 注意事项

1. **文件夹创建/删除**：目前忽略文件夹事件，仅同步文件。
2. **同步范围**：仅监控 `localFolderPath` 配置的文件夹及其子文件夹。
3. **性能考虑**：防抖机制避免频繁同步。
