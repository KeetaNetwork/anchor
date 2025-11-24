import { KeetaAnchorError } from '../error.js';
import type { KeetaAnchorQueueRequestID } from './index.js';

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

export const Errors: {
	IdempotentExistsError: typeof KeetaAnchorQueueIdempotentKeyExistsError;
} = {
	/**
	 * An entry already exists in the queue that contains one of the idempotent
	 * ID(s) as the requested entry.
	 */
	IdempotentExistsError: KeetaAnchorQueueIdempotentKeyExistsError
};
