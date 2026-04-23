/**
 * 飞书目录浏览器模块
 * 提供在设置界面中浏览飞书云空间文件夹树的弹窗组件
 */

import { App, Modal, Setting } from 'obsidian';
import { FeishuApiClient, FeishuFileMeta } from './feishuApi';
import { createLogger } from './logger';

const log = createLogger('FeishuFolderBrowser');

/**
 * 格式化文件大小
 */
function formatFileSize(bytes?: number): string {
	if (bytes === undefined || bytes === null) return '';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 根据文件类型返回图标
 */
function getFileTypeIcon(type: string): string {
	const iconMap: Record<string, string> = {
		folder: '📁',
		file: '📄',
		docx: '📝',
		doc: '📝',
		sheet: '📊',
		bitable: '📋',
		slides: '📽️',
	};
	return iconMap[type] || '📄';
}

/**
 * 格式化时间戳
 */
function formatTime(timestamp?: number): string {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	return date.toLocaleString('zh-CN', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

/**
 * 飞书目录浏览器弹窗
 * 以列表形式展示飞书云空间中的文件夹和文件，逐级展开，供用户选择目标文件夹
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
		void this.renderContent();
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

		// 工具栏：刷新 + 查看文件树
		new Setting(contentEl)
			.setName('工具栏')
			.setDesc('刷新目录或查看完整文件树')
			.addButton(btn => {
				btn.setButtonText('刷新')
					.onClick(() => this.refreshContents());
			})
			.addButton(btn => {
				btn.setButtonText('查看文件树')
					.onClick(() => {
						const path = this.currentPath.length > 0
							? this.currentPath.map(p => p.name).join('/')
							: '根目录';
						new FeishuFileTreeModal(
							this.app,
							this.apiClient,
							this.currentFolderToken,
							path
						).open();
					});
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

		// 内容列表容器（文件夹 + 文件）
		const listContainer = contentEl.createDiv({ cls: 'feisync-folder-browser-list' });

		await this.loadAndRenderContents(listContainer);
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
			void this.renderContent();
		});

		// 子目录
		for (let i = 0; i < this.currentPath.length; i++) {
			breadcrumb.createSpan({ text: ' / ', cls: 'feisync-breadcrumb-separator' });

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
				void this.renderContent();
			});
		}
	}

	/**
	 * 加载并渲染当前目录的内容（文件夹 + 文件）
	 */
	private async loadAndRenderContents(container: HTMLElement): Promise<void> {
		if (this.isLoading) return;
		this.isLoading = true;

		// 显示加载状态
		container.empty();
		container.createDiv({ text: '加载中...', cls: 'feisync-loading' });

		try {
			const files = await this.apiClient.listFolderContents(this.currentFolderToken);
			const folders = files.filter(f => f.type === 'folder');
			const nonFolders = files.filter(f => f.type !== 'folder');

			container.empty();

			// --- 文件夹列表 ---
			if (folders.length === 0 && nonFolders.length === 0) {
				container.createDiv({ text: '此目录下没有内容', cls: 'feisync-empty' });
				return;
			}

			if (folders.length > 0) {
				container.createDiv({
					text: `📂 子文件夹 (${folders.length})`,
					cls: 'feisync-file-list-header',
				});

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
						void this.renderContent();
					});
				}
			}

			// --- 文件列表 ---
			if (nonFolders.length > 0) {
				if (folders.length > 0) {
					// 分隔线
				const divider = container.createDiv({ cls: 'feisync-file-list-header feisync-divider' });
				divider.setText(`📄 文件 (${nonFolders.length})`);
				} else {
					container.createDiv({
						text: `📄 文件 (${nonFolders.length})`,
						cls: 'feisync-file-list-header',
					});
				}

				for (const file of nonFolders) {
					const item = container.createDiv({
						cls: 'feisync-file-list-item',
					});

					const icon = getFileTypeIcon(file.type);
					item.createSpan({ text: `${icon} ${file.name}` });

					// 右侧元信息
					const metaEl = item.createDiv({ cls: 'feisync-file-meta' });
					const metaParts: string[] = [];
					if (file.size !== undefined) metaParts.push(formatFileSize(file.size));
					if (file.modifiedTime) metaParts.push(formatTime(file.modifiedTime));
					if (metaParts.length > 0) {
						metaEl.createSpan({ text: metaParts.join(' · ') });
					}

					// Token
					metaEl.createSpan({
						text: file.token.substring(0, 8),
						cls: 'feisync-file-token',
					});
				}
			}
		} catch (err) {
			container.empty();
			container.createDiv({ text: `加载失败: ${(err as Error).message}`, cls: 'feisync-error-text' });
			log.error('加载飞书目录内容失败:', err);
		} finally {
			this.isLoading = false;
		}
	}

	/**
	 * 刷新内容（不重置导航状态）
	 */
	private async refreshContents(): Promise<void> {
		const listContainer = this.contentEl.querySelector('.feisync-folder-browser-list') as HTMLElement;
		if (listContainer) {
			await this.loadAndRenderContents(listContainer);
		}
	}
}

// ==================== 文件树弹窗 ====================

interface TreeNode {
	meta: FeishuFileMeta;
	children: TreeNode[];
	expanded: boolean;
}

/**
 * 飞书文件树弹窗
 * 递归展示从指定目录开始的所有文件和文件夹，以树形结构呈现
 */
export class FeishuFileTreeModal extends Modal {
	private apiClient: FeishuApiClient;
	private rootToken: string;
	private rootPath: string;
	private treeData: TreeNode[] = [];
	private isLoading = false;
	private abortFlag = { aborted: false };
	private maxDepth = 5;
	private contentArea!: HTMLElement;
	private statusEl!: HTMLElement;

	constructor(app: App, apiClient: FeishuApiClient, rootToken: string, rootPath: string) {
		super(app);
		this.apiClient = apiClient;
		this.rootToken = rootToken;
		this.rootPath = rootPath || '根目录';
	}

	onOpen(): void {
		this.titleEl.setText(`飞书文件树 - ${this.rootPath}`);
		void this.renderContent();
		void this.loadTree();
	}

	onClose(): void {
		this.abortFlag.aborted = true;
		this.contentEl.empty();
	}

	private renderContent(): void {
		const { contentEl } = this;
		contentEl.empty();

		// 工具栏
		new Setting(contentEl)
			.setName('文件树')
			.setDesc('点击 ▶/▼ 可展开或折叠文件夹')
			.addButton(btn => {
				btn.setButtonText('刷新')
					.onClick(() => void this.loadTree());
			})
			.addButton(btn => {
				btn.setButtonText('全部展开')
					.onClick(() => this.toggleAll(true));
			})
			.addButton(btn => {
				btn.setButtonText('全部折叠')
					.onClick(() => this.toggleAll(false));
			});

		// 状态栏
		this.statusEl = contentEl.createDiv({ cls: 'feisync-hint-block' });

		// 文件树容器
		this.contentArea = contentEl.createDiv({ cls: 'feisync-file-tree' });
	}

	private async loadTree(): Promise<void> {
		if (this.isLoading) return;
		this.isLoading = true;
		this.abortFlag.aborted = false;
		this.contentArea.empty();
		this.statusEl.setText('正在加载文件树...');
		this.contentArea.createDiv({ text: '加载中...', cls: 'feisync-loading' });

		try {
			this.treeData = await this.buildTree(this.rootToken, 0);
			if (this.abortFlag.aborted) return;
			this.renderTree();
			const totalFiles = this.countFiles(this.treeData);
			const totalFolders = this.countFolders(this.treeData);
			this.statusEl.setText(`共 ${totalFolders} 个文件夹，${totalFiles} 个文件（最大递归深度：${this.maxDepth} 层）`);
		} catch (err) {
			if (this.abortFlag.aborted) return;
			this.contentArea.empty();
			this.contentArea.createDiv({ text: `加载失败: ${(err as Error).message}`, cls: 'feisync-error-text' });
			this.statusEl.setText('加载失败');
			log.error('加载文件树失败:', err);
		} finally {
			this.isLoading = false;
		}
	}

	private async buildTree(folderToken: string, depth: number): Promise<TreeNode[]> {
		if (this.abortFlag.aborted || depth > this.maxDepth) return [];

		const files = await this.apiClient.listFolderContents(folderToken);
		// 文件夹排在前面
		files.sort((a, b) => {
			if (a.type === 'folder' && b.type !== 'folder') return -1;
			if (a.type !== 'folder' && b.type === 'folder') return 1;
			return a.name.localeCompare(b.name);
		});

		const nodes: TreeNode[] = [];

		for (const file of files) {
			const node: TreeNode = {
				meta: file,
				children: [],
				expanded: depth < 2, // 前两层默认展开
			};

			if (file.type === 'folder' && depth < this.maxDepth) {
				try {
					node.children = await this.buildTree(file.token, depth + 1);
				} catch (err) {
					log.warn(`加载子文件夹 ${file.name} 失败:`, err);
				}
			}

			nodes.push(node);
		}

		return nodes;
	}

	private renderTree(): void {
		this.contentArea.empty();
		if (this.treeData.length === 0) {
			this.contentArea.createDiv({ text: '此目录下没有文件', cls: 'feisync-empty' });
			return;
		}

		for (const node of this.treeData) {
			this.renderNode(node, this.contentArea, 0);
		}
	}

	private renderNode(node: TreeNode, container: HTMLElement, level: number): void {
	const item = container.createDiv({ cls: `feisync-file-tree-item feisync-tree-level-${Math.min(level, 10)}` });

		const isFolder = node.meta.type === 'folder';
		const hasChildren = isFolder && node.children.length > 0;

		// 展开/折叠指示器
		if (hasChildren) {
			const toggle = item.createSpan({
				text: node.expanded ? '▼' : '▶',
				cls: 'feisync-tree-toggle',
			});
			toggle.addEventListener('click', () => {
				node.expanded = !node.expanded;
				this.renderTree();
			});
		} else {
			item.createSpan({ text: ' ', cls: 'feisync-tree-toggle-placeholder' });
		}

		// 图标和名称
		const icon = getFileTypeIcon(node.meta.type);
		item.createSpan({ text: `${icon} ${node.meta.name}`, cls: 'feisync-tree-name' });

		// 元信息
		const metaParts: string[] = [];
		if (node.meta.size !== undefined) metaParts.push(formatFileSize(node.meta.size));
		if (node.meta.modifiedTime) metaParts.push(formatTime(node.meta.modifiedTime));
		if (metaParts.length > 0) {
			item.createSpan({ text: `(${metaParts.join(', ')})`, cls: 'feisync-tree-meta' });
		}

		// Token
		item.createSpan({
			text: node.meta.token.substring(0, 8),
			cls: 'feisync-tree-token',
		});

		// 子节点容器
		if (isFolder && node.expanded) {
			const childrenContainer = container.createDiv({ cls: 'feisync-file-tree-children' });
			for (const child of node.children) {
				this.renderNode(child, childrenContainer, level + 1);
			}
		}
	}

	private toggleAll(expanded: boolean): void {
		const walk = (nodes: TreeNode[]) => {
			for (const node of nodes) {
				node.expanded = expanded;
				walk(node.children);
			}
		};
		walk(this.treeData);
		this.renderTree();
	}

	private countFiles(nodes: TreeNode[]): number {
		let count = 0;
		for (const node of nodes) {
			if (node.meta.type !== 'folder') count++;
			count += this.countFiles(node.children);
		}
		return count;
	}

	private countFolders(nodes: TreeNode[]): number {
		let count = 0;
		for (const node of nodes) {
			if (node.meta.type === 'folder') count++;
			count += this.countFolders(node.children);
		}
		return count;
	}
}
