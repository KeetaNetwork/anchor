import type {
	KeetaAnchorQueueScanFilter,
	KeetaAnchorQueueStatus,
	KeetaAnchorQueueStorageDriver
} from './index.ts';
import type { Logger } from '../log/index.ts';
import type { JSONSerializable } from '../utils/json.ts';
import { MethodLogger } from './internal.js';

/**
 * The statuses the fast pass treats as actionable work: the owning unit's
 * next pass will process or requeue them without waiting for any timeout.
 */
const fastPassStatuses: KeetaAnchorQueueStatus[] = ['pending', 'failed_temporarily', 'stuck', 'aborted'];

/**
 * The status the recovery sweep inspects for stale in-flight work. Live
 * locks and in-flight entries also carry it, so the sweep only selects
 * entries older than the staleness bound.
 */
const staleProcessingStatuses: KeetaAnchorQueueStatus[] = ['processing'];

/**
 * The pipeable statuses the recovery sweep inspects for failed stage moves.
 * Terminal-stage entries also carry them, so the sweep only selects entries
 * recently touched by the failed-move timestamp refresh.
 */
const moveRetryStatuses: KeetaAnchorQueueStatus[] = ['completed', 'failed_permanently'];

/**
 * A unit of work (e.g. a saga's runners) that a
 * {@link KeetaAnchorQueueScheduler} can multiplex.
 */
export interface KeetaAnchorSchedulable {
	/**
	 * Static routing key: the unit owns every partition whose head segment
	 * equals this prefix or starts with `${prefix}:`. The prefix must not
	 * contain `:`.
	 */
	readonly partitionPrefix: string;

	/**
	 * Run exactly one processing pass, building any lazily-initialized
	 * resources first.
	 *
	 * @param budgetMs - Optional time budget; a unit exhausting it must
	 *                   yield and report that progress may remain.
	 * @returns Whether progress may remain
	 */
	runPass(budgetMs?: number): Promise<boolean>;

	/**
	 * Release built resources after an idle period. A later
	 * {@link runPass} must rebuild them lazily.
	 */
	deactivate(): Promise<void>;
}

export type KeetaAnchorQueueSchedulerOptions<QueueRequest extends JSONSerializable, QueueResult extends JSONSerializable> = {
	/**
	 * The root storage driver to scan for active partitions -- it must
	 * implement `scanActivePaths`
	 */
	driver: KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>;
	/**
	 * The schedulable units to multiplex, keyed by their partition prefix
	 */
	units: Iterable<KeetaAnchorSchedulable>;
	/**
	 * The logger to use for logging
	 */
	logger?: Logger | undefined;
	/**
	 * Safety-net cadence between fast passes while idle (default 5s)
	 */
	pollIntervalMs?: number | undefined;
	/**
	 * Cadence of the recovery sweep (default 60s)
	 */
	sweepIntervalMs?: number | undefined;
	/**
	 * Age bound for the sweep's stale-`processing` scan. Over-selection is
	 * harmless because the selected unit applies its own stuck threshold
	 * (default 300s, the anchor default process timeout)
	 */
	sweepStalenessMs?: number | undefined;
	/**
	 * Recency window for the sweep's failed-move scan. Must exceed
	 * `sweepIntervalMs` plus worst-case pass latency or the failed-move
	 * refresh chain breaks between sweeps (default `4 * sweepIntervalMs`)
	 */
	moveRetryWindowMs?: number | undefined;
	/**
	 * Recency window for the startup sweep's failed-move scan, covering
	 * process downtime during which the failed-move refresh chain could
	 * not run (default 24 hours)
	 */
	startupMoveRetryWindowMs?: number | undefined;
	/**
	 * Age after which a unit that has not run is deactivated (default 15
	 * minutes)
	 */
	idleDeactivateMs?: number | undefined;
	/**
	 * Per-unit time budget passed to each `runPass` (default none)
	 */
	passBudgetMs?: number | undefined;
	/**
	 * Pause before rerunning units that reported remaining progress.
	 */
	busyIntervalMs?: number | undefined;
	/**
	 * Maximum partition heads processed per loop iteration.
	 */
	maxHeadsPerIteration?: number | undefined;
};

/**
 * A single-loop scheduler that multiplexes many {@link KeetaAnchorSchedulable}
 * units over one storage backend.
 *
 * Instead of one poll loop per unit, one loop scans the backend for
 * partitions holding actionable entries and runs only the owning units.
 *
 * {@link notify} is level-triggered: a notification arriving during an
 * in-flight iteration schedules the next iteration instead of being lost.
 */
export class KeetaAnchorQueueScheduler<QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> {
	private readonly driver: KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>;
	private readonly unitsByPrefix: Map<string, KeetaAnchorSchedulable>;
	private readonly logger?: Logger | undefined;

	private readonly pollIntervalMs: number;
	private readonly sweepIntervalMs: number;
	private readonly sweepStalenessMs: number;
	private readonly moveRetryWindowMs: number;
	private readonly startupMoveRetryWindowMs: number;
	private readonly idleDeactivateMs: number;
	private readonly passBudgetMs: number | undefined;
	private readonly busyIntervalMs: number;
	private readonly maxHeadsPerIteration: number;

	/**
	 * Heads notified since the loop last consumed the set (level-triggered)
	 */
	private readonly notifiedHeads = new Set<string>();
	/**
	 * Heads whose units reported remaining progress. Rerun at the busy
	 * cadence rather than immediately: progress reports can be spurious (a
	 * runner lock held by another worker) and an un-paced rerun would spin
	 * the loop hot against the backend
	 */
	private readonly rerunHeads = new Set<string>();
	/**
	 * Heads deferred over the per-iteration cap. Consumed ahead of the
	 * progress reruns so a busy set of early heads cannot starve the
	 * deferred ones
	 */
	private readonly deferredHeads = new Set<string>();
	/**
	 * Prefixes of units that have run and not yet been deactivated, with the
	 * timestamp of their most recent pass
	 */
	private readonly lastRunAtByPrefix = new Map<string, number>();
	private wakeLoop: (() => void) | null = null;
	private running = false;
	private loopPromise: Promise<void> | null = null;
	private lastSweepAt: number | null = null;

	readonly id: string;

	constructor(options: KeetaAnchorQueueSchedulerOptions<QueueRequest, QueueResult>) {
		this.driver = options.driver;
		this.logger = options.logger;
		this.id = crypto.randomUUID();

		this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
		this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
		this.sweepStalenessMs = options.sweepStalenessMs ?? 300_000;
		this.moveRetryWindowMs = options.moveRetryWindowMs ?? this.sweepIntervalMs * 4;
		this.startupMoveRetryWindowMs = options.startupMoveRetryWindowMs ?? 86_400_000;
		this.idleDeactivateMs = options.idleDeactivateMs ?? 900_000;
		this.passBudgetMs = options.passBudgetMs;
		this.busyIntervalMs = options.busyIntervalMs ?? 100;
		this.maxHeadsPerIteration = options.maxHeadsPerIteration ?? 100;

		this.unitsByPrefix = new Map();
		for (const unit of options.units) {
			const prefix = unit.partitionPrefix;
			if (prefix.includes(':')) {
				throw(new Error(`Schedulable partition prefix may not contain ":": ${prefix}`));
			}
			if (this.unitsByPrefix.has(prefix)) {
				throw(new Error(`Duplicate schedulable partition prefix: ${prefix}`));
			}

			this.unitsByPrefix.set(prefix, unit);
		}

		this.methodLogger('new')?.debug('Created queue scheduler with', this.unitsByPrefix.size, 'schedulable units');
	}

	private methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueScheduler',
			file: 'src/lib/queue/scheduler.ts',
			method: method,
			instanceID: this.id
		}));
	}

	/**
	 * Start the scheduler loop
	 *
	 * @throws {@link Error} when the driver does not implement `scanActivePaths`
	 */
	start(): void {
		if (this.running) {
			return;
		}

		if (this.driver.scanActivePaths === undefined) {
			throw(new Error(`Storage driver ${this.driver.name} does not implement scanActivePaths and cannot back a multiplexing scheduler`));
		}

		this.methodLogger('start')?.debug('Starting scheduler loop');

		this.running = true;
		this.lastSweepAt = null;
		this.loopPromise = this.loop();
	}

	/**
	 * Wake the scheduler for a partition head (the first path segment below
	 * the scheduler's driver), typically after an enqueue. Level-triggered:
	 * never lost, even during an in-flight iteration.
	 */
	notify(head: string): void {
		this.notifiedHeads.add(head);
		this.wake();
	}

	/**
	 * Stop the scheduler loop and wait for any in-flight iteration to finish
	 */
	async stop(): Promise<void> {
		this.methodLogger('stop')?.debug('Stopping scheduler loop');

		this.running = false;
		this.wake();

		await this.loopPromise;

		this.loopPromise = null;
	}

	private wake(): void {
		const wakeLoop = this.wakeLoop;
		this.wakeLoop = null;

		wakeLoop?.();
	}

	private async sleepUntilWake(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.wakeLoop = null;
				resolve();
			}, ms);

			this.wakeLoop = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}

	private async loop(): Promise<void> {
		const logger = this.methodLogger('loop');

		while (this.running) {
			try {
				await this.iteration();
			} catch (error: unknown) {
				logger?.error('Scheduler iteration failed:', error);
			}

			if (!this.running) {
				break;
			}

			/*
			 * A notify that arrived during the iteration schedules the next
			 * iteration immediately instead of waiting out the poll interval
			 */
			if (this.notifiedHeads.size !== 0) {
				continue;
			}

			/*
			 * Progress reruns and deferred heads run at the busy cadence,
			 * never immediately: a unit can report progress without making
			 * any (its runner lock held by another worker), and an un-paced
			 * rerun would spin the loop hot against the backend
			 */
			if (this.rerunHeads.size !== 0 || this.deferredHeads.size !== 0) {
				await this.sleepUntilWake(this.busyIntervalMs);
				continue;
			}

			await this.sleepUntilWake(this.pollIntervalMs);
		}
	}

	private async iteration(): Promise<void> {
		const heads = this.consumeQueuedHeads();

		await this.collectFastPassHeads(heads);
		await this.collectSweepHeads(heads);

		await this.runOwningUnits(heads);
		await this.deactivateIdleUnits();
	}

	/*
	 * Consumption order sets the run order under the per-iteration cap:
	 * deferred heads first (they already waited a full iteration), then
	 * fresh notifications, then progress reruns last.
	 */
	private consumeQueuedHeads(): Set<string> {
		const heads = new Set(this.deferredHeads);
		this.deferredHeads.clear();

		for (const head of this.notifiedHeads) {
			heads.add(head);
		}

		this.notifiedHeads.clear();

		for (const head of this.rerunHeads) {
			heads.add(head);
		}

		this.rerunHeads.clear();

		return(heads);
	}

	private async scanHeadsInto(heads: Set<string>, statuses: KeetaAnchorQueueStatus[], filter?: KeetaAnchorQueueScanFilter): Promise<void> {
		if (this.driver.scanActivePaths === undefined) {
			throw(new Error(`Storage driver ${this.driver.name} does not implement scanActivePaths`));
		}

		const paths = await this.driver.scanActivePaths(statuses, filter);
		for (const path of paths) {
			const head = path[0];
			if (head === undefined) {
				/*
				 * Entries at the driver's own partition have no head to route
				 */
				continue;
			}

			heads.add(head);
		}
	}

	private async collectFastPassHeads(heads: Set<string>): Promise<void> {
		await this.scanHeadsInto(heads, fastPassStatuses);
	}

	private async collectSweepHeads(heads: Set<string>): Promise<void> {
		const now = Date.now();

		const lastSweepAt = this.lastSweepAt;
		const isStartupSweep = lastSweepAt === null;
		if (lastSweepAt !== null && now - lastSweepAt < this.sweepIntervalMs) {
			return;
		}

		this.lastSweepAt = now;

		this.methodLogger('collectSweepHeads')?.debug('Running recovery sweep (startup:', isStartupSweep, ')');

		await this.scanHeadsInto(heads, staleProcessingStatuses, {
			updatedBefore: new Date(now - this.sweepStalenessMs)
		});

		/*
		 * The startup sweep widens the failed-move window to cover process
		 * downtime during which the refresh chain could not run.
		 */
		let window = this.moveRetryWindowMs;
		if (isStartupSweep) {
			window = Math.max(window, this.startupMoveRetryWindowMs);
		}

		await this.scanHeadsInto(heads, moveRetryStatuses, {
			updatedAfter: new Date(now - window)
		});
	}

	private async runOwningUnits(heads: Set<string>): Promise<void> {
		const logger = this.methodLogger('runOwningUnits');

		let processed = 0;
		for (const head of heads) {
			if (!this.running) {
				return;
			}

			const [prefix] = head.split(':', 1);
			if (prefix === undefined) {
				continue;
			}

			const unit = this.unitsByPrefix.get(prefix);
			if (unit === undefined) {
				logger?.debug('No schedulable unit owns partition head', head);
				continue;
			}

			/*
			 * Defer owned heads over the cap so external notifications
			 * interleave with a large backlog instead of waiting a full
			 * iteration out
			 */
			if (processed >= this.maxHeadsPerIteration) {
				this.deferredHeads.add(head);
				continue;
			}

			processed++;
			this.lastRunAtByPrefix.set(prefix, Date.now());

			try {
				const progressRemains = await unit.runPass(this.passBudgetMs);
				if (progressRemains) {
					this.rerunHeads.add(head);
				}
			} catch (error: unknown) {
				logger?.error('Pass for unit with prefix', prefix, 'failed:', error);
			}
		}
	}

	private async deactivateIdleUnits(): Promise<void> {
		const logger = this.methodLogger('deactivateIdleUnits');
		const now = Date.now();

		for (const [prefix, lastRunAt] of this.lastRunAtByPrefix) {
			if (now - lastRunAt < this.idleDeactivateMs) {
				continue;
			}

			const unit = this.unitsByPrefix.get(prefix);
			if (unit === undefined) {
				this.lastRunAtByPrefix.delete(prefix);
				continue;
			}

			logger?.debug('Deactivating idle unit with prefix', prefix);

			try {
				await unit.deactivate();
				this.lastRunAtByPrefix.delete(prefix);
			} catch (error: unknown) {
				logger?.error('Failed to deactivate unit with prefix', prefix, ':', error);
			}
		}
	}
}
