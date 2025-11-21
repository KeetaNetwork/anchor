import { KeetaAnchorQueueStorageDriverMemory } from '../index.js';
import { MethodLogger } from '../internal.js';
import * as fs from 'fs';
import type { Logger } from '../../log/index.ts';

export class KeetaAnchorQueueStorageDriverFile extends KeetaAnchorQueueStorageDriverMemory {
	private readonly filePath: string;
	private syncInProgress: Promise<void> | null = null;
	readonly name = 'KeetaAnchorQueueStorageDriverFile';

	constructor(options: NonNullable<ConstructorParameters<typeof KeetaAnchorQueueStorageDriverMemory>[0]> & { filePath: string }) {
		super(options);
		this.filePath = options.filePath;
		this.loadFile();
	}

	protected methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueStorageDriverMemory',
			file: 'src/lib/queue/index.ts',
			method: method,
			instanceID: this.id
		}));
	}

	private loadFile(): void {
		if (!fs.existsSync(this.filePath)) {
			return;
		}

		const input = fs.readFileSync(this.filePath, 'utf-8');
		const parsed: unknown = JSON.parse(input, function(key, inputValue) {
			let nominalValue = this[key];
			if (key === 'created' || key === 'updated') {
				nominalValue = new Date(nominalValue);
			}
			if (key === 'parents' && Array.isArray(inputValue)) {
				nominalValue = new Set(inputValue);
			}
			return(nominalValue);
		});
		const data = parsed as { queue: InstanceType<typeof KeetaAnchorQueueStorageDriverMemory>['queue'] };
		Object.assign(this.queue, data.queue);
	}

	private async syncFile(): Promise<void> {
		await this.syncInProgress;
		this.syncInProgress = new Promise<void>(async (resolve) => {
			const tmpFilePath = `${this.filePath}.${crypto.randomUUID()}`;
			try {
				fs.writeFileSync(tmpFilePath, JSON.stringify({
					queue: this.queue
				}, function(key, inputValue) {
					if (key === 'created' || key === 'updated') {
						if (inputValue instanceof Date) {
							return(inputValue.toISOString());
						}
					}
					if (key === 'parents' && inputValue instanceof Set) {
						return(Array.from(inputValue));
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
				resolve();
			}
		});
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
