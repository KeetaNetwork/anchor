import * as zlib from 'zlib';
import * as crypto from 'crypto';

import Account from '@keetapay/keetanet-client/lib/account';
import { ASN1toJS } from '@keetapay/keetanet-client/lib/utils/asn1';
import { bufferToArrayBuffer } from '@keetapay/keetanet-client/lib/utils/helper';

import { MetadataStore } from './metadata';

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

	expect(builder.checkAccountHasAccess(encryptedForAccountOne)).toEqual(false);
	await builder.grantAccess(encryptedForAccountOne);
	expect(builder.checkAccountHasAccess(encryptedForAccountOne)).toEqual(true);

	expect(builder.data.keys.length).toEqual(1);
	expect(builder.isEncrypted).toEqual(true);
	expect(builder.data.value).toEqual(testingData);


	// Granting access twice will not do anything
	await builder.grantAccess(encryptedForAccountOne);
	expect(builder.data.keys.length).toEqual(1);

	const compiled = await builder.build();
	const constructedFromData = await MetadataStore.fromData(compiled, [ encryptedForAccountOne ]);

	expect(constructedFromData.data.value).toEqual(builder.data.value);
});
