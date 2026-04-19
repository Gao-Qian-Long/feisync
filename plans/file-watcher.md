# 本地文件监控与同步触发设计

## 概述

该模块负责监控用户指定的本地文件夹，当文件发生变化（创建、修改、删除、重命名）时，自动或手动触发同步到飞书Drive。根据需求，用户可以选择开启“自动同步”或仅手动触发。

## Obsidian 事件系统

Obsidian 提供了 `Vault` 事件，可以通过 `this.app.vault.on(event, callback)` 监听。相关事件包括：

- `'create'`：文件或文件夹创建。
- `'modify'`：文件内容修改。
- `'delete'`：文件或文件夹删除。
- `'rename'`：文件或文件夹重命名。

我们可以监听这些事件，但需要过滤出用户配置的文件夹内的变化。

## 设计

### 文件监控器类

```typescript
import { Vault, TAbstractFile } from 'obsidian';

export class FileWatcher {
  private plugin: FlybookPlugin;
  private watchedPath: string; // 配置的本地文件夹路径（相对仓库根目录）
  private isEnabled: boolean = false;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(plugin: FlybookPlugin) {
    this.plugin = plugin;
  }

  /**
   * 更新监控配置（当设置变更时调用）
   */
  updateConfig(watchedPath: string, autoSync: boolean) {
    this.stop();
    this.watchedPath = watchedPath;
    this.isEnabled = autoSync;
    if (this.isEnabled && watchedPath) {
      this.start();
    }
  }

  private start() {
    const { vault } = this.plugin.app;
    // 监听所有事件，但过滤路径
    vault.on('create', this.handleCreate.bind(this));
    vault.on('modify', this.handleModify.bind(this));
    vault.on('delete', this.handleDelete.bind(this));
    vault.on('rename', this.handleRename.bind(this));
  }

  private stop() {
    const { vault } = this.plugin.app;
    vault.off('create', this.handleCreate);
    vault.off('modify', this.handleModify);
    vault.off('delete', this.handleDelete);
    vault.off('rename', this.handleRename);
    // 清理所有防抖定时器
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
  }

  private isInWatchedPath(file: TAbstractFile): boolean {
    if (!this.watchedPath) return false;
    const relativePath = this.plugin.app.vault.getRelativePath(file);
    return relativePath.startsWith(this.watchedPath + '/') || relativePath === this.watchedPath;
  }

  private handleCreate(file: TAbstractFile) {
    if (!this.isInWatchedPath(file)) return;
    if (file instanceof TFolder) {
      // 文件夹创建，暂时忽略（因为同步可能只需要文件）
      return;
    }
    this.scheduleSync('create', file.path);
  }

  private handleModify(file: TAbstractFile) {
    if (!this.isInWatchedPath(file)) return;
    this.scheduleSync('modify', file.path);
  }

  private handleDelete(file: TAbstractFile) {
    if (!this.isInWatchedPath(file)) return;
    this.scheduleSync('delete', file.path);
  }

  private handleRename(file: TAbstractFile, oldPath: string) {
    // 重命名视为删除旧路径 + 创建新路径（如果新路径在监控范围内）
    if (this.isInWatchedPath(file)) {
      this.scheduleSync('rename', oldPath, file.path);
    }
  }

  /**
   * 防抖调度同步，避免短时间内多次变化导致重复上传。
   * 延迟时间可从设置中读取（默认5秒）。
   */
  private scheduleSync(action: string, ...paths: string[]) {
    const key = paths.join('|');
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key)!);
    }
    const delay = this.plugin.settings.syncInterval * 1000 * 60; // 分钟转毫秒
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.triggerSync();
    }, delay);
    this.debounceTimers.set(key, timer);
  }

  /**
   * 触发同步（实际执行同步逻辑）
   */
  private async triggerSync() {
    // 调用插件的同步方法
    await this.plugin.sync();
  }
}
```

## 手动同步触发

除了自动监听，插件还应提供手动同步触发方式：

1. **命令（Command）**：注册一个 Obsidian 命令，用户可以通过命令面板执行“Flybook: Sync now”。
2. ** ribbon 按钮**：在左侧 ribbon 添加一个图标按钮，点击触发同步。
3. **设置界面按钮**：如之前设计。

## 同步逻辑

`plugin.sync()` 方法负责协调整个同步过程：

1. 扫描本地文件夹，获取文件列表。
2. 与飞书Drive中已存在的文件列表比较（可能需要缓存）。
3. 对于本地新增或修改的文件，上传到飞书。
4. 对于本地删除的文件，删除飞书上的对应文件（根据需求，暂不实现删除同步？用户需求“以本地文件为准”，但未要求删除同步。可配置）。
5. 记录同步结果，通知用户。

## 冲突处理

由于需求规定“以本地文件为准”，我们总是用本地文件覆盖云端文件。如果云端存在本地没有的文件，则忽略（不同步删除）。

## 性能考虑

- 防抖：避免频繁同步，尤其是快速连续修改时。
- 增量同步：记录文件最后修改时间，仅同步修改时间晚于上次同步时间的文件。
- 缓存：缓存飞书文件夹结构和文件token，减少API调用。

## 用户通知

使用 Obsidian 的 `Notice` 类显示同步进度和结果。

## 下一步

1. 在插件主类中集成 FileWatcher。
2. 实现 `sync()` 方法，协调文件夹管理器和文件上传器。
3. 添加 Obsidian 命令和 ribbon 按钮。
4. 测试文件监听和同步触发。