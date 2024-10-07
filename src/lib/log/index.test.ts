import { test, expect, describe } from 'vitest';
import Log from './index.js';
import type { LogTarget, LogTargetLevel, LogEntry } from './common.js';
import { canLogForTargetLevel } from './common.js';
import LogTargetConsole from './target_console.js';

class LogTargetTest implements LogTarget {
	readonly logs: LogEntry[] = [];

	readonly logLevel: LogTargetLevel;

	constructor(logLevel: LogTargetLevel) {
		this.logLevel = logLevel;
	}

	async emitLogs(logs: LogEntry[]): Promise<void> {
		for (const log of logs) {
			if (!canLogForTargetLevel(log.level, this.logLevel)) {
				continue;
			}

			this.logs.push(log);
		}
	}
}

describe('Log Tests', function() {
	test('Basic Tests', async function() {
		/*
		 * Setup for test
		 */
		const logger1 = new Log();
		logger1.debug('basic tests', 'Test 1');

		const target_l1t1 = new LogTargetTest('ALL');
		let targetID = logger1.registerTarget(target_l1t1);

		await logger1.sync();

		/*
		 * Ensure that logging works at all
		 */
		expect(target_l1t1.logs.length).toEqual(1);

		/*
		 * Ensure that logs written with no registered targets
		 * are enqueued until a target is registered and sync
		 * is called
		 */
		logger1.unregisterTarget(targetID);
		logger1.debug('basic tests', 'Test 2');

		await logger1.sync();

		expect(target_l1t1.logs.length).toEqual(1);
		targetID = logger1.registerTarget(target_l1t1);

		await logger1.sync();
		expect(target_l1t1.logs.length).toEqual(2);

		/*
		 * Ensure that logs are written to all targets
		 * and that the "canLogForTargetLevel" function
		 * works as expected
		 */
		const target_l1t2 = new LogTargetTest('ERROR');
		logger1.registerTarget(target_l1t2);

		logger1.debug('basic tests', 'Test 3');
		logger1.error('basic tests', 'Test 4');
		await logger1.sync();
		expect(target_l1t1.logs.length).toEqual(4);
		expect(target_l1t2.logs.length).toEqual(1);

		/*
		 * Ensure logging interfaces work
		 */
		logger1.warn({ currentRequestInfo: { id: '1' } }, 'basic tests', 'Test 5');
		await logger1.sync();
		expect(target_l1t1.logs.length).toEqual(5);
		expect(target_l1t1.logs[3]?.options?.currentRequestInfo?.id).toBeUndefined();
		expect(target_l1t1.logs[4]?.options?.currentRequestInfo?.id).toEqual('1');

		/*
		 * Test all methods
		 */
		for (const method of ['log', 'debug', 'info', 'warn', 'error'] as const) {
			logger1[method]('basic tests', 'Test 6');
		}
		await logger1.sync();
		expect(target_l1t1.logs.length).toEqual(10);

		/*
		 * Ensure that the logging of tracing information works
		 */
		const logger2 = new Log({
			logDebugTracing: true
		});
		const target_l2t1 = new LogTargetTest('ALL');
		logger2.registerTarget(target_l2t1);

		logger2.debug('basic tests', 'Test 7');
		await logger2.sync();
		expect(target_l2t1.logs.length).toEqual(1);
		expect(target_l2t1.logs[0]?.trace).toBeDefined();
		expect(target_l1t1.logs[0]?.trace).toBeUndefined();
	});

	test('Console Tests', async function() {
		const called = {
			debug: 0,
			info: 0,
			warn: 0,
			error: 0
		};

		const logger = new Log();
		logger.registerTarget(new LogTargetConsole({
			console: {
				debug: function() { called.debug++; },
				info: function() { called.info++; },
				warn: function() { called.warn++; },
				error: function() { called.error++; }
			}
		}));

		logger.log('console tests', 'Test 1');
		logger.debug('console tests', 'Test 2');
		logger.info('console tests', 'Test 3');
		logger.warn('console tests', 'Test 4');
		logger.error('console tests', 'Test 5');

		expect(called.debug).toEqual(0);
		expect(called.info).toEqual(0);
		expect(called.warn).toEqual(0);
		expect(called.error).toEqual(0);

		await logger.sync();

		expect(called.debug).toEqual(1);
		expect(called.info).toEqual(2);
		expect(called.warn).toEqual(1);
		expect(called.error).toEqual(1);

		for (const method of ['debug', 'info', 'warn', 'error'] as const) {
			logger[method]('console tests', 'Test 6');
			const before = called[method];
			await logger.sync();
			const after = called[method];

			expect(after).toEqual(before + 1);
		}
	});
});
