import type { LogLevel } from './log/index.ts';
/**
 * Type for error classes that can be deserialized
 */
interface DeserializableErrorClass {
	readonly name: string;
	fromJSON: (input: unknown) => Promise<KeetaAnchorError>;
}

/**
 * Lazy-loaded error classes to avoid circular dependencies
 * The classes are loaded on first use
 */
let ERROR_CLASS_MAPPING: { [key: string]: (input: unknown) => Promise<KeetaAnchorError> } | null = null;

async function getErrorClassMapping(): Promise<{ [key: string]: (input: unknown) => Promise<KeetaAnchorError> }> {
	if (ERROR_CLASS_MAPPING) {
		return(ERROR_CLASS_MAPPING);
	}

	// Dynamically import KYC errors to avoid circular dependencies
	const kycModule = await import('../services/kyc/common.js');
	const KYCErrors = kycModule.Errors;

	// Dynamically import FX errors to avoid circular dependencies
	const fxModule = await import('../services/fx/common.js');
	const FXErrors = fxModule.Errors;

	const ERROR_CLASSES: DeserializableErrorClass[] = [
		/*
		 * We purposefully leave out KeetaAnchorError here since it
		 * is the base error class and could cause circular resolution
		 */
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		KeetaAnchorUserError,
		...Object.values(KYCErrors),
		...Object.values(FXErrors)
	];

	const mapping: { [key: string]: (input: unknown) => Promise<KeetaAnchorError> } = {};
	for (const errorClass of ERROR_CLASSES) {
		mapping[errorClass.name] = errorClass.fromJSON.bind(errorClass);
	}

	ERROR_CLASS_MAPPING = mapping;
	return(mapping);
}

/**
 * Base error class for all Keeta Anchor errors
 */
export class KeetaAnchorError extends Error {
	static override readonly name: string = 'KeetaAnchorError';
	#name: string;
	#statusCode = 400;
	#retryable = false;
	private readonly keetaAnchorErrorObjectTypeID!: string;
	private static readonly keetaAnchorErrorObjectTypeID = '5d7f1578-e887-4104-bab0-4115ae33b08f';
	protected userError = false;
	readonly logLevel: LogLevel = 'ERROR';

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
				throw(new TypeError('Invalid statusCode: expected number'));
			}
			this.statusCode = other.statusCode;
		}

		// Restore retryable if present
		if ('retryable' in other) {
			if (typeof other.retryable !== 'boolean') {
				throw(new TypeError('Invalid retryable: expected boolean'));
			}
			this.retryable = other.retryable;
		}
	}

	static isInstance(input: unknown): input is KeetaAnchorError {
		return(this.hasPropWithValue(input, 'keetaAnchorErrorObjectTypeID', KeetaAnchorError.keetaAnchorErrorObjectTypeID));
	}

	asErrorResponse(contentType: 'text/plain' | 'application/json', message?: string): { error: string; statusCode: number; contentType: string } {
		message ??= 'Internal error';
		if (contentType === 'application/json') {
			message = JSON.stringify({
				...this.toJSON(),
				statusCode: undefined
			});
		}

		return({
			error: message,
			statusCode: this.statusCode,
			contentType: contentType
		});
	}

	toJSON(): { ok: false; retryable: boolean; error: string; name: string; statusCode: number } {
		let message = 'Internal error';
		if (this.userError) {
			message = this.message;
		}

		return({
			ok: false,
			retryable: this.retryable,
			error: message,
			name: this.#name,
			statusCode: this.statusCode
		});
	}

	protected static hasPropWithValue<PROP extends string, VALUE extends string | number | boolean>(input: unknown, prop: PROP, value: VALUE): input is { [key in PROP]: VALUE } {
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
	protected static extractErrorProperties(input: unknown, expectedClass?: { name: string }): { message: string; other: { [key: string]: unknown }} {
		if (!this.hasPropWithValue(input, 'ok', false)) {
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

	static async fromJSON(input: unknown): Promise<KeetaAnchorError> {
		// Try to use the deserializer mapping if available for subclasses
		if (typeof input !== 'object' || input === null) {
			throw(new Error('Invalid error JSON object'));
		}

		if (!('ok' in input) || input.ok !== false) {
			throw(new Error('Invalid error JSON object: expected ok: false'));
		}

		// Check if there's a specific error class name
		if ('name' in input && typeof input.name === 'string') {
			if (input.name === 'KeetaAnchorError') {
				const { message, other } = KeetaAnchorError.extractErrorProperties(input, this);
				const error = new this(message);
				error.restoreFromJSON(other);
				return(error);
			}
			const mapping = await getErrorClassMapping();
			const deserializer = mapping[input.name];
			if (deserializer) {
				return(await deserializer(input));
			}
		}

		throw(new Error('Invalid error JSON object: unknown error class'));
	}
}

/**
 * User-facing error class that extends KeetaAnchorError
 */
export class KeetaAnchorUserError extends KeetaAnchorError {
	static readonly name: string = 'KeetaAnchorUserError';
	private readonly keetaAnchorUserErrorObjectTypeID!: string;
	private static readonly keetaAnchorUserErrorObjectTypeID = 'a1e64819-14b6-45ac-a1ec-b9c0bdd51e7b';
	protected override userError = true;

	static isInstance(input: unknown): input is KeetaAnchorUserError {
		return(this.hasPropWithValue(input, 'keetaAnchorUserErrorObjectTypeID', KeetaAnchorUserError.keetaAnchorUserErrorObjectTypeID));
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

	static async fromJSON(input: unknown): Promise<InstanceType<typeof this>> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}
