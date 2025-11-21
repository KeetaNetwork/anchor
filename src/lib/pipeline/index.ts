import type {
	KeetaAnchorQueueRunner,
	KeetaAnchorQueueStorageDriver,
	KeetaAnchorQueueRequestID
} from '../queue/index.ts';
import type { Logger } from '../log/index.ts';

type KeetaAnchorPipelineOptions = {
	logger?: Logger | undefined;
};

/*
 * This type alias is for cases where we don't know the exact type of a stage
 * in the pipeline, but want to work with it in a generic way.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeetaAnchorQueueRunnerAny = KeetaAnchorQueueRunner<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeetaAnchorQueueStorageDriverAny = KeetaAnchorQueueStorageDriver<any, any>;

export class KeetaAnchorPipeline {
	private stages: { name: string; runner: KeetaAnchorQueueRunner }[]
	private logger?: Logger | undefined;
	private pipes: (KeetaAnchorPipeline | KeetaAnchorQueueRunnerAny | KeetaAnchorQueueStorageDriverAny)[] = [];
	private pipeBatches: { next: KeetaAnchorPipeline | KeetaAnchorQueueRunnerAny | KeetaAnchorQueueStorageDriverAny; maxBatchSize: number; minBatchSize: number; }[] = [];

	readonly id: string;

	constructor(stages: { name: string; runner: KeetaAnchorQueueRunnerAny }[], options?: KeetaAnchorPipelineOptions) {
		this.id = crypto.randomUUID();
		this.stages = stages;
		this.logger = options?.logger;
	}

	/**
	 * Add a new request to the first stage in the pipeline
	 */
	async add(input: unknown, id?: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueRequestID> {
		const firstStage = this.stages[0];
		if (!firstStage) {
			throw(new Error('Pipeline has no stages'));
		}
		return(await firstStage.runner.add(input, { id }));
	}

	private getLastStage(): { name: string; runner: KeetaAnchorQueueRunner } {
		const lastStage = this.stages[this.stages.length - 1];
		if (!lastStage) {
			throw(new Error('Pipeline has no stages'));
		}

		return(lastStage);
	}

	/**
	 * Query the last stage in the pipeline
	 */
	async query(...args: Parameters<KeetaAnchorQueueRunnerAny['query']>): Promise<ReturnType<KeetaAnchorQueueRunnerAny['query']>> {
		const lastStage = this.getLastStage();

		return(await lastStage.runner.query(...args));
	}

	/** @internal */
	_testingStages(key: string): { name: string; runner: KeetaAnchorQueueRunner }[] {
		if (key !== 'bc81abf8-e43b-490b-b486-744fb49a5082') {
			throw(new Error('This is a testing only method'));
		}
		return(this.stages);
	}

	/** @internal */
	_testingGetStageByName(key: string, name: string): { name: string; runner: KeetaAnchorQueueRunnerAny } | null {
		if (key !== 'bc81abf8-e43b-490b-b486-744fb49a5082') {
			throw(new Error('This is a testing only method'));
		}
		const stageIndex = this.getStageIndexByName(name);
		if (stageIndex === null) {
			return(null);
		}

		return(this.stages[stageIndex] ?? null);
	}

	private getStageIndexByName(name: string): number | null {
		const stageIndex = this.stages.findIndex(function(stage) {
			return(stage.name === name);
		});

		if (stageIndex === -1) {
			return(null);
		}

		return(stageIndex);
	}

	private getNextStageByName(name: string): { name: string; runner: KeetaAnchorQueueRunner } | null {
		const stageIndex = this.getStageIndexByName(name);
		if (stageIndex === null) {
			return(null);
		}

		const nextStage = this.stages[stageIndex + 1];
		if (!nextStage) {
			return(null);
		}

		return(nextStage);
	}

	private async moveOutputsToNextStage(currentStage: { name: string; runner: KeetaAnchorQueueRunner }): Promise<void> {
		const batchSize = 100;

		/*
		 * Get the next stage in the pipeline
		 */
		const nextStage = this.getNextStageByName(currentStage.name);

		this.logger?.debug('KeetaAnchorPipeline::moveOutputsToNextStage', `Moving outputs from stage: ${currentStage.name} to next stage ${nextStage?.name ?? '<final>'}`);

		/*
		 * If there is no next stage, the pipeline is complete and there is nothing to do
		 */
		if (!nextStage) {
			return;
		}

		/*
		 * Get all the completed entries from the current stage
		 */
		const completedEntries = await currentStage.runner.query({ status: 'completed', limit: batchSize });
		for (const entry of completedEntries) {
			this.logger?.debug('KeetaAnchorPipeline::moveOutputsToNextStage', `Moving request ID: ${String(entry.id)} to next stage: ${nextStage.name}`);

			/*
			 * Add the output of the current stage to the next stage
			 *
			 * Use the same ID as the current entry so that if there
			 * is an error adding it to the next stage, we can retry without
			 * duplicating entries.
			 */
			await nextStage.runner.add(entry.output, { id: entry.id });

			/*
			 * Remove the entry from the current stage
			 */
			await currentStage.runner.setStatus(entry.id, 'moved', {
				oldStatus: 'completed'
			});
		}
	}

	private async runPipes(): Promise<this> {
		const lastStage = this.getLastStage();
		const completedRequests = await lastStage.runner.query({ status: 'completed' });
		for (const request of completedRequests) {
			for (const pipe of this.pipes) {
				await pipe.add(request.output, request.id);
			}

			await lastStage.runner.setStatus(request.id, 'moved', { oldStatus: 'completed' });
		}

		return(this);
	}

	async run(): Promise<boolean> {
		let retval = false;
		for (const stage of this.stages) {
			this.logger?.info('KeetaAnchorPipline::run', `Running stage: ${stage.name}`);
			const stageHasMoreRequests = await stage.runner.run();
			if (stageHasMoreRequests) {
				retval = true;
			}

			await this.moveOutputsToNextStage(stage);
			await this.runPipes();
		}

		return(retval);
	}

	async maintain(): Promise<void> {
		for (const stage of this.stages) {
			this.logger?.info('KeetaAnchorPipline::maintain', `Maintaining stage: ${stage.name}`);
			await stage.runner.maintain();
		}
	}

	pipe(nextPiplineOrQueue: KeetaAnchorPipeline | KeetaAnchorQueueRunnerAny | KeetaAnchorQueueStorageDriverAny): this {
		this.pipes.push(nextPiplineOrQueue);
		return(this);
	}

	pipeBatch(nextPiplineOrQueue: KeetaAnchorPipeline | KeetaAnchorQueueRunnerAny | KeetaAnchorQueueStorageDriverAny, maxBatchSize: number = 100, minBatchSize = 0): this {
		this.pipeBatches.push({ next: nextPiplineOrQueue, maxBatchSize: maxBatchSize, minBatchSize: minBatchSize });
		return(this);
	}

	async destroy(): Promise<void> {
		/* Nothing to do */
	}

	async [Symbol.asyncDispose](): Promise<void> {
		return(await this.destroy());
	}
}
