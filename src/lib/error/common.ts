import { KeetaAnchorError, KeetaAnchorUserError } from './index.js';

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
export function extractErrorProperties(input: unknown, expectedClass?: { name: string }): { message: string; other: { [key: string]: unknown }} {
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
	const kycModule = await import('../../services/kyc/common.js');
	const KYCErrors = kycModule.Errors;

	const ERROR_CLASSES: DeserializableErrorClass[] = [
		KeetaAnchorError,
		KeetaAnchorUserError,
		KYCErrors.VerificationNotFound,
		KYCErrors.CertificateNotFound,
		KYCErrors.PaymentRequired
	];

	const mapping: { [key: string]: (input: unknown) => Promise<KeetaAnchorError> } = {};
	for (const errorClass of ERROR_CLASSES) {
		mapping[errorClass.name] = errorClass.fromJSON.bind(errorClass);
	}

	ERROR_CLASS_MAPPING = mapping;
	return(mapping);
}

/**
 * Deserialize a JSON object to the appropriate KeetaAnchorError subclass.
 * This function uses a static mapping of error class names to their deserialization functions,
 * ensuring deterministic behavior that doesn't depend on module load order or global state.
 *
 * @param input - The JSON object to deserialize
 * @returns The deserialized error object of the appropriate subclass
 * @throws Error if the input is not a valid KeetaAnchorError JSON object
 */
export async function deserializeError(input: unknown): Promise<KeetaAnchorError> {
	if (typeof input !== 'object' || input === null) {
		throw(new Error('Invalid error JSON object: expected an object'));
	}

	if (!('ok' in input) || input.ok !== false) {
		throw(new Error('Invalid error JSON object: expected ok: false'));
	}

	// Check if there's a specific error class name
	if ('name' in input && typeof input.name === 'string') {
		const mapping = await getErrorClassMapping();
		const deserializer = mapping[input.name];
		if (deserializer) {
			return(await deserializer(input));
		}
	}

	// Fall back to the base KeetaAnchorError deserialization
	return(await KeetaAnchorError.fromJSON(input));
}
