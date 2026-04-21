import FeiSyncPlugin from './main';
import { App, PluginSettingTab, Setting, Notice, TextComponent, AbstractInputSuggest, TFolder, Modal } from 'obsidian';

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

    // 按时间倒序显示
    const sortedLogs = [...logs].reverse();
    const container = contentEl.createEl('div', { cls: 'feisync-log-container' });
    container.style.maxHeight = '500px';
    container.style.overflowY = 'auto';
    container.style.fontFamily = 'monospace';
    container.style.fontSize = '12px';

    for (const entry of sortedLogs) {
      const item = container.createEl('div', { cls: 'feisync-log-entry' });
      item.style.padding = '4px 8px';
      item.style.borderBottom = '1px solid var(--background-modifier-border)';

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

      const timeSpan = item.createEl('span', { text: time });
      timeSpan.style.color = 'var(--text-muted)';
      timeSpan.style.marginRight = '8px';

      const actionSpan = item.createEl('span', { text: `[${entry.action.toUpperCase()}]` });
      actionSpan.style.color = color;
      actionSpan.style.marginRight = '8px';
      actionSpan.style.fontWeight = 'bold';

      if (entry.filePath) {
        const fileSpan = item.createEl('span', { text: entry.filePath });
        fileSpan.style.marginRight = '8px';
      }

      if (entry.message) {
        const msgSpan = item.createEl('span', { text: entry.message });
        msgSpan.style.color = entry.action === 'error' ? '#ff5722' : 'var(--text-muted)';
      }
    }
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
  proxyUrl: string; // 代理服务器地址，例如 http://your-proxy.com:8080
  enableScheduledSync: boolean; // 定时同步开关
  scheduledSyncInterval: number; // 定时同步间隔（分钟）
  syncOnDelete: boolean; // 本地删除时同步删除云端
  maxConcurrentUploads: number; // 最大并发上传数
  maxRetryAttempts: number; // API 请求最大重试次数
  syncLog: SyncLogEntry[]; // 同步日志（持久化）
  syncRecords: Record<string, import('./syncEngine').FileSyncRecord>; // 同步记录（持久化）
}

// 默认设置
const DEFAULT_SETTINGS: FeiSyncPluginSettings = {
  appId: '',
  appSecret: '',
  localFolderPath: '',
  feishuRootFolderToken: '',
  autoSyncOnChange: false,
  syncInterval: 5, // 分钟
  proxyUrl: '', // 代理服务器地址，留空则直连
  enableScheduledSync: false,
  scheduledSyncInterval: 30, // 30 分钟
  syncOnDelete: true,
  maxConcurrentUploads: 3,
  maxRetryAttempts: 3,
  syncLog: [],
  syncRecords: {},
};

/**
 * 加载默认设置
 */
export function getDefaultSettings(): FeiSyncPluginSettings {
  return Object.assign({}, DEFAULT_SETTINGS);
}

/**
 * 文件夹路径输入建议器
 * 输入时自动下拉显示仓库中所有文件夹供选择
 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
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

    if (!query) {
      return allFolders;
    }
    const lowerQuery = query.toLowerCase();
    return allFolders.filter(f => f.path.toLowerCase().includes(lowerQuery));
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
 * 以列表形式展示仓库中的所有文件夹，点击即可选择
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

    // 获取所有文件夹
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

    // 排序：根目录在前，然后按路径字母顺序
    allFolders.sort((a, b) => {
      if (a.path === '') return -1;
      if (b.path === '') return 1;
      return a.path.localeCompare(b.path);
    });

    const listEl = contentEl.createEl('div', { cls: 'feisync-folder-list' });
    listEl.style.maxHeight = '400px';
    listEl.style.overflowY = 'auto';
    listEl.style.border = '1px solid var(--background-modifier-border)';
    listEl.style.borderRadius = '4px';

    for (const folder of allFolders) {
      const item = listEl.createEl('div', {
        cls: 'feisync-folder-item',
        text: folder.path || '/ (根目录)'
      });
      item.style.padding = '8px 12px';
      item.style.cursor = 'pointer';
      item.style.borderBottom = '1px solid var(--background-modifier-border)';

      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = 'var(--background-modifier-hover)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.backgroundColor = '';
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
    containerEl.createEl('h2', { text: 'FeiSync 设置' });

    // 凭证配置
    new Setting(containerEl)
      .setName('飞书 App ID')
      .setDesc('在飞书开放平台创建应用后获得的 App ID')
      .addText((text: TextComponent) => {
        text.inputEl.style.width = '100%';
        text.setPlaceholder('cli_xxxxxxxx')
          .setValue(this.plugin.settings.appId)
          .onChange(async (value: string) => {
            this.plugin.settings.appId = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('飞书 App Secret')
      .setDesc('对应的 App Secret，请妥善保管')
      .addText((text: TextComponent) => {
        text.inputEl.style.width = '100%';
        text.inputEl.type = 'password'; // 隐藏密码
        text.setPlaceholder('xxxxxxxxxxxxxxxx')
          .setValue(this.plugin.settings.appSecret)
          .onChange(async (value: string) => {
            this.plugin.settings.appSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // 代理服务器配置（可选，用于解决 CORS 限制）
    const proxySetting = new Setting(containerEl)
      .setName('代理服务器地址（可选）')
      .setDesc('如果直接连接飞书 API 失败，请填写代理服务器地址。例如：http://your-proxy.com:8080')
      .addText((text: TextComponent) => {
        text.inputEl.style.width = '100%';
        text.setPlaceholder('http://your-proxy.com:8080')
          .setValue(this.plugin.settings.proxyUrl)
          .onChange(async (value: string) => {
            this.plugin.settings.proxyUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });
    // 让设置项纵向排列，输入框独占一整行
    proxySetting.controlEl.style.flexWrap = 'wrap';
    proxySetting.controlEl.style.width = '100%';

    // 代理连接测试按钮（单独一行，避免挤压输入框）
    new Setting(containerEl)
      .setName('代理连接测试')
      .setDesc('测试代理服务器是否可达以及飞书 API 是否连通')
      .addButton((button) => {
        button.setButtonText('测试连接')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('测试中...');
            const proxyUrl = this.plugin.settings.proxyUrl;
            if (proxyUrl) {
              // 有代理：先测本地→代理，再测代理→飞书
              const r1 = await this.plugin.testStep('local-to-proxy');
              if (!r1.success) {
                new Notice(`✗ ${r1.message}`);
              } else {
                const r2 = await this.plugin.testStep('proxy-to-feishu');
                new Notice(r2.success ? `✓ ${r2.message}` : `✗ 本地→代理: ${r1.message}；代理→飞书: ${r2.message}`);
              }
            } else {
              // 无代理：直连飞书
              const result = await this.plugin.testStep('direct-to-feishu');
              new Notice(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
            }
            button.setDisabled(false);
            button.setButtonText('测试连接');
          });
      });

    // 本地文件夹路径（输入框 + 浏览按钮）
    let folderTextComp: TextComponent;
    new Setting(containerEl)
      .setName('本地同步文件夹')
      .setDesc('选择要同步到飞书的本地文件夹')
      .addText((text: TextComponent) => {
        folderTextComp = text;
        text.inputEl.style.width = '100%';
        text.setPlaceholder('Notes')
          .setValue(this.plugin.settings.localFolderPath)
          .onChange(async (value: string) => {
            this.plugin.settings.localFolderPath = value.trim();
            await this.plugin.saveSettings();
          });
        // 保留输入时的下拉建议
        new FolderSuggest(this.app, text.inputEl);
      })
      .addButton((button) => {
        button.setButtonText('浏览...')
          .onClick(() => {
            new FolderSelectModal(this.app, (selectedPath: string) => {
              this.plugin.settings.localFolderPath = selectedPath;
              this.plugin.saveSettings();
              folderTextComp.setValue(selectedPath);
            }).open();
          });
      });

    // 飞书文件夹 token（可选）
    new Setting(containerEl)
      .setName('飞书目标文件夹 Token（可选）')
      .setDesc('填入飞书Drive中目标文件夹的token。如果留空，插件将在根目录下创建 "ObsidianSync" 文件夹。')
      .addText((text: TextComponent) => {
        text.inputEl.style.width = '100%';
        text.setPlaceholder('fldcnxxxxxxxx')
          .setValue(this.plugin.settings.feishuRootFolderToken)
          .onChange(async (value: string) => {
            this.plugin.settings.feishuRootFolderToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // 分隔线
    containerEl.createEl('hr');

    // 自动同步开关
    new Setting(containerEl)
      .setName('自动同步')
      .setDesc('监听本地文件变化并自动上传到飞书')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoSyncOnChange)
          .onChange(async (value: boolean) => {
            this.plugin.settings.autoSyncOnChange = value;
            await this.plugin.saveSettings();
            // 动态启停文件监听器
            this.plugin.toggleFileWatcher(value);
            // 刷新设置界面以显示/隐藏同步间隔选项
            this.display();
          });
      });

    // 同步间隔（仅当自动同步开启时显示）
    if (this.plugin.settings.autoSyncOnChange) {
      new Setting(containerEl)
        .setName('同步间隔（分钟）')
        .setDesc('两次自动同步的最小时间间隔，防止频繁同步')
        .addText((text: TextComponent) => {
          text.inputEl.style.width = '80px';
          text.setPlaceholder('5')
            .setValue(this.plugin.settings.syncInterval.toString())
            .onChange(async (value: string) => {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0 && num <= 1440) {
                this.plugin.settings.syncInterval = num;
                await this.plugin.saveSettings();
              } else {
                new Notice('请输入有效的数字（大于0且不超过1440）');
              }
            });
        });
    }

    // 本地删除时同步删除云端
    new Setting(containerEl)
      .setName('同步删除')
      .setDesc('本地文件删除时，同时删除飞书云端的对应文件')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncOnDelete)
          .onChange(async (value: boolean) => {
            this.plugin.settings.syncOnDelete = value;
            await this.plugin.saveSettings();
          });
      });

    // 定时同步
    new Setting(containerEl)
      .setName('定时同步')
      .setDesc('按固定时间间隔自动执行同步，无需文件变化触发')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableScheduledSync)
          .onChange(async (value: boolean) => {
            this.plugin.settings.enableScheduledSync = value;
            await this.plugin.saveSettings();
            this.plugin.toggleScheduledSync(value);
            this.display();
          });
      });

    if (this.plugin.settings.enableScheduledSync) {
      new Setting(containerEl)
        .setName('定时同步间隔（分钟）')
        .setDesc('定时同步的执行间隔，最小1分钟')
        .addText((text: TextComponent) => {
          text.inputEl.style.width = '80px';
          text.setPlaceholder('30')
            .setValue(this.plugin.settings.scheduledSyncInterval.toString())
            .onChange(async (value: string) => {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0 && num <= 1440) {
                this.plugin.settings.scheduledSyncInterval = num;
                await this.plugin.saveSettings();
                // 重新启动定时器
                if (this.plugin.settings.enableScheduledSync) {
                  this.plugin.toggleScheduledSync(false);
                  this.plugin.toggleScheduledSync(true);
                }
              } else {
                new Notice('请输入有效的数字（大于0且不超过1440）');
              }
            });
        });
    }

    // 分隔线
    containerEl.createEl('hr');

    // 高级设置
    containerEl.createEl('h3', { text: '高级设置' });

    new Setting(containerEl)
      .setName('最大并发上传数')
      .setDesc('同时上传的最大文件数（1-10），过高可能触发飞书速率限制')
      .addSlider((slider) => {
        slider.setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxConcurrentUploads)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.plugin.settings.maxConcurrentUploads = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('API 请求重试次数')
      .setDesc('网络请求失败时的最大重试次数')
      .addSlider((slider) => {
        slider.setLimits(0, 5, 1)
          .setValue(this.plugin.settings.maxRetryAttempts)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.plugin.settings.maxRetryAttempts = value;
            await this.plugin.saveSettings();
          });
      });

    // 分隔线
    containerEl.createEl('hr');

    // 用户授权区域
    containerEl.createEl('h3', { text: '飞书用户授权' });

    // 检查用户授权状态
    const isUserAuthorized = this.plugin.authManager?.isUserAuthorized() ?? false;
    
    if (isUserAuthorized) {
      // 显示已授权状态
      new Setting(containerEl)
        .setName('用户已授权')
        .setDesc('已绑定飞书用户，可以访问个人云空间')
        .addButton((button) => {
          button.setButtonText('解除授权')
            .setWarning()
            .onClick(async () => {
              this.plugin.authManager?.clearUserToken();
              new Notice('已解除用户授权');
              this.display();
            });
        });
    } else {
      // 显示授权说明
      containerEl.createEl('p', {
        text: '要访问个人云空间，需要进行用户授权。授权后插件将获得访问你个人云空间的权限。',
        cls: 'feisync-hint'
      });

      containerEl.createEl('p', {
        text: '提示：请先在飞书开放平台 → 应用功能 → 网页应用 中，添加回调地址 http://localhost:9527/callback',
        cls: 'feisync-hint'
      });

      // 授权按钮
      new Setting(containerEl)
        .setName('进行用户授权')
        .setDesc('点击后将在浏览器中打开授权页面，授权完成后会自动获取令牌')
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
            .onClick(async () => {
              if (!this.plugin.authManager) {
                new Notice('认证管理器未初始化');
                return;
              }

              if (isAuthorizing) {
                // 用户主动取消
                this.plugin.authManager.abortLocalCallbackServer();
                return;
              }

              setCancelState();

              try {
                // 先启动本地回调服务器
                const codePromise = this.plugin.authManager.startLocalCallbackServer(9527);

                // 生成 OAuth URL（使用本地回调地址）并打开浏览器
                const oauthUrl = this.plugin.authManager.generateOAuthUrl('http://localhost:9527/callback');
                window.open(oauthUrl);
                new Notice('请在浏览器中完成飞书授权...');

                // 等待本地服务器自动捕获 code
                const code = await codePromise;
                new Notice('已获取授权码，正在交换令牌...');

                // 自动用 code 换取 token
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
            });
        });
    }

    // 分隔线
    containerEl.createEl('hr');

    // 手动同步按钮
    new Setting(containerEl)
      .setName('手动同步')
      .setDesc('立即执行一次同步操作')
      .addButton((button) => {
        button.setButtonText('立即同步')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('同步中...');
            try {
              await this.plugin.sync();
              new Notice('同步完成！');
            } catch (error) {
              new Notice('同步失败：' + (error as Error).message);
            } finally {
              button.setDisabled(false);
              button.setButtonText('立即同步');
            }
          });
      });

    // 从飞书下载
    new Setting(containerEl)
      .setName('从飞书下载')
      .setDesc('将飞书云端的文件下载到本地（覆盖本地同名文件）')
      .addButton((button) => {
        button.setButtonText('从飞书下载')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('下载中...');
            try {
              await this.plugin.downloadFromFeishu();
              new Notice('下载完成！');
            } catch (error) {
              new Notice('下载失败：' + (error as Error).message);
            } finally {
              button.setDisabled(false);
              button.setButtonText('从飞书下载');
            }
          });
      });

    // 同步日志
    containerEl.createEl('h3', { text: '同步日志与记录' });

    new Setting(containerEl)
      .setName('查看同步日志')
      .setDesc('查看最近的同步操作记录')
      .addButton((button) => {
        button.setButtonText('查看日志')
          .onClick(() => {
            new SyncLogModal(this.app, this.plugin).open();
          });
      })
      .addButton((button) => {
        button.setButtonText('清除日志')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.syncLog = [];
            await this.plugin.saveSettings();
            new Notice('同步日志已清除');
          });
      });

    new Setting(containerEl)
      .setName('清除同步记录')
      .setDesc('清除所有文件的同步记录，下次同步时将重新上传所有文件（适用于云端文件被手动删除后需要重新上传的情况）')
      .addButton((button) => {
        const recordCount = Object.keys(this.plugin.settings.syncRecords || {}).length;
        button.setButtonText(`清除同步记录 (${recordCount} 条)`)
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.syncRecords = {};
            await this.plugin.saveSettings();
            new Notice('同步记录已清除，下次同步将重新上传所有文件');
            this.display(); // 刷新显示
          });
      });

    // 提示信息
    containerEl.createEl('p', {
      text: '提示：请确保在飞书开放平台为应用开启了 "云空间" 权限（drive:drive），用于上传文件到飞书云盘。',
      cls: 'feisync-hint'
    });
  }

}
