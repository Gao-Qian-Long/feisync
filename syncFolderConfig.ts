/**
 * 多文件夹同步配置模块
 * 管理本地文件夹到飞书云空间的映射关系
 */

import { createLogger } from './logger';

const log = createLogger('SyncFolderConfig');

/**
 * 单个文件夹同步映射配置
 */
export interface SyncFolderConfig {
	/** 唯一标识符 */
	id: string;
	/** 本地文件夹路径（相对 Vault 根目录，如 "Notes"） */
	localPath: string;
	/** 飞书目标文件夹 token（空字符串表示自动创建同名文件夹） */
	remoteFolderToken: string;
	/** 是否启用此映射 */
	enabled: boolean;
	/** 映射类型：auto（自动创建）或 custom（手动指定 token） */
	mode: 'auto' | 'custom';
	/** 上次同步时间（毫秒时间戳，0 表示未同步过） */
	lastSyncTime: number;
	/** 上次同步的文件数 */
	lastSyncFileCount: number;
}

/**
 * 生成唯一 ID
 */
export function generateFolderId(): string {
	return `folder_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * 创建默认的文件夹映射配置
 * @param localPath 本地路径
 * @param mode 映射模式
 * @param remoteFolderToken 远程 token（custom 模式需要）
 */
export function createSyncFolderConfig(
	localPath: string,
	mode: 'auto' | 'custom' = 'auto',
	remoteFolderToken: string = ''
): SyncFolderConfig {
	return {
		id: generateFolderId(),
		localPath,
		remoteFolderToken,
		enabled: true,
		mode,
		lastSyncTime: 0,
		lastSyncFileCount: 0,
	};
}

/**
 * 验证文件夹映射配置是否有效
 */
export function validateSyncFolderConfig(config: SyncFolderConfig): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!config.localPath || config.localPath.trim() === '') {
		errors.push('本地文件夹路径不能为空');
	}

	if (config.localPath.includes('..')) {
		errors.push('本地路径不能包含 .. ');
	}

	if (config.mode === 'custom' && (!config.remoteFolderToken || config.remoteFolderToken.trim() === '')) {
		errors.push('自定义模式需要指定飞书文件夹 Token');
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * 将旧的单文件夹配置迁移为新的多文件夹配置
 * @param localFolderPath 旧的本地路径
 * @param feishuRootFolderToken 旧的飞书 token
 * @returns 迁移后的 SyncFolderConfig 数组
 */
export function migrateFromLegacyConfig(
	localFolderPath: string,
	feishuRootFolderToken: string
): SyncFolderConfig[] {
	const configs: SyncFolderConfig[] = [];

	if (localFolderPath) {
		const config = createSyncFolderConfig(
			localFolderPath,
			feishuRootFolderToken ? 'custom' : 'auto',
			feishuRootFolderToken
		);
		// 旧配置中 token 为空时，它是 ObsidianSync 文件夹，标记为 auto
		if (!feishuRootFolderToken) {
			config.mode = 'auto';
		}
		configs.push(config);
		log.info(`迁移旧配置: localPath="${localFolderPath}", remoteToken="${feishuRootFolderToken || '(auto)'}" → id=${config.id}`);
	}

	return configs;
}

/**
 * 查找指定本地路径的映射配置
 */
export function findConfigByLocalPath(
	configs: SyncFolderConfig[],
	localPath: string
): SyncFolderConfig | undefined {
	return configs.find(c => c.localPath === localPath && c.enabled);
}

/**
 * 获取所有已启用的映射配置
 */
export function getEnabledConfigs(configs: SyncFolderConfig[]): SyncFolderConfig[] {
	return configs.filter(c => c.enabled);
}
