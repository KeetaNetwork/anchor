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

// Data-driven tests for VerifySignedData options
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
