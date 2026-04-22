/**
 * 飞书目录浏览器模块
 * 提供在设置界面中浏览飞书云空间文件夹树的弹窗组件
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import { FeishuApiClient, FeishuFileMeta } from './feishuApi';
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
		listContainer.style.maxHeight = '400px';
		listContainer.style.overflowY = 'auto';
		listContainer.style.border = '1px solid var(--background-modifier-border)';
		listContainer.style.borderRadius = '4px';

		await this.loadAndRenderFolders(listContainer);
	}

	/**
	 * 渲染面包屑导航
	 */
	private renderBreadcrumb(container: HTMLElement): void {
		const breadcrumb = container.createDiv({ cls: 'feisync-breadcrumb' });
		breadcrumb.style.padding = '8px 0';
		breadcrumb.style.display = 'flex';
		breadcrumb.style.flexWrap = 'wrap';
		breadcrumb.style.gap = '4px';
		breadcrumb.style.alignItems = 'center';
		breadcrumb.style.fontSize = '13px';

		// 根目录
		const rootItem = breadcrumb.createSpan({ text: '🏠 根目录' });
		rootItem.style.cursor = 'pointer';
		rootItem.style.padding = '2px 6px';
		rootItem.style.borderRadius = '3px';
		if (!this.currentFolderToken) {
			rootItem.style.fontWeight = 'bold';
			rootItem.style.backgroundColor = 'var(--background-modifier-hover)';
		}
		rootItem.addEventListener('click', () => {
			this.currentFolderToken = '';
			this.currentPath = [];
			this.renderContent();
		});

		// 子目录
		for (let i = 0; i < this.currentPath.length; i++) {
			const separator = breadcrumb.createSpan({ text: ' / ' });
			separator.style.color = 'var(--text-muted)';

			const item = this.currentPath[i];
			const isLast = i === this.currentPath.length - 1;
			const span = breadcrumb.createSpan({ text: item.name });
			span.style.cursor = 'pointer';
			span.style.padding = '2px 6px';
			span.style.borderRadius = '3px';

			if (isLast) {
				span.style.fontWeight = 'bold';
				span.style.backgroundColor = 'var(--background-modifier-hover)';
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
		const loadingEl = container.createDiv({ text: '加载中...' });
		loadingEl.style.padding = '20px';
		loadingEl.style.textAlign = 'center';
		loadingEl.style.color = 'var(--text-muted)';

		try {
			const files = await this.apiClient.listFolderContents(this.currentFolderToken);
			const folders = files.filter(f => f.type === 'folder');

			container.empty();

			if (folders.length === 0) {
				const emptyEl = container.createDiv({ text: '此目录下没有子文件夹' });
				emptyEl.style.padding = '20px';
				emptyEl.style.textAlign = 'center';
				emptyEl.style.color = 'var(--text-muted)';
			}

			for (const folder of folders) {
				const item = container.createDiv({
					cls: 'feisync-folder-browser-item',
				});
				item.style.padding = '8px 12px';
				item.style.cursor = 'pointer';
				item.style.borderBottom = '1px solid var(--background-modifier-border)';
				item.style.display = 'flex';
				item.style.justifyContent = 'space-between';
				item.style.alignItems = 'center';

				const nameSpan = item.createSpan({ text: `📁 ${folder.name}` });

				const enterBtn = item.createSpan({ text: '进入 →' });
				enterBtn.style.color = 'var(--text-accent)';
				enterBtn.style.fontSize = '12px';

				item.addEventListener('mouseenter', () => {
					item.style.backgroundColor = 'var(--background-modifier-hover)';
				});
				item.addEventListener('mouseleave', () => {
					item.style.backgroundColor = '';
				});

				item.addEventListener('click', () => {
					this.currentPath.push({ name: folder.name, token: folder.token });
					this.currentFolderToken = folder.token;
					log.debug(`进入文件夹: ${folder.name} (token: ${folder.token})`);
					this.renderContent();
				});
			}
		} catch (err) {
			container.empty();
			const errorEl = container.createDiv({ text: `加载失败: ${(err as Error).message}` });
			errorEl.style.padding = '20px';
			errorEl.style.color = 'var(--text-error)';
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
