import { test, expect } from 'vitest';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as Signing from './signing.js';
import { Buffer, bufferToArrayBuffer } from '../../lib/utils/buffer.js';

const genericAccount = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);
const TestVectors = [
	{ data: [] },
	{ data: ['test-string'] },
	{ data: [12345] },
	{ data: [genericAccount] },
	{ data: ['string', 67890, genericAccount] }
];

test('Basic Tests (Format Data)', async function() {
	const signAccount = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);

	for (const checkVector of TestVectors) {
		const check = Signing.FormatData(signAccount, checkVector.data);
		expect(check).toHaveProperty('nonce');
		expect(check).toHaveProperty('timestamp');
		expect(check).toHaveProperty('verificationData');
		expect(Buffer.isBuffer(check.verificationData)).toBe(true);

		const reverseCheck = Signing.FormatData(signAccount, checkVector.data, check.nonce, check.timestamp);
		expect(reverseCheck.nonce).toBe(check.nonce);
		expect(reverseCheck.timestamp).toBe(check.timestamp);
		expect(reverseCheck.verificationData.equals(check.verificationData)).toBe(true);
	}
});

test('Basic Tests (Sign and Verify Data)', async function() {
	const account = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);

	for (const checkVector of TestVectors) {
		const signatureInfo = await Signing.SignData(account, checkVector.data);

		const isValid = await Signing.VerifySignedData(
			account,
			checkVector.data,
			signatureInfo
		);

		expect(isValid).toBe(true);

		/*
		 * Change the signature and ensure that the verification fails
		 */
		const alteredSignatureInfo = {
			...signatureInfo,
			signature: signatureInfo.signature.slice(0, 10) + (signatureInfo.signature.slice(10, 11) === 'A' ? 'B' : 'A') + signatureInfo.signature.slice(11)
		};
		const isAlteredValid = await Signing.VerifySignedData(
			account,
			checkVector.data,
			alteredSignatureInfo
		);
		expect(isAlteredValid).toBe(false);

		/*
		 * Change input data and ensure that the verification fails
		 */
		const alteredData = [...checkVector.data, 'extra-data'];
		const isAlteredDataValid = await Signing.VerifySignedData(
			account,
			alteredData,
			signatureInfo
		);
		expect(isAlteredDataValid).toBe(false);

		/*
		 * Change the nonce and ensure that the verification fails
		 */
		const alteredNonceSignatureInfo = {
			...signatureInfo,
			nonce: signatureInfo.nonce.slice(0, 10) + (signatureInfo.nonce.slice(10) === 'A' ? 'B' : 'A') + signatureInfo.nonce.slice(11)
		};
		const isAlteredNonceValid = await Signing.VerifySignedData(
			account,
			checkVector.data,
			alteredNonceSignatureInfo
		);
		expect(isAlteredNonceValid).toBe(false);
	}
});

// Tests for VerifySignedData options
const verifyOptionsCases = [
	// maxSkewMs tests
	{
		name: '10-min-old signature fails with default skew',
		timestampOffsetMs: -10 * 60 * 1000,
		options: undefined,
		expected: false
	},
	{
		name: '10-min-old signature succeeds with 1-hour skew',
		timestampOffsetMs: -10 * 60 * 1000,
		options: { maxSkewMs: 60 * 60 * 1000 },
		expected: true
	},
	{
		name: '6-min-old signature fails with default 5-min skew',
		timestampOffsetMs: -6 * 60 * 1000,
		options: undefined,
		expected: false
	},
	{
		name: '4-min-old signature succeeds with default 5-min skew',
		timestampOffsetMs: -4 * 60 * 1000,
		options: undefined,
		expected: true
	},
	// referenceTime tests
	{
		name: 'current signature fails with future reference time',
		timestampOffsetMs: 0,
		options: { referenceTime: new Date(Date.now() + 10 * 60 * 1000) },
		expected: false
	},
	{
		name: 'current signature succeeds with future reference time and extended skew',
		timestampOffsetMs: 0,
		options: { referenceTime: new Date(Date.now() + 10 * 60 * 1000), maxSkewMs: 15 * 60 * 1000 },
		expected: true
	}
];

const objectToSignableCases: { name: string; input: Signing.SignableInput; expected: Signing.Signable }[] = [
	{
		name: 'flat object emits JCS string with keys sorted by codepoint',
		input: { z: 1, a: 'first', m: 'middle' },
		expected: [ '{"a":"first","m":"middle","z":1}' ]
	},
	{
		name: 'nested object preserves structure',
		input: { outer: { inner: 'v' }, top: 't' },
		expected: [ '{"outer":{"inner":"v"},"top":"t"}' ]
	},
	{
		name: 'arrays preserve index order',
		input: { items: [ 'a', 'b', 'c' ] },
		expected: [ '{"items":["a","b","c"]}' ]
	},
	{
		name: 'object keys with undefined values are dropped, null values are kept',
		input: { a: 'kept', b: undefined, c: null },
		expected: [ '{"a":"kept","c":null}' ]
	},
	{
		name: 'booleans serialize as JSON true/false',
		input: { yes: true, no: false },
		expected: [ '{"no":false,"yes":true}' ]
	},
	{
		name: 'object key insertion order does not affect output',
		input: { b: 2, a: 1 },
		expected: [ '{"a":1,"b":2}' ]
	},
	{
		name: 'top-level scalar emits a JSON string literal',
		input: 'lonely',
		expected: [ '"lonely"' ]
	},
	{
		name: 'top-level array preserves element order',
		input: [ 'x', 'y' ],
		expected: [ '["x","y"]' ]
	},
	{
		name: 'array null and undefined entries serialize as JSON null',
		input: [ 'x', null, undefined, 'y' ],
		expected: [ '["x",null,null,"y"]' ]
	},
	{
		name: 'marker-like characters as keys and values are escaped properly by JCS',
		input: { a: 'first', m: 'middle', '{': 'a', '}': '{' },
		expected: [ '{"a":"first","m":"middle","{":"a","}":"{"}' ]
	},
	{
		name: 'RFC 8785 Section 3.2.3 sort vector: keys ordered by UTF-16 code unit',
		input: {
			'\u20ac': 'Euro Sign',
			'\r': 'Carriage Return',
			'1': 'One'
		},
		expected: [ '{"\\r":"Carriage Return","1":"One","\u20ac":"Euro Sign"}' ]
	},
	{
		name: 'sparse array holes serialize as JSON null preserving index',
		input: (function() {
			const arr = new Array<string>(3);
			arr[0] = 'a';
			arr[2] = 'c';
			return(arr);
		})(),
		expected: [ '["a",null,"c"]' ]
	},
	{
		name: 'Date instances serialize as their ISO 8601 string',
		input: { at: new Date('2024-01-02T03:04:05.678Z') },
		expected: [ '{"at":"2024-01-02T03:04:05.678Z"}' ]
	}
];

for (const testCase of objectToSignableCases) {
	test(`objectToSignable: ${testCase.name}`, function() {
		const out = Signing.objectToSignable(testCase.input);
		expect(out).toEqual(testCase.expected);
	});
}

const objectToSignableDistinctCases: { name: string; a: Signing.SignableInput; b: Signing.SignableInput }[] = [
	{
		name: 'object with numeric-string key vs array',
		a: { '0': 'x' },
		b: ['x']
	},
	{
		name: 'nested object vs flat object using dot separator',
		a: { a: { b: 'x' }},
		b: { 'a.b': 'x' }
	},
	{
		name: 'array with null entry vs array without it',
		a: ['x', null, 'y'],
		b: ['x', 'y']
	}
];

for (const testCase of objectToSignableDistinctCases) {
	test(`objectToSignable distinct: ${testCase.name}`, function() {
		const a = Signing.objectToSignable(testCase.a);
		const b = Signing.objectToSignable(testCase.b);
		expect(a).not.toEqual(b);
	});
}

test('objectToSignable: equivalent inputs produce a verifiable signature against either form', async function() {
	const account = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);
	const a = Signing.objectToSignable({ a: 1, b: { c: 'x', d: 'y' }});
	const b = Signing.objectToSignable({ b: { d: 'y', c: 'x' }, a: 1 });
	const signed = await Signing.SignData(account, a);

	const isValid = await Signing.VerifySignedData(account, b, signed);
	expect(isValid).toBe(true);
});

const forgerySignedObject: Signing.SignableInput = { a: 'first', m: 'middle', '{': 'a', '}': '{' };
const forgeryAccount = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);
const forgeryAttempts: { name: string; original: Signing.SignableInput; forged: Signing.SignableInput; expected: boolean }[] = [
	{
		name: 'reordered keys verify',
		original: forgerySignedObject,
		forged: { '}': '{', '{': 'a', m: 'middle', a: 'first' },
		expected: true
	},
	{
		name: 'changed value fails',
		original: forgerySignedObject,
		forged: { a: 'first', m: 'middle', '{': 'b', '}': '{' },
		expected: false
	},
	{
		name: 'added key fails',
		original: forgerySignedObject,
		forged: { a: 'first', m: 'middle', '{': 'a', '}': '{', extra: 'x' },
		expected: false
	},
	{
		name: 'removed key fails',
		original: forgerySignedObject,
		forged: { a: 'first', m: 'middle', '{': 'a' },
		expected: false
	},
	{
		name: 'swapped values across keys fails',
		original: forgerySignedObject,
		forged: { a: 'middle', m: 'first', '{': 'a', '}': '{' },
		expected: false
	},
	{
		name: 'reshape into a nested object with the same scalars fails',
		original: forgerySignedObject,
		forged: { a: 'first', m: 'middle', n: { '{': 'a', '}': '{' }},
		expected: false
	},
	{
		name: 'array forged as object with index keys fails',
		original: [ 'x', 'y' ],
		forged: { '0': 'x', '1': 'y' },
		expected: false
	},
	{
		name: 'Account forged as the empty object fails',
		original: forgeryAccount,
		forged: {},
		expected: false
	}
];

for (const attempt of forgeryAttempts) {
	test(`VerifySignedData forgery resistance: ${attempt.name}`, async function() {
		const account = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);
		const signed = await Signing.SignData(account, Signing.objectToSignable(attempt.original));

		const result = await Signing.VerifySignedData(account, Signing.objectToSignable(attempt.forged), signed);
		expect(result).toBe(attempt.expected);
	});
}

test('objectToSignable: throws when node count exceeds DoS guard', function() {
	const big: { [key: string]: string } = {};
	for (let i = 0; i < 2000; i++) {
		big[`k${i}`] = `v${i}`;
	}

	expect(() => Signing.objectToSignable(big)).toThrow();
});

const objectToSignableRejectionCases: { name: string; input: Signing.SignableInput }[] = [
	// @ts-expect-error
	{ name: 'Map instance', input: new Map() },
	// @ts-expect-error
	{ name: 'Set instance', input: new Set() },
	// @ts-expect-error
	{ name: 'RegExp instance', input: /x/ },
	{ name: 'NaN value', input: { x: Number.NaN }},
	{ name: 'positive infinity value', input: { x: Number.POSITIVE_INFINITY }},
	{ name: 'bigint above MAX_SAFE_INTEGER', input: { x: BigInt(Number.MAX_SAFE_INTEGER) + 1n }},
	{ name: 'lone high surrogate in value', input: { x: '\uD800' }},
	{ name: 'lone low surrogate in key', input: { '\uDC00': 'x' }},
	{ name: 'invalid Date instance', input: { at: new Date('not a date') }}
];

for (const testCase of objectToSignableRejectionCases) {
	test(`objectToSignable rejects: ${testCase.name}`, function() {
		expect(() => Signing.objectToSignable(testCase.input)).toThrow();
	});
}

for (const testCase of verifyOptionsCases) {
	test(`VerifySignedData: ${testCase.name}`, async function() {
		const account = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);
		const data = ['test-data'];

		// Create signature with offset timestamp
		const signTime = new Date(Date.now() + testCase.timestampOffsetMs);
		const { nonce, timestamp, verificationData } = Signing.FormatData(account, data, undefined, signTime);
		const signature = await account.sign(bufferToArrayBuffer(verificationData));
		const signedData = {
			nonce,
			timestamp,
			signature: signature.getBuffer().toString('base64')
		};

		const result = await Signing.VerifySignedData(account, data, signedData, testCase.options);
		expect(result).toBe(testCase.expected);
	});
}
