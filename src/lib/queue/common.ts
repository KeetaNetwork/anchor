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

class KeetaAnchorQueueIncorrectStateAssertedError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorQueueIncorrectState';
	private readonly KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID!: string;
	private static readonly KeetaAnchorQueueIncorrectStateAssertedErrorObjectTypeID = '9a298ad0-7144-483c-bac2-20c914df3697';

	constructor(id: KeetaAnchorQueueRequestID, expectedStatus: KeetaAnchorQueueStatus, actualStatus: KeetaAnchorQueueStatus, message?: string) {
		super(message ?? `The entry (${String(id)}) is in an incorrect state. Expected: ${expectedStatus}, Actual: ${actualStatus}`);
		this.statusCode = -1;

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
} = {
	/**
	 * An entry already exists in the queue that contains one of the idempotent
	 * ID(s) as the requested entry.
	 */
	IdempotentExistsError: KeetaAnchorQueueIdempotentKeyExistsError,
	/**
	 * The entry is not in the state asserted by the request
	 */
	IncorrectStateAssertedError: KeetaAnchorQueueIncorrectStateAssertedError
};
