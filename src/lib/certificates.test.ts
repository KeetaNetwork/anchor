import { test, expect } from 'vitest';
import * as Certificates from './certificates.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { arrayBufferToBuffer } from './utils/buffer.js';
import type { ContactDetails, CertificateAttributeValue, CertificateAttributeOIDDB } from '../generated/iso20022.js';

type CertificateAttributeNames = keyof typeof CertificateAttributeOIDDB;

async function verifyAttribute<NAME extends CertificateAttributeNames>(
	certificateWithPrivate: Certificates.Certificate,
	certificate: Certificates.Certificate,
	attributeName: NAME,
	expectedValue: CertificateAttributeValue<NAME>
): Promise<void> {
	expect(certificateWithPrivate.attributes[attributeName]?.sensitive).toBe(true);
	expect(certificate.attributes[attributeName]?.sensitive).toBe(true);

	if (!certificateWithPrivate.attributes[attributeName]) {
		throw(new Error(`Attribute ${attributeName} not found`));
	}

	const attrWithPrivate = certificateWithPrivate.getSensitiveAttribute(attributeName);
	if (!attrWithPrivate) {
		throw(new Error(`Attribute ${attributeName} not found`));
	}

	const attr = certificate.getSensitiveAttribute(attributeName);
	if (!attr) {
		throw(new Error(`Attribute ${attributeName} not found`));
	}

	const actualValue = await attrWithPrivate.getValue(attributeName);
	expect(actualValue).toEqual(expectedValue);

	const proof = await attrWithPrivate.prove();
	expect(await attr.validateProof(proof)).toBe(true);

	const decodedValue = await attrWithPrivate.getValue(attributeName);
	expect(decodedValue).toEqual(expectedValue);

	await expect(async () => await attr.getValue(attributeName)).rejects.toThrow();
	await expect(async () => await attr.prove()).rejects.toThrow();
}

const testSeed = 'D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D';
const testAccount1 = KeetaNetClient.lib.Account.fromSeed(testSeed, 0);
const testAccount2 = KeetaNetClient.lib.Account.fromSeed(testSeed, 1);

test('Sensitive Attributes', async function() {
	/*
	 * Build a sensitive attribute with a test value from the users public key
	 */
	const testAccount1NoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(testAccount1.publicKeyString.get());
	const builder1 = new Certificates._Testing.SensitiveAttributeBuilder(testAccount1NoPrivate);
	const contactDetails: ContactDetails = {
		fullName: 'Test User',
		emailAddress: 'test@example.com',
		phoneNumber: '+1 555 911 3808'
	};

	builder1.set(contactDetails, 'contactDetails');

	const attribute = await builder1.build();

	/*
	 * Access it with the private key
	 */
	const sensitiveAttribute1 = new Certificates._Testing.SensitiveAttribute(testAccount1, attribute);
	const sensitiveAttribute1Value = await sensitiveAttribute1.getValue('contactDetails');
	expect(sensitiveAttribute1Value).toEqual(contactDetails);

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
	const sensitiveAttribute1Proof = await sensitiveAttribute1.prove();

	const sensitiveAttribute2 = new Certificates._Testing.SensitiveAttribute(testAccount1NoPrivate, attribute);
	const sensitiveAttribute2Valid = await sensitiveAttribute2.validateProof(sensitiveAttribute1Proof);
	expect(sensitiveAttribute2Valid).toBe(true);

	/*
	 * Attempt to access it with the wrong private key
	 */
	const sensitiveAttribute3 = new Certificates._Testing.SensitiveAttribute(testAccount2, attribute);
	await expect(async function() {
		return(await sensitiveAttribute3.prove());
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
	const attributeBuffer = arrayBufferToBuffer(attribute);
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
		builder1.setAttribute('address', true, { streetName: '100 Belgrave Street', townName: 'Oldsmar', countrySubDivision: 'FL', postalCode: '34677' });
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

		/*
		 * Verify all sensitive attributes
		 */
		await verifyAttribute(
			certificateWithPrivate,
			certificate,
			'fullName',
			'Test User'
		);

		await verifyAttribute(
			certificateWithPrivate,
			certificate,
			'email',
			'user@example.com'
		);

		await verifyAttribute(
			certificateWithPrivate,
			certificate,
			'phoneNumber',
			'+1 555 911 3808'
		);

		await verifyAttribute(
			certificateWithPrivate,
			certificate,
			'address',
			{ streetName: '100 Belgrave Street', townName: 'Oldsmar', countrySubDivision: 'FL', postalCode: '34677' }
		);

		await verifyAttribute(
			certificateWithPrivate,
			certificate,
			'dateOfBirth',
			new Date('1980-01-01')
		);
	}
});

test('Rust Certificate Interoperability', async function() {
	/*
	 * Certificate DER from anchor-rs
	 * This certificate contains encrypted Address and ContactDetails attributes
	 */
	const rustCertificateDER = new Uint8Array(Buffer.from('MIIEODCCA96gAwIBAgICMDkwCgYIKoZIzj0EAwIwFzEVMBMGA1UEAxYMVGVzdCBTdWJqZWN0MCIYDzIwMjUxMDA3MjE1NzU4WhgPMjAyNjEwMDcyMTU3NThaMBcxFTATBgNVBAMWDFRlc3QgU3ViamVjdDA2MBAGByqGSM49AgEGBSuBBAAKAyIAAqZBYih/ucvv3LGVEj0SGcDjdOtWrBo62nM7M19Sy9h7o4IDNzCCAzMwDgYDVR0PAQH/BAQDAgDAMIIDHwYKKwYBBAGD6VMAAASCAw8wggMLMIIBjQYKKwYBBAGD6VMBCYGCAX0wggF5AgEAMIGtBglghkgBZQMEAS4EDKl0BkdjJD6B/4ewlwSBkQTo+AvA2SsdwRFOiyVLo/2URA9O1JaGBUx+/swbjp5R1U2Nc2EZonF4L1Ta/+7xsxw1dUG16nt/B4DtFIrwd/DqKrQgtg9ZlqgtlrUPI5OimyMwqvhYgmrxthon41veu2d0Lq8b48OV4inNgVo01a1Lu8KZnGzGqHIZM86CX5IzT/7EgZ58gdh+t+Vw6WxLHZgwXwQwRb1IRFDk7djvLMSPxKCbaURUpBbYMNMrdV/lt+q2MxaY+BuW/l5/9wblnrb/cKeQBglghkgBZQMEAggEIIBWsv91eXu1XCB7/v6odgKw5qLbKVekcu6b/BPIRzoRBGPZmphyZS8UrcGk6nIqI5xrk1P/H2QNqbNB3SxE1F7GsFk+xKTWisIgXspdQk4U5Pcwqj9egteRYBgErVM2nVazQ4H2OEyWo2xH6mouJmK3vytD4+cF7O4f+TyKFPzjoCHt1qkwggF2BgorBgEEAYPpUwECgYIBZjCCAWICAQAwga0GCWCGSAFlAwQBLgQMbuAJFU5ttXMNG4bSBIGRBC51qyxBugOTJPd1A3y2DwJWARHVp2qXZL/zsLebEIC82Jk40e9g84+f3kD5NAh49wLESDCaqfOwL2WjjgXoMR5Tvw+0wVekCpzRbYILWMfiSTdtmiu5IK+NKSaGysvlExzEH9HxUbpGkW26SJup1gPWqEg6AcKHhOysSvfTcvYBMzynlvn1G/JElLsykopYFDBfBDA8jfyuWU3zUqNJ0vjTZQV7kn7X9qIe/G8l5am1p+ro1rh7buEOR0bwpWPrQd72lOIGCWCGSAFlAwQCCAQgtqzKw4tADo1xuV0hdzTR2Q8LJQqwUHY83z5QqkrKDoIETHGeGhq2sYWdsLG/+3oM6Y+6k6MskFoY3E/G8u9RW4lHx2d4EW7NWZtehw8sQKjw2Awpul30ruSwYqFAKoPFfVczfYleYrS5Db3UehEwCgYIKoZIzj0EAwIDSAAwRQIhANHzR2nlfPL3W/Jtdajg5jJErppTvnZk70J4duzRPfWJAiBIyd5/QYMkHKXsZAnkyc8u9VsEQFr5wxa7nOVhbOJO2Q==', 'base64'));

	/*
	 * Create account with same seed as Rust test (index 0, ECDSA SECP256K1)
	 */
	const subjectAccount = KeetaNetClient.lib.Account.fromSeed(
		testSeed,
		0,
		KeetaNetClient.lib.Account.AccountKeyAlgorithm.ECDSA_SECP256K1
	);

	/*
	 * Parse the Rust certificate
	 */
	const certificate = new Certificates.Certificate(rustCertificateDER.buffer, {
		subjectKey: subjectAccount
	});

	/*
	 * Verify we have the expected attributes (address and contactDetails)
	 */
	expect(certificate.attributes['address']).toBeDefined();
	expect(certificate.attributes['contactDetails']).toBeDefined();

	/*
	 * Both should be marked as sensitive (encrypted)
	 */
	expect(certificate.attributes['address']?.sensitive).toBe(true);
	expect(certificate.attributes['contactDetails']?.sensitive).toBe(true);

	/*
	 * Decrypt and verify the Address attribute
	 */
	const address = await certificate.getValue('address');

	/*
	 * Verify address structure and expected values from Rust test
	 */
	expect(address).toBeDefined();
	expect(typeof address).toBe('object');
	expect(address).toHaveProperty('postalCode');
	expect(address).toHaveProperty('townName');
	expect(address).toHaveProperty('country');

	/*
	 * Expected values from create_test_address() in Rust testing.rs
	 */
	expect(address.postalCode).toBe('12345');
	expect(address.townName).toBe('Springfield');
	expect(address.country).toBe('US');
	expect(address.streetName).toBe('Main Street');
	expect(address.buildingNumber).toBe('123');
	expect(address.countrySubDivision).toBe('IL');

	/*
	 * Decrypt and verify the ContactDetails attribute
	 */
	const contact = await certificate.getValue('contactDetails');

	/*
	 * Verify contact structure and expected values from Rust test
	 */
	expect(contact).toBeDefined();
	expect(typeof contact).toBe('object');
	expect(contact).toHaveProperty('emailAddress');
	expect(contact).toHaveProperty('phoneNumber');

	/*
	 * Expected values from create_test_contact_details() in Rust testing.rs
	 */
	expect(contact.emailAddress).toBe('john.doe@example.com');
	expect(contact.phoneNumber).toBe('+1-555-123-4567');
	expect(contact.mobileNumber).toBe('+1-555-987-6543');
	expect(contact.faxNumber).toBe('+1-555-111-2222');

	/*
	 * Verify proof generation and validation works with Rust-generated certificates
	 */
	const addressAttr = certificate.getSensitiveAttribute('address');
	if (!addressAttr) {
		throw(new Error('Expected address attribute'));
	}

	const addressProof = await addressAttr.prove();
	expect(await addressAttr.validateProof(addressProof)).toBe(true);

	const contactAttr = certificate.getSensitiveAttribute('contactDetails');
	if (!contactAttr) {
		throw(new Error('Expected contactDetails attribute'));
	}

	const contactProof = await contactAttr.prove();
	expect(await contactAttr.validateProof(contactProof)).toBe(true);
});
