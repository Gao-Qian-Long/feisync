# Obsidian-Flybook 插件设计文档

## 设置界面设计

### 设置字段

| 字段名 | 类型 | 描述 | 默认值 |
|--------|------|------|--------|
| `appId` | 文本输入 | 飞书开放平台应用的 App ID | 空 |
| `appSecret` | 文本输入（密码类型） | 飞书开放平台应用的 App Secret | 空 |
| `localFolderPath` | 文本输入 | 本地需要同步的文件夹路径（相对于 Obsidian 仓库根目录） | 空 |
| `feishuRootFolderToken` | 文本输入 | 飞书 Drive 中目标根文件夹的 token（可选）。如果为空，插件将在用户的云空间根目录下创建名为 "ObsidianSync" 的文件夹。 | 空 |
| `autoSyncOnChange` | 开关 | 是否在本地文件变化时自动同步 | `false` |
| `syncInterval` | 数字输入 | 自动同步间隔（分钟），仅当 `autoSyncOnChange` 开启时有效 | `5` |

### 设置界面布局

1. **凭证配置区域**
   - App ID
   - App Secret
   - 说明文字：如何获取这些凭证的链接（引导用户到飞书开放平台）

2. **文件夹配置区域**
   - 本地文件夹路径（支持浏览按钮？Obsidian 暂无原生文件夹选择器，可考虑使用文本输入 + 路径验证）
   - 飞书目标文件夹 token（高级设置）

3. **同步行为区域**
   - 自动同步开关
   - 同步间隔

4. **操作按钮**
   - “测试连接”按钮：验证凭证有效性并获取 tenant_access_token
   - “手动同步”按钮：立即执行一次同步

### 设置存储

使用 Obsidian 插件的 `loadData` / `saveData` API 存储设置对象。

```typescript
interface FlybookPluginSettings {
  appId: string;
  appSecret: string;
  localFolderPath: string;
  feishuRootFolderToken: string;
  autoSyncOnChange: boolean;
  syncInterval: number;
}
```

### 设置选项卡示例代码

```typescript
import { App, PluginSettingTab, Setting } from 'obsidian';
import FlybookPlugin from './main';

export class FlybookSettingTab extends PluginSettingTab {
  plugin: FlybookPlugin;

  constructor(app: App, plugin: FlybookPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 凭证配置
    new Setting(containerEl)
      .setName('飞书 App ID')
      .setDesc('在飞书开放平台创建应用后获得的 App ID')
      .addText(text => text
        .setPlaceholder('cli_xxxxxxxx')
        .setValue(this.plugin.settings.appId)
        .onChange(async (value) => {
          this.plugin.settings.appId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('飞书 App Secret')
      .setDesc('对应的 App Secret，请妥善保管')
      .addText(text => text
        .setPlaceholder('xxxxxxxxxxxxxxxx')
        .setValue(this.plugin.settings.appSecret)
        .onChange(async (value) => {
          this.plugin.settings.appSecret = value;
          await this.plugin.saveSettings();
        }));

    // 本地文件夹路径
    new Setting(containerEl)
      .setName('本地同步文件夹')
      .setDesc('相对于仓库根目录的路径，例如 "Notes"')
      .addText(text => text
        .setPlaceholder('Notes')
        .setValue(this.plugin.settings.localFolderPath)
        .onChange(async (value) => {
          this.plugin.settings.localFolderPath = value;
          await this.plugin.saveSettings();
        }));

    // 飞书文件夹 token（可选）
    new Setting(containerEl)
      .setName('飞书目标文件夹 Token')
      .setDesc('可选，如果不填则使用默认文件夹')
      .addText(text => text
        .setPlaceholder('fldcnxxxxxxxx')
        .setValue(this.plugin.settings.feishuRootFolderToken)
        .onChange(async (value) => {
          this.plugin.settings.feishuRootFolderToken = value;
          await this.plugin.saveSettings();
        }));

    // 自动同步开关
    new Setting(containerEl)
      .setName('自动同步')
      .setDesc('监听本地文件变化并自动上传')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSyncOnChange)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncOnChange = value;
          await this.plugin.saveSettings();
          // 动态启停文件监听器
          this.plugin.toggleFileWatcher(value);
        }));

    // 同步间隔（仅当自动同步开启时显示）
    if (this.plugin.settings.autoSyncOnChange) {
      new Setting(containerEl)
        .setName('同步间隔（分钟）')
        .setDesc('两次自动同步的最小时间间隔')
        .addText(text => text
          .setPlaceholder('5')
          .setValue(this.plugin.settings.syncInterval.toString())
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.syncInterval = num;
              await this.plugin.saveSettings();
            }
          }));
    }

    // 测试连接按钮
    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('验证凭证并获取飞书访问令牌')
      .addButton(button => button
        .setButtonText('测试')
        .onClick(async () => {
          const success = await this.plugin.testConnection();
          if (success) {
            new Notice('连接成功，令牌有效');
          } else {
            new Notice('连接失败，请检查凭证');
          }
        }));

    // 手动同步按钮
    new Setting(containerEl)
      .setName('手动同步')
      .setDesc('立即执行一次同步')
      .addButton(button => button
        .setButtonText('同步')
        .onClick(async () => {
          await this.plugin.sync();
        }));
  }
}
```

## 下一步

1. 实现 `FlybookPlugin` 类，包含 `settings` 属性和 `loadSettings` / `saveSettings` 方法。
2. 实现 `testConnection` 方法，调用飞书认证 API。
3. 实现 `sync` 方法，遍历本地文件夹并上传文件。
4. 实现文件变化监听器（使用 `app.vault.on('modify', ...)` 等事件）。

## 参考

- [Obsidian 设置界面文档](https://docs.obsidian.md/Plugins/User+interface/Settings)
- [飞书开放平台 API 文档](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all)