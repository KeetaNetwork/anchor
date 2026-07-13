import { KeetaAnchorError } from '../error.js';
import type { KeetaAnchorQueueRequestID, KeetaAnchorQueueStatus } from './index.js';

export type KeetaAnchorQueueRunOptions = {
	timeoutMs?: number | undefined;
};

class KeetaAnchorQueueIdempotentKeyExistsError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorQueueIdempotentExists';
	private readonly KeetaAnchorQueueIdempotentExistsErrorObjectTypeID!: string;
	private static readonly KeetaAnchorQueueIdempotentExistsErrorObjectTypeID = '8aa29501-53ac-40ee-9a6c-519b189e4bc8';
	readonly idempotentIDsFound?: Set<KeetaAnchorQueueRequestID>;

	constructor(message?: string, idempotentIDsFound?: Set<KeetaAnchorQueueRequestID>) {
		super(message ?? 'One or more idempotent entries already exist in the queue');
		this.statusCode = -1;

		Object.defineProperty(this, 'KeetaAnchorQueueIdempotentExistsErrorObjectTypeID', {
			value: KeetaAnchorQueueIdempotentKeyExistsError.KeetaAnchorQueueIdempotentExistsErrorObjectTypeID,
			enumerable: false
		});

		this.idempotentIDsFound = new Set(idempotentIDsFound);
	}

	static isInstance(input: unknown): input is KeetaAnchorQueueIdempotentKeyExistsError {
		return(this.hasPropWithValue(input, 'KeetaAnchorQueueIdempotentExistsErrorObjectTypeID', KeetaAnchorQueueIdempotentKeyExistsError.KeetaAnchorQueueIdempotentExistsErrorObjectTypeID));
	}
}

class KeetaAnchorQueueCompletedRetentionNotConfiguredError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorQueueCompletedRetentionNotConfigured';
	private readonly KeetaAnchorQueueCompletedRetentionNotConfiguredErrorObjectTypeID!: string;
	private static readonly KeetaAnchorQueueCompletedRetentionNotConfiguredErrorObjectTypeID = 'c4e8f1a2-6b3d-4e91-9f0a-1d2c3b4a5e6f';

	constructor(message?: string) {
		super(message ?? 'completedRetentionMs is not configured on this queue');
		this.statusCode = -1;

		Object.defineProperty(this, 'KeetaAnchorQueueCompletedRetentionNotConfiguredErrorObjectTypeID', {
			value: KeetaAnchorQueueCompletedRetentionNotConfiguredError.KeetaAnchorQueueCompletedRetentionNotConfiguredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaAnchorQueueCompletedRetentionNotConfiguredError {
		return(this.hasPropWithValue(input, 'KeetaAnchorQueueCompletedRetentionNotConfiguredErrorObjectTypeID', KeetaAnchorQueueCompletedRetentionNotConfiguredError.KeetaAnchorQueueCompletedRetentionNotConfiguredErrorObjectTypeID));
	}
}

class KeetaAnchorQueueCompletedRetentionPipingError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorQueueCompletedRetentionPiping';
	private readonly KeetaAnchorQueueCompletedRetentionPipingErrorObjectTypeID!: string;
	private static readonly KeetaAnchorQueueCompletedRetentionPipingErrorObjectTypeID = 'f8a2c4e1-7b3d-4f92-a1c0-9e8d7f6a5b4c';

	constructor(message?: string) {
		super(message ?? 'Queues with completedRetentionMs configured cannot be piped to or from other queues');
		this.statusCode = -1;

		Object.defineProperty(this, 'KeetaAnchorQueueCompletedRetentionPipingErrorObjectTypeID', {
			value: KeetaAnchorQueueCompletedRetentionPipingError.KeetaAnchorQueueCompletedRetentionPipingErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaAnchorQueueCompletedRetentionPipingError {
		return(this.hasPropWithValue(input, 'KeetaAnchorQueueCompletedRetentionPipingErrorObjectTypeID', KeetaAnchorQueueCompletedRetentionPipingError.KeetaAnchorQueueCompletedRetentionPipingErrorObjectTypeID));
	}
}

class KeetaAnchorQueueIncorrectStateAssertedError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorQueueIncorrectState';
	private readonly KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID!: string;
	private static readonly KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID = '9a298ad0-7144-483c-bac2-20c914df3697';

	constructor(id: KeetaAnchorQueueRequestID, expectedStatus: KeetaAnchorQueueStatus, actualStatus: KeetaAnchorQueueStatus, message?: string) {
		super(message ?? `The entry (${String(id)}) is in an incorrect state. Expected: ${expectedStatus}, Actual: ${actualStatus}`);
		this.statusCode = -1;
		this.retryable = true;

		Object.defineProperty(this, 'KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID', {
			value: KeetaAnchorQueueIncorrectStateAssertedError.KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaAnchorQueueIncorrectStateAssertedError {
		return(this.hasPropWithValue(input, 'KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID', KeetaAnchorQueueIncorrectStateAssertedError.KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID));
	}
}

export const Errors: {
	IdempotentExistsError: typeof KeetaAnchorQueueIdempotentKeyExistsError;
	IncorrectStateAssertedError: typeof KeetaAnchorQueueIncorrectStateAssertedError;
	CompletedRetentionNotConfiguredError: typeof KeetaAnchorQueueCompletedRetentionNotConfiguredError;
	CompletedRetentionPipingError: typeof KeetaAnchorQueueCompletedRetentionPipingError;
} = {
	/**
	 * An entry already exists in the queue that contains one of the idempotent
	 * ID(s) as the requested entry.
	 */
	IdempotentExistsError: KeetaAnchorQueueIdempotentKeyExistsError,
	/**
	 * The entry is not in the state asserted by the request
	 */
	IncorrectStateAssertedError: KeetaAnchorQueueIncorrectStateAssertedError,
	/**
	 * {@link KeetaAnchorQueueStorageDriver.deleteExpiredCompleted} was called without
	 * `completedRetentionMs` configured on the queue.
	 */
	CompletedRetentionNotConfiguredError: KeetaAnchorQueueCompletedRetentionNotConfiguredError,
	/**
	 * A queue with `completedRetentionMs` was piped to or from another queue, or
	 * {@link KeetaAnchorQueueStorageDriver.deleteExpiredCompleted} was called while piped.
	 */
	CompletedRetentionPipingError: KeetaAnchorQueueCompletedRetentionPipingError
};
