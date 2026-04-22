/**
 * 统一日志模块
 * 借鉴 Obsidian 日志格式：简洁、层级清晰
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
	console.log(`[FeiSync] 日志级别: ${LogLevel[level]}`);
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
	return currentLogLevel;
}

/**
 * DEBUG 级别 - 详细调试信息
 * 格式: [DEBUG] message
 */
export function debug(message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.DEBUG) {
		const prefix = '%c[DEBUG]';
		const style = 'color: #888; font-weight: normal;';
		if (data.length > 0) {
			console.log(prefix, style, message, ...data);
		} else {
			console.log(prefix, style, message);
		}
	}
}

/**
 * INFO 级别 - 常规操作信息
 * 格式: [INFO] message
 */
export function info(message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.INFO) {
		const prefix = '%c[INFO]';
		const style = 'color: #3b82f6; font-weight: bold;';
		if (data.length > 0) {
			console.log(prefix, style, message, ...data);
		} else {
			console.log(prefix, style, message);
		}
	}
}

/**
 * WARN 级别 - 警告信息
 * 格式: [WARN] message
 */
export function warn(message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.WARN) {
		const prefix = '%c[WARN]';
		const style = 'color: #f59e0b; font-weight: bold;';
		if (data.length > 0) {
			console.warn(prefix, style, message, ...data);
		} else {
			console.warn(prefix, style, message);
		}
	}
}

/**
 * ERROR 级别 - 错误信息
 * 格式: [ERROR] message
 */
export function error(message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.ERROR) {
		const prefix = '%c[ERROR]';
		const style = 'color: #ef4444; font-weight: bold;';
		if (data.length > 0) {
			console.error(prefix, style, message, ...data);
		} else {
			console.error(prefix, style, message);
		}
	}
}

/**
 * 创建子日志器
 * 用法: const log = createLogger('SyncEngine');
 */
export function createLogger(module: string) {
	return {
		debug: (message: string, ...data: any[]) => debug(`[${module}] ${message}`, ...data),
		info: (message: string, ...data: any[]) => info(`[${module}] ${message}`, ...data),
		warn: (message: string, ...data: any[]) => warn(`[${module}] ${message}`, ...data),
		error: (message: string, ...data: any[]) => error(`[${module}] ${message}`, ...data),
	};
}
