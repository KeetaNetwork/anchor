import { KeetaAnchorError, KeetaAnchorUserError } from './error.js';
import { Errors as KYCErrors } from '../services/kyc/common.js';

/**
 * Static mapping of error class names to their fromJSON deserialization functions.
 * This mapping is defined at module load time and does not rely on global state
 * or side effects during module initialization.
 */
const ERROR_CLASS_MAPPING: Record<string, (input: unknown) => KeetaAnchorError> = {
	'KeetaAnchorError': KeetaAnchorError.fromJSON,
	'KeetaAnchorUserError': KeetaAnchorUserError.fromJSON,
	'KeetaKYCAnchorVerificationNotFoundError': KYCErrors.VerificationNotFound.fromJSON,
	'KeetaKYCAnchorCertificateNotFoundError': KYCErrors.CertificateNotFound.fromJSON,
	'KeetaKYCAnchorCertificatePaymentRequired': KYCErrors.PaymentRequired.fromJSON,
};

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
