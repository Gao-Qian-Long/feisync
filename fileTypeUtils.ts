/**
 * 文件类型工具模块
 * 负责判断文件是文本还是二进制，以及确定上传时的 file_type 参数
 * 采用白名单模式：已知文本扩展名用文本方式读取，其余全部用二进制读取
 */

import { createLogger } from './logger';

const log = createLogger('FileTypeUtils');

/**
 * 已知的文本文件扩展名（白名单）
 * 不在此列表中的扩展名一律视为二进制文件
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	// 文档类
	'md', 'markdown', 'mark', 'txt', 'rst', 'adoc', 'org',
	// 配置类
	'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties',
	'env', 'editorconfig', 'gitignore', 'dockerignore', 'feisyncignore',
	// Web 前端
	'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'jsx', 'ts', 'tsx',
	'vue', 'svelte',
	// 编程语言
	'py', 'rb', 'go', 'rs', 'java', 'kt', 'scala', 'c', 'h', 'cpp', 'hpp',
	'cs', 'swift', 'php', 'pl', 'r', 'lua', 'sh', 'bash', 'zsh', 'fish',
	'ps1', 'bat', 'cmd',
	// 数据/标记
	'xml', 'svg', 'csv', 'tsv', 'log', 'diff', 'patch',
	// 其他
	'sql', 'graphql', 'proto', 'tf', 'dockerfile', 'makefile',
]);

/**
 * 判断文件扩展名是否为文本类型
 * @param extension 文件扩展名（不含点号），如 'md', 'png'
 * @returns true 表示文本文件，false 表示二进制文件
 */
export function isTextFile(extension: string): boolean {
	return TEXT_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * 判断文件扩展名是否为二进制类型
 * @param extension 文件扩展名（不含点号）
 * @returns true 表示二进制文件，false 表示文本文件
 */
export function isBinaryFile(extension: string): boolean {
	return !isTextFile(extension);
}

/**
 * 根据文件扩展名确定飞书上传接口的 file_type 参数
 * 用于 /drive/v1/files/upload_all 接口
 * 
 * 支持的 file_type 值：stream, xlsx, docx, pptx, pdf
 * 不在此列表中的格式使用 stream（万能类型）
 */
export function getFeishuFileType(extension: string): string {
	const ext = extension.toLowerCase();
	const typeMap: Record<string, string> = {
		'xlsx': 'xlsx',
		'xlsm': 'xlsx',
		'docx': 'docx',
		'pptx': 'pptx',
		'pdf': 'pdf',
	};
	const result = typeMap[ext] || 'stream';
	log.debug(`文件扩展名 .${ext} → file_type=${result}`);
	return result;
}

/**
 * 判断文件是否支持导入为飞书在线文档
 * 参考：https://open.feishu.cn/document/server-docs/docs/drive-v1/import_user_guide
 */
export function canImportAsDocument(extension: string): boolean {
	const ext = extension.toLowerCase();
	return ['md', 'markdown', 'mark', 'docx', 'doc', 'txt', 'html', 'xlsx', 'csv', 'xls'].includes(ext);
}

/**
 * 获取文本文件扩展名白名单（供外部查询）
 */
export function getTextExtensions(): string[] {
	return Array.from(TEXT_EXTENSIONS);
}
