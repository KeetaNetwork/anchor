import { describe, test, expect } from 'vitest';
import {
	matchesPattern,
	findMatchingValidators,
	requiresValidation,
	ContentValidator,
	type ValidationResult
} from './validators.js';
import { Buffer } from '../../../lib/utils/buffer.js';

describe('Validator Pattern Matching', function() {
	const patternTestCases = [
		{ path: '/user/abc123/icon', pattern: '/user/*/icon', expected: true },
		{ path: '/user/xyz789/icon', pattern: '/user/*/icon', expected: true },
		{ path: '/user/abc123/other', pattern: '/user/*/icon', expected: false },
		{ path: '/user/abc123/icon', pattern: /^\/user\/[^/]+\/icon$/, expected: true },
		{ path: '/user/abc123/other', pattern: /^\/user\/[^/]+\/icon$/, expected: false },
		{ path: '/some/deep/path', pattern: '/some/*/path', expected: true },
		{ path: '/some/path', pattern: '/some/*/path', expected: false }
	];

	for (const { path, pattern, expected } of patternTestCases) {
		const patternStr = pattern instanceof RegExp ? pattern.toString() : pattern;
		test(`matchesPattern('${path}', ${patternStr}) = ${expected}`, function() {
			expect(matchesPattern(path, pattern)).toBe(expected);
		});
	}

	test('findMatchingValidators with custom validators', function() {
		class TestValidator extends ContentValidator {
			readonly pathPattern = '/user/*/test';
			readonly maxSize = 1024;
			readonly allowedMimeTypes = ['text/plain'] as const;
		}

		const validators = [new TestValidator()];
		const matches = findMatchingValidators('/user/abc123/test', validators);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toBeInstanceOf(TestValidator);
	});

	test('findMatchingValidators returns empty for unmatched paths', function() {
		class TestValidator extends ContentValidator {
			readonly pathPattern = '/user/*/test';
			readonly maxSize = 1024;
			readonly allowedMimeTypes = ['text/plain'] as const;
		}

		const validators = [new TestValidator()];
		expect(findMatchingValidators('/user/abc123/other', validators)).toHaveLength(0);
	});

	test('requiresValidation returns correct values', function() {
		class TestValidator extends ContentValidator {
			readonly pathPattern = '/user/*/icon';
			readonly maxSize = 1024;
			readonly allowedMimeTypes = ['image/png'] as const;
		}

		const validators = [new TestValidator()];
		expect(requiresValidation('/user/abc123/icon', validators)).toBe(true);
		expect(requiresValidation('/user/abc123/random', validators)).toBe(false);
	});
});

describe('ContentValidator Base Class', function() {
	// Create a concrete implementation for testing
	class TestContentValidator extends ContentValidator {
		readonly pathPattern = '/test/*';
		readonly maxSize = 1000;
		readonly allowedMimeTypes = ['text/plain', 'application/json'] as const;
	}

	const validator = new TestContentValidator();
	const testPath = '/test/file.txt';

	test('accepts valid content within size and mime type', async function() {
		const content = Buffer.from('Hello, World!');
		const result = await validator.validate(testPath, content, 'text/plain');
		expect(result.valid).toBe(true);
	});

	test('rejects invalid mime type', async function() {
		const content = Buffer.from('Hello');
		const result = await validator.validate(testPath, content, 'image/png');
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain('Invalid mime type');
			expect(result.error).toContain('image/png');
		}
	});

	test('rejects oversized content', async function() {
		const largeContent = Buffer.alloc(1001); // Just over maxSize
		const result = await validator.validate(testPath, largeContent, 'text/plain');
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain('too large');
		}
	});

	test('accepts content at exact max size', async function() {
		const exactContent = Buffer.alloc(1000); // Exactly maxSize
		const result = await validator.validate(testPath, exactContent, 'text/plain');
		expect(result.valid).toBe(true);
	});

	test('validateContent can be overridden for custom logic', async function() {
		class CustomValidator extends ContentValidator {
			readonly pathPattern = '/custom/*';
			readonly maxSize = 1000;
			readonly allowedMimeTypes = ['text/plain'] as const;

			protected override validateContent(
				_ignorePath: string,
				content: Buffer,
				_ignoreMimeType: string
			): Promise<ValidationResult> {
				// Custom rule: content must start with "VALID:"
				if (!content.toString().startsWith('VALID:')) {
					return(Promise.resolve({
						valid: false,
						error: 'Content must start with VALID:'
					}));
				}
				return(Promise.resolve({ valid: true }));
			}
		}

		const customValidator = new CustomValidator();

		const validContent = Buffer.from('VALID: This is valid');
		const validResult = await customValidator.validate('/custom/file', validContent, 'text/plain');
		expect(validResult.valid).toBe(true);

		const invalidContent = Buffer.from('This is invalid');
		const invalidResult = await customValidator.validate('/custom/file', invalidContent, 'text/plain');
		expect(invalidResult.valid).toBe(false);

		if (!invalidResult.valid) {
			expect(invalidResult.error).toContain('VALID:');
		}
	});
});
