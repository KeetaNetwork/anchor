// Internal helper - not exported to avoid namespace pollution
// The public version is exported from common.ts
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
 * Internal helper to extract common error properties from JSON input
 * This validates the structure and extracts properties needed for construction
 * Note: This is kept internal to avoid circular dependencies. The public version
 * is exported from common.ts
 */
function extractErrorProperties(input: unknown, expectedClass?: { name: string }): { message: string; other: { [key: string]: unknown }} {
	if (!hasPropWithValue(input, 'ok', false)) {
		throw(new Error('Invalid error JSON object'));
	}

	if (typeof input !== 'object' || input === null) {
		throw(new Error('Invalid error JSON object'));
	}

	// Verify the name matches if an expected class is provided
	if (expectedClass && 'name' in input && input.name !== expectedClass.name) {
		throw(new Error(`Error name mismatch: expected ${expectedClass.name}, got ${input.name}`));
	}

	// Extract error message
	let message = 'Internal error';
	if ('error' in input && typeof input.error === 'string') {
		message = input.error;
	}

	// Extract other properties
	const other: { [key: string]: unknown } = {};
	for (const key in input) {
		if (key !== 'error' && key !== 'ok') {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			other[key] = input[key as keyof typeof input];
		}
	}

	return({ message, other });
}

/**
 * Base error class for all Keeta Anchor errors
 */
export class KeetaAnchorError extends Error {
	static readonly name: string = 'KeetaAnchorError';
	#name: string;
	#statusCode = 400;
	#retryable = false;
	protected keetaAnchorErrorObjectTypeID!: string;
	private static readonly keetaAnchorErrorObjectTypeID = '5d7f1578-e887-4104-bab0-4115ae33b08f';

	get name(): string {
		return(this.#name);
	}

	protected set name(value: string) {
		this.#name = value;
	}

	get statusCode(): number {
		return(this.#statusCode);
	}

	protected set statusCode(value: number) {
		this.#statusCode = value;
	}

	get retryable(): boolean {
		return(this.#retryable);
	}

	protected set retryable(value: boolean) {
		this.#retryable = value;
	}

	constructor(message: string) {
		super(message);

		// Need to cast to access the static name property from the constructor
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		this.#name = (this.constructor as typeof KeetaAnchorError).name;

		Object.defineProperty(this, 'keetaAnchorErrorObjectTypeID', {
			value: KeetaAnchorError.keetaAnchorErrorObjectTypeID,
			enumerable: false
		});
	}

	/**
	 * Protected method to restore error properties from JSON
	 * This allows subclasses to properly restore properties without using any
	 */
	protected restoreFromJSON(other: { [key: string]: unknown }): void {
		// Restore statusCode if present
		if ('statusCode' in other) {
			if (typeof other.statusCode !== 'number') {
				throw(new Error('Invalid statusCode: expected number'));
			}
			this.statusCode = other.statusCode;
		}

		// Restore retryable if present
		if ('retryable' in other) {
			if (typeof other.retryable !== 'boolean') {
				throw(new Error('Invalid retryable: expected boolean'));
			}
			this.retryable = other.retryable;
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
		return({
			ok: false,
			retryable: this.retryable,
			error: this.message,
			name: this.#name,
			statusCode: this.statusCode
		});
	}

	// Memoized promise for loading the deserializer module
	private static deserializerModulePromise: Promise<{ deserializeError: (input: unknown) => Promise<KeetaAnchorError> }> | null = null;

	private static async loadDeserializer(): Promise<{ deserializeError: (input: unknown) => Promise<KeetaAnchorError> }> {
		if (!this.deserializerModulePromise) {
			// Need to cast the import result to the expected type
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			this.deserializerModulePromise = import('./common.js') as Promise<{ deserializeError: (input: unknown) => Promise<KeetaAnchorError> }>;
		}
		return(await this.deserializerModulePromise);
	}

	static async fromJSON(input: unknown): Promise<KeetaAnchorError> {
		// Try to use the deserializer mapping if available for subclasses
		if (typeof input === 'object' && input !== null && 'name' in input && typeof input.name === 'string') {
			if (input.name !== this.name) {
				// For subclasses, use the common deserializer to get the right type
				try {
					const { deserializeError } = await this.loadDeserializer();
					return(await deserializeError(input));
				} catch {
					// If common.js is not available, fall through to default behavior
				}
			}
		}

		const { message, other } = extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

/**
 * User-facing error class that extends KeetaAnchorError
 */
export class KeetaAnchorUserError extends KeetaAnchorError {
	static readonly name: string = 'KeetaAnchorUserError';
	protected keetaAnchorUserErrorObjectTypeID!: string;
	private static readonly keetaAnchorUserErrorObjectTypeID = 'a1e64819-14b6-45ac-a1ec-b9c0bdd51e7b';

	static isInstance(input: unknown): input is KeetaAnchorUserError {
		return(hasPropWithValue(input, 'keetaAnchorUserErrorObjectTypeID', KeetaAnchorUserError.keetaAnchorUserErrorObjectTypeID));
	}

	constructor(message: string) {
		super(message);

		Object.defineProperty(this, 'keetaAnchorUserErrorObjectTypeID', {
			value: KeetaAnchorUserError.keetaAnchorUserErrorObjectTypeID,
			enumerable: false
		});
	}

	asErrorResponse(contentType: 'text/plain' | 'application/json'): { error: string; statusCode: number; contentType: string } {
		return(super.asErrorResponse(contentType, this.message));
	}

	static async fromJSON(input: unknown): Promise<KeetaAnchorUserError> {
		const { message, other } = extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}
