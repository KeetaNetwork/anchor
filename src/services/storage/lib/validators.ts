import { Buffer } from '../../../lib/utils/buffer.js';

/**
 * Result of a validation operation
 */
export type ValidationResult = { valid: true } | { valid: false; error: string };

/**
 * Interface for namespace validators that validate content at specific paths
 */
export interface NamespaceValidator {
	/**
	 * Path pattern this validator applies to.
	 * Can be a glob pattern string or a RegExp.
	 *
	 * @example
	 * pathPattern: "/user/*"  // Glob: matches paths under /user/
	 * @example
	 * pathPattern: /^\/user\/[^/]+\/icon$/  // RegExp: matches user icons
	 */
	pathPattern: string | RegExp;

	/**
	 * Validate decrypted content before storage.
	 * Called only when anchor can decrypt (i.e., anchor is a principal).
	 *
	 * @param path - The full storage path
	 * @param content - The decrypted content
	 * @param mimeType - The mime-type from inside the EncryptedContainer
	 * @returns ValidationResult indicating if the content is valid
	 */
	validate(path: string, content: Buffer, mimeType: string): Promise<ValidationResult>;
}

/**
 * Checks if a path matches a validator's pattern
 */
export function matchesPattern(path: string, pattern: string | RegExp): boolean {
	if (pattern instanceof RegExp) {
		return(pattern.test(path));
	}

	// Convert glob pattern to regex
	// Replace * with regex pattern for "anything except /"
	const regexPattern = pattern
		.replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
		.replace(/\*/g, '[^/]+'); // Replace * with "one or more non-slash chars"

	const regex = new RegExp(`^${regexPattern}$`);
	return(regex.test(path));
}

/**
 * Finds all validators that match a given path
 */
export function findMatchingValidators(path: string, validators: NamespaceValidator[]): NamespaceValidator[] {
	return(validators.filter(v => matchesPattern(path, v.pathPattern)));
}

/**
 * Checks if a path requires validation (matches any validator pattern)
 */
export function requiresValidation(path: string, validators: NamespaceValidator[]): boolean {
	return(validators.some(v => matchesPattern(path, v.pathPattern)));
}

// #region Built-in Validators

/**
 * Validator for user icons at path: user/PUBLICKEY/icon
 * - Must be an image (PNG, JPEG, or WebP)
 * - Max size 1MB
 */
export class IconValidator implements NamespaceValidator {
	readonly pathPattern: string = '/user/*/icon';
	readonly maxSize: number = 1024 * 1024; // 1MB

	readonly allowedMimeTypes: readonly string[] = [
		'image/png',
		'image/jpeg',
		'image/jpg',
		'image/webp'
	] as const;

	async validate(path: string, content: Buffer, mimeType: string): Promise<ValidationResult> {
		// Check mime type
		if (!this.allowedMimeTypes.includes(mimeType.toLowerCase())) {
			return({
				valid: false,
				error: `Invalid mime type for icon: ${mimeType}. Allowed: ${this.allowedMimeTypes.join(', ')}`
			});
		}

		// Check size
		if (content.length > this.maxSize) {
			return({
				valid: false,
				error: `Icon too large: ${content.length} bytes. Maximum: ${this.maxSize} bytes`
			});
		}

		// Verify it's actually an image by checking magic bytes
		const isValidImage = this.#checkMagicBytes(content, mimeType);
		if (!isValidImage) {
			return({
				valid: false,
				error: 'Content does not match declared mime type (invalid magic bytes)'
			});
		}

		return({ valid: true });
	}

	static readonly #magicBytes: ReadonlyMap<string, { bytes: Buffer; offset?: number }[]> = new Map([
		['image/png', [{ bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47]) }]],
		['image/jpeg', [{ bytes: Buffer.from([0xFF, 0xD8, 0xFF]) }]],
		['image/jpg', [{ bytes: Buffer.from([0xFF, 0xD8, 0xFF]) }]],
		['image/webp', [
			{ bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]) },  // RIFF at offset 0
			{ bytes: Buffer.from([0x57, 0x45, 0x42, 0x50]), offset: 8 }  // WEBP at offset 8
		]]
	]);

	#checkMagicBytes(content: Buffer, mimeType: string): boolean {
		const checks = IconValidator.#magicBytes.get(mimeType.toLowerCase());
		if (!checks) {
			return(false);
		}

		return(checks.every(({ bytes, offset = 0 }) => {
			if (content.length < offset + bytes.length) {return(false);}
			return(content.subarray(offset, offset + bytes.length).equals(bytes));
		}));
	}
}

// #endregion

/**
 * Default set of built-in validators for paths where content validation is required.
 */
export const defaultValidators: NamespaceValidator[] = [
	new IconValidator()
];

/**
 * Creates a validator registry with the default validators plus custom ones
 */
export function createValidatorRegistry(customValidators?: NamespaceValidator[]): NamespaceValidator[] {
	return([...defaultValidators, ...(customValidators ?? [])]);
}
