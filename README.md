# Obsidian Flybook

一个 Obsidian 插件，用于将本地笔记同步到飞书（Feishu/Lark）Drive。

## 功能

- **单向同步**：以本地文件为准，将 Obsidian 笔记同步到飞书 Drive。
- **指定文件夹同步**：只同步您选择的本地文件夹。
- **手动同步**：通过命令面板或 ribbon 图标手动触发同步。
- **自动同步**（可选）：监听文件变化，自动上传修改后的文件。

## 安装

### 前置要求

- Obsidian 0.15.0 或更高版本
- 一个飞书企业账号（自建应用需要企业版）

### 步骤

1. **创建飞书应用**
   - 访问 [飞书开放平台](https://open.feishu.cn/app) 并登录。
   - 创建一个企业自建应用。
   - 在“权限管理”中添加以下权限：
     - `drive:drive`（查看、编辑和管理云空间）
     - `drive:file`（查看、编辑和管理云空间文件）
   - 获取 **App ID** 和 **App Secret**。

2. **安装插件**
   - 将此仓库克隆到您的本地：
     ```bash
     git clone https://github.com/your-username/obsidian-flybook.git
     ```
   - 将插件文件夹复制到 Obsidian 插件目录：
     ```bash
     cp -r obsidian-flybook <vault>/.obsidian/plugins/
     ```
   - 或者，如果您会使用 GitHub Actions 发布，可以直接从发布页面下载 `main.js`、`manifest.json` 等文件。

3. **启用插件**
   - 重启 Obsidian。
   - 进入“设置” → “社区插件”，找到 “Obsidian Flybook” 并启用。

4. **配置插件**
   - 进入“设置” → “Obsidian Flybook”。
   - 填入您的飞书 App ID 和 App Secret。
   - 选择要同步的本地文件夹路径（相对于仓库根目录）。
   - （可选）填入飞书目标文件夹的 token。
   - 点击“测试连接”验证凭证。

## 使用

### 手动同步

- **命令面板**：按 `Ctrl/Cmd + P`，输入 “Flybook: Sync now”，回车执行。
- **Ribbon 图标**：点击左侧的云朵图标，选择“立即同步”。

### 自动同步

- 在设置中开启“自动同步”选项。
- 设置同步间隔（分钟），防止频繁同步。
- 开启后，任何在监控文件夹内的文件修改都会在指定间隔后自动上传。

### 查看日志

- 打开 Obsidian 开发者工具（`Ctrl+Shift+I`）查看控制台日志。

## 开发

### 构建

```bash
npm install
npm run build
```

### 监听模式（开发）

```bash
npm run dev
```

### 项目结构

- `main.ts` - 插件主入口
- `settings.ts` - 设置界面
- `feishuAuth.ts` - 飞书认证模块
- `feishuApi.ts` - 飞书 Drive API 封装
- `syncEngine.ts` - 同步引擎
- `fileWatcher.ts` - 本地文件监控

## 注意事项

- **文件大小限制**：目前飞书 API 限制单个文件 ≤20MB。
- **单向同步**：本插件以本地文件为准，不会将飞书的修改拉取到本地。
- **权限要求**：确保飞书应用已申请相关权限并已发布。

## License

MIT