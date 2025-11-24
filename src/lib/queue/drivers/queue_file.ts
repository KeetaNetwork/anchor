import { KeetaAnchorQueueStorageDriverMemory } from '../index.js';
import { MethodLogger } from '../internal.js';
import type { Logger } from '../../log/index.ts';

import * as fs from 'fs';

export class KeetaAnchorQueueStorageDriverFile extends KeetaAnchorQueueStorageDriverMemory {
	private readonly filePath: string;
	private syncInProgress: Promise<void> | null = null;
	readonly name = 'KeetaAnchorQueueStorageDriverFile';

	constructor(options: NonNullable<ConstructorParameters<typeof KeetaAnchorQueueStorageDriverMemory>[0]> & { filePath: string }) {
		super(options);
		this.filePath = options.filePath;
		this.loadFile();
	}

	protected clone(options?: Partial<ConstructorParameters<typeof KeetaAnchorQueueStorageDriverFile>[0]>): KeetaAnchorQueueStorageDriverFile {
		const cloned = new KeetaAnchorQueueStorageDriverFile({
			logger: this.logger,
			id: `${this.id}::${this.partitionCounter++}`,
			path: [...this.path],
			filePath: this.filePath,
			...options
		});
		cloned.queueStorage = this.queueStorage;

		return(cloned);
	}

	protected methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueStorageDriverFile',
			file: 'src/lib/queue/drivers/queue_file.ts',
			method: method,
			instanceID: this.id
		}));
	}

	private loadFile(): void {
		if (!fs.existsSync(this.filePath)) {
			return;
		}

		const input = fs.readFileSync(this.filePath, 'utf-8');
		const parsed: unknown = JSON.parse(input, function(this: { [key: string]: unknown }, key, inputValue) {
			let nominalValue: unknown = this[key];
			if (key === 'created' || key === 'updated') {
				if (typeof nominalValue === 'string' || typeof nominalValue === 'number') {
					nominalValue = new Date(nominalValue);
				}
			}
			if (key === 'idempotentIDs' && Array.isArray(inputValue)) {
				nominalValue = new Set(inputValue);
			}
			return(nominalValue);
		});
		if (typeof parsed !== 'object' || parsed === null || !('queue' in parsed)) {
			throw(new Error('Invalid queue file format'));
		}
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const data = parsed as { queue: InstanceType<typeof KeetaAnchorQueueStorageDriverMemory>['queue'] };
		Object.assign(this.queueStorage, data.queue);
	}

	private async syncFile(): Promise<void> {
		await this.syncInProgress;
		this.syncInProgress = (async (): Promise<void> => {
			const tmpFilePath = `${this.filePath}.${crypto.randomUUID()}`;
			try {
				fs.writeFileSync(tmpFilePath, JSON.stringify({
					queue: this.queueStorage
				}, function(key, inputValue: unknown): unknown {
					if (key === 'created' || key === 'updated') {
						if (inputValue instanceof Date) {
							return(inputValue.toISOString());
						}
					}
					if (key === 'idempotentIDs') {
						if (inputValue instanceof Set) {
							return(Array.from(inputValue));
						}
					}
					return(inputValue);
				}, 2), 'utf-8');
				fs.renameSync(tmpFilePath, this.filePath);
			} finally {
				try {
					fs.unlinkSync(tmpFilePath);
				} catch {
					/* Ignore */
				}
			}
		})();
		await this.syncInProgress;
	}

	async add(...args: Parameters<KeetaAnchorQueueStorageDriverMemory['add']>): ReturnType<KeetaAnchorQueueStorageDriverMemory['add']> {
		const retval = await super.add(...args);

		await this.syncFile();

		return(retval);
	}

	async setStatus(...args: Parameters<KeetaAnchorQueueStorageDriverMemory['setStatus']>): ReturnType<KeetaAnchorQueueStorageDriverMemory['setStatus']> {
		const retval = await super.setStatus(...args);

		await this.syncFile();

		return(retval);
	}
}
