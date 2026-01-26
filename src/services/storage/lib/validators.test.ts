import { describe, test, expect } from 'vitest';
import {
	matchesPattern,
	findMatchingValidators,
	requiresValidation,
	IconValidator,
	defaultValidators,
	createValidatorRegistry
} from './validators.js';
import { Buffer } from '../../../lib/utils/buffer.js';

describe('Validator Pattern Matching', () => {
	const patternTestCases = [
		{ path: '/user/abc123/icon', pattern: '/user/*/icon', expected: true },
		{ path: '/user/xyz789/icon', pattern: '/user/*/icon', expected: true },
		{ path: '/user/abc123/other', pattern: '/user/*/icon', expected: false },
		{ path: '/user/abc123/icon', pattern: /^\/user\/[^/]+\/icon$/, expected: true },
		{ path: '/user/abc123/other', pattern: /^\/user\/[^/]+\/icon$/, expected: false }
	];

	for (const { path, pattern, expected } of patternTestCases) {
		const patternStr = pattern instanceof RegExp ? pattern.toString() : pattern;
		test(`matchesPattern('${path}', ${patternStr}) = ${expected}`, () => {
			expect(matchesPattern(path, pattern)).toBe(expected);
		});
	}

	test('findMatchingValidators returns IconValidator for icon path', () => {
		const matches = findMatchingValidators('/user/abc123/icon', defaultValidators);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toBeInstanceOf(IconValidator);
	});

	test('findMatchingValidators returns empty for unvalidated paths', () => {
		expect(findMatchingValidators('/user/abc123/random', defaultValidators)).toHaveLength(0);
	});

	test('requiresValidation returns correct values', () => {
		expect(requiresValidation('/user/abc123/icon', defaultValidators)).toBe(true);
		expect(requiresValidation('/user/abc123/random', defaultValidators)).toBe(false);
	});
});

describe('IconValidator', () => {
	const validator = new IconValidator();
	const testPath = '/user/abc123/icon';

	// Valid image test cases
	const validImageCases = [
		{ mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
		{ mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF, 0xE0] },
		{ mime: 'image/jpg', bytes: [0xFF, 0xD8, 0xFF, 0xE0] },
		{ mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50] }
	];

	const padding = new Array<number>(100).fill(0);
	for (const { mime, bytes } of validImageCases) {
		test(`accepts valid ${mime}`, async () => {
			const content = Buffer.from([...bytes, ...padding]);
			const result = await validator.validate(testPath, content, mime);
			expect(result.valid).toBe(true);
		});
	}

	// Rejection test cases
	const rejectionCases = [
		{
			description: 'invalid mime type',
			content: Buffer.from([0x89, 0x50, 0x4E, 0x47, ...padding]),
			mime: 'application/json',
			errorContains: 'Invalid mime type'
		},
		{
			description: 'mismatched magic bytes (JPEG content declared as PNG)',
			content: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, ...padding]),
			mime: 'image/png',
			errorContains: 'invalid magic bytes'
		}
	];

	for (const { description, content, mime, errorContains } of rejectionCases) {
		test(`rejects ${description}`, async () => {
			const result = await validator.validate(testPath, content, mime);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.error).toContain(errorContains);
			}
		});
	}

	test('rejects oversized image (>1MB)', async () => {
		const largeContent = Buffer.alloc(1024 * 1024 + 1);
		// Set PNG magic bytes
		[0x89, 0x50, 0x4E, 0x47].forEach((b, i) => largeContent[i] = b);

		const result = await validator.validate(testPath, largeContent, 'image/png');
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain('too large');
		}
	});
});

describe('Validator Registry', () => {
	test('createValidatorRegistry includes default validators', () => {
		const registry = createValidatorRegistry();
		expect(registry).toHaveLength(1);
		expect(registry[0]).toBeInstanceOf(IconValidator);
	});

	test('createValidatorRegistry merges custom validators', () => {
		const customValidator = {
			pathPattern: '/user/*/custom/*',
			validate: async () => ({ valid: true as const })
		};
		const registry = createValidatorRegistry([customValidator]);
		expect(registry).toHaveLength(2);
		expect(registry[0]).toBeInstanceOf(IconValidator);
		expect(registry[1]).toBe(customValidator);
	});
});
