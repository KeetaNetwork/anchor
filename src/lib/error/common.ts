import { KeetaAnchorError, KeetaAnchorUserError } from './index.js';
import { Errors as KYCErrors } from '../../services/kyc/common.js';

/**
 * Type for error classes that can be deserialized
 */
interface DeserializableErrorClass {
	readonly name: string;
	fromJSON: (input: unknown) => KeetaAnchorError;
}

/**
 * Array of all error classes that should be deserializable
 * Add new error classes here to make them deserializable
 */
const ERROR_CLASSES: DeserializableErrorClass[] = [
	KeetaAnchorError,
	KeetaAnchorUserError,
	KYCErrors.VerificationNotFound,
	KYCErrors.CertificateNotFound,
	KYCErrors.PaymentRequired,
];

/**
 * Generate mapping from error class names to their fromJSON methods
 * This mapping is generated at module load time from the ERROR_CLASSES array
 */
function generateErrorClassMapping(): Record<string, (input: unknown) => KeetaAnchorError> {
	const mapping: Record<string, (input: unknown) => KeetaAnchorError> = {};
	
	for (const errorClass of ERROR_CLASSES) {
		mapping[errorClass.name] = errorClass.fromJSON.bind(errorClass);
	}
	
	return mapping;
}

const ERROR_CLASS_MAPPING = generateErrorClassMapping();

/**
 * Deserialize a JSON object to the appropriate KeetaAnchorError subclass.
 * This function uses a static mapping of error class names to their deserialization functions,
 * ensuring deterministic behavior that doesn't depend on module load order or global state.
 * 
 * @param input - The JSON object to deserialize
 * @returns The deserialized error object of the appropriate subclass
 * @throws Error if the input is not a valid KeetaAnchorError JSON object
 */
export function deserializeError(input: unknown): KeetaAnchorError {
	if (typeof input !== 'object' || input === null) {
		throw new Error('Invalid error JSON object: expected an object');
	}

	if (!('ok' in input) || input.ok !== false) {
		throw new Error('Invalid error JSON object: expected ok: false');
	}

	// Check if there's a specific error class name
	if ('name' in input && typeof input.name === 'string') {
		const deserializer = ERROR_CLASS_MAPPING[input.name];
		if (deserializer) {
			return deserializer(input);
		}
	}

	// Fall back to the base KeetaAnchorError deserialization
	return KeetaAnchorError.fromJSON(input);
}
