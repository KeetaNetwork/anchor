import {
	KeetaAnchorQueueRunner
} from './index.js';
import type {
	KeetaAnchorQueueStorageDriver,
	KeetaAnchorQueueRequestID,
	KeetaAnchorQueueCommonOptions,
	KeetaAnchorQueueEntry
} from './index.ts';
import { MethodLogger } from './internal.js';
import type { Logger } from '../log/index.ts';
import type { JSONSerializable } from '../utils/json.js';
import type { KeetaAnchorQueueRunOptions } from './common.js';

/**
 * A KeetaAnchorQueueRunner that uses `any` for the user types
 * This is helpful for expressing pipelines where the inputs
 * and outputs of various stages are not known ahead of time
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class KeetaAnchorQueueRunnerAny<UserRequest = any, UserResult = any, QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> extends KeetaAnchorQueueRunner<UserRequest, UserResult, QueueRequest, QueueResult> {
	protected processor(): ReturnType<KeetaAnchorQueueRunner<UserRequest, UserResult, QueueRequest, QueueResult>['processor']> { throw(new Error('not implemented')); }
	protected decodeRequest(): UserRequest { throw(new Error('not implemented')); }
	protected decodeResponse(): UserResult | null { throw(new Error('not implemented')); }
	protected encodeRequest(): QueueRequest { throw(new Error('not implemented')); }
	protected encodeResponse(): QueueResult | null { throw(new Error('not implemented')); }

}

type KeetaAnchorQueuePipelineStage<QueueRequest, QueueResult> = {
	/**
	 * Name of the stage (must be unique within the pipeline)
	 */
	name: string;
	/**
	 * Constructor of the runner to use for this stage
	 */
	runner: typeof KeetaAnchorQueueRunner<QueueRequest, QueueResult, JSONSerializable, JSONSerializable>;
	/**
	 * Arguments to pass to the runner constructor
	 */
	args?: [{ [key: string]: unknown; }?, ...unknown[]];
};

export interface KeetaAnchorQueuePipeline<QueueRequest, FINALQueueResult> {
	readonly id: string;

	/**
	 * Add a new request to the queue pipeline at the first stage
	 *
	 * @param request The request to add
	 * @returns The ID of the newly added request
	 */
	add: (request: QueueRequest) => Promise<KeetaAnchorQueueRequestID>;
	/**
	 * Get the entry of a request at the final stage of the pipeline
	 * stage or `null` if not in the final stage
	 *
	 * The original request is also returned if available
	 *
	 * @param id The ID of the request to get
	 * @returns The entry at the final stage or `null` if not found, with the original request (may be `null` if not available)
	 */
	get: (id: KeetaAnchorQueueRequestID) => Promise<(Omit<KeetaAnchorQueueEntry<QueueRequest, FINALQueueResult>, 'request'> & { request: QueueRequest | null; }) | null>;
	/**
	 * Run the pipeline processing jobs for up to the specified timeout (in milliseconds)
	 * The process may take longer than the timeout if a job is already in progress
	 * when the timeout is reached, in which case the process will complete the current job
	 * before returning.
	 *
	 * @param timeoutMs The maximum time to run the processing jobs (in milliseconds). If not specified, runs until all available jobs are processed.
	 * @returns `true` if there are more jobs to process, `false` otherwise
	 */
	run: (options?: KeetaAnchorQueueRunOptions) => Promise<boolean>;
	/**
	 * Run maintenance tasks for the pipeline -- this includes moving tasks from various states
	 * and between stages of the pipeline
	 */
	maintain: () => Promise<void>;
	/**
	 * Destroy the pipeline and release any resources it allocated
	 */
	destroy: () => Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;
}

const symbolFirst: unique symbol = Symbol('first');
const symbolLast: unique symbol = Symbol('last');

/**
 * Abstract base class for queue advanced pipelines -- this provides
 * a standardized way to implement custom processing pipelines that
 * consist of multiple stages with custom behavior
 */
export abstract class KeetaAnchorQueuePipelineAdvanced<IN1 = unknown, FINALOUT = unknown> implements KeetaAnchorQueuePipeline<IN1, FINALOUT> {
	readonly id: string;
	protected readonly baseQueue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>;
	protected readonly logger?: Logger | undefined;
	protected queues!: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>[];
	protected initPromise?: Promise<void>;
	protected destroyed = false;

	static readonly StageID: {
		readonly first: typeof symbolFirst;
		readonly last: typeof symbolLast;
	} = {
			first: symbolFirst,
			last: symbolLast
		};

	constructor(options: KeetaAnchorQueueCommonOptions & { baseQueue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>; }) {
		this.logger = options.logger;
		this.id = options.id ?? crypto.randomUUID();
		this.baseQueue = options.baseQueue;

		this.queues = [];
	}

	protected methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueuePipelineAdvanced',
			file: 'src/lib/queue/pipeline.ts',
			method: method,
			instanceID: this.id
		}));
	}

	/**
	 * Create the pipeline stages -- will be called by the initialization process
	 */
	protected abstract createPipeline(): Promise<void>;

	/**
	 * Get the stage runner for the specified stage name, or the first/last stage
	 */
	protected abstract getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.first): KeetaAnchorQueueRunner<IN1, unknown>;
	protected abstract getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.last): KeetaAnchorQueueRunner<unknown, FINALOUT>;
	protected abstract getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.first | typeof KeetaAnchorQueuePipelineAdvanced.StageID.last | string): KeetaAnchorQueueRunnerAny | null;

	/**
	 * Create a new queue to use in a pipeline stage
	 * It will be released when the pipeline is destroyed
	 *
	 * @param name The name of the queue
	 * @returns The created queue
	 */
	protected async createQueue(name: string): Promise<KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>> {
		const retval = await this.baseQueue.partition(name);
		this.queues.push(retval);
		return(retval);
	}

	protected async init(): Promise<void> {
		const logger = this.methodLogger('init');

		if (this.destroyed) {
			throw(new Error('Pipeline has been destroyed'));
		}

		if (this.initPromise !== undefined) {
			return(await this.initPromise);
		}

		this.initPromise = (async () => {
			try {
				await this.createPipeline();
			} catch (error) {
				logger?.error('Error initializing pipeline:', error);
				try {
					await this.destroy();
				} catch {
					/* Ignore */
				}
				throw(error);
			}
		})();

		return(await this.initPromise);
	}

	async add(request: IN1): ReturnType<KeetaAnchorQueueRunner<IN1, unknown>['add']> {
		await this.init();

		const stage1 = this.getStage(KeetaAnchorQueuePipelineAdvanced.StageID.first);

		return(await stage1.add(request));
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<(Omit<KeetaAnchorQueueEntry<IN1, FINALOUT>, 'request'> & { request: IN1 | null; }) | null> {
		await this.init();

		const firstStage = this.getStage(KeetaAnchorQueuePipelineAdvanced.StageID.first);
		const finalStage = this.getStage(KeetaAnchorQueuePipelineAdvanced.StageID.last);
		const firstEntry = await firstStage.get(id);
		const finalOutput = await finalStage.get(id);

		if (finalOutput === null) {
			return(null);
		}

		return({
			...finalOutput,
			request: firstEntry?.request ?? null
		});
	}

	async run(options?: KeetaAnchorQueueRunOptions): Promise<boolean> {
		await this.init();

		const logger = this.methodLogger('run');

		const stage1 = this.getStage(KeetaAnchorQueuePipelineAdvanced.StageID.first);
		let retval = true;
		try {
			retval = await stage1.run(options);
		} catch (error) {
			logger?.error('Error running stage processor:', error);
		}

		return(retval);
	}

	async maintain(): Promise<void> {
		await this.init();

		const logger = this.methodLogger('maintain');

		const stage1 = this.getStage(KeetaAnchorQueuePipelineAdvanced.StageID.first);
		try {
			await stage1.maintain();
		} catch (error) {
			logger?.error('Error running stage maintenance:', error);
		}
	}

	async destroy(): Promise<void> {
		const logger = this.methodLogger('destroy');

		if (this.destroyed) {
			return;
		}
		this.destroyed = true;

		await this.init();

		for (let index = 0; index < this.queues.length; index++) {
			const queue = this.queues[index];
			if (queue === undefined) {
				continue;
			}
			try {
				logger?.debug(`Destroying queue for stage "#${index}"`);
				await queue.destroy();
			} catch (error) {
				logger?.error(`Error destroying queue for stage "#${index}:`, error);
			}
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		const logger = this.methodLogger('asyncDispose');
		try {
			await this.destroy();
		} catch (error) {
			logger?.error('Error during async dispose:', error);
		}
	}

}
/**
 * Abstract base class for queue basic pipelines -- this provides
 * a standardized way to implement custom processing pipelines that
 * consist of multiple stages but do not require batching
 */
export abstract class KeetaAnchorQueuePipelineBasic<IN1 = unknown, FINALOUT = unknown, OUT1 = unknown, OUT2 = unknown, OUT3 = unknown, OUT4 = unknown, OUT5 = unknown, OUT6 = unknown, OUT7 = unknown, OUT8 = unknown, OUT9 = unknown, OUT10 = unknown> extends KeetaAnchorQueuePipelineAdvanced<IN1, FINALOUT> implements KeetaAnchorQueuePipeline<IN1, FINALOUT> {
	protected readonly abstract stages: readonly [
		KeetaAnchorQueuePipelineStage<IN1, OUT1>,
		KeetaAnchorQueuePipelineStage<OUT1, OUT2>?,
		KeetaAnchorQueuePipelineStage<OUT2, OUT3>?,
		KeetaAnchorQueuePipelineStage<OUT3, OUT4>?,
		KeetaAnchorQueuePipelineStage<OUT4, OUT5>?,
		KeetaAnchorQueuePipelineStage<OUT5, OUT6>?,
		KeetaAnchorQueuePipelineStage<OUT6, OUT7>?,
		KeetaAnchorQueuePipelineStage<OUT7, OUT8>?,
		KeetaAnchorQueuePipelineStage<OUT8, OUT9>?,
		KeetaAnchorQueuePipelineStage<OUT9, OUT10>?
	];

	protected stageRunners!: [
		KeetaAnchorQueueRunner<IN1, OUT1>,
		KeetaAnchorQueueRunner<OUT1, OUT2>?,
		KeetaAnchorQueueRunner<OUT2, OUT3>?,
		KeetaAnchorQueueRunner<OUT3, OUT4>?,
		KeetaAnchorQueueRunner<OUT4, OUT5>?,
		KeetaAnchorQueueRunner<OUT5, OUT6>?,
		KeetaAnchorQueueRunner<OUT6, OUT7>?,
		KeetaAnchorQueueRunner<OUT7, OUT8>?,
		KeetaAnchorQueueRunner<OUT8, OUT9>?,
		KeetaAnchorQueueRunner<OUT9, OUT10>?
	];

	constructor(options: KeetaAnchorQueueCommonOptions & { baseQueue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>; }) {
		super(options);

		/*
		 * We start out with no stages, but the createPipeline method
		 * will be run during initialization to set them up
		 */
		// @ts-ignore
		this.stageRunners = [];
	}

	protected methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueuePipelineBasic',
			file: 'src/lib/queue/pipeline.ts',
			method: method,
			instanceID: this.id
		}));
	}

	protected getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.first): KeetaAnchorQueueRunner<IN1, unknown>;
	protected getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.last): KeetaAnchorQueueRunner<unknown, FINALOUT>;
	protected getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.first | typeof KeetaAnchorQueuePipelineAdvanced.StageID.last | string): KeetaAnchorQueueRunnerAny | null;
	protected getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.first | typeof KeetaAnchorQueuePipelineAdvanced.StageID.last | string): KeetaAnchorQueueRunnerAny | KeetaAnchorQueueRunner<IN1, unknown> | KeetaAnchorQueueRunner<unknown, FINALOUT> | null {
		if (this.initPromise === undefined) {
			throw(new Error('Pipeline not initialized'));
		}

		if (stageID === KeetaAnchorQueuePipelineAdvanced.StageID.first) {
			const runner = this.stageRunners[0];
			if (runner !== undefined) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				return(runner as unknown as KeetaAnchorQueueRunner<IN1, unknown>);
			}
			throw(new Error('First stage runner not found'));
		} else if (stageID === KeetaAnchorQueuePipelineAdvanced.StageID.last) {
			for (let index = this.stageRunners.length - 1; index >= 0; index--) {
				const runner = this.stageRunners[index];
				if (runner !== undefined) {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					return(runner as unknown as KeetaAnchorQueueRunner<unknown, FINALOUT>);
				}
			}
			throw(new Error('Last stage runner not found'));
		} else {
			for (let index = 0; index < this.stages.length; index++) {
				const stage = this.stages[index];
				if (stage?.name === stageID) {
					const runner = this.stageRunners[index];
					if (runner !== undefined) {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						return(runner as KeetaAnchorQueueRunnerAny);
					}
				}
			}
			return(null);
		}
	}

	/**
	 * Create the pipeline from the user-defined stages
	 */
	protected async createPipeline(): Promise<void> {
		const logger = this.methodLogger('init');

		let lastRunner: InstanceType<typeof KeetaAnchorQueueRunnerAny> | undefined = undefined;
		for (const stage of this.stages) {
			if (stage === undefined) {
				break;
			}

			try {
				logger?.debug(`Initializing queue for stage "${stage.name}"`);
				const queue = await this.createQueue(stage.name);

				logger?.debug(`Initializing stage processor for stage "${stage.name}"`);

				/**
				 * We have to use this type because we cannot express the relationship
				 * between the various generic types in the stages array and the stageRunners array
				 */
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				const runnerClass = stage.runner as typeof KeetaAnchorQueueRunnerAny;
				const runnerArgsFirst = stage.args?.[0];
				const runnerArgs0: ConstructorParameters<typeof KeetaAnchorQueueRunnerAny>[0] = {
					id: `${this.id}::runner::${stage.name}`,
					queue: queue,
					logger: this.logger,
					...runnerArgsFirst
				};
				const runnerArgs = [runnerArgs0, ...(stage.args?.slice(1) ?? [])] as const;

				/*
				 * We check the first parameter's type above, but all the remaining
				 * parameters are user-defined and we cannot validate them here
				 * so we cast to the tuple `any` type to avoid type checking
				 */
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-argument
				const runner = new runnerClass(...runnerArgs as [any]);

				/*
				 * The type assertions here are necessary because we cannot
				 * express the relationship between the various generic
				 * types in the stages array and the stageRunners array
				 */
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-argument
				this.stageRunners.push(runner as any);

				lastRunner?.pipe(runner);

				lastRunner = runner;
			} catch (error) {
				logger?.error(`Error initializing stage processor for stage "${stage.name}":`, error);
				this.destroy().catch(function() { /* do nothing */ });
			}
		}
	}

	async destroy(): Promise<void> {
		const logger = this.methodLogger('destroy');

		if (this.destroyed) {
			return;
		}
		this.destroyed = true;

		for (let index = 0; index < this.stageRunners.length; index++) {
			const runner = this.stageRunners[index];
			const stage = this.stages[index] ?? { name: '' };
			if (runner === undefined) {
				continue;
			}

			try {
				logger?.debug(`Destroying stage processor for stage "${stage.name}"`);
				await runner.destroy();
			} catch (error) {
				logger?.error(`Error destroying stage processor for stage "${stage.name}":`, error);
			}
		}

		await super.destroy();
	}
}
