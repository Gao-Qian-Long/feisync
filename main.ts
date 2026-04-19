/**
 * Obsidian Flybook 插件主入口
 * 将本地 Obsidian 笔记同步到飞书 Drive
 */

import { Plugin, Notice, Menu, setIcon } from 'obsidian';
import { FlybookPluginSettings, FlybookSettingTab, getDefaultSettings } from './settings';
import { FeishuAuthManager, validateToken } from './feishuAuth';
import { FeishuApiClient } from './feishuApi';
import { FileWatcher } from './fileWatcher';
import { SyncEngine } from './syncEngine';

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
    this.initializeModules();

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

      // 如果认证信息变更，更新 authManager
      if (this.authManager) {
        this.authManager.updateCredentials(this.settings.appId, this.settings.appSecret);
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
  private initializeModules(): void {
    // 认证管理器
    if (this.settings.appId && this.settings.appSecret) {
      this.authManager = new FeishuAuthManager(this.settings.appId, this.settings.appSecret);
    }

    // API 客户端
    if (this.authManager) {
      this.apiClient = new FeishuApiClient(this.authManager);
    }

    // 同步引擎
    if (this.apiClient) {
      this.syncEngine = new SyncEngine(this, this.apiClient);
    }

    // 文件监控器
    this.fileWatcher = new FileWatcher(this);
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
   * 测试连接
   */
  async testConnection(): Promise<boolean> {
    if (!this.authManager) {
      new Notice('请先配置飞书凭证');
      return false;
    }

    try {
      const token = await this.authManager.getAccessToken();
      const isValid = await validateToken(token);

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

    if (!this.syncEngine.isConfigured()) {
      throw new Error('请先配置飞书 App ID 和 App Secret');
    }

    if (!this.settings.localFolderPath) {
      throw new Error('请先配置本地同步文件夹');
    }

    console.log('[Flybook] 开始同步...');
    await this.syncEngine.sync();
    console.log('[Flybook] 同步流程结束');
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