import type { LogEntry, LogTargetLevel, LogTarget } from './common.js';
import { canLogForTargetLevel } from './common.js';
import { assertNever } from '../utils/never.js';

type LogTargetConsoleConfig = {
	logLevel?: LogTargetLevel;
	console?: Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;
};

export class LogTargetConsole implements LogTarget {
	readonly logLevel: LogTargetLevel;
	#console: NonNullable<LogTargetConsoleConfig['console']>;

	constructor(config?: LogTargetConsoleConfig) {
		this.logLevel = config?.logLevel ?? 'ALL';
		this.#console = config?.console ?? console;
	}

	async emitLogs(logs: LogEntry[]): Promise<void> {
		for (const log of logs) {
			if (!canLogForTargetLevel(log.level, this.logLevel)) {
				continue;
			}

			let method: 'debug' | 'info' | 'warn' | 'error';

			switch (log.level) {
				case 'ERROR':
					method = 'error';
					break;
				case 'WARN':
					method = 'warn';
					break;
				case 'INFO':
					method = 'info';
					break;
				case 'DEBUG':
					method = 'debug';
					break;
				default:
					assertNever(log.level);
			}

			let requestID = log.options?.currentRequestInfo?.id;
			if (requestID === undefined) {
				requestID = '<NO_REQUEST_ID>';
			}

			this.#console[method](`[${requestID}] ${log.level} ${log.from}:`, ...log.args);
			if (log.trace !== undefined) {
				this.#console[method](`[${requestID}] ${log.level} ${log.from} TRACE:`, log.trace);
			}
		}
	}
}

export default LogTargetConsole;
