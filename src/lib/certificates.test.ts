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
	const passphrase = 'quick pride swear mistake sound crack pony gun label enjoy aim champion scene cheap spider leisure ritual possible dial ski yellow pigeon pet warrior';
	const seed = await KeetaNetClient.lib.Account.seedFromPassphrase(passphrase);
	const account = KeetaNetClient.lib.Account.fromSeed(seed, 0);

	const testCerts = [
		{ name: 'old (no context tags)', pem: `-----BEGIN CERTIFICATE-----
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
jbkxZaWmEWSxLfwvIl60ke5W9IKyd6r7Q3Q=
-----END CERTIFICATE-----` },
		{ name: 'new (with context tags)', pem: `-----BEGIN CERTIFICATE-----
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
Ikz1g4z7LFI2Qw5gyPXl/+PcDSJwN6IHTQ==
-----END CERTIFICATE-----` }
	];

	// Test attributes to share
	const attributesToShare: (keyof typeof CertificateAttributeOIDDB)[] = ['entityType', 'fullName', 'email', 'dateOfBirth', 'documentDriversLicense'];
	for (const { name, pem } of testCerts) {
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
}, 10000);
