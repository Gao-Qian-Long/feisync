/**
 * Obsidian Flybook 插件主入口
 * 将本地 Obsidian 笔记同步到飞书 Drive
 */

import { Plugin, Notice, Menu } from 'obsidian';
import { FlybookPluginSettings, FlybookSettingTab, getDefaultSettings } from './settings';
import { FeishuAuthManager, validateToken } from './feishuAuth';
import { FeishuApiClient } from './feishuApi';
import { FileWatcher } from './fileWatcher';
import { SyncEngine, FileSyncRecord } from './syncEngine';

// 插件主类
export default class FlybookPlugin extends Plugin {
  // 设置
  settings: FlybookPluginSettings = getDefaultSettings();

  // 模块实例
  authManager: FeishuAuthManager | null = null;
  apiClient: FeishuApiClient | null = null;
  fileWatcher: FileWatcher | null = null;
  syncEngine: SyncEngine | null = null;

  // 设置选项卡
  settingTab: FlybookSettingTab | null = null;

  // Ribbon 图标元素
  ribbonIconEl: HTMLElement | null = null;

  /**
   * 插件加载时调用
   */
  async onload(): Promise<void> {
    console.log('[Flybook] 插件加载中...');

    // 1. 加载设置
    await this.loadSettings();

    // 2. 初始化模块
    await this.initializeModules();

    // 3. 注册设置界面
    this.settingTab = new FlybookSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // 4. 注册命令
    this.registerCommands();

    // 5. 添加 Ribbon 图标
    this.setupRibbonIcon();

    // 6. 启动文件监控（如果已启用）
    if (this.settings.autoSyncOnChange && this.settings.localFolderPath) {
      this.toggleFileWatcher(true);
    }

    console.log('[Flybook] 插件加载完成');
  }

  /**
   * 插件卸载时调用
   */
  async onunload(): Promise<void> {
    console.log('[Flybook] 插件卸载中...');

    // 停止文件监控
    if (this.fileWatcher) {
      this.fileWatcher.stop();
    }

    // 移除 Ribbon 图标
    if (this.ribbonIconEl) {
      this.ribbonIconEl.remove();
    }

    console.log('[Flybook] 插件卸载完成');
  }

  /**
   * 加载设置
   */
  async loadSettings(): Promise<void> {
    try {
      const loadedData = await this.loadData();
      this.settings = Object.assign({}, getDefaultSettings(), loadedData);
      console.log('[Flybook] 设置加载成功');
    } catch (error) {
      console.error('[Flybook] 加载设置失败:', error);
      this.settings = getDefaultSettings();
    }
  }

  /**
   * 保存设置
   */
  async saveSettings(): Promise<void> {
    try {
      await this.saveData(this.settings);
      console.log('[Flybook] 设置保存成功');

      // 如果认证信息变更，更新或创建 authManager
      if (this.settings.appId && this.settings.appSecret) {
        if (this.authManager) {
          // 已存在则更新凭证
          this.authManager.updateCredentials(this.settings.appId, this.settings.appSecret, this.settings.proxyUrl);
        } else {
          // 不存在则创建
          this.authManager = new FeishuAuthManager(
            this.settings.appId, this.settings.appSecret, this.settings.proxyUrl,
            () => this.saveUserToken()
          );
          // 同时创建依赖的 API 客户端和同步引擎
          this.apiClient = new FeishuApiClient(this.authManager, this.settings.proxyUrl);
          this.syncEngine = new SyncEngine(this, this.apiClient);
        }
      }

      // 更新文件监控配置
      if (this.fileWatcher) {
        this.fileWatcher.updateConfig(this.settings.localFolderPath, this.settings.autoSyncOnChange);
      }
    } catch (error) {
      console.error('[Flybook] 保存设置失败:', error);
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
      this.apiClient = new FeishuApiClient(this.authManager, this.settings.proxyUrl);
    }

    // 同步引擎
    if (this.apiClient) {
      this.syncEngine = new SyncEngine(this, this.apiClient);
    }

    // 文件监控器
    this.fileWatcher = new FileWatcher(this);
    
    // 从存储中恢复用户授权信息（必须 await，否则后续操作可能报未授权）
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
      console.error('[Flybook] 加载用户令牌失败:', error);
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
        console.log('[Flybook] 用户令牌已保存');
      } catch (error) {
        console.error('[Flybook] 保存用户令牌失败:', error);
      }
    }
  }

  /**
   * 加载同步记录
   * @returns 文件路径到同步记录的映射
   */
  async loadSyncRecords(): Promise<Record<string, FileSyncRecord>> {
    try {
      const data = await this.loadData();
      if (data && data.flybookSyncRecords) {
        const records = typeof data.flybookSyncRecords === 'string'
          ? JSON.parse(data.flybookSyncRecords)
          : data.flybookSyncRecords;
        console.log(`[Flybook] 已加载 ${Object.keys(records).length} 条同步记录`);
        return records;
      }
    } catch (error) {
      console.error('[Flybook] 加载同步记录失败:', error);
    }
    return {};
  }

  /**
   * 保存同步记录
   * @param records 文件路径到同步记录的映射
   */
  async saveSyncRecords(records: Record<string, FileSyncRecord>): Promise<void> {
    try {
      const data = await this.loadData();
      data.flybookSyncRecords = records;
      await this.saveData(data);
      console.log(`[Flybook] 已保存 ${Object.keys(records).length} 条同步记录`);
    } catch (error) {
      console.error('[Flybook] 保存同步记录失败:', error);
    }
  }

  /**
   * 注册命令
   */
  private registerCommands(): void {
    // 手动同步命令
    this.addCommand({
      id: 'flybook-sync',
      name: 'Sync now',
      callback: async () => {
        try {
          await this.sync();
          new Notice('同步完成');
        } catch (error) {
          new Notice('同步失败: ' + (error as Error).message);
        }
      },
    });
  }

  /**
   * 添加 Ribbon 图标
   */
  private setupRibbonIcon(): void {
    this.ribbonIconEl = this.addRibbonIcon('cloud-upload', '同步到飞书', async (evt: MouseEvent) => {
      // 点击时显示菜单
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('立即同步')
          .setIcon('sync')
          .onClick(async () => {
            try {
              await this.sync();
              new Notice('同步完成');
            } catch (error) {
              new Notice('同步失败: ' + (error as Error).message);
            }
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
   * 测试连接（单步）
   * @returns 测试结果 { success, message }
   */
  async testStep(step: 'local-to-proxy' | 'proxy-to-feishu' | 'direct-to-feishu'): Promise<{ success: boolean; message: string }> {
    const proxyUrl = this.settings.proxyUrl;

    // 步骤1：本地 → 代理服务器
    if (step === 'local-to-proxy') {
      if (!proxyUrl) {
        return { success: false, message: '未配置代理服务器地址' };
      }
      try {
        // 仅测试能否到达代理服务器，发送一个简单请求
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(proxyUrl, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        // 只要能连上就算成功（即使返回 404 也说明代理可达）
        return { success: true, message: `代理服务器可达（HTTP ${response.status}）` };
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes('abort')) {
          return { success: false, message: '连接代理服务器超时（10秒）' };
        }
        return { success: false, message: `无法连接代理服务器: ${msg}` };
      }
    }

    // 步骤2：代理服务器 → 飞书（或直连飞书）
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
   * 测试连接（旧接口，保留兼容）
   */
  async testConnection(): Promise<boolean> {
    // 如果 authManager 不存在但凭证已配置，则初始化
    if (!this.authManager && this.settings.appId && this.settings.appSecret) {
      this.authManager = new FeishuAuthManager(
        this.settings.appId, this.settings.appSecret, this.settings.proxyUrl,
        () => this.saveUserToken()
      );
    }

    if (!this.authManager) {
      new Notice('请先配置飞书凭证');
      return false;
    }

    try {
      const token = await this.authManager.getAccessToken();
      const isValid = await validateToken(token, this.settings.proxyUrl);

      if (isValid) {
        console.log('[Flybook] 连接测试成功');
        return true;
      } else {
        console.warn('[Flybook] 连接测试失败：令牌无效');
        return false;
      }
    } catch (error) {
      console.error('[Flybook] 连接测试异常:', error);
      return false;
    }
  }

  /**
   * 执行同步
   */
  async sync(): Promise<void> {
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

    console.log('[Flybook] 开始同步...');
    await this.syncEngine.sync();
    console.log('[Flybook] 同步流程结束');
  }

  /**
   * 检查插件是否已配置（凭证是否完整）
   */
  isConfigured(): boolean {
    return !!this.settings.appId && !!this.settings.appSecret;
  }

  /**
   * 切换文件监控器
   */
  toggleFileWatcher(enable: boolean): void {
    if (!this.fileWatcher) {
      console.warn('[Flybook] 文件监控器未初始化');
      return;
    }

    if (enable) {
      this.fileWatcher.updateConfig(this.settings.localFolderPath, true);
    } else {
      this.fileWatcher.stop();
    }
  }
}