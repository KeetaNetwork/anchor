import * as zlib from 'zlib';
import * as crypto from 'crypto';

import Account from '@keetapay/keetanet-client/lib/account';
import { ASN1toJS, JStoASN1 } from '@keetapay/keetanet-client/lib/utils/asn1';
import { bufferToArrayBuffer } from '@keetapay/keetanet-client/lib/utils/helper';

import type { EncryptedMetadataWithoutHeader } from './metadata';
import { MetadataStore } from './metadata';
import type { ErrorCode } from './error';
import { ExpectErrorCode } from './error';

function generateRandomKeyedAccount() {
	return(Account.fromSeed(Account.generateRandomSeed(), 0));
}

it('should build and compile a metadata object from simple inputs', async () => {
	const expectedText = 'Hello World!';
	const expectedBase64 = 'MB4CAQABAQAwFgQUeJzzSM3JyVcIzy/KSVEEABxJBD4=';

	const metadataBuilder = await MetadataStore.createFromPlainText(expectedText);

	const receivedBase64 = await metadataBuilder.build();
	expect(receivedBase64).toBe(expectedBase64);

	const rebuiltData = await MetadataStore.fromData(receivedBase64);
	expect(rebuiltData.data.value).toBe(expectedText);
});

it('should encrypt metadata when provided with a valid principal', async () => {
	const account = generateRandomKeyedAccount();
	const expectedText = 'Hello World!';

	const metadataStore = await MetadataStore.createFromPlainText(expectedText);

	const unencryptedDataBase64 = await metadataStore.build();
	const unencryptedData = Buffer.from(unencryptedDataBase64, 'base64');
	// eslint-disable-next-line no-type-assertion/no-type-assertion
	const unencryptedMetadata = ASN1toJS(bufferToArrayBuffer(unencryptedData)) as any;
	const unencryptedMetadataValue = unencryptedMetadata[2][0];
	expect(zlib.inflateSync(unencryptedMetadataValue).toString()).toBe(expectedText);

	expect(metadataStore.data.keys.length).toEqual(0);

	await metadataStore.grantAccess(account);

	expect(metadataStore.data.keys.length).toEqual(1);

	const encryptedDataBase64 = await metadataStore.build();
	const encryptedData = Buffer.from(encryptedDataBase64, 'base64');

	// eslint-disable-next-line no-type-assertion/no-type-assertion
	const encryptedMetadata = ASN1toJS(bufferToArrayBuffer(encryptedData)) as any;
	const encryptedMetadataValue = encryptedMetadata[2][2];
	expect(() => zlib.inflateSync(encryptedMetadataValue)).toThrow();

	const accountPublicKey = Account.fromEcDSAPublicKeyK1(encryptedMetadata[2][0][0][0].value);
	expect(accountPublicKey.publicKeyString.get()).toBe(account.publicKeyString.get());

	const encryptedEncryptionKey = bufferToArrayBuffer(encryptedMetadata[2][0][0][1].value);
	const encryptionKey = Buffer.from(await account.decrypt(encryptedEncryptionKey));
	const iv = encryptedMetadata[2][1];
	const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, iv);
	const decryptedData = Buffer.concat([ decipher.update(encryptedMetadataValue), decipher.final() ]);
	const deflatedData = zlib.inflateSync(decryptedData).toString();
	expect(deflatedData).toBe(expectedText);
});

it('should compile and grant/revoke access to another account', async () => {
	const account = generateRandomKeyedAccount();
	const shareAccount = generateRandomKeyedAccount();

	const metadataBuilder = await MetadataStore.createFromPlainText('Test', [ account ]);

	// No keys for new metadata until first build
	expect(metadataBuilder.data.keys).toHaveLength(1);

	await metadataBuilder.grantAccess(shareAccount);

	expect(metadataBuilder.data.keys).toHaveLength(2);
	expect(metadataBuilder.data.keys).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				publicKey: account.publicKey
			})
		])
	);
	expect(metadataBuilder.data.keys).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				publicKey: shareAccount.publicKey
			})
		])
	);

	await metadataBuilder.revokeAccess(shareAccount);

	expect(metadataBuilder.data.keys).toHaveLength(1);
	expect(metadataBuilder.data.keys).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				publicKey: account.publicKey
			})
		])
	);
});

it('Should be able to decrypt + encrypt data, and have multiple accounts', async () => {
	const testingData = crypto.randomBytes(32).toString('hex');
	const builder = await MetadataStore.createFromPlainText(testingData);

	expect(builder.data.keys.length).toEqual(0);
	expect(builder.isEncrypted).toEqual(false);
	expect(builder.data.value).toEqual(testingData);

	const encryptedForAccountOne = generateRandomKeyedAccount();

	await ExpectErrorCode('METADATA_CANNOT_REVOKE_ACCESS_NOT_ENCRYPTED', async function() {
		await builder.revokeAccess(encryptedForAccountOne);
	});

	expect(builder.checkAccountHasAccess(encryptedForAccountOne)).toEqual(false);
	await builder.grantAccess(encryptedForAccountOne);
	expect(builder.checkAccountHasAccess(encryptedForAccountOne)).toEqual(true);

	await ExpectErrorCode('METADATA_ACCOUNT_MUST_SUPPORT_ENCRYPTION', async function() {
		// @ts-expect-error
		await builder.grantAccess(Account.generateNetworkAddress(BigInt(0)));
	});

	expect(builder.data.keys.length).toEqual(1);
	expect(builder.isEncrypted).toEqual(true);
	expect(builder.data.value).toEqual(testingData);

	await ExpectErrorCode('METADATA_CANNOT_REVOKE_ACCESS_LAST_ACCOUNT', async function() {
		await builder.revokeAccess(encryptedForAccountOne);
	});

	// Granting access twice will not do anything
	await builder.grantAccess(encryptedForAccountOne);
	expect(builder.data.keys.length).toEqual(1);

	const compiledAsString: string = await builder.build();
	expect(typeof compiledAsString).toEqual('string');
	const compiledAsBuffer: Buffer = await builder.build(true);
	expect(Buffer.isBuffer(compiledAsBuffer)).toEqual(true);
	const constructedFromStringData = await MetadataStore.fromData(compiledAsString, [ encryptedForAccountOne ]);
	const constructedFromBufferData = await MetadataStore.fromData(compiledAsBuffer, [ encryptedForAccountOne ]);

	expect(constructedFromStringData.data.value).toEqual(builder.data.value);
	expect(constructedFromBufferData.data.value).toEqual(builder.data.value);

	await ExpectErrorCode('METADATA_PRINCIPAL_REQUIRED_TO_DECRYPT', async function() {
		await MetadataStore.fromData(compiledAsString);
	});

	await ExpectErrorCode('METADATA_ENCRYPTION_KEY_REQUIRED', async function() {
		new MetadataStore(constructedFromBufferData.data);
	});
});

it('ASN.1 Coverage Tests', async () => {
	const accounts = [
		generateRandomKeyedAccount(),
		generateRandomKeyedAccount()
	];

	const testingData = crypto.randomBytes(32).toString('hex');
	const builder = await MetadataStore.createFromPlainText(testingData, accounts);

	expect(builder.data.keys.length).toEqual(accounts.length);
	expect(builder.isEncrypted).toEqual(true);

	const compiledAsBuffer = await builder.build(true);

	// eslint-disable-next-line no-type-assertion/no-type-assertion
	const asn1Decoded = ASN1toJS(bufferToArrayBuffer(compiledAsBuffer)) as [ bigint, ...EncryptedMetadataWithoutHeader ];

	if (!Array.isArray(asn1Decoded)) {
		throw new Error('expected array here');
	}

	function expectInvalidASN1(input: Parameters<typeof JStoASN1>[0], code: ErrorCode = 'METADATA_INVALID_ASN1_SCHEMA') {
		return(ExpectErrorCode(code, async function() {
			await MetadataStore.fromData(JStoASN1(input).toBER(false));
		}));
	}

	await expectInvalidASN1([
		// Version other than zero
		BigInt(1),
		...asn1Decoded.slice(1)
	], 'METADATA_INVALID_VERSION');

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		// Invalid encrypted data (should be an array)
		false
	]);

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		// Invalid encrypted data (should have a length of 3)
		[ [], Buffer.from('xyz'), Buffer.from('xyz'), [] ]
	]);

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		// Invalid encrypted data (should have a length of 3)
		[ [], Buffer.from('xyz'), Buffer.from('xyz'), [] ]
	]);

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		// Keys are not an array
		[ false, Buffer.from('xyz'), Buffer.from('xyz') ]
	]);

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		[
			[
				// A single key is not an array
				null
			],
			asn1Decoded[2].slice(1)
		]
	]);

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		[
			[
				// A single key is not an array with a length of 2
				[ { type: 'bitstring', value: Buffer.from('') }, { type: 'bitstring', value: Buffer.from('') }, { type: 'bitstring', value: Buffer.from('') } ]
			],
			asn1Decoded[2].slice(1)
		]
	]);

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		[
			[
				// A single key does not contain two bitstrings
				[ { type: 'bitstring', value: Buffer.from('') }, false ]
			],
			...asn1Decoded[2].slice(1)
		]
	]);


	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		// IV is not a buffer
		[ [], false, Buffer.from('xyz') ]
	]);

	await expectInvalidASN1([
		...asn1Decoded.slice(0, 2),
		// Data is not a buffer
		[ [], Buffer.from('xyz'), false ]
	]);

	await expectInvalidASN1(false);
	await expectInvalidASN1(null);
	await expectInvalidASN1([]);

	await expectInvalidASN1([
		BigInt(0),
		false,
		[ Buffer.from('xyz'), true ]
	]);

	await expectInvalidASN1([
		BigInt(0),
		false,
		[]
	]);

	await expectInvalidASN1([
		BigInt(0),
		false,
		[ true ]
	]);

	await expectInvalidASN1([
		BigInt(0),
		false,
		null
	]);
});
