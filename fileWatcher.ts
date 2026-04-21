/**
 * 本地文件监控模块
 * 负责监听 Obsidian 仓库中的文件变化，并触发同步
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
   * @param watchedPath 要监控的本地文件夹路径
   * @param enabled 是否启用监控
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

    // 监听 Vault 事件（使用类型断言解决 TypeScript 类型兼容性）
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

    // 移除事件监听（使用相同的类型断言）
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
    const normalizedWatchedPath = this.watchedPath.replace(/\\/g, '/').replace(/\/$/, ''); // 规范化路径
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');

    // 检查是否以监控路径开头
    if (normalizedRelativePath === normalizedWatchedPath) {
      return true; // 正好是监控路径本身
    }

    return normalizedRelativePath.startsWith(normalizedWatchedPath + '/');
  }

  /**
   * 文件创建事件处理
   */
  private onFileCreate(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) {
      return;
    }

    // 文件夹创建暂时忽略
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

    // 文件夹修改忽略
    if (file instanceof TFolder) {
      return;
    }

    console.log('[Flybook] 检测到文件修改:', file.path);
    this.scheduleSync('modify', file.path);
  }

  /**
   * 文件删除事件处理
   */
  private onFileDelete(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) {
      return;
    }

    console.log('[Flybook] 检测到文件删除:', file.path);
    this.scheduleSync('delete', file.path);
  }

  /**
   * 文件重命名事件处理
   */
  private onFileRename(file: TAbstractFile, oldPath: string): void {
    // 如果新路径在监控范围内，则视为创建
    if (this.isInWatchedPath(file)) {
      console.log('[Flybook] 检测到文件重命名（新路径在监控内）:', oldPath, '->', file.path);
      this.scheduleSync('rename', oldPath, file.path);
    }
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

    // 计算延迟时间（从设置中读取，转换为毫秒）
    const delayMs = this.plugin.settings.syncInterval * 60 * 1000;

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
    // 取消所有待处理的同步
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();

    // 立即执行同步
    await this.plugin.sync();
  }

  /**
   * 检查是否正在监听
   */
  isWatching(): boolean {
    return this.isEnabled;
  }
}