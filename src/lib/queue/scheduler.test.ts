import { test, expect, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';

import type { JSONSerializable } from '../utils/json.ts';
import { AsyncDisposableStack } from '../utils/defer.js';

import type {
	KeetaAnchorQueueScanFilter,
	KeetaAnchorQueueStatus,
	KeetaAnchorQueueStorageDriver
} from './index.ts';
import type { KeetaAnchorSchedulable } from './scheduler.ts';
import { KeetaAnchorQueueScheduler } from './scheduler.js';
import { KeetaAnchorQueueStorageDriverMemory } from './index.js';
import KeetaAnchorQueueStorageDriverFirestore from './drivers/queue_firestore.js';

/**
 * A schedulable unit driving a real storage driver: each pass drains the
 * pending entries of the unit's stage partition.
 */
class TestSchedulableUnit implements KeetaAnchorSchedulable {
	readonly partitionPrefix: string;
	readonly passBudgets: (number | undefined)[] = [];
	deactivateCount = 0;
	active = false;

	private readonly root: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>;
	private yieldPassesRemaining: number;
	private readonly onPass?: (() => Promise<void>) | undefined;

	constructor(root: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>, prefix: string, options?: { yieldPasses?: number; onPass?: () => Promise<void>; }) {
		this.root = root;
		this.partitionPrefix = prefix;
		this.yieldPassesRemaining = options?.yieldPasses ?? 0;
		this.onPass = options?.onPass;
	}

	async runPass(budgetMs?: number): Promise<boolean> {
		this.active = true;
		this.passBudgets.push(budgetMs);

		await this.onPass?.();

		if (this.yieldPassesRemaining > 0) {
			this.yieldPassesRemaining--;
			return(true);
		}

		const stage = await this.root.partition(`${this.partitionPrefix}:stage`);
		const pending = await stage.query({ status: 'pending' });
		for (const entry of pending) {
			await stage.setStatus(entry.id, 'completed', { oldStatus: 'pending' });
		}

		return(false);
	}

	async deactivate(): Promise<void> {
		this.active = false;
		this.deactivateCount++;
	}
}

/**
 * A memory driver that fails selected `scanActivePaths` calls (by 1-based
 * call index) to model transient backend outages
 */
class ScanFailureMemoryDriver extends KeetaAnchorQueueStorageDriverMemory {
	readonly failScanCalls = new Set<number>();
	private scanCallIndex = 0;

	override async scanActivePaths(statuses: KeetaAnchorQueueStatus[], filter?: KeetaAnchorQueueScanFilter): Promise<string[][]> {
		this.scanCallIndex++;
		if (this.failScanCalls.has(this.scanCallIndex)) {
			throw(new Error(`induced scan failure on call ${this.scanCallIndex}`));
		}

		const paths = await super.scanActivePaths(statuses, filter);
		return(paths);
	}
}

/**
 * Give the scheduler loop's promise chains enough microtask turns to settle
 * without advancing the fake clock
 */
async function settleAsyncWork(): Promise<void> {
	for (let turn = 0; turn < 256; turn++) {
		await Promise.resolve();
	}
}

/**
 * Advance the fake clock, then let the scheduler loop settle
 */
async function advanceAndSettle(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settleAsyncWork();
}

type SchedulerHarness = {
	root: KeetaAnchorQueueStorageDriverMemory;
	scheduler: KeetaAnchorQueueScheduler;
	units: TestSchedulableUnit[];
};

/**
 * Build a memory-backed scheduler over freshly constructed test units and
 * register cleanup (fake timers, scheduler stop, driver dispose)
 */
function createSchedulerHarness(cleanup: InstanceType<typeof AsyncDisposableStack>, options: {
	prefixes: string[];
	root?: KeetaAnchorQueueStorageDriverMemory;
	unitOptions?: { [prefix: string]: { yieldPasses?: number; onPass?: () => Promise<void>; }};
	pollIntervalMs?: number;
	sweepIntervalMs?: number;
	sweepStalenessMs?: number;
	moveRetryWindowMs?: number;
	startupMoveRetryWindowMs?: number;
	idleDeactivateMs?: number;
	passBudgetMs?: number;
	busyIntervalMs?: number;
	maxHeadsPerIteration?: number;
}): SchedulerHarness {
	vi.useFakeTimers();

	cleanup.defer(function() {
		vi.useRealTimers();
	});

	const root = options.root ?? new KeetaAnchorQueueStorageDriverMemory({ id: 'scheduler-test' });

	cleanup.defer(async function() {
		await root[Symbol.asyncDispose]();
	});

	const units = options.prefixes.map(function(prefix) {
		return(new TestSchedulableUnit(root, prefix, options.unitOptions?.[prefix]));
	});

	const scheduler = new KeetaAnchorQueueScheduler({
		driver: root,
		units: units,
		pollIntervalMs: options.pollIntervalMs,
		sweepIntervalMs: options.sweepIntervalMs,
		sweepStalenessMs: options.sweepStalenessMs,
		moveRetryWindowMs: options.moveRetryWindowMs,
		startupMoveRetryWindowMs: options.startupMoveRetryWindowMs,
		idleDeactivateMs: options.idleDeactivateMs,
		passBudgetMs: options.passBudgetMs,
		busyIntervalMs: options.busyIntervalMs,
		maxHeadsPerIteration: options.maxHeadsPerIteration
	});

	cleanup.defer(async function() {
		await scheduler.stop();
	});

	const harness: SchedulerHarness = { root: root, scheduler: scheduler, units: units };
	return(harness);
}

test('Scheduler runs only the units owning active partitions', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha', 'beta'],
		pollIntervalMs: 1000,
		sweepIntervalMs: 60_000,
		passBudgetMs: 250
	});
	const [alpha, beta] = units;
	if (!alpha || !beta) {
		throw(new Error('internal error: units missing'));
	}

	const alphaStage = await root.partition('alpha:stage');
	const id = await alphaStage.add({ v: 1 });

	scheduler.start();
	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'the unit owning the pending partition ran once').toBe(1);
	expect(alpha.passBudgets[0], 'the pass budget is forwarded to the unit').toBe(250);
	expect(beta.passBudgets.length, 'the idle unit never ran').toBe(0);

	const entry = await alphaStage.get(id);
	expect(entry?.status, 'the pending entry was processed').toBe('completed');

	/* A head owned by no unit is ignored without disturbing the loop */
	scheduler.notify('nobody:stage');
	await settleAsyncWork();
	expect(beta.passBudgets.length, 'an unowned head does not run other units').toBe(0);
});

test('Scheduler notify wakes the loop before the poll interval', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		pollIntervalMs: 600_000,
		sweepIntervalMs: 600_000
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	scheduler.start();

	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'no unit runs while nothing is active').toBe(0);

	const alphaStage = await root.partition('alpha:stage');
	const id = await alphaStage.add({ v: 1 });

	scheduler.notify('alpha:stage');

	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'the notified unit ran without a timer tick').toBe(1);

	const entry = await alphaStage.get(id);
	expect(entry?.status, 'the notified entry was processed').toBe('completed');
});

test('Scheduler latches a notify that arrives during an in-flight pass', async function() {
	await using cleanup = new AsyncDisposableStack();

	/*
	 * alpha's pass enqueues work for beta and notifies mid-iteration; the
	 * level-triggered set must schedule the next iteration immediately
	 */
	let notifyDuringPass: (() => Promise<void>) | undefined;
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha', 'beta'],
		unitOptions: {
			'alpha': {
				onPass: async function() {
					await notifyDuringPass?.();
					notifyDuringPass = undefined;
				}
			}
		},
		pollIntervalMs: 600_000,
		sweepIntervalMs: 600_000
	});
	const [alpha, beta] = units;
	if (!alpha || !beta) {
		throw(new Error('internal error: units missing'));
	}

	const betaStage = await root.partition('beta:stage');
	notifyDuringPass = async function() {
		await betaStage.add({ v: 2 });
		scheduler.notify('beta:stage');
	};

	const alphaStage = await root.partition('alpha:stage');
	await alphaStage.add({ v: 1 });

	scheduler.start();
	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'the initially active unit ran').toBeGreaterThanOrEqual(1);
	expect(beta.passBudgets.length, 'the mid-pass notify ran the other unit without a timer tick').toBeGreaterThanOrEqual(1);
});

test('Scheduler sweep recovers stale processing entries the fast pass skips', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		pollIntervalMs: 1000,
		sweepIntervalMs: 5000,
		sweepStalenessMs: 5000
	});
	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	const alphaStage = await root.partition('alpha:stage');
	const id = await alphaStage.add({ v: 1 });
	await alphaStage.setStatus(id, 'processing', { oldStatus: 'pending' });

	/* Age the in-flight entry past the staleness bound before starting */
	vi.advanceTimersByTime(10_000);

	scheduler.start();
	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'the sweep selected the unit holding the stale entry').toBeGreaterThanOrEqual(1);
});

test('Scheduler ages terminal rows out of the sweep and deactivates the idle unit', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		pollIntervalMs: 1000,
		sweepIntervalMs: 5000,
		sweepStalenessMs: 300_000,
		moveRetryWindowMs: 20_000,
		idleDeactivateMs: 30_000
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	const alphaStage = await root.partition('alpha:stage');
	await alphaStage.add({ v: 1 });

	scheduler.start();

	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'the unit processed the pending entry').toBeGreaterThanOrEqual(1);

	/* Within the retry window, the terminal row keeps selecting the unit */
	await advanceAndSettle(10_000);
	const passesWithinWindow = alpha.passBudgets.length;
	expect(passesWithinWindow, 'the sweep keeps selecting a fresh terminal row').toBeGreaterThan(1);

	/* Once the row ages out, the sweeps stop selecting the unit */
	await advanceAndSettle(30_000);
	const passesAfterAgeOut = alpha.passBudgets.length;

	await advanceAndSettle(30_000);
	expect(alpha.passBudgets.length, 'an aged-out terminal row no longer selects the unit').toBe(passesAfterAgeOut);

	/* The idle unit is eventually deactivated and stays deactivated */
	await advanceAndSettle(60_000);
	expect(alpha.deactivateCount, 'the idle unit was deactivated').toBeGreaterThanOrEqual(1);
	expect(alpha.active, 'the deactivated unit stays inactive').toBe(false);

	const deactivationsAfterCollection = alpha.deactivateCount;
	await advanceAndSettle(60_000);
	expect(alpha.deactivateCount, 'a deactivated unit is not repeatedly deactivated').toBe(deactivationsAfterCollection);
});

test('Scheduler startup sweep recovers terminal rows older than the retry window', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		pollIntervalMs: 1000,
		sweepIntervalMs: 5000,
		sweepStalenessMs: 300_000,
		moveRetryWindowMs: 20_000
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	const alphaStage = await root.partition('alpha:stage');
	await alphaStage.add({ v: 1 }, { status: 'completed' });

	/* Age the terminal row past the retry window before starting */
	vi.advanceTimersByTime(60_000);

	scheduler.start();
	await settleAsyncWork();

	expect(alpha.passBudgets.length, 'the widened startup sweep selected the aged terminal row').toBe(1);

	/* Subsequent windowed sweeps no longer select the aged-out row */
	await advanceAndSettle(15_000);
	expect(alpha.passBudgets.length, 'windowed sweeps skip the aged-out row').toBe(1);
});

test('Scheduler reschedules a unit that exhausts its budget at the busy cadence', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		unitOptions: {
			'alpha': { yieldPasses: 2 }
		},
		pollIntervalMs: 600_000,
		sweepIntervalMs: 600_000,
		passBudgetMs: 50,
		busyIntervalMs: 100
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	scheduler.start();
	await settleAsyncWork();

	scheduler.notify('alpha:stage');
	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'a budget-exhausted yield does not rerun the unit within the same tick').toBe(1);

	await advanceAndSettle(100);
	expect(alpha.passBudgets.length, 'the yielded unit reran after one busy interval').toBe(2);

	await advanceAndSettle(100);
	expect(alpha.passBudgets.length, 'the yielded unit reran until it drained').toBe(3);
	expect(alpha.passBudgets, 'the budget is forwarded on every pass').toEqual([50, 50, 50]);

	await advanceAndSettle(1_000);
	expect(alpha.passBudgets.length, 'a drained unit stops rerunning').toBe(3);
});

test('Scheduler paces reruns while a unit reports progress it cannot make', async function() {
	await using cleanup = new AsyncDisposableStack();

	/*
	 * A unit that always reports remaining progress models a runner whose
	 * lock is held by another worker; the scheduler must not spin hot
	 */
	const { scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		unitOptions: {
			'alpha': { yieldPasses: 1_000 }
		},
		pollIntervalMs: 600_000,
		sweepIntervalMs: 600_000,
		busyIntervalMs: 100
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	scheduler.start();
	await settleAsyncWork();

	scheduler.notify('alpha:stage');
	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'a spurious progress report yields exactly one pass per busy interval').toBe(1);

	await advanceAndSettle(100);
	expect(alpha.passBudgets.length, 'the rerun waited out the busy interval').toBe(2);

	await advanceAndSettle(500);
	expect(alpha.passBudgets.length, 'reruns stay bounded by the busy cadence').toBeLessThanOrEqual(8);
});

test('Scheduler defers heads over the per-iteration cap without dropping them', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha', 'beta', 'gamma'],
		pollIntervalMs: 600_000,
		sweepIntervalMs: 600_000,
		busyIntervalMs: 100,
		maxHeadsPerIteration: 1
	});

	for (const prefix of ['alpha', 'beta', 'gamma']) {
		const stage = await root.partition(`${prefix}:stage`);
		await stage.add({ v: 1 });
	}

	function totalPasses(): number {
		return(units.reduce(function(sum, unit) {
			return(sum + unit.passBudgets.length);
		}, 0));
	}

	scheduler.start();
	await settleAsyncWork();
	expect(totalPasses(), 'the first iteration ran only the capped head count').toBe(1);

	await advanceAndSettle(100);
	expect(totalPasses(), 'a deferred head ran on the next busy interval').toBe(2);

	await advanceAndSettle(100);
	expect(totalPasses(), 'every deferred head eventually ran').toBe(3);

	for (const prefix of ['alpha', 'beta', 'gamma']) {
		const stage = await root.partition(`${prefix}:stage`);
		const pending = await stage.query({ status: 'pending' });
		expect(pending.length, `no pending work remains for ${prefix}`).toBe(0);
	}
});

test('Scheduler cap does not starve deferred heads behind busy units', async function() {
	await using cleanup = new AsyncDisposableStack();

	/*
	 * Every unit always reports remaining progress
	 */
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha', 'beta', 'gamma'],
		unitOptions: {
			'alpha': { yieldPasses: 1_000 },
			'beta': { yieldPasses: 1_000 },
			'gamma': { yieldPasses: 1_000 }
		},
		pollIntervalMs: 600_000,
		sweepIntervalMs: 600_000,
		busyIntervalMs: 100,
		maxHeadsPerIteration: 2
	});

	const [alpha, beta, gamma] = units;
	if (!alpha || !beta || !gamma) {
		throw(new Error('internal error: units missing'));
	}

	for (const prefix of ['alpha', 'beta', 'gamma']) {
		const stage = await root.partition(`${prefix}:stage`);
		await stage.add({ v: 1 });
	}

	scheduler.start();

	await settleAsyncWork();
	expect(alpha.passBudgets.length + beta.passBudgets.length + gamma.passBudgets.length, 'the first iteration ran only the capped head count').toBe(2);
	expect(gamma.passBudgets.length, 'the head over the cap was deferred').toBe(0);

	await advanceAndSettle(100);
	expect(gamma.passBudgets.length, 'the deferred head ran ahead of the busy reruns').toBe(1);

	await advanceAndSettle(300);
	for (const unit of [alpha, beta, gamma]) {
		expect(unit.passBudgets.length, `the busy units share the cap fairly (${unit.partitionPrefix})`).toBeGreaterThanOrEqual(2);
	}
});

test('Scheduler startup sweep skips terminal rows older than the startup window', async function() {
	await using cleanup = new AsyncDisposableStack();
	const { root, scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		pollIntervalMs: 1000,
		sweepIntervalMs: 5000,
		sweepStalenessMs: 300_000,
		moveRetryWindowMs: 20_000,
		startupMoveRetryWindowMs: 30_000
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	const alphaStage = await root.partition('alpha:stage');
	await alphaStage.add({ v: 1 }, { status: 'completed' });

	/* Age the terminal row past the startup window before starting */
	vi.advanceTimersByTime(60_000);

	scheduler.start();
	await settleAsyncWork();

	expect(alpha.passBudgets.length, 'the startup sweep never selected the historical terminal row').toBe(0);
});

test('Scheduler retries a sweep whose scan failed instead of skipping the interval', async function() {
	await using cleanup = new AsyncDisposableStack();

	const root = new ScanFailureMemoryDriver({ id: 'scheduler-scan-failure' });
	const { scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		root: root,
		pollIntervalMs: 1000,
		sweepIntervalMs: 600_000,
		sweepStalenessMs: 5000
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	const alphaStage = await root.partition('alpha:stage');
	const id = await alphaStage.add({ v: 1 });
	await alphaStage.setStatus(id, 'processing', { oldStatus: 'pending' });

	/*
	 * Age the in-flight entry past the staleness bound before starting.
	 */
	vi.advanceTimersByTime(10_000);

	/*
	 * The first iteration scans: fast pass (call 1), then the sweep's
	 * stale-processing scan (call 2), which fails mid-sweep
	 */
	root.failScanCalls.add(2);

	scheduler.start();

	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'the failed sweep selected nothing').toBe(0);

	await advanceAndSettle(1000);
	expect(alpha.passBudgets.length, 'the sweep was retried on the next poll instead of waiting out the sweep interval').toBe(1);
});

test('Scheduler restores notified heads dropped by a failed scan', async function() {
	await using cleanup = new AsyncDisposableStack();

	const root = new ScanFailureMemoryDriver({ id: 'scheduler-head-restore' });
	const { scheduler, units } = createSchedulerHarness(cleanup, {
		prefixes: ['alpha'],
		root: root,
		pollIntervalMs: 1000,
		sweepIntervalMs: 600_000,
		busyIntervalMs: 100
	});

	const [alpha] = units;
	if (!alpha) {
		throw(new Error('internal error: units missing'));
	}

	scheduler.start();
	await settleAsyncWork();

	/*
	 * The startup iteration consumed scan calls 1-3. The notify-triggered
	 * iteration's fast pass is call 4.
	 */
	root.failScanCalls.add(4);

	scheduler.notify('alpha:stage');
	await settleAsyncWork();
	expect(alpha.passBudgets.length, 'the failed iteration ran nothing').toBe(0);

	/*
	 * A failed iteration waits out the poll interval, not the busy cadence.
	 */
	await advanceAndSettle(100);
	expect(alpha.passBudgets.length, 'a failed iteration is not retried at the busy cadence').toBe(0);

	await advanceAndSettle(900);
	expect(alpha.passBudgets.length, 'the restored head ran once the backend recovered').toBe(1);
});

test('Scheduler constructor and start validate their inputs', async function() {
	const root = new KeetaAnchorQueueStorageDriverMemory({ id: 'scheduler-validation' });
	expect(function() {
		return(new KeetaAnchorQueueScheduler({
			driver: root,
			units: [new TestSchedulableUnit(root, 'has:colon')]
		}));
	}, 'a prefix containing ":" is rejected').toThrow('may not contain ":"');
	expect(function() {
		return(new KeetaAnchorQueueScheduler({
			driver: root,
			units: [new TestSchedulableUnit(root, 'dup'), new TestSchedulableUnit(root, 'dup')]
		}));
	}, 'duplicate prefixes are rejected').toThrow('Duplicate schedulable partition prefix');

	await root.destroy();

	/*
	 * A driver without scanActivePaths cannot back the scheduler. The
	 * Firestore driver's connection factory is lazy, so start() rejects
	 * before any connection is attempted.
	 */
	const firestoreDriver = new KeetaAnchorQueueStorageDriverFirestore({
		firestore: async function(): Promise<Firestore> {
			throw(new Error('internal error: the connection factory must never be invoked'));
		},
		namespace: 'scheduler-unsupported',
		id: 'scheduler-unsupported'
	});
	try {
		const scheduler = new KeetaAnchorQueueScheduler({
			driver: firestoreDriver,
			units: []
		});
		expect(function() {
			scheduler.start();
		}, 'a driver without scanActivePaths is rejected at start').toThrow('does not implement scanActivePaths');
	} finally {
		await firestoreDriver.destroy();
	}
});
