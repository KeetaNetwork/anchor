import { test, expect } from 'vitest';
import * as Certificates from './certificates.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { arrayBufferToBuffer, bufferToArrayBuffer } from './utils/buffer.js';
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
		const modifiedValueCompressed = KeetaNetClient.lib.Utils.Buffer.ZlibDeflate(modifiedValueBuffer);
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
