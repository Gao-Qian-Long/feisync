import FeiSyncPlugin from './main';
import { App, PluginSettingTab, Setting, Notice, TextComponent, AbstractInputSuggest, TFolder, TFile, Modal } from 'obsidian';
import { SyncFolderConfig, createSyncFolderConfig, validateSyncFolderConfig } from './syncFolderConfig';
import { FeishuFolderBrowserModal } from './feishuFolderBrowser';
import { getDefaultIgnoreContent, FEISYNC_IGNORE_FILE } from './ignoreFilter';

/**
 * 同步日志查看弹窗
 */
class SyncLogModal extends Modal {
  private plugin: FeiSyncPlugin;

  constructor(app: App, plugin: FeiSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText('同步日志');

    const logs = this.plugin.settings.syncLog || [];
    if (logs.length === 0) {
      contentEl.createEl('p', { text: '暂无同步日志', cls: 'feisync-hint' });
      return;
    }

    const sortedLogs = [...logs].reverse();
    const container = contentEl.createEl('div', { cls: 'feisync-log-container' });

    for (const entry of sortedLogs) {
      const item = container.createEl('div', { cls: 'feisync-log-entry' });

      const time = new Date(entry.timestamp).toLocaleString();
      const actionColors: Record<string, string> = {
        upload: '#4caf50',
        skip: '#9e9e9e',
        delete: '#f44336',
        download: '#2196f3',
        error: '#ff5722',
        info: '#607d8b',
      };
      const color = actionColors[entry.action] || '#607d8b';

      item.createEl('span', { text: time, cls: 'feisync-log-time' });

      const actionSpan = item.createEl('span', { text: `[${entry.action.toUpperCase()}]`, cls: 'feisync-log-action' });
      actionSpan.setCssProps({ color });

      if (entry.filePath) {
        item.createEl('span', { text: entry.filePath, cls: 'feisync-log-file' });
      }

      if (entry.message) {
        const msgCls = entry.action === 'error' ? 'feisync-log-msg-error' : 'feisync-log-msg-default';
        item.createEl('span', { text: entry.message, cls: msgCls });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 添加文件夹映射弹窗
 */
class AddFolderMappingModal extends Modal {
  private plugin: FeiSyncPlugin;
  private onAdd: (config: SyncFolderConfig) => void;
  private localPath: string = '';
  private mode: 'auto' | 'custom' = 'auto';
  private remoteFolderToken: string = '';

  constructor(app: App, plugin: FeiSyncPlugin, onAdd: (config: SyncFolderConfig) => void) {
    super(app);
    this.plugin = plugin;
    this.onAdd = onAdd;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText('添加文件夹映射');

    // 选择本地文件夹
    new Setting(contentEl)
      .setName('本地文件夹')
      .setDesc('选择要同步到飞书的本地文件夹')
      .addText((text: TextComponent) => {
        text.inputEl.addClass('feisync-input-width');
        text.setPlaceholder('Notes')
          .setValue(this.localPath)
          .onChange((value: string) => {
            this.localPath = value.trim();
          });
        new FolderSuggest(this.app, text.inputEl);
      })
      .addButton((button) => {
        button.setButtonText('浏览...')
          .onClick(() => {
            new FolderSelectModal(this.app, (selectedPath: string) => {
              this.localPath = selectedPath;
              this.close();
              this.open();
            }).open();
          });
      });

    // 映射模式
    new Setting(contentEl)
      .setName('映射模式')
      .setDesc('自动：在同步根目录下创建同名文件夹；自定义：指定已有的飞书文件夹')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('auto', '自动（创建同名文件夹）')
          .addOption('custom', '自定义（指定飞书文件夹）')
          .setValue(this.mode)
          .onChange((value: string) => {
            this.mode = value as 'auto' | 'custom';
            this.close();
            this.open();
          });
      });

    // 自定义模式：飞书文件夹 token
    if (this.mode === 'custom') {
      new Setting(contentEl)
        .setName('Feishu folder token')
        .setDesc('输入飞书云空间中目标文件夹的 token')
        .addText((text: TextComponent) => {
          text.inputEl.addClass('feisync-input-width');
          text.setPlaceholder('fldcnxxxxxxxx')
            .setValue(this.remoteFolderToken)
            .onChange((value: string) => {
              this.remoteFolderToken = value.trim();
            });
        });

      // 浏览飞书文件夹按钮
      if (this.plugin.apiClient) {
        new Setting(contentEl)
          .setName('浏览飞书文件夹')
          .setDesc('从飞书云空间中选择目标文件夹')
          .addButton((button) => {
            button.setButtonText('浏览飞书目录...')
              .onClick(() => {
                const rootToken = this.plugin.settings.feishuRootFolderToken;
                new FeishuFolderBrowserModal(
                  this.app,
                  this.plugin.apiClient!,
                  (folderToken: string, folderName: string) => {
                    this.remoteFolderToken = folderToken;
                    this.mode = 'custom';
                    this.close();
                    this.open();
                    new Notice(`已选择飞书文件夹: ${folderName}`);
                  },
                  rootToken
                ).open();
              });
          });
      }
    }

    // 确认按钮
    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText('添加')
          .setCta()
          .onClick(() => {
            if (!this.localPath) {
              new Notice('请选择本地文件夹');
              return;
            }
            if (this.mode === 'custom' && !this.remoteFolderToken) {
              new Notice('自定义模式需要指定飞书文件夹 Token');
              return;
            }
            const config = createSyncFolderConfig(this.localPath, this.mode, this.remoteFolderToken);
            const validation = validateSyncFolderConfig(config);
            if (!validation.valid) {
              new Notice(validation.errors.join('; '));
              return;
            }
            this.onAdd(config);
            this.close();
          });
      })
      .addButton((button) => {
        button.setButtonText('取消')
          .onClick(() => {
            this.close();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// 同步日志条目
export interface SyncLogEntry {
  timestamp: number;
  action: 'upload' | 'skip' | 'delete' | 'download' | 'error' | 'info';
  filePath: string;
  message: string;
}

// 设置接口
export interface FeiSyncPluginSettings {
  appId: string;
  appSecret: string;
  localFolderPath: string;
  feishuRootFolderToken: string;
  autoSyncOnChange: boolean;
  syncInterval: number;
  enableProxy: boolean;
  proxyUrl: string;
  enableScheduledSync: boolean;
  scheduledSyncInterval: number;
  syncOnDelete: boolean;
  maxConcurrentUploads: number;
  maxRetryAttempts: number;
  syncLog: SyncLogEntry[];
  syncRecords: Record<string, import('./syncEngine').FileSyncRecord>;
  feishuUserToken: string;
  // 新增：多文件夹映射
  syncFolders: SyncFolderConfig[];
  // 同步记录清除时间戳，用于判断是否需要检查云端
  recordsClearedAt: number | null;
}

// 默认设置
const DEFAULT_SETTINGS: FeiSyncPluginSettings = {
  appId: '',
  appSecret: '',
  localFolderPath: '',
  feishuRootFolderToken: '',
  autoSyncOnChange: false,
  syncInterval: 5,
  proxyUrl: '',
  enableProxy: false,
  enableScheduledSync: false,
  scheduledSyncInterval: 30,
  syncOnDelete: true,
  maxConcurrentUploads: 3,
  maxRetryAttempts: 3,
  syncLog: [],
  syncRecords: {},
  feishuUserToken: '',
  syncFolders: [],
  recordsClearedAt: null,
};

/**
 * 加载默认设置（深拷贝，避免共享引用）
 */
export function getDefaultSettings(): FeiSyncPluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    syncLog: [],
    syncRecords: {},
    syncFolders: [],
  };
}

/**
 * 文件夹路径输入建议器
 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private cachedFolders: TFolder[] | null = null;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  private buildFolderList(): TFolder[] {
    const allFolders: TFolder[] = [];
    const queue: TFolder[] = [this.app.vault.getRoot()];
    while (queue.length > 0) {
      const current = queue.shift()!;
      allFolders.push(current);
      for (const child of current.children) {
        if (child instanceof TFolder) {
          queue.push(child);
        }
      }
    }
    return allFolders;
  }

  getSuggestions(query: string): TFolder[] {
    if (!this.cachedFolders) {
      this.cachedFolders = this.buildFolderList();
    }

    if (!query) {
      return this.cachedFolders;
    }
    const lowerQuery = query.toLowerCase();
    return this.cachedFolders.filter(f => f.path.toLowerCase().includes(lowerQuery));
  }

  renderSuggestion(value: TFolder, el: HTMLElement): void {
    el.setText(value.path || '/');
  }

  selectSuggestion(value: TFolder, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(value.path);
    this.close();
  }
}

/**
 * 文件夹选择弹窗
 */
class FolderSelectModal extends Modal {
  private onSelect: (path: string) => void;

  constructor(app: App, onSelect: (path: string) => void) {
    super(app);
    this.onSelect = onSelect;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText('选择同步文件夹');

    const allFolders: TFolder[] = [];
    const queue: TFolder[] = [this.app.vault.getRoot()];
    while (queue.length > 0) {
      const current = queue.shift()!;
      allFolders.push(current);
      for (const child of current.children) {
        if (child instanceof TFolder) {
          queue.push(child);
        }
      }
    }

    allFolders.sort((a, b) => {
      if (a.path === '') return -1;
      if (b.path === '') return 1;
      return a.path.localeCompare(b.path);
    });

    const listEl = contentEl.createEl('div', { cls: 'feisync-folder-list' });

    for (const folder of allFolders) {
      const item = listEl.createEl('div', {
        cls: 'feisync-folder-item',
        text: folder.path || '/ (根目录)'
      });

      item.addEventListener('click', () => {
        this.onSelect(folder.path);
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// 设置选项卡类
export class FeiSyncSettingTab extends PluginSettingTab {
  plugin: FeiSyncPlugin;

  constructor(app: App, plugin: FeiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 标题
    new Setting(containerEl).setName('FeiSync').setHeading();

    // ==================== 常用操作（最优先）====================
    new Setting(containerEl).setName('Quick actions').setHeading();

    const isUserAuthorized = this.plugin.authManager?.isUserAuthorized() ?? false;
    const mappingCount = (this.plugin.settings.syncFolders || []).filter(c => c.enabled).length;
    const hasMappings = mappingCount > 0;

    // 授权状态 + 同步按钮 一行
    const actionRow = containerEl.createDiv({ cls: 'feisync-action-row' });

    // 授权状态指示
    const authStatus = actionRow.createSpan({
      text: isUserAuthorized ? '✓ 已授权' : '✗ 未授权',
      cls: isUserAuthorized ? 'feisync-auth-authorized' : 'feisync-auth-unauthorized'
    });
    authStatus.title = isUserAuthorized ? '已绑定飞书用户，可以访问个人云空间' : '需要完成用户授权才能访问个人云空间';

    // 映射状态
    actionRow.createSpan({
      text: hasMappings ? `📁 ${mappingCount} 个映射` : '📁 未配置映射',
      cls: hasMappings ? 'feisync-mapping-active' : 'feisync-mapping-inactive'
    });

    // 同步按钮
    const syncBtn = actionRow.createEl('button', { text: '立即同步', cls: 'feisync-btn-primary' });
    syncBtn.title = '立即执行一次同步操作';
    syncBtn.onclick = () => {
      if (!isUserAuthorized) {
        new Notice('请先完成用户授权');
        return;
      }
      if (!hasMappings) {
        new Notice('请先配置文件夹映射');
        return;
      }
      void (async () => {
        syncBtn.setAttribute('disabled', 'true');
        syncBtn.textContent = '同步中...';
        try {
          await this.plugin.sync();
        } catch {
          new Notice('同步失败');
        } finally {
          syncBtn.removeAttribute('disabled');
          syncBtn.textContent = '立即同步';
        }
      })();
    };

    // 下载按钮
    const downloadBtn = actionRow.createEl('button', { text: '从飞书下载', cls: 'feisync-btn-primary' });
    downloadBtn.title = '将飞书云端的文件下载到本地';
    downloadBtn.onclick = () => {
      void (async () => {
        downloadBtn.setAttribute('disabled', 'true');
        downloadBtn.textContent = '下载中...';
        try {
          await this.plugin.downloadFromFeishu();
        } catch {
          new Notice('下载失败');
        } finally {
          downloadBtn.removeAttribute('disabled');
          downloadBtn.textContent = '从飞书下载';
        }
      })();
    };

    // 查看日志按钮
    const logBtn = actionRow.createEl('button', { text: '查看日志', cls: 'feisync-btn-outline' });
    logBtn.title = '查看最近的同步操作记录';
    logBtn.onclick = () => {
      new SyncLogModal(this.app, this.plugin).open();
    };

    // ==================== 用户授权 ====================
    new Setting(containerEl).setName('User authorization').setHeading();

    if (isUserAuthorized) {
      new Setting(containerEl)
        .setName('已绑定飞书用户')
        .setDesc('可以访问个人云空间')
        .addButton((button) => {
          button.setButtonText('解除授权')
            .setWarning()
            .onClick(() => {
              this.plugin.authManager?.clearUserToken();
              new Notice('已解除用户授权');
              this.display();
            });
        });
    } else {
      containerEl.createEl('p', {
        text: '需要完成用户授权才能访问个人云空间',
        cls: 'feisync-hint'
      });

      containerEl.createEl('p', {
        text: '提示：在飞书开放平台 → 应用功能 → 网页应用，添加回调地址 http://localhost:9527/callback',
        cls: 'feisync-hint'
      });

      new Setting(containerEl)
        .setName('开始授权')
        .setDesc('点击后在浏览器中完成飞书 OAuth 授权')
        .addButton((button) => {
          let isAuthorizing = false;

          const resetButton = () => {
            isAuthorizing = false;
            button.setDisabled(false);
            button.setButtonText('开始授权');
            button.buttonEl.classList.remove('mod-warning');
            button.buttonEl.classList.add('mod-cta');
          };

          const setCancelState = () => {
            isAuthorizing = true;
            button.setDisabled(false);
            button.setButtonText('取消授权');
            button.buttonEl.classList.remove('mod-cta');
            button.buttonEl.classList.add('mod-warning');
          };

          button.setButtonText('开始授权')
            .setCta()
            .onClick(() => {
              void (async () => {
                if (!this.plugin.authManager) {
                  new Notice('认证管理器未初始化');
                  return;
                }

                if (isAuthorizing) {
                  this.plugin.authManager.abortLocalCallbackServer();
                  return;
                }

                setCancelState();

                try {
                  const codePromise = this.plugin.authManager.startLocalCallbackServer(9527);
                  const oauthUrl = this.plugin.authManager.generateOAuthUrl('http://localhost:9527/callback');
                  window.open(oauthUrl);
                  new Notice('请在浏览器中完成飞书授权...');

                  const code = await codePromise;
                  new Notice('已获取授权码，正在交换令牌...');

                  await this.plugin.authManager.exchangeCodeForUserToken(code, 'http://localhost:9527/callback');
                  await this.plugin.saveUserToken();
                  new Notice('授权成功！');
                  this.display();
                } catch (error) {
                  const msg = (error as Error).message;
                  if (msg !== '授权已取消') {
                    new Notice('授权失败：' + msg);
                  }
                  resetButton();
                }
              })();
            });
        });
    }

    // ==================== 文件夹映射 ====================
    new Setting(containerEl).setName('Folder mapping').setHeading();

    // 飞书同步根目录（紧凑显示）
    if (this.plugin.settings.feishuRootFolderToken) {
      const rootHint = containerEl.createEl('p', {
        text: `同步根目录: ${this.plugin.settings.feishuRootFolderToken.substring(0, 16)}...`,
        cls: 'feisync-hint'
      });
      rootHint.title = '所有自动映射的文件夹将在此目录下创建';
    }

    // 文件夹映射列表
    const syncFolders = this.plugin.settings.syncFolders || [];

    if (syncFolders.length > 0) {
      const listContainer = containerEl.createDiv({ cls: 'feisync-folder-mapping-list' });

      for (let i = 0; i < syncFolders.length; i++) {
        const config = syncFolders[i];
        const itemContainer = listContainer.createDiv({ cls: 'feisync-folder-mapping-item' });

        // 启用开关
        const toggleEl = itemContainer.createEl('input', { type: 'checkbox', cls: 'feisync-toggle' });
        toggleEl.checked = config.enabled;
        toggleEl.title = config.enabled ? '点击禁用' : '点击启用';
        toggleEl.addEventListener('change', () => {
          void (async () => {
            config.enabled = toggleEl.checked;
            await this.plugin.saveSettings();
          })();
        });

        // 信息区
        const infoEl = itemContainer.createDiv({ cls: 'feisync-mapping-info' });

        const pathEl = infoEl.createEl('strong', { text: config.localPath });
        pathEl.title = `本地路径: ${config.localPath}`;

        const modeText = config.mode === 'auto' ? '→ 自动创建' : '→ 自定义';
        const lastSync = config.lastSyncTime > 0 ? ` | ${new Date(config.lastSyncTime).toLocaleDateString()}` : ' | 未同步';
        infoEl.createEl('span', {
          text: modeText + lastSync,
          cls: 'feisync-mapping-mode'
        });

        // 删除按钮
        const deleteBtn = itemContainer.createEl('button', { text: '×', cls: 'feisync-delete-btn' });
        deleteBtn.title = '删除此映射';
        deleteBtn.addEventListener('click', () => {
          void (async () => {
            this.plugin.settings.syncFolders = this.plugin.settings.syncFolders.filter(c => c.id !== config.id);
            await this.plugin.saveSettings();
            this.display();
          })();
        });
      }
    } else {
      containerEl.createEl('p', {
        text: '尚未配置文件夹映射',
        cls: 'feisync-hint'
      });

      // 旧版配置迁移提示
      if (this.plugin.settings.localFolderPath) {
        new Setting(containerEl)
          .setName('检测到旧配置')
          .setDesc(`"${this.plugin.settings.localFolderPath}" → 点击迁移为多文件夹映射`)
          .addButton((button) => {
            button.setButtonText('迁移')
              .setCta()
              .onClick(() => {
                void (async () => {
                  const { migrateFromLegacyConfig } = await import('./syncFolderConfig');
                  const newConfigs = migrateFromLegacyConfig(
                    this.plugin.settings.localFolderPath,
                    this.plugin.settings.feishuRootFolderToken
                  );
                  this.plugin.settings.syncFolders = newConfigs;
                  await this.plugin.saveSettings();
                  new Notice('旧配置已迁移');
                  this.display();
                })();
              });
          });
      }
    }

    // 添加映射按钮
    new Setting(containerEl)
      .setName('添加新映射')
      .setDesc('选择本地文件夹并配置到飞书的映射关系')
      .addButton((button) => {
        button.setButtonText('+ 添加映射')
          .setCta()
          .onClick(() => {
            new AddFolderMappingModal(this.app, this.plugin, (config: SyncFolderConfig) => {
              void (async () => {
                const existing = this.plugin.settings.syncFolders.find(c => c.localPath === config.localPath);
                if (existing) {
                  new Notice(`文件夹 "${config.localPath}" 已存在映射`);
                  return;
                }
                this.plugin.settings.syncFolders.push(config);
                await this.plugin.saveSettings();
                this.display();
                new Notice(`已添加映射: ${config.localPath}`);
              })();
            }).open();
          });
      });

    // 浏览飞书目录（紧凑）
    if (this.plugin.apiClient) {
      new Setting(containerEl)
        .setName('浏览飞书目录')
        .setDesc('选择同步根目录（留空则自动创建 ObsidianSync 文件夹）')
        .addButton((button) => {
          button.setButtonText('浏览...')
            .onClick(() => {
              new FeishuFolderBrowserModal(
                this.app,
                this.plugin.apiClient!,
                async (folderToken: string, folderName: string) => {
                  this.plugin.settings.feishuRootFolderToken = folderToken;
                  await this.plugin.saveSettings();
                  this.display();
                  new Notice(`已选择根目录: ${folderName}`);
                },
                ''
              ).open();
            });
        });
    }

    // ==================== 同步选项 ====================
    new Setting(containerEl).setName('Sync').setHeading();

    new Setting(containerEl)
      .setName('自动同步')
      .setDesc('监听本地文件变化，自动上传到飞书')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoSyncOnChange)
          .onChange((value: boolean) => {
            void (async () => {
              this.plugin.settings.autoSyncOnChange = value;
              await this.plugin.saveSettings();
              await this.plugin.toggleFileWatcher(value);
              this.display();
            })();
          });
      });

    if (this.plugin.settings.autoSyncOnChange) {
      new Setting(containerEl)
        .setName('最小同步间隔')
        .setDesc('单位：分钟')
        .addText((text: TextComponent) => {
          text.inputEl.addClass('feisync-input-small');
          text.setValue(this.plugin.settings.syncInterval.toString())
            .onChange((value: string) => {
              void (async () => {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num > 0 && num <= 1440) {
                  this.plugin.settings.syncInterval = num;
                  await this.plugin.saveSettings();
                }
              })();
            });
        });
    }

    new Setting(containerEl)
      .setName('定时同步')
      .setDesc('按固定间隔自动执行同步')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableScheduledSync)
          .onChange((value: boolean) => {
            void (async () => {
              this.plugin.settings.enableScheduledSync = value;
              await this.plugin.saveSettings();
              this.plugin.toggleScheduledSync(value);
              this.display();
            })();
          });
      });

    if (this.plugin.settings.enableScheduledSync) {
      new Setting(containerEl)
        .setName('定时同步间隔')
        .setDesc('单位：分钟')
        .addText((text: TextComponent) => {
          text.inputEl.addClass('feisync-input-small');
          text.setValue(this.plugin.settings.scheduledSyncInterval.toString())
            .onChange((value: string) => {
              void (async () => {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num > 0 && num <= 1440) {
                  this.plugin.settings.scheduledSyncInterval = num;
                  await this.plugin.saveSettings();
                  if (this.plugin.settings.enableScheduledSync) {
                    this.plugin.toggleScheduledSync(false);
                    this.plugin.toggleScheduledSync(true);
                  }
                }
              })();
            });
        });
    }

    new Setting(containerEl)
      .setName('同步删除')
      .setDesc('本地文件删除时，同步删除云端文件')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncOnDelete)
          .onChange((value: boolean) => {
            void (async () => {
              this.plugin.settings.syncOnDelete = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    // ==================== 飞书凭证 ====================
    new Setting(containerEl).setName('Feishu credentials').setHeading();

    new Setting(containerEl)
      .setName('App ID')
      .setDesc('飞书开放平台创建应用后获得的 App ID')
      .addText((text: TextComponent) => {
        text.inputEl.addClass('feisync-input-width');
        text.setPlaceholder('cli_xxxxxxxx')
          .setValue(this.plugin.settings.appId)
          .onChange((value: string) => {
            void (async () => {
              this.plugin.settings.appId = value.trim();
              await this.plugin.saveSettings();
            })();
          });
      });

    new Setting(containerEl)
      .setName('App secret')
      .setDesc('对应的 App secret')
      .addText((text: TextComponent) => {
        text.inputEl.addClass('feisync-input-width');
        text.inputEl.type = 'password';
        text.setPlaceholder('xxxxxxxxxxxxxxxx')
          .setValue(this.plugin.settings.appSecret)
          .onChange((value: string) => {
            void (async () => {
              this.plugin.settings.appSecret = value.trim();
              await this.plugin.saveSettings();
            })();
          });
      });

    containerEl.createEl('p', {
      text: '提示：请确保在飞书开放平台为应用开启以下权限：drive:drive（云空间）、drive:export:readonly（导出文档）、drive:file:download（下载文件）、docx:document（在线文档）、docs:document:import（导入文档）、docs:document:export（导出文档）',
      cls: 'feisync-hint'
    });

    // ==================== 网络设置 ====================
    new Setting(containerEl).setName('Network').setHeading();

    new Setting(containerEl)
      .setName('使用代理')
      .setDesc('通过代理服务器访问飞书 API')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableProxy)
          .onChange((value: boolean) => {
            void (async () => {
              this.plugin.settings.enableProxy = value;
              await this.plugin.saveSettings();
              this.display();
            })();
          });
      });

    if (this.plugin.settings.enableProxy) {
      new Setting(containerEl)
        .setName('代理地址')
        .setDesc('例如：http://proxy.com:8080')
        .addText((text: TextComponent) => {
          text.inputEl.addClass('feisync-input-width');
          text.setPlaceholder('http://your-proxy.com:8080')
            .setValue(this.plugin.settings.proxyUrl)
            .onChange((value: string) => {
              void (async () => {
                const trimmed = value.trim();
                // 基本格式校验：必须以 http:// 或 https:// 开头
                if (trimmed && !/^https?:\/\//.test(trimmed)) {
                  new Notice('代理地址必须以 http:// 或 https:// 开头');
                  return;
                }
                this.plugin.settings.proxyUrl = trimmed;
                await this.plugin.saveSettings();
              })();
            });
        });

      new Setting(containerEl)
        .setName('测试连接')
        .setDesc('测试代理和飞书 API 连通性')
        .addButton((button) => {
          button.setButtonText('测试')
            .onClick(() => {
              void (async () => {
                button.setDisabled(true);
                button.setButtonText('测试中...');
                const proxyUrl = this.plugin.settings.proxyUrl;
                if (proxyUrl) {
                  const r1 = await this.plugin.testStep('local-to-proxy');
                  if (!r1.success) {
                    new Notice(`✗ ${r1.message}`);
                  } else {
                    const r2 = await this.plugin.testStep('proxy-to-feishu');
                    new Notice(r2.success ? `✓ ${r2.message}` : `✗ 代理→飞书: ${r2.message}`);
                  }
                } else {
                  const result = await this.plugin.testStep('direct-to-feishu');
                  new Notice(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
                }
                button.setDisabled(false);
                button.setButtonText('测试');
              })();
            });
        });
    }

    // ==================== 忽略规则 ====================
    new Setting(containerEl).setName('Ignore rules').setHeading();

    const ignoreFile = this.app.vault.getAbstractFileByPath(FEISYNC_IGNORE_FILE);

    // 语法说明
    const syntaxHint = containerEl.createEl('p', { cls: 'feisync-hint' });
    syntaxHint.createSpan({ text: '语法：' });
    syntaxHint.createEl('code', { text: 'folder/', cls: 'feisync-code' }); syntaxHint.createSpan({ text: ' 忽略目录 ' });
    syntaxHint.createEl('code', { text: '*.ext', cls: 'feisync-code' }); syntaxHint.createSpan({ text: ' 忽略扩展名 ' });
    syntaxHint.createEl('code', { text: '**/.bak', cls: 'feisync-code' }); syntaxHint.createSpan({ text: ' 任意位置 ' });
    syntaxHint.createEl('code', { text: '!file.md', cls: 'feisync-code' }); syntaxHint.createSpan({ text: ' 取消忽略' });
    syntaxHint.title = '创建 feisync-ignore.md 文件可排除特定文件/文件夹不同步';

    if (!ignoreFile) {
      new Setting(containerEl)
        .setName('创建忽略规则文件')
        .setDesc('生成包含常见忽略项的配置文件')
        .addButton((button) => {
          button.setButtonText('创建')
            .onClick(() => {
              void (async () => {
                try {
                  const defaultContent = getDefaultIgnoreContent();
                  await this.app.vault.create(FEISYNC_IGNORE_FILE, defaultContent);
                  new Notice(`${FEISYNC_IGNORE_FILE} 已创建`);
                  this.display();
                } catch (err) {
                  new Notice('创建失败: ' + (err as Error).message);
                }
              })();
            });
        });
    } else {
      new Setting(containerEl)
        .setName('编辑忽略规则')
        .setDesc(`${FEISYNC_IGNORE_FILE} 已存在`)
        .addButton((button) => {
          button.setButtonText('在编辑器中打开')
            .onClick(() => {
              void this.app.workspace.openLinkText(FEISYNC_IGNORE_FILE, '');
            });
        })
        .addButton((button) => {
          button.setButtonText('重置')
            .onClick(() => {
              void (async () => {
                try {
                  const defaultContent = getDefaultIgnoreContent();
                  if (ignoreFile instanceof TFile) {
                    await this.app.vault.modify(ignoreFile, defaultContent);
                    new Notice('已重置为默认规则');
                    await this.plugin.syncEngine?.reloadIgnoreFilter();
                    await this.plugin.fileWatcher?.reloadIgnoreFilter();
                  }
                } catch (err) {
                  new Notice('重置失败: ' + (err as Error).message);
                }
              })();
            });
        });
    }

    // ==================== 高级设置 ====================
    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('并发上传数')
      .setDesc('同时上传的最大文件数（1-10）')
      .addSlider((slider) => {
        slider.setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxConcurrentUploads)
          .setDynamicTooltip()
          .onChange((value: number) => {
            void (async () => {
              this.plugin.settings.maxConcurrentUploads = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    new Setting(containerEl)
      .setName('API 重试次数')
      .setDesc('网络请求失败时的最大重试次数')
      .addSlider((slider) => {
        slider.setLimits(0, 5, 1)
          .setValue(this.plugin.settings.maxRetryAttempts)
          .setDynamicTooltip()
          .onChange((value: number) => {
            void (async () => {
              this.plugin.settings.maxRetryAttempts = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    // ==================== 数据管理 ====================
    new Setting(containerEl).setName('Data management').setHeading();

    new Setting(containerEl)
      .setName('重置同步记录')
      .setDesc(`清除本地记录（${Object.keys(this.plugin.settings.syncRecords || {}).length} 条）`)
      .addButton((button) => {
        button.setButtonText('重置')
          .setWarning()
          .onClick(() => {
            void (async () => {
              this.plugin.settings.syncRecords = {};
              this.plugin.settings.recordsClearedAt = Date.now();
              await this.plugin.saveSettings();
              new Notice('同步记录已重置');
              this.display();
            })();
          });
      });

    new Setting(containerEl)
      .setName('清除同步日志')
      .setDesc('清空所有同步日志记录')
      .addButton((button) => {
        button.setButtonText('清除')
          .setWarning()
          .onClick(() => {
            void (async () => {
              this.plugin.settings.syncLog = [];
              await this.plugin.saveSettings();
              new Notice('同步日志已清除');
            })();
          });
      });
  }
}
