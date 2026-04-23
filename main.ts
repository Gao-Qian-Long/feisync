/**
 * FeiSync 插件主入口
 * 将本地 Obsidian 笔记同步到飞书 Drive
 */

import { Plugin, Notice, Menu, requestUrl } from 'obsidian';
import { FeiSyncPluginSettings, FeiSyncSettingTab, getDefaultSettings } from './settings';
import { FeishuAuthManager, validateToken } from './feishuAuth';
import { FeishuApiClient } from './feishuApi';
import { FileWatcher } from './fileWatcher';
import { SyncEngine, FileSyncRecord } from './syncEngine';
import { migrateFromLegacyConfig, getEnabledConfigs } from './syncFolderConfig';
import { createLogger } from './logger';

const log = createLogger('Main');

// 插件主类
export default class FeiSyncPlugin extends Plugin {
  // 设置
  settings: FeiSyncPluginSettings = getDefaultSettings();

  // 模块实例
  authManager: FeishuAuthManager | null = null;
  apiClient: FeishuApiClient | null = null;
  fileWatcher: FileWatcher | null = null;
  syncEngine: SyncEngine | null = null;

  // 设置选项卡
  settingTab: FeiSyncSettingTab | null = null;

  // Ribbon 图标元素
  ribbonIconEl: HTMLElement | null = null;

  // 状态栏元素
  statusBarItemEl: HTMLElement | null = null;

  // 定时同步计时器
  private scheduledSyncTimer: ReturnType<typeof setTimeout> | null = null;

  // 同步锁，防止并发同步
  private isSyncing: boolean = false;
  private syncLock: Promise<void> = Promise.resolve();

  /**
   * 插件加载时调用
   */
  async onload(): Promise<void> {
    log.info('插件加载中...');

    // 1. 加载设置
    await this.loadSettings();

    // 2. 初始化模块
    this.initializeModules();

    // 3. 注册设置界面
    this.settingTab = new FeiSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // 4. 注册命令
    this.registerCommands();

    // 5. 添加 Ribbon 图标
    this.setupRibbonIcon();

    // 6. 添加状态栏
    this.setupStatusBar();

    // 7. 启动文件监控（如果已启用且有同步路径）
    if (this.settings.autoSyncOnChange && this.hasSyncPaths()) {
      await this.toggleFileWatcher(true);
    }

    // 8. 启动定时同步（如果已启用）
    if (this.settings.enableScheduledSync) {
      this.toggleScheduledSync(true);
    }

    log.info('插件加载完成');
  }

  /**
   * 插件卸载时调用
   */
  onunload(): void {
    log.info('插件卸载中...');

    // 停止文件监控
    if (this.fileWatcher) {
      this.fileWatcher.stop();
    }

    // 停止定时同步
    this.toggleScheduledSync(false);

    // 移除 Ribbon 图标
    if (this.ribbonIconEl) {
      this.ribbonIconEl.remove();
    }

    log.info('插件卸载完成');
  }

  /**
   * 获取实际使用的代理地址
   * 仅当 enableProxy 开关开启时才返回 proxyUrl，否则返回空字符串（直连）
   */
  getEffectiveProxyUrl(): string {
    return this.settings.enableProxy ? this.settings.proxyUrl : '';
  }

  /**
   * 加载设置
   */
  async loadSettings(): Promise<void> {
    try {
      const loadedData = await this.loadData();
      const defaults = getDefaultSettings();
      // 过滤掉 loadedData 中 undefined 的值，避免覆盖默认值
      const filteredData: Partial<FeiSyncPluginSettings> = {};
      if (loadedData) {
        for (const key of Object.keys(defaults) as (keyof FeiSyncPluginSettings)[]) {
          if (loadedData[key] !== undefined) {
            Object.assign(filteredData, { [key]: loadedData[key] });
          }
        }
      }
      this.settings = { ...defaults, ...filteredData };
      // 确保 syncLog 是数组
      if (!Array.isArray(this.settings.syncLog)) {
        this.settings.syncLog = [];
      }
      // 确保 syncRecords 是对象
      if (!this.settings.syncRecords || typeof this.settings.syncRecords !== 'object') {
        this.settings.syncRecords = {};
      }
      // 确保 syncFolders 是数组
      if (!Array.isArray(this.settings.syncFolders)) {
        this.settings.syncFolders = [];
      }
      // 兼容旧版本：如果 data 中有 feisyncSyncRecords 但 settings.syncRecords 为空，迁移数据
      if (loadedData && loadedData.feisyncSyncRecords && Object.keys(this.settings.syncRecords).length === 0) {
        const oldRecords = typeof loadedData.feisyncSyncRecords === 'string'
          ? JSON.parse(loadedData.feisyncSyncRecords)
          : loadedData.feisyncSyncRecords;
        if (oldRecords && typeof oldRecords === 'object') {
          this.settings.syncRecords = oldRecords;
        }
      }
      // 兼容旧版本：如果 localFolderPath 存在但 syncFolders 为空，自动迁移
      if (this.settings.localFolderPath && this.settings.syncFolders.length === 0) {
        log.info(`检测到旧版单文件夹配置 "${this.settings.localFolderPath}"，自动迁移为多文件夹映射`);
        this.settings.syncFolders = migrateFromLegacyConfig(
          this.settings.localFolderPath,
          this.settings.feishuRootFolderToken
        );
        await this.saveData(this.settings);
        log.info(`旧配置已迁移，生成 ${this.settings.syncFolders.length} 条映射`);
      }
      log.info('设置加载成功');
    } catch {
      log.error('加载设置失败');
      this.settings = getDefaultSettings();
    }
  }

  /**
   * 保存设置
   */
  async saveSettings(): Promise<void> {
    try {
      await this.saveData(this.settings);
      log.debug('设置保存成功');

      // 如果认证信息变更，更新或创建 authManager
      if (this.settings.appId && this.settings.appSecret) {
        if (this.authManager) {
          // 仅在凭证确实变更时才更新，避免不必要的 token 刷新
          const currentProxy = this.getEffectiveProxyUrl();
          const needUpdate = this.authManager.updateCredentialsIfNeeded(
            this.settings.appId, this.settings.appSecret, currentProxy
          );
          if (needUpdate) {
            this.apiClient = new FeishuApiClient(this.authManager, currentProxy, this.settings.maxRetryAttempts);
            this.syncEngine = new SyncEngine(this, this.apiClient);
          }
        } else {
          this.authManager = new FeishuAuthManager(
            this.settings.appId, this.settings.appSecret, this.getEffectiveProxyUrl(),
            () => this.saveUserToken()
          );
          this.apiClient = new FeishuApiClient(this.authManager, this.getEffectiveProxyUrl(), this.settings.maxRetryAttempts);
          this.syncEngine = new SyncEngine(this, this.apiClient);
        }
      }

      // 更新 API 客户端配置
      if (this.apiClient) {
        this.apiClient.updateProxyUrl(this.getEffectiveProxyUrl());
        this.apiClient.updateMaxRetries(this.settings.maxRetryAttempts);
      }

      // 更新文件监控配置（现在是异步的）
      if (this.fileWatcher) {
        await this.fileWatcher.updateConfig(this.settings.localFolderPath, this.settings.autoSyncOnChange);
      }
    } catch {
      log.error('保存设置失败');
      new Notice('保存设置失败');
    }
  }

  /**
   * 初始化各模块
   */
  private initializeModules(): void {
    log.debug('初始化模块...');

    // 认证管理器
    if (this.settings.appId && this.settings.appSecret) {
      this.authManager = new FeishuAuthManager(
        this.settings.appId, this.settings.appSecret, this.getEffectiveProxyUrl(),
        () => this.saveUserToken()
      );
      log.debug('认证管理器已初始化');
    }

    // API 客户端
    if (this.authManager) {
      this.apiClient = new FeishuApiClient(this.authManager, this.getEffectiveProxyUrl(), this.settings.maxRetryAttempts);
      log.debug('API 客户端已初始化');
    }

    // 同步引擎
    if (this.apiClient) {
      this.syncEngine = new SyncEngine(this, this.apiClient);
      log.debug('同步引擎已初始化');
    }

    // 文件监控器
    this.fileWatcher = new FileWatcher(this);
    log.debug('文件监控器已初始化');

    // 从存储中恢复用户授权信息
    this.loadUserToken();
  }

  /**
   * 从设置中加载用户令牌
   */
  private loadUserToken(): void {
    try {
      const tokenStr = this.settings.feishuUserToken;
      if (tokenStr) {
        const tokenInfo = JSON.parse(tokenStr);
        if (tokenInfo) {
          this.authManager?.loadUserTokenFromData(tokenInfo);
          log.debug('用户令牌已加载');
        }
      }
    } catch {
      log.error('加载用户令牌失败');
    }
  }

  /**
   * 保存用户令牌到设置
   */
  async saveUserToken(): Promise<void> {
    if (this.authManager?.isUserAuthorized()) {
      try {
        this.settings.feishuUserToken = JSON.stringify(this.authManager.getUserTokenInfo());
        await this.saveData(this.settings);
        log.debug('用户令牌已保存');
      } catch {
        log.error('保存用户令牌失败');
      }
    } else {
      // token 已被清除（如 refresh_token 失效），需要从设置中移除旧 token
      if (this.settings.feishuUserToken) {
        try {
          this.settings.feishuUserToken = '';
          await this.saveData(this.settings);
          log.info('已从存储中移除失效的用户令牌');
        } catch {
          log.error('移除用户令牌失败');
        }
      }
    }
  }

  /**
   * 加载同步记录（从 settings 对象中读取）
   */
  loadSyncRecords(): Record<string, FileSyncRecord> {
    if (!this.settings.syncRecords || typeof this.settings.syncRecords !== 'object') {
      this.settings.syncRecords = {};
    }
    const records = this.settings.syncRecords;
    log.debug(`已加载 ${Object.keys(records).length} 条同步记录`);
    return records;
  }

  /**
   * 保存同步记录（写入 settings 对象，随 saveSettings 持久化）
   */
  async saveSyncRecords(records: Record<string, FileSyncRecord>): Promise<void> {
    try {
      this.settings.syncRecords = records;
      await this.saveData(this.settings);
      log.debug(`已保存 ${Object.keys(records).length} 条同步记录`);
    } catch {
      log.error('保存同步记录失败');
    }
  }

  /**
   * 注册命令
   */
  private registerCommands(): void {
    // 手动同步命令
    this.addCommand({
      id: 'sync',
      name: 'Sync now',
      callback: () => {
        void this.sync();
      },
    });

    // 从飞书下载命令
    this.addCommand({
      id: 'download',
      name: 'Download from feishu',
      callback: () => {
        void this.downloadFromFeishu();
      },
    });

    // 查看同步日志
    this.addCommand({
      id: 'log',
      name: 'View sync log',
      callback: () => {
        // 打开设置页面
        this.settingTab?.display();
      },
    });
  }

  /**
   * 添加 Ribbon 图标
   */
  private setupRibbonIcon(): void {
    this.ribbonIconEl = this.addRibbonIcon('cloud-upload', '同步到飞书', (evt: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('立即同步')
          .setIcon('sync')
          .onClick(() => {
            void this.sync();
          });
      });
      menu.addItem((item) => {
        item.setTitle('从飞书下载')
          .setIcon('download')
          .onClick(() => {
            void this.downloadFromFeishu();
          });
      });
      menu.addItem((item) => {
        item.setTitle('打开设置')
          .setIcon('settings')
          .onClick(() => {
            this.settingTab?.display();
          });
      });
      menu.showAtMouseEvent(evt);
    });
  }

  /**
   * 设置状态栏
   */
  private setupStatusBar(): void {
    this.statusBarItemEl = this.addStatusBarItem();
    this.updateStatusBar('就绪');
  }

  /**
   * 更新状态栏
   */
  updateStatusBar(text: string, _icon?: string): void {
    if (!this.statusBarItemEl) return;
    this.statusBarItemEl.setText(`FeiSync: ${text}`);
    this.statusBarItemEl.title = `FeiSync - ${text}`;
  }

  /**
   * 测试连接（单步）
   */
  async testStep(step: 'local-to-proxy' | 'proxy-to-feishu' | 'direct-to-feishu'): Promise<{ success: boolean; message: string }> {
    const proxyUrl = this.getEffectiveProxyUrl();

    if (step === 'local-to-proxy') {
      if (!proxyUrl) {
        return { success: false, message: '未配置代理服务器地址' };
      }
      try {
        const response = await requestUrl({
          url: proxyUrl,
          method: 'GET',
          throw: false,
        });
        // 转发代理通常只配置了 API 路径，根路径 404 属于正常情况
        if (response.status === 404) {
          return { success: true, message: '代理服务器可达（HTTP 404：无根路由，属于正常情况）' };
        }
        if (response.status >= 500) {
          return { success: false, message: `代理服务器返回错误（HTTP ${response.status}），请检查代理服务状态` };
        }
        return { success: true, message: `代理服务器可达（HTTP ${response.status}）` };
      } catch (error) {
        const msg = (error as Error).message;
        return { success: false, message: `无法连接代理服务器: ${msg}` };
      }
    }

    if (!this.authManager && this.settings.appId && this.settings.appSecret) {
      this.authManager = new FeishuAuthManager(
        this.settings.appId, this.settings.appSecret, this.getEffectiveProxyUrl(),
        () => this.saveUserToken()
      );
    }
    if (!this.authManager) {
      return { success: false, message: '请先配置飞书 App ID 和 App Secret' };
    }

    try {
      const token = await this.authManager.getAccessToken();
      const isValid = await validateToken(token, this.getEffectiveProxyUrl());
      if (isValid) {
        const via = proxyUrl ? `经由代理 (${proxyUrl})` : '直连';
        return { success: true, message: `飞书 API 连接成功（${via}），凭证有效` };
      } else {
        return { success: false, message: '飞书 API 可达，但凭证验证失败' };
      }
    } catch (error) {
      const msg = (error as Error).message;
      return { success: false, message: `飞书 API 连接失败: ${msg}` };
    }
  }

  /**
   * 获取同步锁
   */
  private async acquireSyncLock(): Promise<(() => void) | null> {
    let release: (() => void) | undefined;
    const lockPromise = new Promise<void>(resolve => { release = resolve; });
    const prevLock = this.syncLock;
    this.syncLock = prevLock.then(() => lockPromise);
    await prevLock;

    if (this.isSyncing) {
      release?.();
      new Notice('同步正在进行中，请稍候...');
      return null;
    }
    this.isSyncing = true;
    return release!;
  }

  /**
   * 执行同步
   */
  async sync(): Promise<void> {
    const release = await this.acquireSyncLock();
    if (!release) return;

    if (!this.syncEngine) {
      release();
      throw new Error('同步引擎未初始化，请检查凭证配置');
    }

    const preCheck = this.validateForSync();
    if (!preCheck.ready) {
      release();
      new Notice(preCheck.message);
      return;
    }

    this.updateStatusBar('同步中...');

    try {
      log.info('开始同步...');
      await this.syncEngine.sync();
      log.info('同步流程结束');
      this.updateStatusBar('同步完成');
    } catch (error) {
      this.updateStatusBar('同步失败');
      throw error;
    } finally {
      this.isSyncing = false;
      release();
      // 3秒后恢复就绪状态
      setTimeout(() => {
        if (!this.isSyncing) {
          this.updateStatusBar('就绪');
        }
      }, 3000);
    }
  }

  /**
   * 从飞书下载
   */
  async downloadFromFeishu(): Promise<void> {
    const release = await this.acquireSyncLock();
    if (!release) return;

    if (!this.syncEngine) {
      release();
      throw new Error('同步引擎未初始化，请检查凭证配置');
    }

    const preCheck = this.validateForSync();
    if (!preCheck.ready) {
      release();
      new Notice(preCheck.message);
      return;
    }

    this.updateStatusBar('下载中...');

    try {
      await this.syncEngine.downloadFromFeishu();
      this.updateStatusBar('下载完成');
    } catch (error) {
      this.updateStatusBar('下载失败');
      throw error;
    } finally {
      this.isSyncing = false;
      release();
      setTimeout(() => {
        if (!this.isSyncing) {
          this.updateStatusBar('就绪');
        }
      }, 3000);
    }
  }

  /**
   * 检查插件是否已配置
   */
  isConfigured(): boolean {
    return !!this.settings.appId && !!this.settings.appSecret;
  }

  /**
   * 检查是否有可同步的路径（新版 syncFolders 或旧版 localFolderPath）
   */
  hasSyncPaths(): boolean {
    const enabledConfigs = getEnabledConfigs(this.settings.syncFolders || []);
    return enabledConfigs.length > 0 || !!this.settings.localFolderPath;
  }

  /**
   * 同步前置检查，返回 { ready, message }
   * 合并 isConfigured + hasSyncPaths + isUserAuthorized 检查，一次性告知用户所有问题
   */
  private validateForSync(): { ready: boolean; message: string } {
    if (!this.isConfigured()) {
      return { ready: false, message: '请先配置飞书 App ID 和 App Secret' };
    }
    if (!this.authManager?.isUserAuthorized()) {
      return { ready: false, message: '用户未授权，请先在设置中完成飞书 OAuth 授权' };
    }
    if (!this.hasSyncPaths()) {
      return { ready: false, message: '请先配置同步文件夹映射（或在旧版设置中指定本地同步文件夹）' };
    }
    return { ready: true, message: '' };
  }

  /**
   * 切换文件监控器
   */
  async toggleFileWatcher(enable: boolean): Promise<void> {
    if (!this.fileWatcher) {
      log.warn('文件监控器未初始化');
      return;
    }

    if (enable) {
      await this.fileWatcher.updateConfig(this.settings.localFolderPath, true);
    } else {
      this.fileWatcher.stop();
    }
  }

  /**
   * 切换定时同步
   */
  toggleScheduledSync(enable: boolean): void {
    // 清除旧定时器
    if (this.scheduledSyncTimer) {
      clearTimeout(this.scheduledSyncTimer);
      this.scheduledSyncTimer = null;
    }

    if (enable && this.settings.scheduledSyncInterval > 0) {
      const intervalMs = this.settings.scheduledSyncInterval * 60 * 1000;
      log.info(`启动定时同步，间隔 ${this.settings.scheduledSyncInterval} 分钟`);

      const scheduleNext = () => {
        this.scheduledSyncTimer = setTimeout(() => {
          void (async () => {
            try {
              log.info('定时同步触发');
              await this.sync();
            } catch (error) {
              log.error('定时同步失败:', error);
            } finally {
              // 只有仍然启用时才安排下一次
              if (this.scheduledSyncTimer) {
                scheduleNext();
              }
            }
          })();
        }, intervalMs);
      };

      scheduleNext();
    } else {
      log.info('定时同步已停止');
    }
  }
}
