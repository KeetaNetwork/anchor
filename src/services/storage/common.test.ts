import { test, expect, describe } from 'vitest';
import KeetaNet from '@keetanetwork/keetanet-client';
import type { PathPolicy } from './common.js';
import { parseContainerPayload, Errors } from './common.js';
import { Buffer, bufferToArrayBuffer } from '../../lib/utils/buffer.js';

// #region Test Path Policy

/**
 * Parsed path for the test path policy: /user/<pubkey>/<relativePath>
 */
type TestParsedPath = {
	path: string;
	owner: string;
	relativePath: string;
};

/**
 * Test path policy implementing the /user/<pubkey>/<path> pattern.
 * Owner-based access control: only the owner can access their namespace.
 */
class TestPathPolicy implements PathPolicy<TestParsedPath> {
	// Matches /user/<owner> or /user/<owner>/ or /user/<owner>/<path>
	readonly #pattern = /^\/user\/([^/]+)(\/(.*))?$/;

	parse(path: string): TestParsedPath | null {
		const match = path.match(this.#pattern);
		if (!match?.[1]) {
			return(null);
		}
		return({ path, owner: match[1], relativePath: match[3] ?? '' });
	}

	validate(path: string): TestParsedPath {
		const parsed = this.parse(path);
		if (!parsed) {
			throw(new Errors.InvalidPath('Path must match /user/<pubkey>/<path>'));
		}
		return(parsed);
	}

	isValid(path: string): boolean {
		return(this.parse(path) !== null);
	}

	checkAccess(
		account: InstanceType<typeof KeetaNet.lib.Account>,
		parsed: TestParsedPath,
		_ignoreOperation: 'get' | 'put' | 'delete' | 'search' | 'metadata'
	): boolean {
		return(parsed.owner === account.publicKeyString.get());
	}

	getAuthorizedSigner(parsed: TestParsedPath): string | null {
		return(parsed.owner);
	}

	makePath(owner: string, relativePath: string): string {
		return(`/user/${owner}/${relativePath}`);
	}

	getNamespacePrefix(owner: string): string {
		return(`/user/${owner}/`);
	}
}

const testPathPolicy = new TestPathPolicy();

// #endregion

const validPaths = [
	{ input: '/user/abc123/file.txt', path: '/user/abc123/file.txt', owner: 'abc123', relativePath: 'file.txt' },
	{ input: '/user/abc123/docs/sub/file.txt', path: '/user/abc123/docs/sub/file.txt', owner: 'abc123', relativePath: 'docs/sub/file.txt' },
	{ input: '/user/key/icon', path: '/user/key/icon', owner: 'key', relativePath: 'icon' },
	// Namespace prefixes (valid for search operations)
	{ input: '/user/abc123', path: '/user/abc123', owner: 'abc123', relativePath: '' },
	{ input: '/user/abc123/', path: '/user/abc123/', owner: 'abc123', relativePath: '' }
] as const;

const invalidPaths = [
	'/invalid',
	'/user/',
	'user/abc123/file.txt',
	''
] as const;

describe('PathPolicy (TestPathPolicy implementation)', function() {
	describe.each(validPaths)('parse($input)', function({ input, path, owner, relativePath }) {
		test('returns parsed path', function() {
			expect(testPathPolicy.parse(input)).toEqual({ path, owner, relativePath });
		});

		test('isValid returns true', function() {
			expect(testPathPolicy.isValid(input)).toBe(true);
		});

		test('validate returns parsed path', function() {
			expect(testPathPolicy.validate(input)).toEqual({ path, owner, relativePath });
		});
	});

	describe.each(invalidPaths)('invalid path: %s', function(input) {
		test('parse returns null', function() {
			expect(testPathPolicy.parse(input)).toBeNull();
		});

		test('isValid returns false', function() {
			expect(testPathPolicy.isValid(input)).toBe(false);
		});

		test('validate throws InvalidPath', function() {
			expect(function() { testPathPolicy.validate(input); }).toThrow(Errors.InvalidPath);
		});
	});

	const makePathCases = [
		{ owner: 'abc123', relativePath: 'file.txt', expected: '/user/abc123/file.txt' },
		{ owner: 'abc123', relativePath: 'docs/file.txt', expected: '/user/abc123/docs/file.txt' }
	] as const;

	describe.each(makePathCases)('makePath($owner, $relativePath)', function({ owner, relativePath, expected }) {
		test(`returns ${expected}`, function() {
			expect(testPathPolicy.makePath(owner, relativePath)).toBe(expected);
		});
	});

	test('getNamespacePrefix returns correct prefix', function() {
		expect(testPathPolicy.getNamespacePrefix('abc123')).toBe('/user/abc123/');
	});

	describe('checkAccess', function() {
		const seed = KeetaNet.lib.Account.generateRandomSeed();
		const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
		const otherAccount = KeetaNet.lib.Account.fromSeed(seed, 1);
		const ownerPubKey = ownerAccount.publicKeyString.get();
		const testPath = `/user/${ownerPubKey}/file.txt`;

		const accessCases = [
			{ name: 'owner account succeeds', account: ownerAccount, allowed: true },
			{ name: 'other account denied', account: otherAccount, allowed: false }
		];

		for (const { name, account, allowed } of accessCases) {
			test(name, function() {
				const parsed = testPathPolicy.parse(testPath);
				expect(parsed).not.toBeNull();
				if (parsed) {
					expect(testPathPolicy.checkAccess(account, parsed, 'get')).toBe(allowed);
				}
			});
		}
	});

	describe('getAuthorizedSigner', function() {
		test('returns owner from parsed path', function() {
			const parsed = testPathPolicy.parse('/user/abc123/file.txt');
			expect(parsed).not.toBeNull();
			if (parsed) {
				expect(testPathPolicy.getAuthorizedSigner(parsed)).toBe('abc123');
			}
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

describe('parseContainerPayload', function() {
	for (const testCase of parseContainerPayloadCases) {
		test(testCase.name, function() {
			const plaintext = Buffer.from(typeof testCase.input === 'string' ? testCase.input : JSON.stringify(testCase.input));
			const result = parseContainerPayload(bufferToArrayBuffer(plaintext));
			expect(result.mimeType).toBe(testCase.expectedMimeType);

			if (Array.isArray(testCase.expectedContent)) {
				expect(result.content).toEqual(Buffer.from(testCase.expectedContent));
			} else {
				expect(result.content.toString()).toBe(testCase.expectedContent);
			}
		});
	}
});
