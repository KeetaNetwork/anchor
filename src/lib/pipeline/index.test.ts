import { test, expect } from 'vitest';
import { KeetaAnchorPipeline } from './index.js';
import {
	KeetaAnchorQueueRunnerJSON,
	KeetaAnchorQueueStorageDriverMemory
} from '../queue/index.js';
import type {
	KeetaAnchorQueueEntry
} from '../queue/index.ts';
import type { Logger } from '../log/index.ts';
import type { JSONSerializable } from '../utils/json.ts';

const DEBUG = false;
let logger: Logger | undefined = undefined;
if (DEBUG) {
	logger = console;
}

type Stage1RequestType = {
	message: string;
	counter: number;
};
type Stage1ResponseType = number;
type Stage2RequestType = Stage1ResponseType;
type Stage2ResponseType = {
	success: boolean;
	counter: number;
}
type Stage3RequestType = Stage2ResponseType;
type Stage3ResponseType = {
	finalMessage: string;
	counter: number;
}

test('Pipeline Basic Test', async function() {
	function createStage<INPUT extends JSONSerializable, OUTPUT extends JSONSerializable>(name: string, processor: (entry: KeetaAnchorQueueEntry<INPUT, OUTPUT>) => Promise<{ status: 'completed'; output: OUTPUT; }>) {
		return({
			name: name,
			runner: new KeetaAnchorQueueRunnerJSON<INPUT, OUTPUT>({
				id: `${name}_runner`,
				processor: processor,
				queue: new KeetaAnchorQueueStorageDriverMemory({
					id: `${name}_queue`,
					logger: logger
				}),
				logger: logger
			})
		});
	}

	let callCount = 0;
	await using pipeline = new KeetaAnchorPipeline([
		createStage<Stage1RequestType, Stage1ResponseType>('stage1', async function(entry) {
			callCount++;
			return({ status: 'completed', output: entry.request.counter + 1 });
		}),
		createStage<Stage2RequestType, Stage2ResponseType>('stage2', async function(entry) {
			callCount++;
			if (callCount < 5) {
				// Simulate needing multiple runs to complete processing
				throw(new Error('Simulated processing error'));
			}
			return({ status: 'completed', output: { success: true, counter: entry.request + 1 }});
		}),
		createStage<Stage3RequestType, Stage3ResponseType>('stage3', async function(entry) {
			callCount++;
			return({ status: 'completed', output: { finalMessage: `Final counter is ${entry.request.counter}`, counter: entry.request.counter + 1 }});
		})
	], {
		logger: logger
	});

	/*
	 * Add an entry to the pipeline and run it multiple times to allow for retries
	 */
	const originalID = await pipeline.add({
		message: 'Start processing',
		counter: 0
	});
	for (let retry = 0; retry < 10; retry++) {
		await pipeline.run();
		await pipeline.maintain();
	}

	const finalStage = pipeline._testingGetStageByName('bc81abf8-e43b-490b-b486-744fb49a5082', 'stage3');
	if (!finalStage) {
		throw(new Error('internal error: No final stage'));
	}
	const finalStageEntries = await finalStage.runner.query({
		status: 'completed'
	});
	expect(finalStageEntries.length).toBe(1);
	const finalStageEntry: { output: Stage3ResponseType; id: unknown; } | undefined = finalStageEntries[0];
	if (!finalStageEntry) {
		throw(new Error('internal error: No final stage entry'));
	}
	expect(finalStageEntry.output.finalMessage).toBe('Final counter is 2');
	expect(finalStageEntry.output.counter).toBe(3);
	expect(finalStageEntry.id).toBe(originalID);
});
