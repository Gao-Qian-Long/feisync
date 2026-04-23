/**
 * 飞书目录浏览器模块
 * 提供在设置界面中浏览飞书云空间文件夹树的弹窗组件
 */

import { App, Modal, Setting } from 'obsidian';
import { FeishuApiClient } from './feishuApi';
import { createLogger } from './logger';

const log = createLogger('FeishuFolderBrowser');

/**
 * 飞书目录浏览器弹窗
 * 以列表形式展示飞书云空间中的文件夹，逐级展开，供用户选择目标文件夹
 */
export class FeishuFolderBrowserModal extends Modal {
	private apiClient: FeishuApiClient;
	private onSelect: (folderToken: string, folderName: string) => void;
	private currentFolderToken: string;
	private currentPath: { name: string; token: string }[] = []; // 面包屑导航
	private isLoading: boolean = false;

	/**
	 * @param app Obsidian App
	 * @param apiClient 飞书 API 客户端
	 * @param onSelect 选择文件夹后的回调
	 * @param rootFolderToken 起始文件夹 token（空字符串表示根目录）
	 */
	constructor(
		app: App,
		apiClient: FeishuApiClient,
		onSelect: (folderToken: string, folderName: string) => void,
		rootFolderToken: string = ''
	) {
		super(app);
		this.apiClient = apiClient;
		this.onSelect = onSelect;
		this.currentFolderToken = rootFolderToken;
	}

	onOpen(): void {
		this.titleEl.setText('选择飞书文件夹');
		this.renderContent();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * 渲染主内容区
	 */
	private async renderContent(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		// 面包屑导航
		this.renderBreadcrumb(contentEl);

		// 刷新按钮
		new Setting(contentEl)
			.setName('刷新目录')
			.addButton(btn => {
				btn.setButtonText('刷新')
					.onClick(() => this.renderFileList());
			});

		// 选择当前文件夹按钮
		if (this.currentFolderToken) {
			new Setting(contentEl)
				.setName('选择此文件夹')
				.setDesc(`Token: ${this.currentFolderToken.substring(0, 12)}...`)
				.addButton(btn => {
					btn.setButtonText('选择')
						.setCta()
						.onClick(() => {
							const name = this.currentPath.length > 0
								? this.currentPath[this.currentPath.length - 1].name
								: '根目录';
							this.onSelect(this.currentFolderToken, name);
							this.close();
						});
				});
		}

		// 文件列表容器
		const listContainer = contentEl.createDiv({ cls: 'feisync-folder-browser-list' });

		await this.loadAndRenderFolders(listContainer);
	}

	/**
	 * 渲染面包屑导航
	 */
	private renderBreadcrumb(container: HTMLElement): void {
		const breadcrumb = container.createDiv({ cls: 'feisync-breadcrumb' });

		// 根目录
		const rootItem = breadcrumb.createSpan({ text: '🏠 根目录', cls: 'feisync-breadcrumb-item' });
		if (!this.currentFolderToken) {
			rootItem.addClass('feisync-breadcrumb-item-active');
		}
		rootItem.addEventListener('click', () => {
			this.currentFolderToken = '';
			this.currentPath = [];
			this.renderContent();
		});

		// 子目录
		for (let i = 0; i < this.currentPath.length; i++) {
			const separator = breadcrumb.createSpan({ text: ' / ', cls: 'feisync-breadcrumb-separator' });

			const item = this.currentPath[i];
			const isLast = i === this.currentPath.length - 1;
			const span = breadcrumb.createSpan({ text: item.name, cls: 'feisync-breadcrumb-item' });

			if (isLast) {
				span.addClass('feisync-breadcrumb-item-active');
			}

			span.addEventListener('click', () => {
				// 导航到该层级
				this.currentFolderToken = item.token;
				this.currentPath = this.currentPath.slice(0, i + 1);
				this.renderContent();
			});
		}
	}

	/**
	 * 加载并渲染文件夹列表
	 */
	private async loadAndRenderFolders(container: HTMLElement): Promise<void> {
		if (this.isLoading) return;
		this.isLoading = true;

		// 显示加载状态
		container.empty();
		container.createDiv({ text: '加载中...', cls: 'feisync-loading' });

		try {
			const files = await this.apiClient.listFolderContents(this.currentFolderToken);
			const folders = files.filter(f => f.type === 'folder');

			container.empty();

			if (folders.length === 0) {
				container.createDiv({ text: '此目录下没有子文件夹', cls: 'feisync-empty' });
			}

			for (const folder of folders) {
				const item = container.createDiv({
					cls: 'feisync-folder-browser-item',
				});

				item.createSpan({ text: `📁 ${folder.name}` });

				item.createSpan({ text: '进入 →', cls: 'feisync-enter-btn' });

				item.addEventListener('click', () => {
					this.currentPath.push({ name: folder.name, token: folder.token });
					this.currentFolderToken = folder.token;
					log.debug(`进入文件夹: ${folder.name} (token: ${folder.token})`);
					this.renderContent();
				});
			}
		} catch (err) {
			container.empty();
			container.createDiv({ text: `加载失败: ${(err as Error).message}`, cls: 'feisync-error-text' });
			log.error('加载飞书文件夹列表失败:', err);
		} finally {
			this.isLoading = false;
		}
	}

	/**
	 * 刷新文件列表（不重置导航状态）
	 */
	private async renderFileList(): Promise<void> {
		const listContainer = this.contentEl.querySelector('.feisync-folder-browser-list') as HTMLElement;
		if (listContainer) {
			await this.loadAndRenderFolders(listContainer);
		}
	}
}
