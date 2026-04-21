/**
 * FeiSync 插件主入口
 * 将本地 Obsidian 笔记同步到飞书 Drive
 */

import { Plugin, Notice, Menu } from 'obsidian';
import { FeiSyncPluginSettings, FeiSyncSettingTab, getDefaultSettings } from './settings';
import { FeishuAuthManager, validateToken } from './feishuAuth';
import { FeishuApiClient } from './feishuApi';
import { FileWatcher } from './fileWatcher';
import { SyncEngine, FileSyncRecord } from './syncEngine';

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
  private scheduledSyncTimer: ReturnType<typeof setInterval> | null = null;

  // 同步锁，防止并发同步
  private isSyncing: boolean = false;

  /**
   * 插件加载时调用
   */
  async onload(): Promise<void> {
    console.log('[FeiSync] 插件加载中...');

    // 1. 加载设置
    await this.loadSettings();

    // 2. 初始化模块
    await this.initializeModules();

    // 3. 注册设置界面
    this.settingTab = new FeiSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // 4. 注册命令
    this.registerCommands();

    // 5. 添加 Ribbon 图标
    this.setupRibbonIcon();

    // 6. 添加状态栏
    this.setupStatusBar();

    // 7. 启动文件监控（如果已启用）
    if (this.settings.autoSyncOnChange && this.settings.localFolderPath) {
      this.toggleFileWatcher(true);
    }

    // 8. 启动定时同步（如果已启用）
    if (this.settings.enableScheduledSync) {
      this.toggleScheduledSync(true);
    }

    console.log('[FeiSync] 插件加载完成');
  }

  /**
   * 插件卸载时调用
   */
  async onunload(): Promise<void> {
    console.log('[FeiSync] 插件卸载中...');

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

    console.log('[FeiSync] 插件卸载完成');
  }

  /**
   * 加载设置
   */
  async loadSettings(): Promise<void> {
    try {
      const loadedData = await this.loadData();
      this.settings = Object.assign({}, getDefaultSettings(), loadedData);
      // 确保 syncLog 是数组
      if (!Array.isArray(this.settings.syncLog)) {
        this.settings.syncLog = [];
      }
      // 确保 syncRecords 是对象
      if (!this.settings.syncRecords || typeof this.settings.syncRecords !== 'object') {
        this.settings.syncRecords = {};
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
      console.log('[FeiSync] 设置加载成功');
    } catch (error) {
      console.error('[FeiSync] 加载设置失败:', error);
      this.settings = getDefaultSettings();
    }
  }

  /**
   * 保存设置
   */
  async saveSettings(): Promise<void> {
    try {
      await this.saveData(this.settings);
      console.log('[FeiSync] 设置保存成功');

      // 如果认证信息变更，更新或创建 authManager
      if (this.settings.appId && this.settings.appSecret) {
        if (this.authManager) {
          this.authManager.updateCredentials(this.settings.appId, this.settings.appSecret, this.settings.proxyUrl);
        } else {
          this.authManager = new FeishuAuthManager(
            this.settings.appId, this.settings.appSecret, this.settings.proxyUrl,
            () => this.saveUserToken()
          );
          this.apiClient = new FeishuApiClient(this.authManager, this.settings.proxyUrl, this.settings.maxRetryAttempts);
          this.syncEngine = new SyncEngine(this, this.apiClient);
        }
      }

      // 更新 API 客户端配置
      if (this.apiClient) {
        this.apiClient.updateProxyUrl(this.settings.proxyUrl);
        this.apiClient.updateMaxRetries(this.settings.maxRetryAttempts);
      }

      // 更新文件监控配置
      if (this.fileWatcher) {
        this.fileWatcher.updateConfig(this.settings.localFolderPath, this.settings.autoSyncOnChange);
      }
    } catch (error) {
      console.error('[FeiSync] 保存设置失败:', error);
      new Notice('保存设置失败');
    }
  }

  /**
   * 初始化各模块
   */
  private async initializeModules(): Promise<void> {
    // 认证管理器
    if (this.settings.appId && this.settings.appSecret) {
      this.authManager = new FeishuAuthManager(
        this.settings.appId, this.settings.appSecret, this.settings.proxyUrl,
        () => this.saveUserToken()
      );
    }

    // API 客户端
    if (this.authManager) {
      this.apiClient = new FeishuApiClient(this.authManager, this.settings.proxyUrl, this.settings.maxRetryAttempts);
    }

    // 同步引擎
    if (this.apiClient) {
      this.syncEngine = new SyncEngine(this, this.apiClient);
    }

    // 文件监控器
    this.fileWatcher = new FileWatcher(this);

    // 从存储中恢复用户授权信息
    await this.loadUserToken();
  }

  /**
   * 从数据文件加载用户令牌
   */
  private async loadUserToken(): Promise<void> {
    try {
      const data = await this.loadData();
      if (data && data.feishuUserToken) {
        const tokenInfo = JSON.parse(data.feishuUserToken);
        if (tokenInfo) {
          this.authManager?.loadUserTokenFromData(tokenInfo);
        }
      }
    } catch (error) {
      console.error('[FeiSync] 加载用户令牌失败:', error);
    }
  }

  /**
   * 保存用户令牌到数据文件
   */
  async saveUserToken(): Promise<void> {
    if (this.authManager?.isUserAuthorized()) {
      try {
        const data = await this.loadData();
        data.feishuUserToken = JSON.stringify(this.authManager.getUserTokenInfo());
        await this.saveData(data);
        console.log('[FeiSync] 用户令牌已保存');
      } catch (error) {
        console.error('[FeiSync] 保存用户令牌失败:', error);
      }
    }
  }

  /**
   * 加载同步记录（从 settings 对象中读取）
   */
  async loadSyncRecords(): Promise<Record<string, FileSyncRecord>> {
    if (!this.settings.syncRecords || typeof this.settings.syncRecords !== 'object') {
      this.settings.syncRecords = {};
    }
    const records = this.settings.syncRecords;
    console.log(`[FeiSync] 已加载 ${Object.keys(records).length} 条同步记录`);
    return records;
  }

  /**
   * 保存同步记录（写入 settings 对象，随 saveSettings 持久化）
   */
  async saveSyncRecords(records: Record<string, FileSyncRecord>): Promise<void> {
    try {
      this.settings.syncRecords = records;
      await this.saveData(this.settings);
      console.log(`[FeiSync] 已保存 ${Object.keys(records).length} 条同步记录`);
    } catch (error) {
      console.error('[FeiSync] 保存同步记录失败:', error);
    }
  }

  /**
   * 注册命令
   */
  private registerCommands(): void {
    // 手动同步命令
    this.addCommand({
      id: 'feisync-sync',
      name: 'Sync now',
      callback: async () => {
        await this.sync();
      },
    });

    // 从飞书下载命令
    this.addCommand({
      id: 'feisync-download',
      name: 'Download from Feishu',
      callback: async () => {
        await this.downloadFromFeishu();
      },
    });

    // 查看同步日志
    this.addCommand({
      id: 'feisync-log',
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
    this.ribbonIconEl = this.addRibbonIcon('cloud-upload', '同步到飞书', async (evt: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('立即同步')
          .setIcon('sync')
          .onClick(async () => {
            await this.sync();
          });
      });
      menu.addItem((item) => {
        item.setTitle('从飞书下载')
          .setIcon('download')
          .onClick(async () => {
            await this.downloadFromFeishu();
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
  updateStatusBar(text: string, icon?: string): void {
    if (!this.statusBarItemEl) return;
    this.statusBarItemEl.setText(`FeiSync: ${text}`);
    this.statusBarItemEl.title = `FeiSync - ${text}`;
  }

  /**
   * 测试连接（单步）
   */
  async testStep(step: 'local-to-proxy' | 'proxy-to-feishu' | 'direct-to-feishu'): Promise<{ success: boolean; message: string }> {
    const proxyUrl = this.settings.proxyUrl;

    if (step === 'local-to-proxy') {
      if (!proxyUrl) {
        return { success: false, message: '未配置代理服务器地址' };
      }
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(proxyUrl, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return { success: true, message: `代理服务器可达（HTTP ${response.status}）` };
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes('abort')) {
          return { success: false, message: '连接代理服务器超时（10秒）' };
        }
        return { success: false, message: `无法连接代理服务器: ${msg}` };
      }
    }

    if (!this.authManager && this.settings.appId && this.settings.appSecret) {
      this.authManager = new FeishuAuthManager(
        this.settings.appId, this.settings.appSecret, this.settings.proxyUrl,
        () => this.saveUserToken()
      );
    }
    if (!this.authManager) {
      return { success: false, message: '请先配置飞书 App ID 和 App Secret' };
    }

    try {
      const token = await this.authManager.getAccessToken();
      const isValid = await validateToken(token, this.settings.proxyUrl);
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
   * 执行同步
   */
  async sync(): Promise<void> {
    if (this.isSyncing) {
      new Notice('同步正在进行中，请稍候...');
      return;
    }

    if (!this.syncEngine) {
      throw new Error('同步引擎未初始化，请检查凭证配置');
    }

    if (!this.isConfigured()) {
      throw new Error('请先配置飞书 App ID 和 App Secret');
    }

    if (!this.authManager?.isUserAuthorized()) {
      throw new Error('用户未授权，请先在设置中完成飞书 OAuth 授权');
    }

    if (!this.settings.localFolderPath) {
      throw new Error('请先配置本地同步文件夹');
    }

    this.isSyncing = true;
    this.updateStatusBar('同步中...');

    try {
      console.log('[FeiSync] 开始同步...');
      await this.syncEngine.sync();
      console.log('[FeiSync] 同步流程结束');
      this.updateStatusBar('同步完成');
    } catch (error) {
      this.updateStatusBar('同步失败');
      throw error;
    } finally {
      this.isSyncing = false;
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
    if (this.isSyncing) {
      new Notice('同步正在进行中，请稍候...');
      return;
    }

    if (!this.syncEngine) {
      throw new Error('同步引擎未初始化，请检查凭证配置');
    }

    if (!this.isConfigured()) {
      throw new Error('请先配置飞书 App ID 和 App Secret');
    }

    if (!this.authManager?.isUserAuthorized()) {
      throw new Error('用户未授权，请先在设置中完成飞书 OAuth 授权');
    }

    if (!this.settings.localFolderPath) {
      throw new Error('请先配置本地同步文件夹');
    }

    this.isSyncing = true;
    this.updateStatusBar('下载中...');

    try {
      await this.syncEngine.downloadFromFeishu();
      this.updateStatusBar('下载完成');
    } catch (error) {
      this.updateStatusBar('下载失败');
      throw error;
    } finally {
      this.isSyncing = false;
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
   * 切换文件监控器
   */
  toggleFileWatcher(enable: boolean): void {
    if (!this.fileWatcher) {
      console.warn('[FeiSync] 文件监控器未初始化');
      return;
    }

    if (enable) {
      this.fileWatcher.updateConfig(this.settings.localFolderPath, true);
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
      clearInterval(this.scheduledSyncTimer);
      this.scheduledSyncTimer = null;
    }

    if (enable && this.settings.scheduledSyncInterval > 0) {
      const intervalMs = this.settings.scheduledSyncInterval * 60 * 1000;
      console.log(`[FeiSync] 启动定时同步，间隔 ${this.settings.scheduledSyncInterval} 分钟`);

      this.scheduledSyncTimer = setInterval(async () => {
        try {
          console.log('[FeiSync] 定时同步触发');
          await this.sync();
        } catch (error) {
          console.error('[FeiSync] 定时同步失败:', error);
        }
      }, intervalMs);
    } else {
      console.log('[FeiSync] 定时同步已停止');
    }
  }
}
