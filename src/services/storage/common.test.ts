import { test, expect, describe } from 'vitest';
import KeetaNet from '@keetanetwork/keetanet-client';
import { defaultPathPolicy, PathPolicy, parseContainerPayload, Errors, type AccessEvent } from './common.js';
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

describe('PathPolicy', function() {
	describe.each(validPaths)('parse($input)', function({ input, path, owner, relativePath }) {
		test('returns parsed path', function() {
			expect(defaultPathPolicy.parse(input)).toEqual({ path, owner, relativePath });
		});

		test('isValid returns true', function() {
			expect(defaultPathPolicy.isValid(input)).toBe(true);
		});

		test('validate returns parsed path', function() {
			expect(defaultPathPolicy.validate(input)).toEqual({ path, owner, relativePath });
		});
	});

	describe.each(invalidPaths)('invalid path: %s', function(input) {
		test('parse returns null', function() {
			expect(defaultPathPolicy.parse(input)).toBeNull();
		});

		test('isValid returns false', function() {
			expect(defaultPathPolicy.isValid(input)).toBe(false);
		});

		test('validate throws InvalidPath', function() {
			expect(function() { defaultPathPolicy.validate(input); }).toThrow(Errors.InvalidPath);
		});
	});

	const makePathCases = [
		{ owner: 'abc123', relativePath: 'file.txt', expected: '/user/abc123/file.txt' },
		{ owner: 'abc123', relativePath: 'docs/file.txt', expected: '/user/abc123/docs/file.txt' }
	] as const;

	describe.each(makePathCases)('makePath($owner, $relativePath)', function({ owner, relativePath, expected }) {
		test(`returns ${expected}`, function() {
			expect(defaultPathPolicy.makePath(owner, relativePath)).toBe(expected);
		});
	});

	test('getNamespacePrefix returns correct prefix', function() {
		expect(defaultPathPolicy.getNamespacePrefix('abc123')).toBe('/user/abc123/');
	});

	test('custom pattern configuration', function() {
		const customPolicy = new PathPolicy({
			pattern: /^\/files\/([^/]+)\/(.+)$/,
			namespacePrefix: function(owner) { return(`/files/${owner}/`); }
		});
		expect(customPolicy.parse('/files/user1/doc.txt')).toEqual({
			path: '/files/user1/doc.txt',
			owner: 'user1',
			relativePath: 'doc.txt'
		});
		expect(customPolicy.getNamespacePrefix('user1')).toBe('/files/user1/');
	});

	describe('assertAccess', function() {
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
				if (allowed) {
					const result = defaultPathPolicy.assertAccess(account, testPath, 'get');
					expect(result).toEqual({ path: testPath, owner: ownerPubKey, relativePath: 'file.txt' });
				} else {
					expect(function() { defaultPathPolicy.assertAccess(account, testPath, 'get'); }).toThrow(Errors.AccessDenied);
				}
			});

			test(`${name} - logs allowed=${allowed}`, function() {
				const events: AccessEvent[] = [];
				const policy = new PathPolicy({ logger: function(e) { events.push(e); } });

				if (allowed) {
					policy.assertAccess(account, testPath, 'put');
				} else {
					expect(function() { policy.assertAccess(account, testPath, 'put'); }).toThrow(Errors.AccessDenied);
				}

				expect(events).toHaveLength(1);
				expect(events[0]?.operation).toBe('put');
				expect(events[0]?.allowed).toBe(allowed);
			});
		}
	});

	describe('assertSearchAccess', function() {
		const seed = KeetaNet.lib.Account.generateRandomSeed();
		const userAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
		const userPubKey = userAccount.publicKeyString.get();

		const searchCases = [
			{ name: 'owner matches', criteria: { owner: userPubKey }, allowed: true },
			{ name: 'pathPrefix within namespace', criteria: { pathPrefix: `/user/${userPubKey}/docs/` }, allowed: true },
			{ name: 'owner mismatch', criteria: { owner: 'other-user' }, allowed: false },
			{ name: 'pathPrefix outside namespace', criteria: { pathPrefix: '/user/other-user/docs/' }, allowed: false }
		];

		for (const { name, criteria, allowed } of searchCases) {
			test(name, function() {
				if (allowed) {
					expect(function() { defaultPathPolicy.assertSearchAccess(userAccount, criteria); }).not.toThrow();
				} else {
					expect(function() { defaultPathPolicy.assertSearchAccess(userAccount, criteria); }).toThrow(Errors.AccessDenied);
				}
			});

			test(`${name} - logs allowed=${allowed}`, function() {
				const events: AccessEvent[] = [];
				const policy = new PathPolicy({ logger: function(e) { events.push(e); } });

				if (allowed) {
					policy.assertSearchAccess(userAccount, criteria);
				} else {
					expect(function() { policy.assertSearchAccess(userAccount, criteria); }).toThrow(Errors.AccessDenied);
				}

				expect(events).toHaveLength(1);
				expect(events[0]?.operation).toBe('search');
				expect(events[0]?.allowed).toBe(allowed);
			});
		}
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
