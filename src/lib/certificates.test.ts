import { test, expect } from 'vitest';
import * as Certificates from './certificates.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { arrayBufferToBuffer, bufferToArrayBuffer } from './utils/buffer.js';
import type { Schema as ASN1Schema } from './utils/asn1.js';
import type { CertificateAttributeValue, CertificateAttributeOIDDB } from '../services/kyc/iso20022.generated.ts';
import { ExternalReferenceBuilder } from './utils/external.js';
import { EncryptedContainer } from './encrypted-container.js';
import * as typia from 'typia';

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

	const attrWithPrivate = certificateWithPrivate.attributes[attributeName];
	if (!attrWithPrivate) {
		throw(new Error(`Attribute ${attributeName} not found`));
	}

	const attr = certificate.attributes[attributeName];
	if (!attr) {
		throw(new Error(`Attribute ${attributeName} not found`));
	}

	expect(attrWithPrivate.sensitive).toBe(true);
	if (!attrWithPrivate.sensitive) {
		throw(new Error(`Attribute ${attributeName} is not sensitive`));
	}
	expect(attr.sensitive).toBe(true);
	if (!attr.sensitive) {
		throw(new Error(`Attribute ${attributeName} is not sensitive`));
	}

	const actualValue = await attrWithPrivate.value.getValue();
	expect(actualValue).toEqual(expectedValue);

	const proof = await attrWithPrivate.value.getProof();
	expect(await attr.value.validateProof(proof)).toBe(true);

	const decodedValue = await attrWithPrivate.value.getValue();
	expect(decodedValue).toEqual(expectedValue);

	await expect(async function() {
		return(await attr.value.getValue());
	}).rejects.toThrow();
	await expect(async function() {
		return(await attr.value.getProof());
	}).rejects.toThrow();
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
	const contactDetails: ArrayBuffer = bufferToArrayBuffer(Buffer.from(JSON.stringify({
		fullName: 'Test User',
		emailAddress: 'test@example.com',
		phoneNumber: '+1 555 911 3808'
	}), 'utf-8'));

	builder1.set(contactDetails);

	const attribute = await builder1.build();

	/*
	 * Access it with the private key
	 */
	const sensitiveAttribute1 = new Certificates._Testing.SensitiveAttribute(testAccount1, attribute);
	const sensitiveAttribute1Value = await sensitiveAttribute1.getValue();
	expect(Buffer.from(sensitiveAttribute1Value).toString('base64')).toEqual(Buffer.from(contactDetails).toString('base64'));

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
	const sensitiveAttribute1Proof = await sensitiveAttribute1.getProof();

	const sensitiveAttribute2 = new Certificates._Testing.SensitiveAttribute(testAccount1NoPrivate, attribute);
	const sensitiveAttribute2Valid = await sensitiveAttribute2.validateProof(sensitiveAttribute1Proof);
	expect(sensitiveAttribute2Valid).toBe(true);

	/*
	 * Attempt to access it with the wrong private key
	 */
	const sensitiveAttribute3 = new Certificates._Testing.SensitiveAttribute(testAccount2, attribute);
	await expect(async function() {
		return(await sensitiveAttribute3.getProof());
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
	const tamperedAttribute = bufferToArrayBuffer(attributeBuffer);
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
		const testEntityType = { person: [{ id: '123-45-6789', schemeName: 'SSN' }] };
		const testAddress = {
			addressLines: ['100 Belgrave Street'],
			streetName: '100 Belgrave Street',
			townName: 'Oldsmar',
			countrySubDivision: 'FL',
			postalCode: '34677'
		};

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
		builder1.setAttribute('address', true, testAddress);
		builder1.setAttribute('dateOfBirth', true, new Date('1980-01-01'));
		builder1.setAttribute('entityType', true, testEntityType);

		// Create a document reference using DocumentBuilder
		const mockDocumentContent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAA8AAAAKCAIAAADkeZOuAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAaNJREFUGBkFwTtv00AcAPD738v22c6DVEUgIEqXKh0QgoWNBYkJCcTI12DlUzEwAOIxgAQS3SoeLSWJS+s4SR2/7s6PO34/WF38llIWhfT8nbzGvdCDro1TiSlmjHJKxld7ejvj/qjSALPFj5M4BaO1ocry6a7b9wTBFJjjMMdag7vN+beXw71nFb8LR9Gf14ty9uYVcfzJoycPSCqKHCHUOmETXKmk2u3VAQLrkWSdYwCIP79/cX//+TiYf//q9kdKa8KwNXrgd4GwpWwMDwAFQBwMYK7nF7o1zPG8NF7GydblGXYtd4mFYegOhgPGGDIdNR2WRdHn4AANuAPRLzCmyfIkOdOyUFKXqewzLvOUoQYZi9Vm9enjl+1yOTs+/vDurS/CWzcn04M7N8Z7WZ5vs21tQHU2Scu2Q5g2aHLvdnV4VK3Kh4+fivTSul6ltEL052kULeYGgSeC0WjQNjWsz06llGHordY5iNDxhWwRqpVUSvjhavF3Ot2fR9G1HZEVJfw7n8vNJfUEdK1GzGIgBDdNQwlr2pZRyglCqOvqopTtfxPN5DQANIAzAAAAAElFTkSuQmCC', 'base64');
		const mockDocumentContentEncrypted = EncryptedContainer.fromPlaintext(mockDocumentContent, [subjectAccount]);
		const mockDocumentContentEncryptedBuffer = Buffer.from(await mockDocumentContentEncrypted.getEncodedBuffer());
		const documentBuilder = new ExternalReferenceBuilder(
			`data:application/octet-string;base64,${mockDocumentContentEncryptedBuffer.toString('base64')}`,
			'image/png'
		);
		const documentReference = documentBuilder.build(mockDocumentContent);
		builder1.setAttribute('documentDriversLicense', true, {
			documentNumber: 'DL1234567890',
			front: documentReference
		});

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
			testAddress
		);

		await verifyAttribute(
			certificateWithPrivate,
			certificate,
			'dateOfBirth',
			new Date('1980-01-01')
		);

		await verifyAttribute(
			certificateWithPrivate,
			certificate,
			'entityType',
			testEntityType
		);

		/*
		 * Verify a reference attribute has a $blob function
		 */
		expect(certificate.attributes['documentDriversLicense']).toBeDefined();
		expect(certificateWithPrivate.attributes['documentDriversLicense']).toBeDefined();
		{
			const checkDocDriversLicense = await certificateWithPrivate.getAttributeValue('documentDriversLicense');
			expect(checkDocDriversLicense).toBeDefined();
			expect(checkDocDriversLicense.front?.$blob).toBeDefined();

			const blob = await checkDocDriversLicense.front?.$blob([subjectAccount]);
			expect(blob).toBeDefined();
			if (blob === undefined) {
				throw(new Error('internal error: Expected blob'));
			}
			expect(blob.type).toBe('image/png');
			expect(Buffer.from(await blob.arrayBuffer()).toString('base64')).toBe(mockDocumentContent.toString('base64'));
		}
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
	const address = await certificate.getAttributeValue('address');

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
	const contact = await certificate.getAttributeValue('contactDetails');

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
	const addressAttr = certificate.attributes['address'];
	if (!addressAttr) {
		throw(new Error('Expected address attribute'));
	}
	if (!addressAttr.sensitive) {
		throw(new Error('Expected address attribute to be sensitive'));
	}

	const addressProof = await addressAttr.value.getProof();
	expect(await addressAttr.value.validateProof(addressProof)).toBe(true);

	const contactAttr = certificate.attributes['contactDetails'];
	if (!contactAttr) {
		throw(new Error('Expected contactDetails attribute'));
	}
	if (!contactAttr.sensitive) {
		throw(new Error('Expected contactDetails attribute to be sensitive'));
	}

	const contactProof = await contactAttr.value.getProof();
	expect(await contactAttr.value.validateProof(contactProof)).toBe(true);
});

test('Certificate Sharable Attributes', async function() {
	/*
	 * Moment to process certificates in
	 */
	const moment = new Date();

	/*
	 * Build a certificate with a test value from the users public key
	 */
	const rootIssuerAccount = KeetaNetClient.lib.Account.fromSeed(testSeed, 0);
	const issuerAccount = KeetaNetClient.lib.Account.fromSeed(testSeed, 1);
	const subjectAccount = KeetaNetClient.lib.Account.fromSeed(testSeed, 2);
	const viewerAccount = KeetaNetClient.lib.Account.fromSeed(testSeed, 3);

	/* Subject Account without a Private Key, for later use */
	const subjectAccountNoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(subjectAccount.publicKeyString.get());

	/* Viewer Account without a Private Key, for later use */
	const viewerAccountNoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(viewerAccount.publicKeyString.get());

	/* Create a root CA Certificate */
	const rootCABuilder = new Certificates.Certificate.Builder({
		issuer: rootIssuerAccount,
		subject: rootIssuerAccount,
		serial: 1,
		validFrom: new Date(moment.getTime() - 60_000),
		validTo: new Date(moment.getTime() + 1000 * 60 * 60 * 24 * 365 * 10)
	});
	const rootCA = await rootCABuilder.build();

	/* Create an intermediate CA Builder */
	const issuerBuilder = new Certificates.Certificate.Builder({
		issuer: rootIssuerAccount,
		subject: issuerAccount,
		issuerDN: rootCA.subjectDN,
		serial: 10,
		validFrom: new Date(moment.getTime() - 60_000),
		validTo: new Date(moment.getTime() + 1000 * 60 * 60 * 24 * 365 * 5)
	});
	const issuerCA = await issuerBuilder.build();

	/* Create a Certificate Builder */
	const builder1 = new Certificates.Certificate.Builder({
		issuer: issuerAccount,
		subject: subjectAccountNoPrivate,
		issuerDN: issuerCA.subjectDN,
		validFrom: new Date(moment.getTime() - 60_000),
		validTo: new Date(moment.getTime() + 1000 * 60 * 60 * 24)
	});

	/*
	 * Create a User Certificate with sharable attributes
	 */
	// The certificates cannot store ms precision times, so we round it down
	const testDOB = new Date(Math.floor(((Date.now() - (35 * 365 * 24 * 60 * 60 * 1000)) / 1000)) * 1000); // Approx 35 years ago
	builder1.setAttribute('fullName', false, 'Test User');
	builder1.setAttribute('email', true, 'user@example.com');
	builder1.setAttribute('dateOfBirth', true, testDOB);

	/*
	 * Add a document to be shared
	 */
	// cspell:disable-next-line
	const mockDocumentContent = Buffer.from('Tk9UIFJFQUxMWSBBIFBORwo=', 'base64');
	{
		const mockDocumentContentEncrypted = EncryptedContainer.fromPlaintext(mockDocumentContent, [subjectAccount]);
		const mockDocumentContentEncryptedBuffer = Buffer.from(await mockDocumentContentEncrypted.getEncodedBuffer());
		const documentBuilder = new ExternalReferenceBuilder(
			`data:application/octet-string;base64,${mockDocumentContentEncryptedBuffer.toString('base64')}`,
			'image/png'
		);
		const documentReference = documentBuilder.build(mockDocumentContent);
		builder1.setAttribute('documentDriversLicense', true, {
			documentNumber: 'DL1234567890',
			front: documentReference
		});
	}

	const certificate = await builder1.build({
		serial: 5
	});

	const certificateWithPrivate = new Certificates.Certificate(certificate, {
		subjectKey: subjectAccount
	});

	/*
	 * Create a sharable object and grant a third user access
	 */
	const sharableWithIntermediates = await Certificates.SharableCertificateAttributes.fromCertificate(certificateWithPrivate, new Set([issuerCA]), ['fullName', 'email', 'documentDriversLicense', 'dateOfBirth', 'phoneNumber' /* non-existent */]);
	const sharableWithoutIntermediates = await Certificates.SharableCertificateAttributes.fromCertificate(certificateWithPrivate, undefined, ['fullName', 'email', 'documentDriversLicense', 'dateOfBirth', 'phoneNumber' /* non-existent */]);

	await sharableWithIntermediates.grantAccess(viewerAccountNoPrivate);
	await sharableWithoutIntermediates.grantAccess(viewerAccountNoPrivate);

	expect(sharableWithIntermediates.principals.length).toBe(1);
	expect(sharableWithoutIntermediates.principals.length).toBe(1);

	const sharedSerialized = await sharableWithIntermediates.export();
	const sharedSerializedString = await sharableWithIntermediates.export({ format: 'string' });
	const sharedWithoutIntermediatesSerializedString = await sharableWithoutIntermediates.export({ format: 'string' });

	/*
	 * Attempt to view with the incorrect account
	 */
	await expect(async function() {
		const imported = new Certificates.SharableCertificateAttributes(sharedSerialized, { principals: subjectAccount });
		return(await imported.getAttributeBuffer('fullName'));
	}).rejects.toThrow();

	/*
	 * Attempt to view with the correct account but without a private key
	 */
	await expect(async function() {
		const imported = new Certificates.SharableCertificateAttributes(sharedSerialized, { principals: viewerAccountNoPrivate });
		return(await imported.getAttributeBuffer('fullName'));
	}).rejects.toThrow();

	/*
	 * Attempt to view with the correct account
	 */
	const imported = new Certificates.SharableCertificateAttributes(sharedSerialized, { principals: viewerAccount });
	expect(imported.principals.length).toBe(1);
	const importedFullName = await imported.getAttribute('fullName');
	expect(importedFullName).toBeDefined();
	if (!importedFullName) {
		throw(new Error('Expected fullName attribute'));
	}
	expect(importedFullName).toBe('Test User');

	const importedDOB = await imported.getAttribute('dateOfBirth');
	expect(importedDOB instanceof Date).toEqual(true);
	expect(importedDOB?.valueOf()).toEqual(testDOB.valueOf());

	const importedIntermediates = await imported.getIntermediates();
	expect(importedIntermediates.size).toBe(1);
	const importedIntermediate = importedIntermediates.values().next().value;
	expect(importedIntermediate).toBeDefined();
	if (importedIntermediate === undefined) {
		throw(new Error('internal error: Expected intermediate CA'));
	}
	expect(importedIntermediate.equals(issuerCA)).toBe(true);

	/* Also verify importing without intermediates works */
	{
		const importedNoIntermediates = new Certificates.SharableCertificateAttributes(sharedWithoutIntermediatesSerializedString, { principals: viewerAccount });
		const importedNoIntermediatesIntermediates = await importedNoIntermediates.getIntermediates();
		expect(importedNoIntermediatesIntermediates.size).toBe(0);
		expect(importedNoIntermediates.principals.length).toBe(1);
		expect(await importedNoIntermediates.getAttribute('fullName')).toBe('Test User');
	}

	/*
	 * Verify that the document is accessible
	 */
	const importedDocument = await imported.getAttribute('documentDriversLicense');
	expect(importedDocument).toBeDefined();
	if (!importedDocument) {
		throw(new Error('Expected documentDriversLicense attribute'));
	}
	expect(importedDocument.documentNumber).toBe('DL1234567890');
	expect(importedDocument.front).toBeDefined();
	if (!importedDocument.front) {
		throw(new Error('Expected document front reference'));
	}
	const documentBlob = await importedDocument.front.$blob();
	expect(documentBlob).toBeDefined();
	const documentValue = Buffer.from(await documentBlob.arrayBuffer());
	expect(documentValue.toString('base64')).toBe(mockDocumentContent.toString('base64'));

	/*
	 * Create a corrupted document and attempt to have it validated
	 */
	{
		/*
		 * 1. Decode the container
		 */
		const container = EncryptedContainer.fromEncodedBuffer(sharedSerialized, [viewerAccount]);
		const value = await container.getPlaintext();
		const valueBuffer = Buffer.from(value);
		const valueString = valueBuffer.toString('utf-8');
		const valueObject: unknown = JSON.parse(valueString);

		/*
		 * 2. Find the reference and replace its value
		 */
		const valueTyped = typia.assert<{
			attributes: {
				documentDriversLicense: {
					sensitive: true;
					value: object;
					references: {
						[id: string]: string;
					};
				}
			}
		}>(valueObject);
		const docDL = valueTyped.attributes.documentDriversLicense;
		const refIDs = Object.keys(docDL.references);
		expect(refIDs.length).toBe(1);

		const refID = refIDs[0];
		if (refID === undefined) {
			throw(new Error('internal error: Expected reference ID'));
		}

		docDL.references[refID] = 'Q09SUlVQVAo=';

		/*
		 * 3. Recreate the container
		 */
		const modifiedValueString = JSON.stringify(valueTyped);
		const modifiedValueBuffer = Buffer.from(modifiedValueString, 'utf-8');
		const modifiedValueBufferArrayBuffer = bufferToArrayBuffer(modifiedValueBuffer);
		const modifiedValueCompressed = KeetaNetClient.lib.Utils.Buffer.ZlibDeflate(modifiedValueBufferArrayBuffer);
		const modifiedContainer = EncryptedContainer.fromPlaintext(modifiedValueCompressed, [viewerAccount]);
		const modifiedSerialized = await modifiedContainer.getEncodedBuffer();

		/*
		 * 4. Import it as a SharableCertificateAttributes
		 */
		const importedCorrupted = new Certificates.SharableCertificateAttributes(modifiedSerialized, { principals: viewerAccount });
		const importedCorruptedDocument = await importedCorrupted.getAttribute('documentDriversLicense');
		expect(importedCorruptedDocument).toBeDefined();

		await expect(async function() {
			return(await importedCorruptedDocument?.front?.$blob());
		}).rejects.toThrow(/Hash/);
	}

	/*
	 * Also attempt to import from the alternative supported formats
	 */
	const importedAltFormat1 = new Certificates.SharableCertificateAttributes(sharedSerializedString, { principals: viewerAccount });
	const importedAltFormat2 = new Certificates.SharableCertificateAttributes(Buffer.from(sharedSerialized).toString('base64'), { principals: viewerAccount });
	expect(importedAltFormat1.principals.length).toBe(1);
	expect(importedAltFormat2.principals.length).toBe(1);

	/*
	 * Attempt to view a non-existent attribute
	 */
	const importedPhoneNumber = await imported.getAttribute('phoneNumber');
	expect(importedPhoneNumber).toBeUndefined();

	/*
	 * Attempt to enumerate all attributes
	 */
	const allAttributes = await imported.getAttributeNames();
	expect(allAttributes).toContain('fullName');
	expect(allAttributes).toContain('email');
	expect(allAttributes).toContain('documentDriversLicense');
	expect(allAttributes).toContain('dateOfBirth');
	expect(allAttributes.length).toBe(4);
});

test('Struct with optional fields', function() {
	const schema = {
		type: 'struct',
		fieldNames: ['optionalBefore', 'required', 'optionalAfter'],
		contains: {
			optionalBefore: { optional: { type: 'context', kind: 'explicit', value: 0, contains: { type: 'string', kind: 'utf8' }}},
			required: { type: 'context', kind: 'explicit', value: 1, contains: Certificates._Testing.ValidateASN1.IsInteger },
			optionalAfter: { optional: { type: 'context', kind: 'explicit', value: 2, contains: { type: 'string', kind: 'utf8' }}}
		}
	} as const;

	const validator = new Certificates._Testing.ValidateASN1(schema);

	// Test 1: All fields present
	const allFields = {
		optionalBefore: 'before',
		required: 42n,
		optionalAfter: 'after'
	};

	// XXX:TODO Fix depth issue
	// @ts-ignore
	const encodedJS1 = validator.fromJavaScriptObject(allFields);
	const der1 = Certificates._Testing.JStoASN1(encodedJS1).toBER(false);
	const decoded1 = new Certificates._Testing.BufferStorageASN1(der1, schema).getASN1();
	const result1 = Certificates._Testing.normalizeDecodedASN1(validator.toJavaScriptObject(decoded1), []);
	expect(result1).toEqual(allFields);

	// Test 2: Only required field (both optionals omitted)
	const onlyRequired = {
		required: 100n
	};

	// XXX:TODO Fix depth issue
	// @ts-ignore
	const encodedJS2 = validator.fromJavaScriptObject(onlyRequired);
	const der2 = Certificates._Testing.JStoASN1(encodedJS2).toBER(false);
	const decoded2 = new Certificates._Testing.BufferStorageASN1(der2, schema).getASN1();
	const result2 = Certificates._Testing.normalizeDecodedASN1(validator.toJavaScriptObject(decoded2), []);
	expect(result2).toEqual(onlyRequired);
	expect(Object.keys(result2 ?? {})).toEqual(['required']);
});

test('Schema unwrapping utilities', function() {
	const { unwrapSingleLayer, unwrapFieldSchema, unwrapContextTagsFromSchema, ValidateASN1 } = Certificates._Testing;

	const stringSchema = { type: 'string' as const, kind: 'utf8' as const };
	const wrapInContext = (schema: unknown, value = 0) => ({
		type: 'context' as const,
		kind: 'explicit' as const,
		value,
		contains: schema
	});

	const singleLayerCases = [
		{ name: 'context tag', input: wrapInContext(stringSchema), expected: stringSchema },
		{ name: 'non-context', input: stringSchema, expected: stringSchema },
		{ name: 'primitive', input: ValidateASN1.IsInteger, expected: ValidateASN1.IsInteger }
	];
	for (const { name, input, expected } of singleLayerCases) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const result = unwrapSingleLayer(input as ASN1Schema);
		expect(result, `unwrapSingleLayer: ${name}`).toEqual(expected);
	}

	const fieldSchemaCases = [
		{ name: 'optional+context', input: { optional: wrapInContext(stringSchema) }, expected: { optional: stringSchema }},
		{ name: 'required+context', input: wrapInContext(ValidateASN1.IsInteger, 1), expected: ValidateASN1.IsInteger },
		{ name: 'optional no context', input: { optional: stringSchema }, expected: { optional: stringSchema }},
		{ name: 'required no context', input: stringSchema, expected: stringSchema }
	];
	for (const { name, input, expected } of fieldSchemaCases) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const result = unwrapFieldSchema(input as ASN1Schema);
		expect(result, `unwrapFieldSchema: ${name}`).toEqual(expected);
	}

	const structWithContext = {
		type: 'struct' as const,
		fieldNames: ['name', 'email'],
		contains: {
			name: wrapInContext(stringSchema, 0),
			email: { optional: wrapInContext(stringSchema, 1) }
		}
	};
	const structUnwrapped = {
		type: 'struct',
		fieldNames: ['name', 'email'],
		contains: {
			name: stringSchema,
			email: { optional: stringSchema }
		}
	};
	const structNoContext = {
		type: 'struct' as const,
		fieldNames: ['x'],
		contains: { x: stringSchema }
	};

	const contextTagsCases = [
		{ name: 'struct with context', input: structWithContext, expected: structUnwrapped },
		{ name: 'struct no context', input: structNoContext, expected: structNoContext },
		{ name: 'non-struct', input: stringSchema, expected: stringSchema },
		{ name: 'primitive', input: ValidateASN1.IsOID, expected: ValidateASN1.IsOID }
	];
	for (const { name, input, expected } of contextTagsCases) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const result = unwrapContextTagsFromSchema(input as ASN1Schema);
		expect(result, `unwrapContextTagsFromSchema: ${name}`).toEqual(expected);
	}
});

test('Old and new certificate formats with SharableCertificateAttributes', async function() {
	const testCerts = [
		{ name: 'old (no context tags)', seed: '38D8765C39247A2ED61C8C277DEB9E1E82D93DF2BB7C642EF86C63F5FE07F83D', pem: `-----BEGIN CERTIFICATE-----
MIISNTCCEdugAwIBAgIRAOaCUFRdyprwkaiMpdnlUOEwCwYJYIZIAWUDBAMKMFAx
TjBMBgNVBAMWRWtlZXRhX2FhYmptYnBmNW93YXV3dWxmM2kzZHM1dGZodWhodmdu
YXBodWhmM2xwNzVyeXFxYnVmdWxycjN5YmMzNjRueTAeFw0yNTEwMzAwMzU3MTFa
Fw0yNjEwMzAwMzU3MTFaMFAxTjBMBgNVBAMWRWtlZXRhX2FhYmptYnBmNW93YXV3
dWxmM2kzZHM1dGZodWhodmduYXBodWhmM2xwNzVyeXFxYnVmdWxycjN5YmMzNjRu
eTA2MBAGByqGSM49AgEGBSuBBAAKAyIAApYF5eusClqLLtGxy7Mp6HPUzQPPQ5dr
f/scQgGhaLjHo4IQtjCCELIwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AMYwHwYDVR0jBBgwFoAUhPqfjJhrW2Egd2bFpVPTbrSf12UwHQYDVR0OBBYEFIT6
n4yYa1thIHdmxaVT0260n9dlMIIQTQYKKwYBBAGD6VMAAASCED0wghA5MIIBRQYK
KwYBBAGD6VMBAIGCATUwggExAgEAMIGtBglghkgBZQMEAS4EDAauPh5dc8su3w+o
DQSBkQTmY8I8+Sl0TuvRwaRK5hP4lJShAvlNfWWF1cqgNy4GmMt7BumYuCj0Qeb0
OGa/bfTOksfOOVLaQ7/pQDaH5/rGHH4FNA9N+fu+u0JqigU6/mgE4rDaoN6PSSYe
EX8TRN9SZ4mZSqfPkK8n79XTIR/aS1pe/NryHo/OlHnUFFoH6wa6QWzO3dhZwlUW
SA7cQJMwXwQwlGrhJ8TNXLwCsHPWgUuMqbkAIYZSLk/Har1r2vvNszn4yV1Qiuq9
L2AMgf5UTu3VBglghkgBZQMEAggEIP/EvIorXLRupGULgdGVCGRCNkzvVvusPwtQ
DPysFXNuBBv++SoBOplSnK3QMDsB554pXthS4rykRGa60YgwggFABgsrBgEEAYPp
UwEAAYGCAS8wggErAgEAMIGtBglghkgBZQMEAS4EDOCEDCt5UBZGbJSgOwSBkQTd
YUv23Sq1aOiw4UT3RFGhTFnp1stZ6M3YTN3/ZHSO+330dDIK6G7BE+6SQzyZThQv
AjcXn59VerJHlSYUTp5Ty3sqU2IHYi8eMKTWtjmlmUYjx0RA73D16CzYBDlRPogN
5TUrwqu+2kzJBhnXvzhFa07lLpYXUZTccSwKW16NPBU/nkfkyaHqM5TuOQxX9fQw
XwQwshHa98SmxqZsz+S2wmD8pO4Fy54N+yTA5njR7/VP+SyTQSJyY4z9qep7mdBf
CoXDBglghkgBZQMEAggEID0I5VTYFmzE4ReHX5P7OT2xJzoUZNwyDokrjCz1TA/U
BBWK2MrjS9JmZw+bHpW62xBX1rU0rQwwggFCBgsrBgEEAYPpUwEAAoGCATEwggEt
AgEAMIGtBglghkgBZQMEAS4EDL+gHXdvLknnCp3nhQSBkQRaVIWAQi3iB10H4ZeM
ENmvqdptllBtQIi9C1xPIbM55wnJy9RksipiJU5O0V3KHKkDwbYRcxOLAoeyxFA1
YqXi03gOzqcjX4hDoTWPnfV95AVlnDeTW3QChn8fmlPBtcCa6D5J7Cmp+6pQbWIz
Q20kMsNHiXzjnQp4RhoWbIDDi40nUPM6+/mJ8CXcZvVYeIEwXwQw4x4N3vd1kZLo
f11gliHIj6El/oBm/iP9DFmDTQu2UGmm46T+78WX8ovBznAvwkt5BglghkgBZQME
AggEINNdE1YOlkwdKRiKLIwBZh7SO/HUNT7HYL+RXuEVor70BBfsMks4N20QGq+P
Fm9VBOlYidYYALNSUzCCAUkGCisGAQQBg+lTAQGBggE5MIIBNQIBADCBrQYJYIZI
AWUDBAEuBAxJA203OJmgXv3sFaoEgZEEKtGLSRppd3rzEMfn4kEjcPMO/HaacXcD
WyisW0PGKcFaxzh4gTy1VtCld5/nKNeXwRLD+hAl7+i+YMQDtIuZZeCfaB/OTBax
mhuSENaQ8QNw1G3pTGQ3bNEGegT784HTLBQE6zg6Ii4NtIpqoT90xgZGSxWWdF8F
3fPDGgAUFSB0O6ipmhB4hZbEkYIr+Zv7MF8EMFTf4nAbHixePjODMVf40363rpeX
oii5pcOuYs/tUD/Lau8Qt5FEcqXHk5pU+5UjnwYJYIZIAWUDBAIIBCBAu/xl8/vt
ovxj+hbzolK/DDGycmAjtct/hXDhTT1FUwQfel9//RHfveZXEKl7Eqk3Bf+E7wAY
DJSI+6Ln/c/gfjCCAUwGCisGAQQBg+lTAQOBggE8MIIBOAIBADCBrQYJYIZIAWUD
BAEuBAxDs0iDqgDdsLzUGI4EgZEE+dLvqg2joBhCCiC09xgjVgnOE318kTAU1zoO
tL2NR5P9weq8kUGTdaC84hxb+7wsaPSH6FZ9YB/6gBiQJLbDfhQtvcHsHjwqn/Pd
/0esW8wzPgHgm00oWN44/+nHBJ/Ts2s/3qb4EIwTSHYPZ5IufYUDGSo/GiMBiLC9
UclKVBi7CDcSdamXdh34XWIPZ91dMF8EMBFuCKiy0A4NJYH4Ch11W2Knlf4zciih
8vi6/0iQ8nudV5/bPxMqqERpPtbQz9Vf0AYJYIZIAWUDBAIIBCBg0ZFApA0jkvzS
LTUEXaaDk4W7oZbGZ2PwLSIQcbCLQgQi6epTxvS3a7H1uoyfFpYMZysu0MwWufCT
UUDl4KL+Dco2IDCCAT4GCisGAQQBg+lTAQqBggEuMIIBKgIBADCBrQYJYIZIAWUD
BAEuBAy945disKI8g2o2K5MEgZEEZTde42LW+wL4iNwY+FqITjoPa0faVTm7VbGj
cmYsqzYm9s1yTytodENiF/srhE0bAQ1UvpTT9XrHtcu/uKl9cLhf1Mqui+AN5dSg
ynpVFQ7zG/f56lDHkeDouhcDYcSpiVJAy9YviOr+B8UMKRmkLm5zWPndutxC250x
lZpoHJTKH483DihdJHcktDH4UkZnMF8EMCQeNLGwoFcxNzbcAeG5NYV/5s0sclP8
TBCayLZVDyKDsjKat8c2uzVBJXnw21OnvwYJYIZIAWUDBAIIBCD02Da0iMQJWfGc
GFukZcPUDIqeb+MxdLPGLmjnua3AhAQU/Kuyh1oPxBz3Id7p2shcoChFEVMwggF3
BgorBgEEAYPpUwECgYIBZzCCAWMCAQAwga0GCWCGSAFlAwQBLgQMbL3rD62GOCoS
cT/8BIGRBJSThGZYiSt6YycYIO+SSJ66CRLEsrFK8RerMrfbubtV1sLL9QqNP6+7
NZipNVpJ56w4Hqf4XV1dO2P9N97zbFpH6ZZ+NPMbVit3BDU5bvUDVOknjioCV8rM
aI6Y9277p0cnf5lBNi56Lzt0hSnqgtrz/pI+W6qYa/DpQVdgufeVQDuYwECuPhKV
upa1jMbfIjBfBDDwdRqSLZEB+NwRfIdSGe3ThNoaBgev7GMy4V8DE5Cm3IYFqc0G
1NbfGQlHIgZ+u4cGCWCGSAFlAwQCCAQgItNiCTEt//93Hin4oWEBTSKOCyIr2w25
Kg0515ZnwJ8ETSsbUSVZzRpfb3BazcjExcgZ6lDXEI1oUbzEUUB9hNDQpbarL8Wl
fDlevABvjw2UV8CwJOMCX5R4WoAWGQtKwMhXuEw0/liz11DfKnqpMIIENAYLKwYB
BAGD6VMBCwCBggQjMIIEHwIBADCBrQYJYIZIAWUDBAEuBAzOuhwViFaOpTEMWnAE
gZEE2LbTU6PmYVlxDdfoRuh150x5qjgTu+uRbQfLS3EOmG0G5wDkuAtccXywj2rY
uzNY+OlRBeUKOMb4NP1ZeECW3H3UuoMUVkO4+0ZlNxaqa036IgC7KBp47WgS15wp
9a7ihz8dRY0uH0H71uFR2U2URiucmcr5ILSTDRKqZXS5/Yh26Fk+QGaL8EGsqp7I
DMiOMF8EMFGtKHxBY32PFhmoZtwhUJD8Pw/cW2gxd4vH3dBvu32mP4tAEjdYzu39
5O759ICPIAYJYIZIAWUDBAIIBCCBQ9hR6eUYQ1RFbHS+8OJaJdtmeb+oX7iGDxTG
wGUxOASCAwf8Fs92ie9hajw295KDH61Ah75p6E2QS3Fqot45tPG6onzbIGPX+LZJ
ycmTY1MllASYMnBmVfbUYU8LvLUSQPmJ6M0J1yvgugNK+Mr/dtxyNrtq6IHo+mJ1
7wDjSxDyBpLDAcxZG9KmGgtiYw/gYSZoXt3fkQajZ/v5NYIDKInAeQIVfvbxVFVL
m+XyzKY7HLbLD7JhosQdTtJYFjYwxzbdLXr4ojz9OwNGgwtQq/3E4cZl91KwAkgK
wze1WSw6KAVb65gDyt9XC/+q3GAOEwACTk2IhvMQYBNjS80Y8cwFGLBxLysaZBF7
CGDqK9SQZr/XiCPBPotrym7L6X8SwYBX+zlIxQYyg72SNU4nYjIjqIzoaLYILNZT
UieMlXmIBJm9cB9bA1VbugX04akEKzS0OjEP7Njd8a7RZu2qHqULWNmjb2R3u7Ee
s8v0vCuyzkylc3Ew7Ui88Gms4jiUvAKQ7xkP/bqJD1P8BvUtjHSPdldgJc9W4TXq
+Ka/zh9F4FhSnEMcmw3FyAU21ubF5SrbfSGHN6nHw6xHIZ00cdKd+7zEK2+3qhhj
I2EDCGEwH+SSnXfyJnuGgu2Ij1qAVIYsC7h6YfHJztQUIVeJLW5C7tuH+SaL1n9X
hL8vejgob7T9nVKKrqcZ4Ojziwb0GBpx3HJ6D44X5BjJ+iJJD9sg8IHw8WkmfSaA
Fem895JNqt8PvBCWpwL825GR8M45rvHogi+dp2WFWQcIi/mrlwprjhyMYm7cK22J
lExRweXX6eITs6b2+tzB3StzuOyEqrUD7r7eVCsJKrres7xofbsL1oM49GMT8ayL
LC2h7q+0H/VOQVVywBAJUWgbHP3Cnd8scbmLjmheLbBIcCAp9gScZQFY3xNGjNQH
ldRWiMLiVG8m65Pw+L5IMMAvrzg3eywS8vI/EVPS1V/jqSlMhMhCJSI9A7IE6pgV
v+291VYgRUuv3c4krj1jZ8x6g63LiOg4lZ+I1k/UCNs4fPaBrmSOqEUDPevPx5+T
EXAnGkRY+W7rMuiDoywkMIIBhAYKKwYBBAGD6VMBCIGCAXQwggFwAgEAMIGtBglg
hkgBZQMEAS4EDMO72R3ZCFILoqv/qgSBkQRJYrZ54HCQKK4gxZv0/Q5CM0PJOfIV
OtvXP2FA3IeTHidExafZH1gXYvewxIGsRp1/kGPxLe3zx+oE2V3n6X67Z4Oqtnho
3TYkrGShtNY1Hcv4f1wpeqSFt0O+89RRziMJi8PGFTtDdhs4AA4ya7ANsfL4Hyye
8tyvT2liFDW19ntnYkO0J3AThGeVPc7/TYIwXwQweOXUFOVHlroVCU8gUiF0vRmq
sqXBO1+L0gT2KogBV+d2ozwRq8hHw8fQktfkggVZBglghkgBZQMEAggEIGk/is4H
gN3Ecu3Jt0XZt57Q/8vOoJd1goqNToA5hhYABFohiZgM9ibrlEFnqTBHF5OVTrS8
g/gsbN79BC0IZ+C1QZzTq2OeNMZb9nEeFh9KL5EgcPTB2kds0KOxMQ/EtZRxKqGF
G+zMrPkjZJoIJIFJ3OLhZNpsE78sk2owggFIBgorBgEEAYPpUwEEgYIBODCCATQC
AQAwga0GCWCGSAFlAwQBLgQM77L/4QFlHX12Ymx+BIGRBPQKZ7v5vpL0Bd84Qxup
5BTTN8o53yOEg6WNJretP2I701szh7iON6zmSMxnq6htw3Uofxm6LJ93c59bhsbU
7eR6IuA/n97bZbck/fQDJg+1agNjF2xNB5yqgyIo4JENVMyU1v7TvoGicxZnLJRg
70DeopLBmXdjXN20YQfXj+hsaP99xlt2dcekP/vBoq8E7DBfBDD+PNkXNtN5LU37
PDAPVn0HYTFIZRQx+MQ0Wj9o2bdFsH8tqon5pQMOHzJP9TLR0ucGCWCGSAFlAwQC
CAQg/9s/LHXCQnvBwcuMkkEnSCzkjXU6euuYAht+XSZgsTwEHtKFUV8gBXMuSG82
VNUJJMfiGw6G9cF+96K/otwDHTALBglghkgBZQMEAwoDRwAwRAIgCGIfyxdQwjmr
vGVSkpNM+BsmzDWDarsjpw/2ZFDvSCUCIBcBGiZPCsgPvbRKEDGStAkJYngZ7Zh3
4Qh9l2aV4VzD
-----END CERTIFICATE-----` },
		{ name: 'new (with context tags)', seed: '657340915c5dd7d4610feaf281f6f4658b5689d414710ce080eb8f8b0b2e03a9', pem: `-----BEGIN CERTIFICATE-----
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
Ikz1g4z7LFI2Qw5gyPXl/+PcDSJwN6IHTQ==
-----END CERTIFICATE-----` }
	];

	// Test attributes to share
	const attributesToShare: (keyof typeof CertificateAttributeOIDDB)[] = ['entityType', 'fullName', 'email', 'dateOfBirth', 'documentDriversLicense'];
	for (const { name, seed, pem } of testCerts) {
		// Create account from seed for this certificate
		const account = KeetaNetClient.lib.Account.fromSeed(seed, 0);

		// Parse certificate with subject's private key
		const cert = new Certificates.Certificate(pem, { subjectKey: account, moment: null });
		expect(cert.subject, `${name}: subject`).toContain('keeta_');
		expect(Object.keys(cert.attributes).length, `${name}: has attributes`).toBeGreaterThan(0);

		// Create SharableCertificateAttributes
		const sharable = await Certificates.SharableCertificateAttributes.fromCertificate(cert, undefined, attributesToShare);
		expect(sharable, `${name}: sharable created`).toBeDefined();

		// Grant access to a viewer
		const viewerAccount = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
		await sharable.grantAccess(viewerAccount);
		expect(sharable.principals.length, `${name}: has principals`).toBe(1);

		// Export and re-import to verify serialization works
		const exported = await sharable.export({ format: 'string' });
		expect(exported, `${name}: exported`).toContain('-----BEGIN KYC CERTIFICATE PROOF-----');

		const reimported = new Certificates.SharableCertificateAttributes(exported, { principals: viewerAccount });
		const attrNames = await reimported.getAttributeNames();
		expect(attrNames.length, `${name}: reimported has attributes`).toBeGreaterThan(0);

		// Verify we can retrieve the certificate
		const reimportedCert = await reimported.getCertificate();
		expect(reimportedCert.subject, `${name}: reimported cert subject`).toContain('keeta_');

		// Verify we can retrieve the entity type attribute
		const entityType = await reimported.getAttribute('entityType');
		expect(entityType, `${name}: entity type retrieved`).toBeDefined();
		expect(entityType?.person, `${name}: entity type is a person`).toBeDefined();

		// Verify we can retrieve and decode the drivers license attribute
		const driversLicense = await reimported.getAttribute('documentDriversLicense');
		expect(driversLicense, `${name}: drivers license retrieved`).toBeDefined();
		expect(driversLicense?.documentNumber, `${name}: drivers license has documentNumber`).toBeDefined();
		expect(driversLicense?.front, `${name}: drivers license has front reference`).toBeDefined();
		expect(driversLicense?.issuingCountry, `${name}: drivers license has issuingCountry`).toBe('US');
	}
}, 20000);
