import { test, expect } from 'vitest';
import * as Certificates from './certificates.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';

const testSeed = 'D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D';
const testAccount1 = KeetaNetClient.lib.Account.fromSeed(testSeed, 0);
const testAccount2 = KeetaNetClient.lib.Account.fromSeed(testSeed, 1);

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
	const sensitiveAttribute1ValueString = await sensitiveAttribute1.getString();
	expect(sensitiveAttribute1Value).toEqual((new Uint8Array([0x54, 0x65, 0x73, 0x74, 0x20, 0x56, 0x61, 0x6c, 0x75, 0x65])).buffer);
	expect(sensitiveAttribute1ValueString).toEqual('Test Value');

	/**
	 * Process the attribute as JSON
	 */
	const attributeJSON = sensitiveAttribute1.toJSON();
	expect(JSON.parse(JSON.stringify(attributeJSON))).toEqual(attributeJSON);
	if (typeof attributeJSON !== 'object' || attributeJSON === null) {
		throw(new Error('Expected JSON object'));
	}
	expect(Object.keys(attributeJSON)).toContain('version');
	expect(Object.keys(attributeJSON)).toContain('cipher');
	expect(Object.keys(attributeJSON)).toContain('publicKey');
	expect(Object.keys(attributeJSON)).toContain('hashedValue');
	expect(Object.keys(attributeJSON)).toContain('encryptedValue');
	expect(Object.keys(attributeJSON).length).toBe(5);

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
	const tamperedAttribute = attributeBuffer.buffer;
	const sensitiveAttribute4 = new Certificates._Testing.SensitiveAttribute(testAccount1NoPrivate, tamperedAttribute);
	expect(await sensitiveAttribute4.validateProof(sensitiveAttribute1Proof)).toBe(false);
});

test('Certificates', async function() {
	/*
	 * Build a certificate with a test value from the users public key
	 */
	for (const keyKind of [
		KeetaNetClient.lib.Account.AccountKeyAlgorithm.ECDSA_SECP256K1,
		KeetaNetClient.lib.Account.AccountKeyAlgorithm.ECDSA_SECP256R1,
		KeetaNetClient.lib.Account.AccountKeyAlgorithm.ED25519
	] as const) {
		const issuerAccount = KeetaNetClient.lib.Account.fromSeed(testSeed, 0, keyKind);
		const subjectAccount = KeetaNetClient.lib.Account.fromSeed(testSeed, 1, keyKind);

		/* Subject Account without a Private Key, for later use */
		const subjectAccountNoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(subjectAccount.publicKeyString.get());

		/* Create a Certificate Builder */
		const builder1 = new Certificates.Certificate.Builder({
			issuer: issuerAccount,
			subject: subjectAccountNoPrivate,
			validFrom: new Date(),
			validTo: new Date(Date.now() + 1000 * 60 * 60 * 24)
		});

		/*
		 * Create a Root CA Certificate
		 */
		const certificateCAData = await builder1.build({
			subject: issuerAccount,
			serial: 3
		});

		/*
		 * Use the same builder to create a User Certificate
		 */
		builder1.setAttribute('fullName', true, 'Test User');
		builder1.setAttribute('email', true, 'user@example.com');
		builder1.setAttribute('phoneNumber', true, '+1 555 911 3808');
		builder1.setAttribute('address', true, ['100 Belgrave Street', 'Oldsmar', 'FL', '34677']);
		builder1.setAttribute('dateOfBirth', true, new Date('1980-01-01'));

		/**
		 * A User Certificate
		 */
		const certificateData = await builder1.build({
			serial: 4
		});

		/**
		 * The Certificate (without access to the private key)
		 */
		const certificate = new Certificates.Certificate(certificateData, {
			store: {
				root: new Set([certificateCAData])
			}
		});

		/*
		 * Validate the Certificate was signed by the issuer
		 */
		expect(certificate.checkIssued(certificateCAData)).toBe(true);
		expect(certificate.trusted).toBe(true);

		/**
		 * The Certificate (with access to the private key)
		 */
		const certificateWithPrivate = new Certificates.Certificate(certificateData, {
			subjectKey: subjectAccount
		});

		expect(certificate.attributes['fullName']?.sensitive).toBe(true);
		expect(certificateWithPrivate.attributes['fullName']?.sensitive).toBe(true);
		if (!certificateWithPrivate.attributes['fullName']?.sensitive || !certificate.attributes['fullName']?.sensitive) {
			throw(new Error('internal error: Expected sensitive attribute'));
		}

		/**
		 * The full name attribute with the private key attached
		 */
		const fullNameAttrWithPrivate = certificateWithPrivate.attributes['fullName'].value;

		/**
		 * The full name attribute without the private key attached
		 */
		const fullNameAttr = certificate.attributes['fullName'].value;

		/*
		 * Get the value of the attribute
		 */
		const fullNameValue = await fullNameAttrWithPrivate.getString();
		expect(fullNameValue).toEqual('Test User');

		/*
		 * Generate the proof of a plain-text value and validate it
		 */
		const toProove = await fullNameAttrWithPrivate.proove();
		expect(Buffer.from(toProove.value, 'base64').toString('utf-8')).toEqual('Test User');

		const valid = await fullNameAttr.validateProof(toProove);
		expect(valid).toBe(true);

		/*
		 * Attempt to access the value without the private key
		 */
		await expect(async function() {
			return(await fullNameAttr.getString());
		}).rejects.toThrow();

		/*
		 * Attempt to generate a proof without the private key (should fail)
		 */
		await expect(async function() {
			return(await fullNameAttr.proove());
		}).rejects.toThrow();
	}
});
