import type { LogEntry, LogTargetLevel, LogTarget } from './common.js';
import { canLogForTargetLevel } from './common.js';

type LogTargetConsoleConfig = {
	logLevel?: LogTargetLevel;
};

export class LogTargetConsole implements LogTarget {
	readonly logLevel: LogTargetLevel;

	constructor(config?: LogTargetConsoleConfig) {
		this.logLevel = config?.logLevel ?? 'ALL';
	}

	async emitLogs(logs: LogEntry[]): Promise<void> {
		for (const log of logs) {
			if (!canLogForTargetLevel(log.level, this.logLevel)) {
				continue;
			}

			let method: 'log' | 'info' | 'warn' | 'error';

			switch (log.level) {
				case 'ERROR':
					method = 'error';
					break;
				case 'WARN':
					method = 'warn';
					break;
				default:
					method = 'log';
					break;
			}

			let requestID = log.options?.currentRequestInfo?.id;
			if (requestID === undefined) {
				requestID = '<NO_REQUEST_ID>';
			}

			console[method](`[${requestID}] ${log.level} ${log.from}:`, ...log.args);
			if (log.trace !== undefined) {
				console[method](`[${requestID}] ${log.level} ${log.from} TRACE:`, log.trace);
			}
		}
	}
}

export default LogTargetConsole;
