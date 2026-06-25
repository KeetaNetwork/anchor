import { KeetaAnchorError } from '../error.js';

/**
 * Stable, programmatic codes for anchor-chaining failures. Consumers branch on
 * these rather than parsing messages.
 */
export const AnchorChainingErrorCodes = [
	'INVALID_REQUEST',
	'INVALID_PATH',
	'INVALID_STATE',
	'STEP_NOT_DEFINED',
	'UNSUPPORTED_AFFINITY',
	'UNSUPPORTED_RAIL',
	'UNSUPPORTED_INSTRUCTION',
	'PROVIDER_UNAVAILABLE',
	'QUOTE_UNAVAILABLE',
	'EXCHANGE_FAILED',
	'UNDER_DELIVERY',
	'POLL_TIMEOUT',
	'RECOVERABLE_SEND_FAILED',
	'NO_LISTENER',
	'RESUME_UNAVAILABLE',
	'ABORTED',
	'INTERNAL'
] as const;

export type AnchorChainingErrorCode = typeof AnchorChainingErrorCodes[number];

/**
 * HTTP status per code. Most chaining errors are caller/setup faults; a few are
 * upstream-availability faults that surface as 5xx.
 */
const STATUS_BY_CODE: { [Code in AnchorChainingErrorCode]: number } = {
	INVALID_REQUEST: 400,
	INVALID_PATH: 400,
	INVALID_STATE: 409,
	STEP_NOT_DEFINED: 500,
	UNSUPPORTED_AFFINITY: 400,
	UNSUPPORTED_RAIL: 400,
	UNSUPPORTED_INSTRUCTION: 400,
	PROVIDER_UNAVAILABLE: 503,
	QUOTE_UNAVAILABLE: 503,
	EXCHANGE_FAILED: 502,
	UNDER_DELIVERY: 422,
	POLL_TIMEOUT: 504,
	RECOVERABLE_SEND_FAILED: 503,
	NO_LISTENER: 500,
	RESUME_UNAVAILABLE: 409,
	ABORTED: 499,
	INTERNAL: 500
};

/**
 * Codes the durability layer ({@link withRetry}) may retry on. Transient
 * upstream-availability faults only; programmer/setup faults are terminal.
 */
const RETRYABLE_BY_CODE: { [Code in AnchorChainingErrorCode]?: true } = {
	PROVIDER_UNAVAILABLE: true,
	QUOTE_UNAVAILABLE: true,
	RECOVERABLE_SEND_FAILED: true
};

interface AnchorChainingErrorJSON {
	ok: false;
	retryable: boolean;
	error: string;
	name: string;
	statusCode: number;
	code: AnchorChainingErrorCode;
}

/**
 * Error raised by the anchor-chaining engine. Carries a stable
 * {@link AnchorChainingErrorCode} and the originating cause when wrapping.
 */
export class AnchorChainingError extends KeetaAnchorError {
	static override readonly name: string = 'AnchorChainingError';
	private readonly anchorChainingErrorObjectTypeID!: string;
	private static readonly anchorChainingErrorObjectTypeID = 'c0b3a6e4-7f1d-4a2c-9e8b-5d3f2a1c7e90';
	readonly code: AnchorChainingErrorCode;

	constructor(code: AnchorChainingErrorCode, message?: string, options?: { cause?: unknown }) {
		super(message ?? code);

		this.code = code;
		this.statusCode = STATUS_BY_CODE[code];
		this.retryable = RETRYABLE_BY_CODE[code] ?? false;
		this.userError = true;

		if (options?.cause !== undefined) {
			Object.defineProperty(this, 'cause', {
				value: options.cause,
				enumerable: false,
				writable: true,
				configurable: true
			});
		}

		Object.defineProperty(this, 'anchorChainingErrorObjectTypeID', {
			value: AnchorChainingError.anchorChainingErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is AnchorChainingError {
		return(this.hasPropWithValue(input, 'anchorChainingErrorObjectTypeID', AnchorChainingError.anchorChainingErrorObjectTypeID));
	}

	static isValidCode(value: string): value is AnchorChainingErrorCode {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(AnchorChainingErrorCodes.includes(value as AnchorChainingErrorCode));
	}

	/**
	 * Normalize an unknown thrown value into an {@link AnchorChainingError},
	 * preserving an already-typed chaining error and otherwise wrapping under
	 * `code`.
	 */
	static from(error: unknown, code: AnchorChainingErrorCode = 'INTERNAL'): AnchorChainingError {
		if (AnchorChainingError.isInstance(error)) {
			return(error);
		}

		let message: string;
		if (error instanceof Error) {
			message = error.message;
		} else {
			message = String(error);
		}

		return(new AnchorChainingError(code, message, { cause: error }));
	}

	override toJSON(): AnchorChainingErrorJSON {
		return({
			...super.toJSON(),
			code: this.code
		});
	}

	static async fromJSON(input: unknown): Promise<AnchorChainingError> {
		const { message, other } = this.extractErrorProperties(input, this);

		if (!('code' in other) || typeof other.code !== 'string' || !this.isValidCode(other.code)) {
			throw(new TypeError('Invalid AnchorChainingError JSON object: missing or invalid code'));
		}

		const error = new this(other.code, message);
		error.restoreFromJSON(other);
		return(error);
	}
}
