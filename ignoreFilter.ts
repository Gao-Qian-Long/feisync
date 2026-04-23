/**
 * 同步忽略规则模块
 * 实现 feisync-ignore.md 文件解析和匹配逻辑
 * 语法兼容 .gitignore 规范子集
 *
 * 支持的语法：
 *   - 空行和 # 开头的行为注释，忽略
 *   - dirname/   忽略整个目录
 *   - *.ext      忽略匹配扩展名的文件
 *   - 双星号/pattern 任意深度匹配
 *   - !pattern   取消忽略（即使之前被忽略）
 *   - pattern    精确匹配文件或目录名
 */

import { Vault, TFile } from 'obsidian';
import { createLogger } from './logger';

const log = createLogger('IgnoreFilter');

/**
 * 忽略规则文件名（Markdown 格式，Obsidian 可直接打开编辑）
 * 使用 .md 后缀确保 Obsidian 文件列表可见
 */
export const FEISYNC_IGNORE_FILE = 'feisync-ignore.md';

/** 向后兼容的旧文件名 */
export const LEGACY_IGNORE_FILE = '.feisyncignore';

/**
 * 单条忽略规则
 */
interface IgnoreRule {
	/** 原始模式字符串 */
	pattern: string;
	/** 是否为否定规则（! 开头） */
	negated: boolean;
	/** 是否只匹配目录（以 / 结尾） */
	directoryOnly: boolean;
	/** 解析后的正则表达式 */
	regex: RegExp;
}

/**
 * 忽略规则过滤器
 * 解析 .feisyncignore 内容，提供文件/目录匹配功能
 */
export class IgnoreFilter {
	private rules: IgnoreRule[] = [];
	private rawContent: string = '';

	/**
	 * 从 feisync-ignore.md 文件内容解析规则
	 * 兼容 Markdown 格式，自动跳过 Markdown 语法元素
	 * @param content 文件内容
	 */
	loadFromContent(content: string): void {
		this.rawContent = content;
		this.rules = [];
		const lines = content.split(/\r?\n/);

		for (let i = 0; i < lines.length; i++) {
			const rawLine = lines[i];
			// 去除行尾空格（但保留行首空格，行首空格有意义）
			const line = rawLine.trimEnd();

			// 跳过空行
			if (!line) {
				continue;
			}

			// 跳过 HTML/Markdown 注释
			if (/^<!--/.test(line) || /-->$/.test(line)) {
				continue;
			}

			// 跳过 Markdown 标题（# 后面有空格）
			if (/^#\s+/.test(line)) {
				continue;
			}

			// 跳过 Markdown 分隔线（---、***、___）
			if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
				continue;
			}

			// 跳过 Markdown 表格行（以 | 开头或结尾）
			if (/^\|.+\|$/.test(line)) {
				continue;
			}

			// 跳过 Markdown 列表项（- 、* 、+ 、数字. 开头）
			if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
				continue;
			}

			// 跳过纯注释行（# 开头）
			if (line.startsWith('#')) {
				continue;
			}

			// 跳过 Markdown 代码块标记（```）
			if (/^```/.test(line)) {
				continue;
			}

			// 注意：不要在此处过滤"纯文字"，因为像 .obsidian、.DS_Store、temp 这样的
			// 规则完全有效，过度过滤会导致用户规则被静默忽略

			try {
				const rule = this.parseRule(line);
				if (rule) {
					this.rules.push(rule);
					log.debug(`规则 #${i + 1}: "${line}" → regex=${rule.regex}, negated=${rule.negated}, dirOnly=${rule.directoryOnly}`);
				}
			} catch (err) {
				log.warn(`忽略规则解析失败 (行 ${i + 1}: "${line}"):`, err);
			}
		}

		log.info(`已加载 ${this.rules.length} 条忽略规则`);
	}

	/**
	 * 获取当前所有规则（供设置界面展示）
	 */
	getRules(): { pattern: string; negated: boolean; directoryOnly: boolean }[] {
		return this.rules.map(r => ({
			pattern: r.pattern,
			negated: r.negated,
			directoryOnly: r.directoryOnly,
		}));
	}

	/**
	 * 判断文件是否应被忽略
	 * @param filePath 相对于 Vault 根目录的文件路径（如 "Notes/daily/2024.md"）
	 * @param isDirectory 是否为目录
	 * @returns true 表示应忽略，false 表示不忽略
	 */
	shouldIgnore(filePath: string, isDirectory: boolean = false): boolean {
		if (this.rules.length === 0) {
			return false;
		}

		// 标准化路径：统一用 / 分隔，去除开头的 /
		const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\//, '');
		const pathParts = normalizedPath.split('/');

		let ignored = false;

		for (const rule of this.rules) {
			// 目录专属规则，如果目标是文件则跳过
			if (rule.directoryOnly && !isDirectory) {
				continue;
			}

			// 匹配完整路径
			const fullPathMatch = rule.regex.test(normalizedPath);

			// 匹配路径中的某一段（用于 **/pattern 模式）
			let segmentMatch = false;
			if (!fullPathMatch) {
				for (let i = 0; i < pathParts.length; i++) {
					const segment = pathParts.slice(i).join('/');
					if (rule.regex.test(segment)) {
						segmentMatch = true;
						break;
					}
				}
			}

			if (fullPathMatch || segmentMatch) {
				if (rule.negated) {
					// 否定规则：取消忽略
					ignored = false;
					log.debug(`否定规则 "!${rule.pattern}" 匹配 ${filePath}，取消忽略`);
				} else {
					ignored = true;
					log.debug(`规则 "${rule.pattern}" 匹配 ${filePath}，标记忽略`);
				}
			}
		}

		return ignored;
	}

	/**
	 * 判断文件夹是否应被忽略（递归，如果文件夹被忽略，其下所有内容也被忽略）
	 * @param folderPath 相对于 Vault 根目录的文件夹路径
	 * @returns true 表示应忽略
	 */
	shouldIgnoreFolder(folderPath: string): boolean {
		return this.shouldIgnore(folderPath, true);
	}

	/**
	 * 解析单条规则
	 */
	private parseRule(line: string): IgnoreRule | null {
		let pattern = line;
		let negated = false;
		let directoryOnly = false;

		// 处理否定规则
		if (pattern.startsWith('!')) {
			negated = true;
			pattern = pattern.substring(1);
		}

		// 处理目录专属规则
		if (pattern.endsWith('/')) {
			directoryOnly = true;
			pattern = pattern.substring(0, pattern.length - 1);
		}

		// 去除前导 / （Obsidian 路径不以 / 开头）
		if (pattern.startsWith('/')) {
			pattern = pattern.substring(1);
		}

		if (!pattern) {
			return null;
		}

		// 将 glob 模式转为正则
		const regex = this.globToRegex(pattern);

		return {
			pattern: line,
			negated,
			directoryOnly,
			regex,
		};
	}

	/**
	 * 将 glob 模式转换为正则表达式
	 * 支持的 glob 语法：
	 *   *     匹配任意非 / 字符
	 *   **    匹配任意字符（含 /）
	 *   ?     匹配单个非 / 字符
	 *   [abc] 字符类
	 */
	private globToRegex(pattern: string): RegExp {
		let regexStr = '';
		let i = 0;

		while (i < pattern.length) {
			const ch = pattern[i];

			if (ch === '*') {
				// 检查是否为 **
				if (i + 1 < pattern.length && pattern[i + 1] === '*') {
					// ** 匹配任意字符（含 /）
					regexStr += '.*';
					i += 2;
					// 跳过 ** 后的 /
					if (i < pattern.length && pattern[i] === '/') {
						regexStr += '/?';
						i++;
					}
				} else {
					// * 匹配任意非 / 字符
					regexStr += '[^/]*';
					i++;
				}
			} else if (ch === '?') {
				regexStr += '[^/]';
				i++;
			} else if (ch === '[') {
				// 字符类，直接传递到正则
				const end = pattern.indexOf(']', i);
				if (end !== -1) {
					regexStr += pattern.substring(i, end + 1);
					i = end + 1;
				} else {
					// 未闭合的 [，当作普通字符
					regexStr += '\\[';
					i++;
				}
			} else {
				// 普通字符，转义
				regexStr += escapeRegex(ch);
				i++;
			}
		}

		// 完整匹配
		return new RegExp(`^${regexStr}$`);
	}

	/**
	 * 获取原始内容
	 */
	getRawContent(): string {
		return this.rawContent;
	}

	/**
	 * 规则数量
	 */
	get ruleCount(): number {
		return this.rules.length;
	}

	/**
	 * 是否有规则
	 */
	get hasRules(): boolean {
		return this.rules.length > 0;
	}
}

/**
 * 正则特殊字符转义
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 Vault 中加载忽略规则文件
 * 支持自动迁移旧文件 .feisyncignore → feisync-ignore.md
 * @param vault Obsidian Vault 实例
 * @returns IgnoreFilter 实例
 */
export async function loadIgnoreFilter(vault: Vault): Promise<IgnoreFilter> {
	const filter = new IgnoreFilter();

	try {
		// 优先查找新文件
		let file = vault.getAbstractFileByPath(FEISYNC_IGNORE_FILE);

		// 如果新文件不存在，检查旧文件并自动迁移
		if (!(file instanceof TFile)) {
			const legacyFile = vault.getAbstractFileByPath(LEGACY_IGNORE_FILE);
			if (legacyFile instanceof TFile) {
				log.info(`检测到旧忽略文件 ${LEGACY_IGNORE_FILE}，正在迁移...`);
				try {
					// 读取旧文件内容
					const content = await vault.read(legacyFile);
					// 创建新文件
					await vault.create(FEISYNC_IGNORE_FILE, content);
					log.info(`已迁移到 ${FEISYNC_IGNORE_FILE}`);
					// 可选：删除旧文件（暂时保留，以防万一）
					// await vault.delete(legacyFile);
					file = vault.getAbstractFileByPath(FEISYNC_IGNORE_FILE);
				} catch (migrateErr) {
					log.warn('迁移忽略文件失败，将使用旧文件:', migrateErr);
					file = legacyFile;
				}
			}
		}

		if (file instanceof TFile) {
			const content = await vault.read(file);
			filter.loadFromContent(content);
			log.info(`从 ${file.name} 加载了 ${filter.ruleCount} 条忽略规则`);
		} else {
			log.info(`忽略规则文件不存在（${FEISYNC_IGNORE_FILE}），无忽略规则`);
		}
	} catch (err) {
		log.warn(`加载忽略规则失败:`, err);
	}

	return filter;
}


/**
 * 生成默认的 feisync-ignore.md 内容
 */
export function getDefaultIgnoreContent(): string {
	return `# FeiSync 忽略规则

在 Obsidian 中直接编辑此文件即可生效。

<!-- 语法示例 -->
<!--
  attachments/   忽略目录
  *.tmp           忽略扩展名
  **/.bak         任意位置
  !important.md   取消忽略
-->

<!-- 忽略规则（删除注释即可启用） -->

<!-- Obsidian 配置 -->
<!-- .obsidian/ -->

<!-- 系统文件 -->
<!-- .DS_Store -->
<!-- Thumbs.db -->

<!-- 临时文件 -->
<!-- *.tmp -->
<!-- *.bak -->
`;
}
