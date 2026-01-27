import { test, expect, describe } from 'vitest';
import { parseStoragePath, validateStoragePath, isValidStoragePath, makeStoragePath, parseContainerPayload, Errors } from './common.js';
import { Buffer, bufferToArrayBuffer } from '../../lib/utils/buffer.js';

const validPaths = [
	{ input: '/user/abc123/file.txt', path: '/user/abc123/file.txt', owner: 'abc123', relativePath: 'file.txt' },
	{ input: '/user/abc123/docs/sub/file.txt', path: '/user/abc123/docs/sub/file.txt', owner: 'abc123', relativePath: 'docs/sub/file.txt' },
	{ input: '/user/key/icon', path: '/user/key/icon', owner: 'key', relativePath: 'icon' }
] as const;

const invalidPaths = [
	'/invalid',
	'/user/',
	'/user/abc123',
	'/user/abc123/',
	'user/abc123/file.txt',
	''
] as const;

describe('Storage Path Utilities', () => {
	describe.each(validPaths)('parseStoragePath($input)', ({ input, path, owner, relativePath }) => {
		test('returns parsed path', () => {
			expect(parseStoragePath(input)).toEqual({ path, owner, relativePath });
		});

		test('isValidStoragePath returns true', () => {
			expect(isValidStoragePath(input)).toBe(true);
		});

		test('validateStoragePath returns parsed path', () => {
			expect(validateStoragePath(input)).toEqual({ path, owner, relativePath });
		});
	});

	describe.each(invalidPaths)('invalid path: %s', (input) => {
		test('parseStoragePath returns null', () => {
			expect(parseStoragePath(input)).toBeNull();
		});

		test('isValidStoragePath returns false', () => {
			expect(isValidStoragePath(input)).toBe(false);
		});

		test('validateStoragePath throws InvalidPath', () => {
			expect(() => validateStoragePath(input)).toThrow(Errors.InvalidPath);
		});
	});

	const makePathCases = [
		{ owner: 'abc123', relativePath: 'file.txt', expected: '/user/abc123/file.txt' },
		{ owner: 'abc123', relativePath: 'docs/file.txt', expected: '/user/abc123/docs/file.txt' }
	] as const;

	describe.each(makePathCases)('makeStoragePath($owner, $relativePath)', ({ owner, relativePath, expected }) => {
		test(`returns ${expected}`, () => {
			expect(makeStoragePath(owner, relativePath)).toBe(expected);
		});
	});
});

const parseContainerPayloadCases: {
	name: string;
	input: string | { mimeType?: string; data?: string };
	expectedMimeType: string;
	expectedContent: string | number[];
}[] = [
	{
		name: 'valid JSON with mimeType and base64 data',
		input: { mimeType: 'text/plain', data: Buffer.from('Hello, World!').toString('base64') },
		expectedMimeType: 'text/plain',
		expectedContent: 'Hello, World!'
	},
	{
		name: 'missing mimeType defaults to octet-stream',
		input: { data: Buffer.from('Some data').toString('base64') },
		expectedMimeType: 'application/octet-stream',
		expectedContent: 'Some data'
	},
	{
		name: 'missing data returns raw plaintext',
		input: { mimeType: 'text/plain' },
		expectedMimeType: 'text/plain',
		expectedContent: '{"mimeType":"text/plain"}'
	},
	{
		name: 'non-object JSON returns raw plaintext',
		input: '["array","values"]',
		expectedMimeType: 'application/octet-stream',
		expectedContent: '["array","values"]'
	},
	{
		name: 'invalid JSON returns raw plaintext',
		input: 'not valid json',
		expectedMimeType: 'application/octet-stream',
		expectedContent: 'not valid json'
	},
	{
		name: 'binary data',
		input: { mimeType: 'application/octet-stream', data: Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]).toString('base64') },
		expectedMimeType: 'application/octet-stream',
		expectedContent: [0x00, 0x01, 0x02, 0xFF, 0xFE]
	}
];

describe('parseContainerPayload', () => {
	parseContainerPayloadCases.forEach(({ name, input, expectedMimeType, expectedContent }) => {
		test(name, () => {
			const plaintext = Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
			const result = parseContainerPayload(bufferToArrayBuffer(plaintext));
			expect(result.mimeType).toBe(expectedMimeType);

			if (Array.isArray(expectedContent)) {
				expect(result.content).toEqual(Buffer.from(expectedContent));
			} else {
				expect(result.content.toString()).toBe(expectedContent);
			}
		});
	});
});
