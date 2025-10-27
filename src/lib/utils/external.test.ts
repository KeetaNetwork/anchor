import { test, expect } from 'vitest';
import { ExternalReferenceBuilder } from './external.js';
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

test('ExternalReferenceBuilder creates valid Reference structures', () => {
	for (const tc of testCases) {
		const builder = new ExternalReferenceBuilder(tc.url, tc.contentType)
			.withDigestAlgorithm(tc.digestAlgo)
			.withEncryptionAlgorithm(tc.encryptAlgo);

		// Verify structure
		const reference = builder.build(tc.content);
		expect(reference.external.url).toBe(tc.url);
		expect(reference.external.contentType).toBe(tc.contentType);
		expect(reference.digest.digestAlgorithm.oid).toBe(tc.expectedDigestOID);
		expect(reference.encryptionAlgorithm.oid).toBe(tc.expectedEncryptOID);

		// Verify digest is computed correctly
		const nodeAlgo = tc.digestAlgo === 'sha3-256' ? 'sha3-256' : 'sha256';
		const expectedDigest = crypto.createHash(nodeAlgo).update(tc.content).digest();
		expect(reference.digest.digest).toEqual(expectedDigest);
	}
});

test('ExternalReferenceBuilder computes different digests for different content', () => {
	const builder = new ExternalReferenceBuilder('https://example.com/doc.pdf', 'application/pdf');

	const ref1 = builder.build(Buffer.from('content v1'));
	const ref2 = builder.build(Buffer.from('content v2'));
	expect(ref1.digest.digest).not.toEqual(ref2.digest.digest);
});
