import { test, expect, describe } from 'vitest';
import * as EncryptedContainer from './encrypted-container.js';
import { EncryptedContainerError } from './encrypted-container.js';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { arrayBufferLikeToBuffer } from './utils/buffer.js';

const JStoASN1 = KeetaNetLib.Utils.ASN1.JStoASN1;
const Account: typeof KeetaNetLib.Account = KeetaNetLib.Account;
type Account = InstanceType<typeof KeetaNetLib.Account>;

const testAccount1 = Account.fromSeed('D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D', 0);
const testAccount2 = Account.fromSeed('D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D', 1);
const testCipherKey = Buffer.from('379D32897C8726F169621464CB1F0B0940308CD91F32A05728C11237CB79E178', 'hex');
const testCipherIV = Buffer.from('94DE12D10B4455148E92A77BAFEC7D94', 'hex');
const cipherAlgorithm = 'aes-256-cbc';

/*
	* Create a container encrypted with a single public key
	*/
const defaultEncryptionOptions = {
	keys: [testAccount1],
	cipherKey: testCipherKey,
	cipherIV: testCipherIV,
	cipherAlgo: cipherAlgorithm
}

describe('Encrypted Container Internal Tests', function() {
	describe('Build ASN.1', function() {
		/*
		* Test cases for invalid parameters
		*/
		const defaultTestEncryptionOptions = {
			keys: [testAccount1],
			cipherKey: testCipherKey,
			cipherIV: testCipherIV,
			cipherAlgo: cipherAlgorithm
		};
		const testCases = [
			{
				description: 'should fail with missing keys',
				encryptionOptions: { ...defaultTestEncryptionOptions, keys: [] }
			},

			{
				description: 'should fail with undefined cipher key',
				encryptionOptions: { ...defaultTestEncryptionOptions, cipherKey: undefined }
			},
			{
				description: 'should fail with undefined cipher IV',
				encryptionOptions: { ...defaultTestEncryptionOptions, cipherIV: undefined }
			},
			{
				description: 'should fail with unsupported cipher algorithm',
				encryptionOptions: { ...defaultTestEncryptionOptions, cipherAlgo: 'xxx' }
			}
		];
		for (const testCase of testCases) {
			test(testCase.description, async function() {
				await expect(async function() {
					await EncryptedContainer._Testing.buildASN1(Buffer.from('Test'), testCase.encryptionOptions);
				}).rejects.toThrow();
			});
		}
	});

	describe('Parse ASN.1', async function() {
		const formatASN1 = function(version: string | number, encrypted: number, contains: null | string | number | Buffer | string[]) {
			const sequence = [];
			sequence[0] = version;
			sequence[1] = {
				type: 'context' as const,
				kind: 'explicit' as const,
				value: encrypted,
				contains
			};
			const outputASN1 = JStoASN1(sequence);
			const outputDER = arrayBufferLikeToBuffer(outputASN1.toBER(false));
			return(outputDER);
		};
		const encryptedBufferSingle = await EncryptedContainer._Testing.buildASN1(
			Buffer.from('Test'),
			defaultEncryptionOptions
		);
		/*
		* Test cases for invalid parameters
		*/
		const testCases = [
			{
				description: 'should fail with missing keys for encrypted buffer',
				input: encryptedBufferSingle,
				keys: []
			},
			{
				description: 'should fail with sequence not an array',
				input: arrayBufferLikeToBuffer(JStoASN1('TEST').toBER(false))
			},
			{
				description: 'should fail with version not a bigint',
				input: formatASN1('test', 0, 0)
			},
			{
				description: 'should fail with unsupported version (0)',
				input: formatASN1(0, 0, 0)
			},
			{
				description: 'should fail with invalid sequence[1] not an object',
				input: arrayBufferLikeToBuffer(JStoASN1([1, 'Test']).toBER(false))
			},
			{
				description: 'should fail with invalid sequence[1] is null',
				input: arrayBufferLikeToBuffer(JStoASN1([1, null]).toBER(false))
			},
			{
				description: 'should fail with invalid value range',
				input: formatASN1(1, 5, 0),
				keys: []
			},
			{
				description: 'should fail with null contains type',
				input: formatASN1(1, 1, null)
			},
			{
				description: 'should fail with invalid contains type',
				input: formatASN1(1, 1, 0)
			},
			{
				description: 'should fail with too many values for unencrypted container',
				input: formatASN1(1, 1, ['test1', 'test2'])
			}
		];
		for (const testCase of testCases) {
			test(testCase.description, async function() {
				await expect(async function() {
					await EncryptedContainer._Testing.parseASN1(testCase.input, testCase.keys);
				}).rejects.toThrow();
			});
		}
	});

	test('Parse/Build ASN.1 (Unencrypted)', async function() {
		/*
		 * Create an unencrypted container
		 */
		const plaintextBuffer = await EncryptedContainer._Testing.buildASN1(Buffer.from('Test'));
		expect(plaintextBuffer.toString('hex')).toEqual('3015020101a110300e040c789c0b492d2e010003dd01a1');
	});

	test('Parse/Build ASN.1 (Single)', async function() {
		const encryptedBufferSingle = await EncryptedContainer._Testing.buildASN1(
			Buffer.from('Test'),
			defaultEncryptionOptions
		);
		expect(encryptedBufferSingle.toString('hex').slice(0, 116)).toEqual('3081f6020101a081f03081ed3081bb3081b804220002a64162287fb9cbefdcb195123d1219c0e374eb56ac1a3ada733b335f52cbd87b04819104');
		expect(encryptedBufferSingle.toString('hex').slice(404)).toEqual('060960864801650304012a041094de12d10b4455148e92a77bafec7d9404103afda951bb876fae84679edf593b6bf4');

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
		const encryptionOptions = {
			...defaultEncryptionOptions,
			keys: [testAccount1, testAccount2]
		}
		const encryptedBufferMulti = await EncryptedContainer._Testing.buildASN1(
			Buffer.from('Test'),
			encryptionOptions
		);
		expect(encryptedBufferMulti.toString('hex').slice(0, 124)).toEqual('308201b4020101a08201ad308201a9308201763081b804220002a64162287fb9cbefdcb195123d1219c0e374eb56ac1a3ada733b335f52cbd87b04819104');
		expect(encryptedBufferMulti.toString('hex').slice(786)).toEqual('060960864801650304012a041094de12d10b4455148e92a77bafec7d9404103afda951bb876fae84679edf593b6bf4');

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
		const testDataAsUint8 = new Uint8Array(testData);
		const testDataDuplicate = Buffer.from(testString, 'utf-8');
		const testDataDuplicateAsUint8 = new Uint8Array(testDataDuplicate);

		/*
		 * Basic container with a single account
		 */
		const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, [testAccount1]);

		/*
		 * Verify that it can be encrypted successfully
		 */
		const basicCipherText_v1 = await container.getEncodedBuffer();
		expect(basicCipherText_v1.byteLength).toBeGreaterThan(32);

		/*
		 * Verify that it can be decrypted successfully
		 */
		const basicCipherTextPlain_v1 = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v1, [testAccount1]);
		const basicCipherTextPlain_v1Text = new Uint8Array(await basicCipherTextPlain_v1.getPlaintext());
		expect(basicCipherTextPlain_v1Text).toEqual(testDataAsUint8);

		/**
		 * Verify that if we mutate the results that it does not
		 * mutate the internal state of the object
		 */
		const basicCipherTextPlain_v1TextCopy = new Uint8Array(basicCipherTextPlain_v1Text);
		basicCipherTextPlain_v1TextCopy[0] = 0x00;
		const basicCipherTextPlain_v1TextCheck = new Uint8Array(await basicCipherTextPlain_v1.getPlaintext());
		expect(basicCipherTextPlain_v1TextCheck).toEqual(testDataAsUint8);
		expect(basicCipherTextPlain_v1TextCheck).toEqual(testDataDuplicateAsUint8);

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
		expect(Buffer.from(basicCipherText_v2).toString('hex')).not.toEqual(Buffer.from(basicCipherText_v1).toString('hex'));

		/*
		 * Verify that either user can decrypt that blob
		 */
		for (const checkAccount of [testAccount1, testAccount2]) {
			const basicCipherTextPlain_v2 = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v2, [checkAccount]);
			expect(new Uint8Array(await basicCipherTextPlain_v2.getPlaintext())).toEqual(testDataAsUint8);

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
		expect(Buffer.from(basicCipherText_v3).toString('hex')).not.toEqual(Buffer.from(basicCipherText_v1).toString('hex'));
		expect(Buffer.from(basicCipherText_v3).toString('hex')).not.toEqual(Buffer.from(basicCipherText_v2).toString('hex'));

		/*
		 * Ensure that the authorized user can access the encrypted
		 * data (given both acceptable and unacceptable keys)
		 */
		const basicCipherTextPlain_v3_a = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v3, [testAccount1, testAccount2]);
		expect(new Uint8Array(await basicCipherTextPlain_v3_a.getPlaintext())).toEqual(testDataAsUint8);

		/*
		 * Ensure that the authorized user can access the encrypted
		 * data (given only acceptable keys)
		 */
		const basicCipherTextPlain_v3_b = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(basicCipherText_v3, [testAccount2]);
		expect(new Uint8Array(await basicCipherTextPlain_v3_b.getPlaintext())).toEqual(testDataAsUint8);

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
		const testData2AsUint8 = new Uint8Array(testData2);
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
		expect(new Uint8Array(plaintextTestData_v5)).toEqual(testData2AsUint8);
	});

	test('Plaintext', async function() {
		/*
		 * Create a container with plaintext data as a buffer
		 */
		const testData = Buffer.from('Test', 'utf-8');
		const testDataAsUint8 = new Uint8Array(testData);
		const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, null, false);

		/*
		 * Verify that the plaintext can be retrieved
		 */
		const plaintextData = await container.getPlaintext();
		expect(container.encrypted).toBe(false);
		expect(new Uint8Array(plaintextData)).toEqual(testDataAsUint8);

		/*
		 * Verify that the plaintext can be set from a string
		 */
		const newTestData = 'New Test Data';
		container.setPlaintext(newTestData);

		const fromBufferContainer = EncryptedContainer.EncryptedContainer.fromEncodedBuffer(await container.getEncodedBuffer(), null);
		expect(fromBufferContainer.encrypted).toBe(false);

		const fromBufferContainerEncoded = await fromBufferContainer.getEncodedBuffer();
		expect(fromBufferContainerEncoded.byteLength).toBe(32);

		// Sync functions that should fail for a plaintext container
		const testCases = [
			function() {
				container.grantAccessSync(testAccount1);
			},
			async function() {
				await container.grantAccess(testAccount1);
			},
			function() {
				fromBufferContainer.grantAccessSync(testAccount1);
			},
			function() {
				container.revokeAccessSync(testAccount1);
			},
			async function() {
				await container.revokeAccess(testAccount1);
			},
			function() {
				fromBufferContainer.revokeAccessSync(testAccount1);
			},
			function() {
				/*
				 * This is a getter, so we are running something -- but we do not care about the result
				 */
				// eslint-disable-next-line @typescript-eslint/no-unused-expressions
				container.principals;
			}
		];

		for (const testCase of testCases) {
			if (testCase.constructor.name === 'AsyncFunction') {
				await expect(testCase).rejects.toThrow();
			} else {
				expect(testCase).toThrow();
			}
		}

		expect(Buffer.from(await fromBufferContainer.getPlaintext())).toEqual(Buffer.from(newTestData, 'utf-8'));

		/*
		 * Verify that the plaintext defaults to unlocked when container is constructed without specifying locked
		 */
		const unlockedContainer = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, null);
		expect(new Uint8Array(await unlockedContainer.getPlaintext())).toEqual(testDataAsUint8);

		/*
		 * Verify that the plaintext container is locked when container is constructed with principals and locked is not defined
		 */
		const lockedContainer = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, [testAccount1]);
		await expect(async function() {
			await lockedContainer.getPlaintext();
		}).rejects.toThrow();
	});
});

describe('Encrypted Container Error Tests', function() {
	describe('EncryptedContainerError.isInstance', function() {
		const testCases = [
			{ input: new EncryptedContainerError('INTERNAL_ERROR', 'Test'), expected: true, description: 'EncryptedContainerError instance' },
			{ input: new Error('Regular error'), expected: false, description: 'generic Error' },
			{ input: null, expected: false, description: 'null' },
			{ input: undefined, expected: false, description: 'undefined' },
			{ input: { message: 'fake' }, expected: false, description: 'plain object' }
		];

		for (const { input, expected, description } of testCases) {
			test(`returns ${expected} for ${description}`, function() {
				expect(EncryptedContainerError.isInstance(input)).toBe(expected);
			});
		}
	});

	test('operations throw EncryptedContainerError with correct code', async function() {
		const testData = Buffer.from('Test', 'utf-8');
		const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, [testAccount1]);
		const encoded = await container.getEncodedBuffer();
		const decrypted = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(encoded, [testAccount1]);
		decrypted.disablePlaintext();

		try {
			await decrypted.getPlaintext();
			expect.fail('Should have thrown');
		} catch (e) {
			expect(EncryptedContainerError.isInstance(e)).toBe(true);
			if (EncryptedContainerError.isInstance(e)) {
				expect(e.code).toBe('PLAINTEXT_DISABLED');
			}
		}
	});
});

describe('Encrypted Container Signing Tests (v3)', function() {
	const testData = Buffer.from('Test content', 'utf-8');

	describe('container creation', function() {
		const accountArray: Account[] = [testAccount1];
		const creationTestCases = [
			{
				description: 'signed encrypted container',
				principals: accountArray,
				options: { signer: testAccount1 },
				expectedSigned: true,
				expectedEncrypted: true
			},
			{
				description: 'signed unencrypted container',
				principals: null,
				options: { locked: false, signer: testAccount1 },
				expectedSigned: true,
				expectedEncrypted: false
			},
			{
				description: 'unsigned container',
				principals: accountArray,
				options: undefined,
				expectedSigned: false,
				expectedEncrypted: true
			},
			{
				description: 'backwards compatible boolean locked parameter',
				principals: accountArray,
				options: true,
				expectedSigned: false,
				expectedEncrypted: true
			}
		];

		for (const { description, principals, options, expectedSigned, expectedEncrypted } of creationTestCases) {
			test(description, function() {
				const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, principals, options);
				expect(container.isSigned).toBe(expectedSigned);
				expect(container.encrypted).toBe(expectedEncrypted);

				if (expectedSigned) {
					expect(container.getSigningAccount()?.comparePublicKey(testAccount1)).toBe(true);
				} else {
					expect(container.getSigningAccount()).toBeUndefined();
				}
			});
		}
	});

	describe('round-trip signature verification', function() {
		test('same signer and principal', async function() {
			const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, [testAccount1], { signer: testAccount1 });
			const encoded = await container.getEncodedBuffer();

			const decoded = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(encoded, [testAccount1]);
			expect(decoded.isSigned).toBe(true);
			expect(decoded.getSigningAccount()?.comparePublicKey(testAccount1)).toBe(true);
			expect(await decoded.verifySignature()).toBe(true);
		});

		test('different signer than principal', async function() {
			const container = EncryptedContainer.EncryptedContainer.fromPlaintext(testData, [testAccount2], { signer: testAccount1 });
			const encoded = await container.getEncodedBuffer();

			const decoded = EncryptedContainer.EncryptedContainer.fromEncryptedBuffer(encoded, [testAccount2]);
			expect(decoded.getSigningAccount()?.comparePublicKey(testAccount1)).toBe(true);
			expect(decoded.getSigningAccount()?.comparePublicKey(testAccount2)).toBe(false);
			expect(await decoded.verifySignature()).toBe(true);
		});
	});
});
