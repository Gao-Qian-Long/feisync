/**
 * 统一日志模块
 * 提供分级日志输出，方便调试和问题定位
 * 所有模块应通过此模块输出日志，而非直接使用 console.log
 */

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	NONE = 4, // 禁用所有日志
}

const LOG_PREFIX = '[FeiSync]';

/** 当前日志级别，可通过设置修改 */
let currentLogLevel: LogLevel = LogLevel.DEBUG;

/**
 * 设置日志级别
 */
export function setLogLevel(level: LogLevel): void {
	currentLogLevel = level;
	console.log(`${LOG_PREFIX} 日志级别设置为: ${LogLevel[level]}`);
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
	return currentLogLevel;
}

/**
 * 格式化模块名
 */
function formatModule(module: string): string {
	return module ? `[${module}]` : '';
}

/**
 * DEBUG 级别日志
 * 用于详细调试信息，生产环境可关闭
 */
export function debug(module: string, message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.DEBUG) {
		if (data.length > 0) {
			console.log(`${LOG_PREFIX}[DEBUG]${formatModule(module)} ${message}`, ...data);
		} else {
			console.log(`${LOG_PREFIX}[DEBUG]${formatModule(module)} ${message}`);
		}
	}
}

/**
 * INFO 级别日志
 * 用于常规操作信息
 */
export function info(module: string, message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.INFO) {
		if (data.length > 0) {
			console.log(`${LOG_PREFIX}[INFO]${formatModule(module)} ${message}`, ...data);
		} else {
			console.log(`${LOG_PREFIX}[INFO]${formatModule(module)} ${message}`);
		}
	}
}

/**
 * WARN 级别日志
 * 用于警告信息，不影响运行但需关注
 */
export function warn(module: string, message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.WARN) {
		if (data.length > 0) {
			console.warn(`${LOG_PREFIX}[WARN]${formatModule(module)} ${message}`, ...data);
		} else {
			console.warn(`${LOG_PREFIX}[WARN]${formatModule(module)} ${message}`);
		}
	}
}

/**
 * ERROR 级别日志
 * 用于错误信息，影响功能正常运行
 */
export function error(module: string, message: string, ...data: any[]): void {
	if (currentLogLevel <= LogLevel.ERROR) {
		if (data.length > 0) {
			console.error(`${LOG_PREFIX}[ERROR]${formatModule(module)} ${message}`, ...data);
		} else {
			console.error(`${LOG_PREFIX}[ERROR]${formatModule(module)} ${message}`);
		}
	}
}

/**
 * 创建子日志器，绑定模块名
 * 用法：const log = createLogger('SyncEngine'); log.info('开始同步');
 */
export function createLogger(module: string) {
	return {
		debug: (message: string, ...data: any[]) => debug(module, message, ...data),
		info: (message: string, ...data: any[]) => info(module, message, ...data),
		warn: (message: string, ...data: any[]) => warn(module, message, ...data),
		error: (message: string, ...data: any[]) => error(module, message, ...data),
	};
}
