import { test, expect } from 'vitest';
import * as Certificates from './certificates.js';
import * as KeetaNetClient from '@keetapay/keetanet-client';

const testAccount1 = KeetaNetClient.lib.Account.fromSeed('D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D', 0);
const testAccount2 = KeetaNetClient.lib.Account.fromSeed('D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D', 1);

test('Sensitive Attributes', async function() {
	/*
	 * Build a sensitive attribute with a test value from the users public key
	 */
	const testAccount1NoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(testAccount1.publicKeyString.get());
	const builder1 = new Certificates._Testing.SensitiveAttributeBuilder(testAccount1NoPrivate);
	builder1.set('Test Value');
	const attribute = await builder1.build();

	/*
	 * Access it with the private key
	 */
	const sensitiveAttribute1 = new Certificates._Testing.SensitiveAttribute(testAccount1, attribute);
	const sensitiveAttribute1Value = await sensitiveAttribute1.get();
	expect(sensitiveAttribute1Value).toEqual((new Uint8Array([0x54, 0x65, 0x73, 0x74, 0x20, 0x56, 0x61, 0x6c, 0x75, 0x65])).buffer);

	/**
	 * Process the attribute as JSON
	 */
	const attributeJSON = sensitiveAttribute1.toJSON();
	expect(JSON.parse(JSON.stringify(attributeJSON))).toEqual(attributeJSON);
	if (typeof attributeJSON !== 'object' || attributeJSON === null) {
		throw(new Error('Expected JSON object'));
	}
	expect(Object.keys(attributeJSON)).toContain('version');
	expect(Object.keys(attributeJSON)).toContain('publicKey');
	expect(Object.keys(attributeJSON)).toContain('hashedValue');
	expect(Object.keys(attributeJSON)).toContain('encryptedValue');
	expect(Object.keys(attributeJSON).length).toBe(4);

	/*
	 * Validate it with the public key and value
	 */
	const sensitiveAttribute1Proof = await sensitiveAttribute1.proove();

	const sensitiveAttribute2 = new Certificates._Testing.SensitiveAttribute(testAccount1NoPrivate, attribute);
	const sensitiveAttribute2Valid = await sensitiveAttribute2.validateProof(sensitiveAttribute1Proof);
	expect(sensitiveAttribute2Valid).toBe(true);

	/*
	 * Attempt to access it with the wrong private key
	 */
	const sensitiveAttribute3 = new Certificates._Testing.SensitiveAttribute(testAccount2, attribute);
	await expect(async function() {
		return(await sensitiveAttribute3.proove());
	}).rejects.toThrow();

	/*
	 * Attempt to validate it with the wrong value
	 */
	const sensitiveAttribute2Invalid = await sensitiveAttribute2.validateProof({
		...sensitiveAttribute1Proof,
		value: 'Something'
	});
	expect(sensitiveAttribute2Invalid).toBe(false);

	/*
	 * Attempt to validate it with the wrong public key
	 */
	const sensitiveAttribute3Invalid = await sensitiveAttribute3.validateProof(sensitiveAttribute1Proof);
	expect(sensitiveAttribute3Invalid).toBe(false);

	/*
	 * Attempt to validate a tampered attribute
	 */
	const attributeBuffer = Buffer.from(attribute);
	attributeBuffer.set([0x00], attributeBuffer.length - 3);
	console.debug(attributeBuffer.toString('base64'));
	const tamperedAttribute = attributeBuffer.buffer;
	const sensitiveAttribute4 = new Certificates._Testing.SensitiveAttribute(testAccount1NoPrivate, tamperedAttribute);
	expect(await sensitiveAttribute4.validateProof(sensitiveAttribute1Proof)).toBe(false);
});
