import type { Buffer } from '../../../lib/utils/buffer.js';

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
 * Cache for compiled glob patterns to avoid recompiling on every match
 */
const globPatternCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern to a RegExp
 */
function compileGlobPattern(pattern: string): RegExp {
	const cached = globPatternCache.get(pattern);
	if (cached) {
		return(cached);
	}

	// Convert glob pattern to regex
	// Replace * with regex pattern for "anything except /"
	const regexPattern = pattern
		.replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
		.replace(/\*/g, '[^/]+'); // Replace * with "one or more non-slash chars"

	const regex = new RegExp(`^${regexPattern}$`);
	globPatternCache.set(pattern, regex);
	return(regex);
}

/**
 * Checks if a path matches a validator's pattern
 */
export function matchesPattern(path: string, pattern: string | RegExp): boolean {
	if (pattern instanceof RegExp) {
		// Reset lastIndex to handle RegExps with global/sticky flags
		pattern.lastIndex = 0;
		return(pattern.test(path));
	}

	const regex = compileGlobPattern(pattern);
	return(regex.test(path));
}

/**
 * Finds all validators that match a given path
 */
export function findMatchingValidators(path: string, validators: NamespaceValidator[]): NamespaceValidator[] {
	return(validators.filter(function(validator) {
		return(matchesPattern(path, validator.pathPattern));
	}));
}

/**
 * Checks if a path requires validation (matches any validator pattern)
 */
export function requiresValidation(path: string, validators: NamespaceValidator[]): boolean {
	return(validators.some(function(validator) {
		return(matchesPattern(path, validator.pathPattern));
	}));
}

/**
 * Abstract base class for content validators.
 * Provides common validation logic for mime type and size checking.
 * Subclasses should override validateContent for custom validation.
 */
export abstract class ContentValidator implements NamespaceValidator {
	abstract readonly pathPattern: string | RegExp;
	abstract readonly maxSize: number;
	abstract readonly allowedMimeTypes: readonly string[];

	async validate(path: string, content: Buffer, mimeType: string): Promise<ValidationResult> {
		// Check mime type
		if (!this.allowedMimeTypes.includes(mimeType.toLowerCase())) {
			return({
				valid: false,
				error: `Invalid mime type: ${mimeType}. Allowed: ${this.allowedMimeTypes.join(', ')}`
			});
		}

		// Check size
		if (content.length > this.maxSize) {
			return({
				valid: false,
				error: `Content too large: ${content.length} bytes. Maximum: ${this.maxSize} bytes`
			});
		}

		// Call subclass-specific validation
		return(await this.validateContent(path, content, mimeType));
	}

	/**
	 * Override to add custom content validation beyond mime type and size checks.
	 * Default implementation accepts all content that passes basic checks.
	 */
	protected validateContent(_ignorePath: string, _ignoreContent: Buffer, _ignoreMimeType: string): Promise<ValidationResult> {
		return(Promise.resolve({ valid: true }));
	}
}
