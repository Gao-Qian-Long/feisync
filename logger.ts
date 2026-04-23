/**
 * 统一日志模块
 * 统一使用 Obsidian 风格：简洁的 [模块] 消息 格式
 */

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	NONE = 4,
}

/** 当前日志级别 */
let currentLogLevel: LogLevel = LogLevel.INFO;

/**
 * 设置日志级别
 */
export function setLogLevel(level: LogLevel): void {
	currentLogLevel = level;
	console.debug(`[FeiSync] 日志级别: ${LogLevel[level]}`);
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
	return currentLogLevel;
}

/**
 * DEBUG 级别 - 详细调试信息
 * 格式: [模块] message
 */
export function debug(message: string, ...data: unknown[]): void {
	if (currentLogLevel <= LogLevel.DEBUG) {
		if (data.length > 0) {
			console.debug(message, ...data);
		} else {
			console.debug(message);
		}
	}
}

/**
 * INFO 级别 - 常规操作信息
 * 格式: [模块] message
 */
export function info(message: string, ...data: unknown[]): void {
	if (currentLogLevel <= LogLevel.INFO) {
		if (data.length > 0) {
			console.info(message, ...data);
		} else {
			console.info(message);
		}
	}
}

/**
 * WARN 级别 - 警告信息
 * 格式: [模块] message
 */
export function warn(message: string, ...data: unknown[]): void {
	if (currentLogLevel <= LogLevel.WARN) {
		if (data.length > 0) {
			console.warn(message, ...data);
		} else {
			console.warn(message);
		}
	}
}

/**
 * ERROR 级别 - 错误信息
 * 格式: [模块] message
 */
export function error(message: string, ...data: unknown[]): void {
	if (currentLogLevel <= LogLevel.ERROR) {
		if (data.length > 0) {
			console.error(message, ...data);
		} else {
			console.error(message);
		}
	}
}

/**
 * 创建子日志器
 * 用法: const log = createLogger('SyncEngine');
 */
export function createLogger(module: string) {
	const prefix = `[${module}]`;
	return {
		debug: (message: string, ...data: unknown[]) => debug(`${prefix} ${message}`, ...data),
		info: (message: string, ...data: unknown[]) => info(`${prefix} ${message}`, ...data),
		warn: (message: string, ...data: unknown[]) => warn(`${prefix} ${message}`, ...data),
		error: (message: string, ...data: unknown[]) => error(`${prefix} ${message}`, ...data),
	};
}
