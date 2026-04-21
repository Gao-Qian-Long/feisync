/**
 * 本地文件监控模块
 * 负责监听 Obsidian 仓库中的文件变化，并触发同步
 * 支持精确的删除和重命名处理
 */

import { Vault, TAbstractFile, TFolder, TFile } from 'obsidian';
import FlybookPlugin from './main';

export class FileWatcher {
  private plugin: FlybookPlugin;
  private watchedPath: string = ''; // 配置的本地文件夹路径（相对仓库根目录）
  private isEnabled: boolean = false;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private vault: Vault;

  // 事件处理函数绑定（保存引用以便移除）
  private handleCreate = this.onFileCreate.bind(this);
  private handleModify = this.onFileModify.bind(this);
  private handleDelete = this.onFileDelete.bind(this);
  private handleRename = this.onFileRename.bind(this);

  constructor(plugin: FlybookPlugin) {
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
    console.log('[Flybook] 启动文件监控，监控路径:', this.watchedPath);

    this.vault.on('create', this.handleCreate as (...args: unknown[]) => unknown);
    this.vault.on('modify', this.handleModify as (...args: unknown[]) => unknown);
    this.vault.on('delete', this.handleDelete as (...args: unknown[]) => unknown);
    this.vault.on('rename', this.handleRename as (...args: unknown[]) => unknown);
  }

  /**
   * 停止文件监控
   */
  stop(): void {
    console.log('[Flybook] 停止文件监控');

    this.vault.off('create', this.handleCreate as (...args: unknown[]) => unknown);
    this.vault.off('modify', this.handleModify as (...args: unknown[]) => unknown);
    this.vault.off('delete', this.handleDelete as (...args: unknown[]) => unknown);
    this.vault.off('rename', this.handleRename as (...args: unknown[]) => unknown);

    // 清理所有防抖定时器
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
  }

  /**
   * 检查文件是否在监控路径内
   */
  private isInWatchedPath(file: TAbstractFile): boolean {
    if (!this.watchedPath) {
      return false;
    }

    const relativePath = file.path;
    const normalizedWatchedPath = this.watchedPath.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');

    if (normalizedRelativePath === normalizedWatchedPath) {
      return true;
    }

    return normalizedRelativePath.startsWith(normalizedWatchedPath + '/');
  }

  /**
   * 检查旧路径是否在监控路径内（用于 rename 事件）
   */
  private wasInWatchedPath(oldPath: string): boolean {
    if (!this.watchedPath) {
      return false;
    }

    const normalizedWatchedPath = this.watchedPath.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedOldPath = oldPath.replace(/\\/g, '/');

    if (normalizedOldPath === normalizedWatchedPath) {
      return true;
    }

    return normalizedOldPath.startsWith(normalizedWatchedPath + '/');
  }

  /**
   * 文件创建事件处理
   */
  private onFileCreate(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) {
      return;
    }

    if (file instanceof TFolder) {
      console.log('[Flybook] 忽略文件夹创建事件:', file.path);
      return;
    }

    console.log('[Flybook] 检测到新文件:', file.path);
    this.scheduleSync('create', file.path);
  }

  /**
   * 文件修改事件处理
   */
  private onFileModify(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) {
      return;
    }

    if (file instanceof TFolder) {
      return;
    }

    console.log('[Flybook] 检测到文件修改:', file.path);
    this.scheduleSync('modify', file.path);
  }

  /**
   * 文件删除事件处理
   * 直接调用 syncEngine.handleDelete 删除云端文件
   */
  private onFileDelete(file: TAbstractFile): void {
    if (!this.wasInWatchedPath(file.path)) {
      return;
    }

    if (file instanceof TFolder) {
      console.log('[Flybook] 忽略文件夹删除事件:', file.path);
      return;
    }

    console.log('[Flybook] 检测到文件删除:', file.path);

    // 删除事件不需要防抖，直接处理
    if (this.plugin.syncEngine) {
      this.plugin.syncEngine.handleDelete(file.path).catch(error => {
        console.error('[Flybook] 处理文件删除失败:', error);
      });
    }
  }

  /**
   * 文件重命名事件处理
   * 使用 syncEngine.handleRename 精确处理：删除旧云端文件，新文件等待下次同步
   */
  private onFileRename(file: TAbstractFile, oldPath: string): void {
    const oldInWatched = this.wasInWatchedPath(oldPath);
    const newInWatched = this.isInWatchedPath(file);

    if (file instanceof TFolder) {
      console.log('[Flybook] 忽略文件夹重命名事件:', oldPath, '->', file.path);
      return;
    }

    if (oldInWatched && newInWatched) {
      // 在监控范围内重命名：删除旧云端文件，新文件等待同步上传
      console.log('[Flybook] 检测到文件重命名:', oldPath, '->', file.path);
      if (this.plugin.syncEngine) {
        this.plugin.syncEngine.handleRename(oldPath, file.path).then(() => {
          // 重命名处理完成后，触发一次同步以上传新路径的文件
          this.scheduleSync('rename', file.path);
        }).catch(error => {
          console.error('[Flybook] 处理文件重命名失败:', error);
        });
      }
    } else if (oldInWatched && !newInWatched) {
      // 从监控范围内移出：删除云端文件
      console.log('[Flybook] 文件移出监控范围:', oldPath, '->', file.path);
      if (this.plugin.syncEngine) {
        this.plugin.syncEngine.handleDelete(oldPath).catch(error => {
          console.error('[Flybook] 处理文件移出失败:', error);
        });
      }
    } else if (!oldInWatched && newInWatched) {
      // 移入监控范围：视为新文件
      console.log('[Flybook] 文件移入监控范围:', oldPath, '->', file.path);
      this.scheduleSync('rename', file.path);
    }
    // 两者都不在监控范围，忽略
  }

  /**
   * 防抖调度同步
   * 避免短时间内多次变化导致重复上传
   */
  private scheduleSync(action: string, ...paths: string[]): void {
    const key = paths.join('|');

    // 如果已有定时器，取消旧的
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key)!);
    }

    // 防抖延迟：5秒（不再使用 syncInterval 作为防抖时间）
    const delayMs = 5000;

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(key);
      console.log('[Flybook] 防抖结束，触发同步（操作:', action, '路径:', paths.join(' -> '), ')');

      try {
        await this.plugin.sync();
      } catch (error) {
        console.error('[Flybook] 自动同步失败:', error);
      }
    }, delayMs);

    this.debounceTimers.set(key, timer);
  }

  /**
   * 立即触发同步（取消所有待处理的同步）
   */
  async triggerImmediateSync(): Promise<void> {
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();

    await this.plugin.sync();
  }

  /**
   * 检查是否正在监听
   */
  isWatching(): boolean {
    return this.isEnabled;
  }
}
