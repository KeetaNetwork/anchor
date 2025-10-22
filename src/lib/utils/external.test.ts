import { test, expect } from 'vitest';
import { ExternalReferenceBuilder } from './external.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as crypto from 'crypto';
import { Buffer } from './buffer.js';

const testCases = [
	{
		url: 'https://example.com/passport.jpg',
		contentType: 'image/jpeg',
		content: Buffer.from('jpeg data'),
		digestAlgo: 'sha3-256',
		encryptAlgo: 'aes-256-gcm',
		expectedDigestOID: '2.16.840.1.101.3.4.2.8',
		expectedEncryptOID: '2.16.840.1.101.3.4.1.46'
	},
	{
		url: 'https://example.com/license.pdf',
		contentType: 'application/pdf',
		content: Buffer.from('pdf data'),
		digestAlgo: 'sha256',
		encryptAlgo: 'aes-256-cbc',
		expectedDigestOID: '2.16.840.1.101.3.4.2.1',
		expectedEncryptOID: '2.16.840.1.101.3.4.1.42'
	}
];

test('ExternalReferenceBuilder creates valid Reference structures', async () => {
	const account = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
	for (const tc of testCases) {
		const builder = new ExternalReferenceBuilder(tc.url, tc.contentType)
			.setDigestAlgorithm(tc.digestAlgo)
			.setEncryptionAlgorithm(tc.encryptAlgo);

		// Verify structure
		const reference = await builder.build(tc.content, account);
		expect(reference.external.contentType).toBe(tc.contentType);
		expect(Buffer.isBuffer(reference.external.url)).toBe(true);
		expect(reference.digest.digestAlgorithm.oid).toBe(tc.expectedDigestOID);
		expect(reference.encryptionAlgorithm.oid).toBe(tc.expectedEncryptOID);

		// Verify digest is computed correctly
		const nodeAlgo = tc.digestAlgo === 'sha3-256' ? 'sha3-256' : 'sha256';
		const expectedDigest = crypto.createHash(nodeAlgo).update(tc.content).digest();
		expect(reference.digest.digest).toEqual(expectedDigest);
	}
});

test('ExternalReferenceBuilder encrypts URL for principals', async () => {
	const account = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
	const url = 'https://example.com/secret.pdf';
	const builder = new ExternalReferenceBuilder(url, 'application/pdf');

	// URL should be encrypted (non-empty buffer)
	const reference = await builder.build(Buffer.from('test'), account);
	expect(Buffer.isBuffer(reference.external.url)).toBe(true);
	expect(reference.external.url.length).toBeGreaterThan(0);
});
