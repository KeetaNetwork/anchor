import type {
	KeetaAnchorQueueStorageDriver,
	KeetaAnchorQueueStorageDriverConstructor,
	KeetaAnchorQueueRequest,
	KeetaAnchorQueueRequestID,
	KeetaAnchorQueueEntry,
	KeetaAnchorQueueEntryExtra,
	KeetaAnchorQueueEntryAncillaryData,
	KeetaAnchorQueueStatus,
	KeetaAnchorQueueFilter,
	KeetaAnchorQueueWorkerID
} from '../index.ts';
import {
	MethodLogger,
	ManageStatusUpdates,
	ConvertStringToRequestID
} from '../internal.js';
import { Errors } from '../common.js';

import type { Logger } from '../../log/index.ts';
import type { JSONSerializable } from '../../utils/json.js';
import { asleep } from '../../utils/asleep.js';

import type { Firestore, DocumentData, CollectionReference, Query } from '@google-cloud/firestore';

type QueueEntryDocument = {
	id: string;
	request: string;
	output: string | null;
	lastError: string | null;
	status: KeetaAnchorQueueStatus;
	created: number;
	updated: number;
	worker: number | null;
	failures: number;
	idempotentKeys?: string[];
};

export default class KeetaAnchorQueueStorageDriverFirestore<QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult> {
	private readonly logger: Logger | undefined;
	private firestoreInternal: (() => Promise<Firestore>) | null = null;

	readonly name = 'KeetaAnchorQueueStorageDriverFirestore';
	readonly id: string;
	readonly path: string[] = [];
	private readonly pathStr: string;
	private readonly collectionPrefix: string;
	private toctouDelay: (() => Promise<void>) | undefined = undefined;

	constructor(options: NonNullable<ConstructorParameters<KeetaAnchorQueueStorageDriverConstructor<QueueRequest, QueueResult>>[0]> & { firestore: () => Promise<Firestore>; }) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger;
		this.firestoreInternal = options.firestore;
		this.path = options.path ?? [];
		this.pathStr = ['root', ...this.path].join('.');
		this.collectionPrefix = `${this.id}_${this.pathStr}`;
		Object.freeze(this.path);

		this.methodLogger('new')?.debug('Initialized Firestore queue storage driver');
	}

	private methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueStorageDriverFirestore',
			file: 'src/lib/queue/drivers/queue_firestore.ts',
			method: method,
			instanceID: this.id
		}));
	}

	private async getFirestore(): Promise<Firestore> {
		if (this.firestoreInternal === null) {
			throw(new Error('Firestore connection is not available'));
		}
		return(await this.firestoreInternal());
	}

	private async getCollection(): Promise<CollectionReference<DocumentData>> {
		const firestore = await this.getFirestore();
		return(firestore.collection(`queue_entries_${this.collectionPrefix}`));
	}

	private async getIdempotentCollection(): Promise<CollectionReference<DocumentData>> {
		const firestore = await this.getFirestore();
		return(firestore.collection(`queue_idempotent_keys_${this.collectionPrefix}`));
	}

	async add(request: KeetaAnchorQueueRequest<QueueRequest>, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		const firestore = await this.getFirestore();
		const collection = await this.getCollection();
		const idempotentCollection = await this.getIdempotentCollection();
		const logger = this.methodLogger('add');

		let entryID = ConvertStringToRequestID(info?.id);
		entryID ??= ConvertStringToRequestID(crypto.randomUUID());

		logger?.debug(`Enqueuing request with id ${String(entryID)}`);

		const currentTime = Date.now();
		const requestJSON = JSON.stringify(request);

		/**
		 * The status to use for the new entry
		 */
		const status = info?.status ?? 'pending';

		const entryData: QueueEntryDocument = {
			id: String(entryID),
			request: requestJSON,
			output: null,
			lastError: null,
			status: status,
			created: currentTime,
			updated: currentTime,
			worker: null,
			failures: 0
		};

		const idempotentIDs = info?.idempotentKeys;
		if (idempotentIDs && idempotentIDs.size > 0) {
			entryData.idempotentKeys = Array.from(idempotentIDs).map(String);
		}

		await this.toctouDelay?.();

		// Use Firestore transaction for atomicity
		const result = await firestore.runTransaction(async (transaction) => {
			const docRef = collection.doc(String(entryID));
			const docSnapshot = await transaction.get(docRef);

			if (docSnapshot.exists) {
				logger?.debug(`Request with id ${String(entryID)} already exists, ignoring`);
				return(entryID);
			}

			// Check idempotent keys
			if (idempotentIDs && idempotentIDs.size > 0) {
				const matchingIdempotentEntries = new Set<KeetaAnchorQueueRequestID>();
				for (const idempotentID of idempotentIDs) {
					const idempotentDocRef = idempotentCollection.doc(String(idempotentID));
					const idempotentSnapshot = await transaction.get(idempotentDocRef);
					if (idempotentSnapshot.exists) {
						matchingIdempotentEntries.add(idempotentID);
					}
				}

				if (matchingIdempotentEntries.size !== 0) {
					throw(new Errors.IdempotentExistsError('One or more idempotent entries already exist in the queue', matchingIdempotentEntries));
				}
			}

			// Create entry
			transaction.set(docRef, entryData);

			// Create idempotent keys
			if (idempotentIDs && idempotentIDs.size > 0) {
				for (const idempotentID of idempotentIDs) {
					const idempotentDocRef = idempotentCollection.doc(String(idempotentID));
					transaction.set(idempotentDocRef, {
						entryId: String(entryID),
						idempotentId: String(idempotentID)
					});
				}
			}

			return(entryID);
		});

		return(result);
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<QueueResult>): Promise<void> {
		const firestore = await this.getFirestore();
		const collection = await this.getCollection();
		const logger = this.methodLogger('setStatus');
		const { oldStatus } = ancillary ?? {};

		await firestore.runTransaction(async (transaction) => {
			const docRef = collection.doc(String(id));
			const docSnapshot = await transaction.get(docRef);

			if (!docSnapshot.exists) {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}

			await this.toctouDelay?.();

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const currentEntry = docSnapshot.data() as QueueEntryDocument;
			if (!currentEntry) {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}

			const currentEntryForUpdate = {
				status: currentEntry.status,
				failures: currentEntry.failures,
				last_error: currentEntry.lastError,
				output: currentEntry.output
			};

			const newEntry = ManageStatusUpdates<QueueResult>(id, currentEntryForUpdate, status, ancillary, logger);
			const currentTime = newEntry.updated.getTime();
			const workerValue = newEntry.worker;
			const newFailures = newEntry.failures ?? currentEntry.failures;
			const newLastError = newEntry.lastError !== undefined ? newEntry.lastError : currentEntry.lastError;
			const newOutput = newEntry.output !== undefined ? JSON.stringify(newEntry.output) : currentEntry.output;

			if (oldStatus && currentEntry.status !== oldStatus) {
				throw(new Errors.IncorrectStateAssertedError(id, oldStatus, currentEntry.status));
			}

			transaction.update(docRef, {
				status: status,
				updated: currentTime,
				worker: workerValue,
				failures: newFailures,
				lastError: newLastError,
				output: newOutput
			});
		});
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> {
		const collection = await this.getCollection();
		const idempotentCollection = await this.getIdempotentCollection();

		const docRef = collection.doc(String(id));
		const docSnapshot = await docRef.get();

		if (!docSnapshot.exists) {
			return(null);
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const entry = docSnapshot.data() as QueueEntryDocument;
		if (!entry) {
			return(null);
		}

		// Get idempotent keys
		const idempotentQuery = await idempotentCollection.where('entryId', '==', String(id)).get();
		const idempotentKeys = idempotentQuery.empty
			? undefined
			: new Set(idempotentQuery.docs.map((doc) => {
				const data = doc.data();
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				return(ConvertStringToRequestID(data['idempotentId'] as string));
			}));

		return({
			id: ConvertStringToRequestID(entry.id),
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			request: JSON.parse(entry.request) as QueueRequest,
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			output: entry.output ? JSON.parse(entry.output) as QueueResult : null,
			lastError: entry.lastError,
			status: entry.status,
			created: new Date(entry.created),
			updated: new Date(entry.updated),
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			worker: entry.worker as unknown as KeetaAnchorQueueWorkerID | null,
			failures: entry.failures,
			idempotentKeys: idempotentKeys
		});
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> {
		const collection = await this.getCollection();
		const idempotentCollection = await this.getIdempotentCollection();
		const logger = this.methodLogger('query');

		logger?.debug(`Querying queue with id ${this.id} with filter:`, filter);

		let query: Query<DocumentData> | CollectionReference<DocumentData> = collection.orderBy('updated');

		if (filter?.status) {
			query = query.where('status', '==', filter.status);
		}

		if (filter?.updatedBefore) {
			query = query.where('updated', '<', filter.updatedBefore.getTime());
		}

		if (filter?.limit !== undefined) {
			query = query.limit(filter.limit);
		}

		const querySnapshot = await query.get();

		const entries: KeetaAnchorQueueEntry<QueueRequest, QueueResult>[] = [];

		for (const doc of querySnapshot.docs) {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const row = doc.data() as QueueEntryDocument;

			// Get idempotent keys for this entry
			const idempotentQuery = await idempotentCollection.where('entryId', '==', row.id).get();
			const idempotentKeys = idempotentQuery.empty
				? undefined
				: new Set(idempotentQuery.docs.map((idempotentDoc) => {
					const data = idempotentDoc.data();
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					return(ConvertStringToRequestID(data['idempotentId'] as string));
				}));

			entries.push({
				id: ConvertStringToRequestID(row.id),
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				request: JSON.parse(row.request) as QueueRequest,
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				output: row.output ? JSON.parse(row.output) as QueueResult : null,
				lastError: row.lastError,
				status: row.status,
				created: new Date(row.created),
				updated: new Date(row.updated),
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				worker: row.worker as unknown as KeetaAnchorQueueWorkerID | null,
				failures: row.failures,
				idempotentKeys: idempotentKeys
			});
		}

		logger?.debug(`Queried queue with id ${this.id} with filter:`, filter, '-- found', entries.length, 'entries');

		return(entries);
	}

	async partition(path: string): Promise<KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>> {
		this.methodLogger('partition')?.debug(`Creating partitioned queue storage driver for path: ${path}`);

		if (this.firestoreInternal === null) {
			throw(new Error('Asked to partition but the instance has been destroyed'));
		}

		const retval = new KeetaAnchorQueueStorageDriverFirestore<QueueRequest, QueueResult>({
			id: `${this.id}::${path}`,
			logger: this.logger,
			firestore: this.firestoreInternal,
			path: [...this.path, path]
		});

		return(retval);
	}

	async destroy(): Promise<void> {
		this.methodLogger('destroy')?.debug('Destroying instance');

		this.firestoreInternal = null;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		return(await this.destroy());
	}

	/** @internal */
	_Testing(key: string): {
		setToctouDelay(delay: number): void;
		unsetToctouDelay(): void;
	} {
		if (key !== 'bc81abf8-e43b-490b-b486-744fb49a5082') {
			throw(new Error('This is a testing only method'));
		}

		return({
			setToctouDelay: (delay: number): void => {
				this.toctouDelay = async (): Promise<void> => {
					return(await asleep(delay));
				};
			},
			unsetToctouDelay: (): void => {
				this.toctouDelay = undefined;
			}
		});
	}
}
