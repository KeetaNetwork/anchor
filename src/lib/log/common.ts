export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogTargetLevel = 'ALL' | LogLevel | 'NONE';

const numericLogLevels = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3
} as const;

/* XXX:TODO -- Do something with this */
type LogCurrentRequest = {
	id: string;
};

export type LogEntry = {
	options: {
		userVisible?: boolean;
		currentRequestInfo?: LogCurrentRequest;
	};
	level: LogLevel;
	from: string;
	args: unknown[];
	trace?: string;
};

export interface LogTarget {
	readonly logLevel: LogTargetLevel;
	emitLogs(logs: LogEntry[]): Promise<void>;
}

export interface Logger {
	log(options: LogEntry['options'], from: string, ...args: unknown[]): void;
	log(from: string, ...args: unknown[]): void;
	debug(options: LogEntry['options'], from: string, ...args: unknown[]): void;
	debug(from: string, ...args: unknown[]): void;
	info(options: LogEntry['options'], from: string, ...args: unknown[]): void;
	info(from: string, ...args: unknown[]): void;
	warn(options: LogEntry['options'], from: string, ...args: unknown[]): void;
	warn(from: string, ...args: unknown[]): void;
	error(options: LogEntry['options'], from: string, ...args: unknown[]): void;
	error(from: string, ...args: unknown[]): void;
}

export function canLogForLevel(level: LogLevel, currentLevel: LogLevel): boolean {
        return(numericLogLevels[level] >= numericLogLevels[currentLevel]);
}

export function canLogForTargetLevel(level: LogLevel, targetLevel: LogTargetLevel): boolean {
	if (targetLevel === 'ALL') {
		return(true);
	}

	if (targetLevel === 'NONE') {
		return(false);
	}

	return(canLogForLevel(level, targetLevel));
}
