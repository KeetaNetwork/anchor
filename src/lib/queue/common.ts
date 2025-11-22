import { KeetaAnchorError } from '../error.js';
import type { KeetaAnchorQueueRequestID } from './index.js';

class KeetaAnchorQueueParentExistsError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorQueueParentExists';
	private readonly KeetaAnchorQueueParentExistsErrorObjectTypeID!: string;
	private static readonly KeetaAnchorQueueParentExistsErrorObjectTypeID = '8aa29501-53ac-40ee-9a6c-519b189e4bc8';
	readonly parentIDsFound?: Set<KeetaAnchorQueueRequestID>;

	constructor(message?: string, parentIDsFound?: Set<KeetaAnchorQueueRequestID>) {
		super(message ?? 'One or more parent entries already exist in the queue');
		this.statusCode = -1;

		Object.defineProperty(this, 'KeetaAnchorQueueParentExistsErrorObjectTypeID', {
			value: KeetaAnchorQueueParentExistsError.KeetaAnchorQueueParentExistsErrorObjectTypeID,
			enumerable: false
		});

		this.parentIDsFound = new Set(parentIDsFound);
	}

	static isInstance(input: unknown): input is KeetaAnchorQueueParentExistsError {
		return(this.hasPropWithValue(input, 'KeetaAnchorQueueParentExistsErrorObjectTypeID', KeetaAnchorQueueParentExistsError.KeetaAnchorQueueParentExistsErrorObjectTypeID));
	}
}

export const Errors: {
	ParentExistsError: typeof KeetaAnchorQueueParentExistsError;
} = {
	/**
	 * An entry already exists in the queue that contains one of the parent
	 * ID(s) as the requested entry.
	 */
	ParentExistsError: KeetaAnchorQueueParentExistsError
};
