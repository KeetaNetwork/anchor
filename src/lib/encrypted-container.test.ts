import { test, expect, describe } from 'vitest';
import { Account } from '@keetapay/keetanet-node/dist/lib/account.js';
import * as EncryptedContainer from './encrypted-container.js';

const testAccount1 = Account.fromSeed('D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D', 0);
const testAccount2 = Account.fromSeed('D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D', 1);
const testCipherKey = Buffer.from('379D32897C8726F169621464CB1F0B0940308CD91F32A05728C11237CB79E178', 'hex');
const testCipherIV = Buffer.from('94DE12D10B4455148E92A77BAFEC7D94', 'hex');
const cipherAlgorithm = 'aes-256-cbc';

describe('Encrypted Container Internal Tests', function() {
	test('Parse/Build ASN.1 (Unencrypted)', async function() {
		/*
		 * Create an unencrypted container
		 */
		const plaintextBuffer = await EncryptedContainer._Testing.buildASN1(Buffer.from('Test'), false);
		expect(plaintextBuffer.toString('hex')).toEqual('3015020101a110300e040c789c0b492d2e010003dd01a1');
	});

	test('Parse/Build ASN.1 (Single)', async function() {
		/*
		 * Create a container encrypted with a single public key
		 */
		const encryptedBufferSingle = await EncryptedContainer._Testing.buildASN1(
			Buffer.from('Test'),
			true,
			cipherAlgorithm,
			[testAccount1],
			testCipherKey,
			testCipherIV
		);
		expect(encryptedBufferSingle.toString('hex').slice(0, 120)).toEqual('3081ed0201000101ff3081e43081bd3081ba0323000002a64162287fb9cbefdcb195123d1219c0e374eb56ac1a3ada733b335f52cbd87b0381920004');
		expect(encryptedBufferSingle.toString('hex').slice(408)).toEqual('041094de12d10b4455148e92a77bafec7d9404103afda951bb876fae84679edf593b6bf4');

		/*
		 * Verify that it can be decrypted and get back the original data
		 */
		const decryptedBufferSingle = await EncryptedContainer._Testing.parseASN1(
			encryptedBufferSingle,
			[testAccount1]
		);
		expect(decryptedBufferSingle.plaintext.toString('utf-8')).toEqual('Test');
		if (!('cipherKey' in decryptedBufferSingle)) {
			throw(new Error('internal error: Missing cipher key'));
		}
		expect(decryptedBufferSingle.cipherKey.toString('hex')).toEqual(testCipherKey.toString('hex'));
		expect(decryptedBufferSingle.cipherIV.toString('hex')).toEqual(testCipherIV.toString('hex'));
		expect(decryptedBufferSingle.isEncrypted).toBe(true);
		expect(decryptedBufferSingle.encryptedData.length).toEqual(16);
	});

	test('Parse/Build ASN.1 (Multi)', async function() {
		/*
		 * Create a container encrypted with multiple public keys
		 */
		const encryptedBufferMulti = await EncryptedContainer._Testing.buildASN1(
			Buffer.from('Test'),
			true,
			cipherAlgorithm,
			[testAccount1, testAccount2],
			testCipherKey,
			testCipherIV
		);
		expect(encryptedBufferMulti.toString('hex').slice(0, 126)).toEqual('308201ac0201000101ff308201a23082017a3081ba0323000002a64162287fb9cbefdcb195123d1219c0e374eb56ac1a3ada733b335f52cbd87b0381920004');
		expect(encryptedBufferMulti.toString('hex').slice(792)).toEqual('041094de12d10b4455148e92a77bafec7d9404103afda951bb876fae84679edf593b6bf4');

		/*
		 * Verify that it can be decrypted by either party
		 */
		for (const checkAccount of [testAccount1, testAccount2]) {
			const decryptedBufferMultiPart = await EncryptedContainer._Testing.parseASN1(
				encryptedBufferMulti,
				[checkAccount]
			);

			expect(decryptedBufferMultiPart.plaintext.toString('utf-8')).toEqual('Test');
		}
	});
});

describe('Encrypted Container Tests', function() {
	test('Basic Tests', async function() {
		const testString = 'Test';
		const testData = Buffer.from(testString, 'utf-8');
		const testDataDuplicate = Buffer.from(testString, 'utf-8');

		/*
		 * Basic container with a single account
		 */
		const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, [testAccount1]);

		/*
		 * Verify that it can be encrypted successfully
		 */
		const basicCipherText_v1 = await container.getEncodedBuffer();
		expect(basicCipherText_v1.length).toBeGreaterThan(32);

		/*
		 * Verify that it can be decrypted successfully
		 */
		const basicCipherTextPlain_v1 = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v1, [testAccount1]);
		const basicCipherTextPlain_v1Text = await basicCipherTextPlain_v1.getPlaintext();
		expect(basicCipherTextPlain_v1Text).toEqual(testData);

		/**
		 * Verify that if we mutate the results that it does not
		 * mutate the internal state of the object
		 */
		basicCipherTextPlain_v1Text[0] = 0;
		const basicCipherTextPlain_v1TextCheck = await basicCipherTextPlain_v1.getPlaintext();
		expect(basicCipherTextPlain_v1TextCheck).toEqual(testData);
		expect(basicCipherTextPlain_v1TextCheck).toEqual(testDataDuplicate);

		/*
		 * Verify that the plaintext can be disabled
		 */
		basicCipherTextPlain_v1.disablePlaintext();
		await expect(async function() {
			await basicCipherTextPlain_v1.getPlaintext();
		}).rejects.toThrow();

		/*
		 * Grant access to the container to a new account
		 */
		container.grantAccessSync(testAccount2);

		const basicCipherText_v2 = await container.getEncodedBuffer();
		expect(basicCipherText_v2.toString('hex')).not.toEqual(basicCipherText_v1.toString('hex'));

		/*
		 * Verify that either user can decrypt that blob
		 */
		for (const checkAccount of [testAccount1, testAccount2]) {
			const basicCipherTextPlain_v2 = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v2, [checkAccount]);
			expect(await basicCipherTextPlain_v2.getPlaintext()).toEqual(testData);

			/*
			 * Verify that regardless of only one user being
			 * specified, the blob has all the principals expected
			 */
			expect(basicCipherTextPlain_v2.principals.length).toEqual(2);
			for (const checkInnerAccount of [testAccount1, testAccount2]) {
				const hasPrincipal = basicCipherTextPlain_v2.principals.find(function(compareAccount) {
					return(compareAccount.comparePublicKey(checkInnerAccount));
				});

				expect(hasPrincipal).toBeDefined();
			}
		}

		/*
		 * Revoke access for a specific user
		 */
		container.revokeAccessSync(testAccount1);
		const basicCipherText_v3 = await container.getEncodedBuffer();
		expect(basicCipherText_v3.toString('hex')).not.toEqual(basicCipherText_v1.toString('hex'));
		expect(basicCipherText_v3.toString('hex')).not.toEqual(basicCipherText_v2.toString('hex'));

		/*
		 * Ensure that the authorized user can access the encrypted
		 * data (given both acceptable and unacceptable keys)
		 */
		const basicCipherTextPlain_v3_a = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v3, [testAccount1, testAccount2]);
		expect(await basicCipherTextPlain_v3_a.getPlaintext()).toEqual(testData);

		/*
		 * Ensure that the authorized user can access the encrypted
		 * data (given only acceptable keys)
		 */
		const basicCipherTextPlain_v3_b = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v3, [testAccount2]);
		expect(await basicCipherTextPlain_v3_b.getPlaintext()).toEqual(testData);

		/*
		 * Ensure that the revoked user cannot access the encrypted data
		 */
		await expect(async function() {
			const basicCipherTextPlain_v3_c = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v3, [testAccount1]);
			await basicCipherTextPlain_v3_c.getPlaintext();
		}).rejects.toThrow();
	});

	test('Multiple Conversions', async function() {
		/*
		 * Perform multiple round-trips through the encoding/decoding
		 * process, mutating the data and only instantiating with
		 * subsets of the accounts along the way
		 */
		const testData1 = Buffer.from('Test', 'utf-8');
		const testData2 = Buffer.from('More Test', 'utf-8');
		const container_v1 = EncryptedContainer.EncryptedContainer.fromPlaintext(testData1, [testAccount1, testAccount2]);
		const encryptedTestData_v1 = await container_v1.getEncodedBuffer();
		expect(container_v1.encrypted).toBe(true);

		const container_v2 = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(encryptedTestData_v1, [testAccount2]);
		container_v2.setPlaintext(testData2);
		expect(container_v2.encrypted).toBe(true);

		const encryptedTestData_v3 = await container_v2.getEncodedBuffer();
		const container_v4 = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(encryptedTestData_v3, [testAccount1]);
		expect(container_v4.principals.length).toBe(2);
		expect(container_v4.encrypted).toBe(true);

		const plaintextTestData_v5 = await container_v4.getPlaintext();
		expect(plaintextTestData_v5).toEqual(testData2);
	});

	test('Plaintext', async function() {
		/*
		 * Create a container with plaintext data
		 */
		const testData = Buffer.from('Test', 'utf-8');
		const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, null, false);

		/*
		 * Verify that the plaintext can be retrieved
		 */
		const plaintextData = await container.getPlaintext();
		expect(container.encrypted).toBe(false);
		expect(plaintextData).toEqual(testData);

		const container_v2 = EncryptedContainer.EncryptedContainer.fromEncodedBuffer(await container.getEncodedBuffer(), null);
		expect(container_v2.encrypted).toBe(false);
		expect(await container_v2.getPlaintext()).toEqual(testData);
	});
});
