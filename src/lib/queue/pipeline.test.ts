import { test, expect } from 'vitest';
import type { Logger } from '../log/index.ts';

import { KeetaAnchorQueuePipelineBasic } from './pipeline.js';
import { KeetaAnchorQueueRunnerJSON, KeetaAnchorQueueStorageDriverMemory } from './index.js';
import type {
	KeetaAnchorQueueEntry
} from './index.ts';

const DEBUG = true;
let logger: Logger | undefined = undefined;
if (DEBUG) {
	logger = console;
}

test('Basic Tests', async function() {
	await using queue = new KeetaAnchorQueueStorageDriverMemory({
		id: 'test-memory-driver',
		logger: logger
	});

	type IN1 = { value: number; };
	type OUT1 = { value: number; doubled: number; };
	type IN2 = OUT1;
	type OUT2 = { value: number; doubled: number; length: number; };

	await using pipeline = new class extends KeetaAnchorQueuePipelineBasic<IN1, OUT2, OUT1, OUT2> {
		protected readonly stages = [{
			name: 'doubler',
			runner: class extends KeetaAnchorQueueRunnerJSON<IN1, OUT1> {
				protected async processor(entry: KeetaAnchorQueueEntry<IN1, OUT1>): Promise<{ status: 'completed'; output: OUT1; }> {
					return({
						status: 'completed',
						output: {
							...entry.request,
							doubled: entry.request.value * 2
						}
					});
				};
			}
		}, {
			name: 'length-calculator',
			runner: class extends KeetaAnchorQueueRunnerJSON<IN2, OUT2> {
				protected async processor(entry: KeetaAnchorQueueEntry<IN2, OUT2>): Promise<{ status: 'completed'; output: OUT2; }> {
					return({
						status: 'completed',
						output: {
							...entry.request,
							doubled: entry.request.value * 2,
							length: String(entry.request.value).length
						}
					});
				};
			}
		}] as const;

		constructor() {
			super({
				id: 'test-pipeline',
				baseQueue: queue,
				logger: logger
			});
		}
	}();

	const id1 = await pipeline.add({
		value: 10
	});
	const id2 = await pipeline.add({
		value: 93939
	});

	for (let i = 0; i < 20; i++) {
		await pipeline.run();
		await pipeline.maintain();
	}

	const result1 = await pipeline.get(id1);
	expect(result1?.output).toEqual({ value: 10, doubled: 20, length: 2 });
	const result2 = await pipeline.get(id2);
	expect(result2?.output).toEqual({ value: 93939, doubled: 187878, length: 5 });
});
