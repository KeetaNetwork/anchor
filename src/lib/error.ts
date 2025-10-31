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

export class KeetaAnchorError extends Error {
	protected _name: string;
	protected statusCode = 400;
	protected retryable = false;
	protected keetaAnchorErrorObjectTypeID!: string;
	private static readonly keetaAnchorErrorObjectTypeID = '5d7f1578-e887-4104-bab0-4115ae33b08f';

	get name(): string {
		return(this._name);
	}

	constructor(message: string) {
		super(message);
		this._name = 'KeetaAnchorError';

		Object.defineProperty(this, 'keetaAnchorErrorObjectTypeID', {
			value: KeetaAnchorError.keetaAnchorErrorObjectTypeID,
			enumerable: false
		});
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
		if (!hasPropWithValue(input, 'ok', false)) {
			throw(new Error('Invalid KeetaAnchorError JSON object'));
		}

		// Extract error properties
		let message = 'Internal error';
		if (typeof input === 'object' && input !== null && 'error' in input && typeof input.error === 'string') {
			message = input.error;
		}

		// Check if this is a KeetaAnchorUserError based on the name
		if (typeof input === 'object' && input !== null && 'name' in input) {
			if (input.name === 'KeetaAnchorUserError') {
				return KeetaAnchorUserError.fromJSON(input);
			}
		}

		// Create a new KeetaAnchorError
		const error = new KeetaAnchorError(message);

		// Restore statusCode if present
		if (typeof input === 'object' && input !== null && 'statusCode' in input && typeof input.statusCode === 'number') {
			error.statusCode = input.statusCode;
		}

		// Restore retryable if present
		if (typeof input === 'object' && input !== null && 'retryable' in input && typeof input.retryable === 'boolean') {
			error.retryable = input.retryable;
		}

		return error;
	}

	static registerSubclass(name: string, fromJSON: (input: unknown) => KeetaAnchorError): void {
		KeetaAnchorError.subclassRegistry.set(name, fromJSON);
	}

	private static subclassRegistry = new Map<string, (input: unknown) => KeetaAnchorError>();

	static fromJSONWithSubclasses(input: unknown): KeetaAnchorError {
		if (!hasPropWithValue(input, 'ok', false)) {
			throw(new Error('Invalid KeetaAnchorError JSON object'));
		}

		// Check if there's a registered subclass handler
		if (typeof input === 'object' && input !== null && 'name' in input && typeof input.name === 'string') {
			const handler = KeetaAnchorError.subclassRegistry.get(input.name);
			if (handler) {
				return handler(input);
			}
		}

		// Fall back to the standard fromJSON
		return KeetaAnchorError.fromJSON(input);
	}
}

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
		if (!hasPropWithValue(input, 'ok', false)) {
			throw(new Error('Invalid KeetaAnchorUserError JSON object'));
		}

		// Extract error properties
		let message = 'Internal error';
		if (typeof input === 'object' && input !== null && 'error' in input && typeof input.error === 'string') {
			message = input.error;
		}

		// Create a new KeetaAnchorUserError
		const error = new KeetaAnchorUserError(message);

		// Restore statusCode if present
		if (typeof input === 'object' && input !== null && 'statusCode' in input && typeof input.statusCode === 'number') {
			error.statusCode = input.statusCode;
		}

		// Restore retryable if present
		if (typeof input === 'object' && input !== null && 'retryable' in input && typeof input.retryable === 'boolean') {
			error.retryable = input.retryable;
		}

		return error;
	}
}
