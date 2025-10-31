function hasPropWithValue<PROP extends string, VALUE extends string | number | boolean>(input: unknown, prop: PROP, value: VALUE): input is { [key in PROP]: VALUE } {
	if (typeof input !== 'object' || input === null) {
		return(false);
	}

	if (!(prop in input)) {
		return(false);
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const inputValue = input[prop as keyof typeof input] as unknown;
	if (inputValue !== value) {
		return(false);
	}

	return(true);
}

/**
 * Extract common error properties from JSON input
 * This validates the structure and extracts properties needed for construction
 */
function extractErrorProperties(input: unknown): { message: string; validated: true } {
	if (!hasPropWithValue(input, 'ok', false)) {
		throw new Error('Invalid error JSON object');
	}

	// Extract error message
	let message = 'Internal error';
	if (typeof input === 'object' && input !== null && 'error' in input && typeof input.error === 'string') {
		message = input.error;
	}

	return { message, validated: true };
}

/**
 * Base error class for all Keeta Anchor errors
 */
export class KeetaAnchorError extends Error {
	protected _name: string;
	#statusCode = 400;
	#retryable = false;
	protected keetaAnchorErrorObjectTypeID!: string;
	private static readonly keetaAnchorErrorObjectTypeID = '5d7f1578-e887-4104-bab0-4115ae33b08f';

	get name(): string {
		return(this._name);
	}

	get statusCode(): number {
		return this.#statusCode;
	}

	protected set statusCode(value: number) {
		this.#statusCode = value;
	}

	get retryable(): boolean {
		return this.#retryable;
	}

	protected set retryable(value: boolean) {
		this.#retryable = value;
	}

	constructor(message: string) {
		super(message);
		this._name = 'KeetaAnchorError';

		Object.defineProperty(this, 'keetaAnchorErrorObjectTypeID', {
			value: KeetaAnchorError.keetaAnchorErrorObjectTypeID,
			enumerable: false
		});
	}

	/**
	 * Protected method to restore error properties from JSON
	 * This allows subclasses to properly restore properties without using any
	 */
	protected restoreFromJSON(input: unknown): void {
		if (typeof input !== 'object' || input === null) {
			return;
		}

		// Restore statusCode if present
		if ('statusCode' in input && typeof input.statusCode === 'number') {
			this.statusCode = input.statusCode;
		}

		// Restore retryable if present
		if ('retryable' in input && typeof input.retryable === 'boolean') {
			this.retryable = input.retryable;
		}
	}

	static isInstance(input: unknown): input is KeetaAnchorError {
		return(hasPropWithValue(input, 'keetaAnchorErrorObjectTypeID', KeetaAnchorError.keetaAnchorErrorObjectTypeID));
	}

	asErrorResponse(contentType: 'text/plain' | 'application/json', message?: string): { error: string; statusCode: number; contentType: string } {
		message ??= 'Internal error';
		if (contentType === 'application/json') {
			message = JSON.stringify({
				ok: false,
				retryable: this.retryable,
				error: message
			});
		}

		return({
			error: message,
			statusCode: this.statusCode,
			contentType: contentType
		});
	}

	toJSON(): { ok: false; retryable: boolean; error: string; name: string; statusCode: number } {
		return {
			ok: false,
			retryable: this.retryable,
			error: this.message,
			name: this._name,
			statusCode: this.statusCode
		};
	}

	static fromJSON(input: unknown): KeetaAnchorError {
		const { message } = extractErrorProperties(input);

		// Try to use the deserializer mapping if available
		if (typeof input === 'object' && input !== null && 'name' in input && typeof input.name === 'string') {
			// Import and use the deserializer if the name doesn't match this class
			if (input.name !== 'KeetaAnchorError') {
				// Check if this is a KeetaAnchorUserError based on the name
				if (input.name === 'KeetaAnchorUserError') {
					return KeetaAnchorUserError.fromJSON(input);
				}
				// For other types, try to use the common deserializer if available
				try {
					const { deserializeError } = require('./common.js');
					return deserializeError(input);
				} catch {
					// If common.js is not available, fall through to default behavior
				}
			}
		}

		// Create a new KeetaAnchorError and restore properties
		const error = new KeetaAnchorError(message);
		error.restoreFromJSON(input);
		return error;
	}
}

/**
 * User-facing error class that extends KeetaAnchorError
 */
export class KeetaAnchorUserError extends KeetaAnchorError {
	protected keetaAnchorUserErrorObjectTypeID!: string;
	private static readonly keetaAnchorUserErrorObjectTypeID = 'a1e64819-14b6-45ac-a1ec-b9c0bdd51e7b';

	static isInstance(input: unknown): input is KeetaAnchorUserError {
		return(hasPropWithValue(input, 'keetaAnchorUserErrorObjectTypeID', KeetaAnchorUserError.keetaAnchorUserErrorObjectTypeID));
	}

	constructor(message: string) {
		super(message);
		this._name = 'KeetaAnchorUserError';

		Object.defineProperty(this, 'keetaAnchorUserErrorObjectTypeID', {
			value: KeetaAnchorUserError.keetaAnchorUserErrorObjectTypeID,
			enumerable: false
		});
	}

	asErrorResponse(contentType: 'text/plain' | 'application/json'): { error: string; statusCode: number; contentType: string } {
		return(super.asErrorResponse(contentType, this.message));
	}

	static fromJSON(input: unknown): KeetaAnchorUserError {
		const { message } = extractErrorProperties(input);

		// Create a new KeetaAnchorUserError and restore properties
		const error = new KeetaAnchorUserError(message);
		error.restoreFromJSON(input);
		return error;
	}
}

export { extractErrorProperties };
