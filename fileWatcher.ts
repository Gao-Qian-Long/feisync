/**
 * 本地文件监控模块
 * 负责监听 Obsidian 仓库中的文件变化，并触发同步
 * 支持精确的删除和重命名处理
 * 支持多文件夹监控和忽略规则过滤
 */

import { Vault, TAbstractFile, TFolder, TFile } from 'obsidian';
import FeiSyncPlugin from './main';
import { loadIgnoreFilter, IgnoreFilter, FEISYNC_IGNORE_FILE } from './ignoreFilter';
import { getEnabledConfigs, SyncFolderConfig } from './syncFolderConfig';
import { createLogger } from './logger';

const log = createLogger('FileWatcher');

export class FileWatcher {
  private plugin: FeiSyncPlugin;
  private watchedPaths: string[] = []; // 监控的本地文件夹路径列表
  private isEnabled: boolean = false;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private vault: Vault;
  private ignoreFilter: IgnoreFilter = new IgnoreFilter();

  // 事件处理函数绑定（保存引用以便移除）
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
   * 支持多文件夹路径
   */
  async updateConfig(watchedPath: string, enabled: boolean): Promise<void> {
    this.stop();
    this.watchedPaths = [];

    // 支持多文件夹映射
    const enabledConfigs = getEnabledConfigs(this.plugin.settings.syncFolders || []);
    if (enabledConfigs.length > 0) {
      this.watchedPaths = enabledConfigs.map(c => c.localPath);
      log.info(`监控 ${this.watchedPaths.length} 个文件夹: ${this.watchedPaths.join(', ')}`);
    } else if (watchedPath) {
      // 旧版兼容
      this.watchedPaths = [watchedPath];
    }

    this.isEnabled = enabled;
    if (this.isEnabled && this.watchedPaths.length > 0) {
      // 加载忽略过滤器
      this.ignoreFilter = await loadIgnoreFilter(this.vault);
      this.start();
    }
  }

  /**
   * 启动文件监控
   */
  private start(): void {
    log.info(`启动文件监控，监控路径: ${this.watchedPaths.join(', ')}`);

    this.vault.on('create', this.handleCreate as (...args: unknown[]) => unknown);
    this.vault.on('modify', this.handleModify as (...args: unknown[]) => unknown);
    this.vault.on('delete', this.handleDelete as (...args: unknown[]) => unknown);
    this.vault.on('rename', this.handleRename as (...args: unknown[]) => unknown);
  }

  /**
   * 停止文件监控
   */
  stop(): void {
    log.info('停止文件监控');

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
   * 支持多文件夹监控
   */
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

  /**
   * 检查旧路径是否在监控路径内（用于 rename 事件）
   */
  private wasInWatchedPath(oldPath: string): boolean {
    if (this.watchedPaths.length === 0) {
      return false;
    }

    const normalizedOldPath = oldPath.replace(/\\/g, '/');
    return this.watchedPaths.some(watchedPath => {
      const normalizedWatchedPath = watchedPath.replace(/\\/g, '/').replace(/\/$/, '');
      if (normalizedOldPath === normalizedWatchedPath) {
        return true;
      }
      return normalizedOldPath.startsWith(normalizedWatchedPath + '/');
    });
  }

  /**
   * 检查文件是否应被忽略
   */
  private shouldIgnore(file: TAbstractFile): boolean {
    // .feisyncignore 文件本身不被忽略
    if (file.name === FEISYNC_IGNORE_FILE) {
      return false;
    }

    if (this.ignoreFilter.hasRules) {
      const isDir = file instanceof TFolder;
      if (this.ignoreFilter.shouldIgnore(file.path, isDir)) {
        log.debug(`忽略文件变更: ${file.path}`);
        return true;
      }
    }
    return false;
  }

  /**
   * 文件创建事件处理
   */
  private onFileCreate(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) {
      return;
    }

    if (this.shouldIgnore(file)) {
      return;
    }

    if (file instanceof TFolder) {
      log.debug('忽略文件夹创建事件:', file.path);
      return;
    }

    // .feisyncignore 文件变更时，重新加载忽略规则
    if (file.name === FEISYNC_IGNORE_FILE) {
      log.info('.feisyncignore 文件已创建，重新加载忽略规则');
      loadIgnoreFilter(this.vault).then(filter => {
        this.ignoreFilter = filter;
      });
      return;
    }

    log.info('检测到新文件:', file.path);
    this.scheduleSync('create', file.path);
  }

  /**
   * 文件修改事件处理
   */
  private onFileModify(file: TAbstractFile): void {
    if (!this.isInWatchedPath(file)) {
      return;
    }

    if (this.shouldIgnore(file)) {
      return;
    }

    if (file instanceof TFolder) {
      return;
    }

    // .feisyncignore 文件变更时，重新加载忽略规则
    if (file.name === FEISYNC_IGNORE_FILE) {
      log.info('.feisyncignore 文件已修改，重新加载忽略规则');
      loadIgnoreFilter(this.vault).then(filter => {
        this.ignoreFilter = filter;
      });
      return;
    }

    log.info('检测到文件修改:', file.path);
    this.scheduleSync('modify', file.path);
  }

  /**
   * 文件删除事件处理
   */
  private onFileDelete(file: TAbstractFile): void {
    if (!this.wasInWatchedPath(file.path)) {
      return;
    }

    // 删除事件不检查忽略规则（可能之前忽略的文件被删除了，但同步记录中可能没有）
    // 但 .feisyncignore 文件删除时，需要重新加载忽略规则
    if (file.path === FEISYNC_IGNORE_FILE || file.path.endsWith('/' + FEISYNC_IGNORE_FILE)) {
      log.info('.feisyncignore 文件已删除，清除忽略规则');
      this.ignoreFilter = new IgnoreFilter();
      return;
    }

    if (file instanceof TFolder) {
      log.debug('忽略文件夹删除事件:', file.path);
      return;
    }

    log.info('检测到文件删除:', file.path);

    // 删除事件不需要防抖，直接处理
    if (this.plugin.syncEngine) {
      this.plugin.syncEngine.handleDelete(file.path).catch(error => {
        log.error('处理文件删除失败:', error);
      });
    }
  }

  /**
   * 文件重命名事件处理
   */
  private onFileRename(file: TAbstractFile, oldPath: string): void {
    const oldInWatched = this.wasInWatchedPath(oldPath);
    const newInWatched = this.isInWatchedPath(file);

    if (file instanceof TFolder) {
      log.debug('忽略文件夹重命名事件:', oldPath, '->', file.path);
      return;
    }

    if (oldInWatched && newInWatched) {
      // 检查新路径是否应被忽略
      if (this.shouldIgnore(file)) {
        // 文件被重命名到忽略的路径，删除旧的云端文件
        log.info(`文件重命名到忽略路径，删除旧云端文件: ${oldPath} -> ${file.path}`);
        if (this.plugin.syncEngine) {
          this.plugin.syncEngine.handleDelete(oldPath).catch(error => {
            log.error('处理文件移出失败:', error);
          });
        }
        return;
      }

      log.info('检测到文件重命名:', oldPath, '->', file.path);
      if (this.plugin.syncEngine) {
        this.plugin.syncEngine.handleRename(oldPath, file.path).then(() => {
          this.scheduleSync('rename', file.path);
        }).catch(error => {
          log.error('处理文件重命名失败:', error);
        });
      }
    } else if (oldInWatched && !newInWatched) {
      log.info('文件移出监控范围:', oldPath, '->', file.path);
      if (this.plugin.syncEngine) {
        this.plugin.syncEngine.handleDelete(oldPath).catch(error => {
          log.error('处理文件移出失败:', error);
        });
      }
    } else if (!oldInWatched && newInWatched) {
      if (!this.shouldIgnore(file)) {
        log.info('文件移入监控范围:', oldPath, '->', file.path);
        this.scheduleSync('rename', file.path);
      }
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

    const delayMs = 5000;

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(key);
      log.debug(`防抖结束，触发同步（操作: ${action}, 路径: ${paths.join(' -> ')}）`);

      try {
        await this.plugin.sync();
      } catch (error) {
        log.error('自动同步失败:', error);
      }
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

  /**
   * 检查是否正在监听
   */
  isWatching(): boolean {
    return this.isEnabled;
  }
}
