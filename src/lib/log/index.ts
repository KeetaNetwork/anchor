import type { LogLevel, LogTargetLevel, LogEntry, Logger, LogTarget } from './common.js';
import { createAssert } from 'typia';
export type { Logger };

/**
 * Maximum number of logs to enqueue when there are no targets assigned to a
 * Log instance
 */
const MAX_LOGS_TO_ENQUEUE_WITH_NO_TARGETS = 131072;

/**
 * Options for a Log instance
 */
type LogOptions = {
	/**
	 * Whether to generate debug tracing information for each log entry
	 */
	logDebugTracing?: boolean;
};

type LogOptionsParam = LogEntry['options'];
const assertLogOptionsParam = createAssert<LogOptionsParam>();

type LogTargetID = Symbol & { _branded: 'LogTargetID' };

export class Log implements Logger {
	/**
	 * The default log level, used for new instances of the logger
	 */
	static readonly defaultLevel: LogTargetLevel = 'DEBUG';

	/**
	 * Queued logs to be sent
	 */
	#logs: LogEntry[] = [];

	/**
	 * Interval holding the current autoSync process
	 */
	#autoSyncInterval?: NodeJS.Timeout;

	/**
	 * Keep track of whether or not we are currently syncing
	 */
	#isSyncing = false;

	/**
	 * If `sync()` is called while we are syncing, we should sync again
	 * to ensure all logs are sent
	 */
	#shouldSyncAgain = false;

	#logDebugTracing = false;
	#targets: Map<Symbol, LogTarget> = new Map();

	constructor(options?: LogOptions) {
		if (options?.logDebugTracing !== undefined) {
			this.#logDebugTracing = options.logDebugTracing;
		}
	}

	#log(level: LogLevel, options: LogOptionsParam, from: string, ...args: unknown[]): void {
		let trace: string | undefined;
		if (this.#logDebugTracing) {
			trace = new Error().stack?.split('\n').slice(2).join('\n');
		}
		this.#logs.push({ options, level, from, args, trace });
	}

	#extractArguments(args: unknown[]): { options: LogOptionsParam, from: string } {
		const options = assertLogOptionsParam((args[0] instanceof Object ? args.shift() : {}));
		const from = args.shift();
		if (typeof from !== 'string') {
			throw(new Error(`Expected string for 'from', got ${typeof from}`));
		}

		return({ options, from });
	}

	log(options: LogOptionsParam, from: string, ...args: unknown[]): void;
	log(from: string, ...args: unknown[]): void;
	log(...args: unknown[]) {
		const { options, from } = this.#extractArguments(args);

		this.#log('INFO', options, from, ...args);
	}

	info(options: LogOptionsParam, from: string, ...args: unknown[]): void;
	info(from: string, ...args: unknown[]): void;
	info(...args: unknown[]) {
		const { options, from } = this.#extractArguments(args);

		this.#log('INFO', options, from, ...args);
	}

	debug(options: LogOptionsParam, from: string, ...args: unknown[]): void;
	debug(from: string, ...args: unknown[]): void;
	debug(...args: unknown[]) {
		const { options, from } = this.#extractArguments(args);

		this.#log('DEBUG', options, from, ...args);
	}

	warn(options: LogOptionsParam, from: string, ...args: unknown[]): void;
	warn(from: string, ...args: unknown[]): void;
	warn(...args: unknown[]) {
		const { options, from } = this.#extractArguments(args);

		this.#log('WARN', options, from, ...args);
	}

	error(options: LogOptionsParam, from: string, ...args: unknown[]): void;
	error(from: string, ...args: unknown[]): void;
	error(...args: unknown[]) {
		const { options, from } = this.#extractArguments(args);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		this.#log('ERROR', options, from, ...args);
	}

	/**
	 * Register a new logging target (sink) to send logs to
	 */
	registerTarget(target: LogTarget): LogTargetID {
		const id = Symbol('LogTargetID');

		this.#targets.set(id, target);

		return(id as unknown as LogTargetID);
	}

	/**
	 * Unregister a logging target (sink) to stop sending logs to
	 */
	unregisterTarget(id: LogTargetID): void {
		this.#targets.delete(id);
	}

	/**
	 * Emit a set of logs to all registered targets
	 */
	private async emitLogs(logs: LogEntry[], targets: LogTarget[]) {
		await Promise.allSettled(targets.map(async function(target) {
			await target.emitLogs(logs);
		}));
	}

	/**
	 * Start a timer to periodically sync logs to all targets
	 */
	startAutoSync(rate = 100): void {
		if (this.#autoSyncInterval) {
			return;
		}

		this.#autoSyncInterval = setInterval(async () => {
			try {
				await this.sync();
			} catch {
				/* Ignored */
			}
		}, rate);
	}

	/**
	 * If a timer was started with `startAutoSync()`, stop it
	 */
	stopAutoSync(): void {
		if (!this.#autoSyncInterval) {
			return;
		}

		clearInterval(this.#autoSyncInterval);
		this.#autoSyncInterval = undefined;
	}

	/**
	 * Sync all currently enqueued logs to all targets
	 */
	async sync(): Promise<void> {
		/*
		 * If there are currently no targets, do not dequeue logs
		 * in case a target is added later;  However, if there are
		 * too many logs, drop the oldest ones
		 */
		if (this.#targets.size === 0) {
			if (this.#logs.length > MAX_LOGS_TO_ENQUEUE_WITH_NO_TARGETS) {
				this.#logs.splice(0, this.#logs.length - MAX_LOGS_TO_ENQUEUE_WITH_NO_TARGETS);
			}

			return;
		}

		/*
		 * If we are already syncing, set a flag to sync again after the current sync is done
		 */
		if (this.#isSyncing) {
			this.#shouldSyncAgain = true;

			return;
		}

		this.#isSyncing = true;

		/*
		 * Create a copy of the currently registered targets in case
		 * they are modified while a sync is on-going, we use the
		 * same targets until the sync is complete
		 *
		 * This ensures no messages are lost if all targets are removed
		 * while a sync is in progress -- they will continue to be sent
		 * to the registered targets at the time of the sync
		 */
		const targets = Array.from(this.#targets.values());

		do {
			try {
				while (this.#logs.length > 0) {
					this.#shouldSyncAgain = false;
					const logs = this.#logs.splice(0, 10);

					await this.emitLogs(logs, targets);
				}
			} catch {
				/* Ignore errors */
			}
		} while (this.#shouldSyncAgain);

		this.#isSyncing = false;
	}
}

export default Log;
