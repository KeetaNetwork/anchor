import { test, expect, describe } from 'vitest';
import KeetaNet from '@keetanetwork/keetanet-client';
import { Errors } from './common.js';
import { testPathPolicy } from './test-utils.js';

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
		test('returns account for parsed path owner', function() {
			const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
			const pubkey = account.publicKeyString.get();
			const parsed = testPathPolicy.validate(`/user/${pubkey}/file.txt`);
			const signer = testPathPolicy.getAuthorizedSigner(parsed);
			expect(signer).not.toBeNull();
			expect(signer?.publicKeyString.get()).toBe(pubkey);
		});
	});
});
