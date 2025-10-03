import { test, expect } from 'vitest';
import * as Certificates from './certificates.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { arrayBufferToBuffer } from './utils/buffer.js';
import { ContactDetails, CertificateAttributeValue, CertificateAttributeOIDDB } from '../generated/iso20022.js';
import * as ASN1 from './utils/asn1.js';

type CertificateAttributeNames = keyof typeof CertificateAttributeOIDDB;

async function verifyAttribute<NAME extends CertificateAttributeNames>(
	certificateWithPrivate: Certificates.Certificate,
	certificate: Certificates.Certificate,
	attributeName: NAME,
	expectedValue: CertificateAttributeValue<NAME>
): Promise<void> {
	expect(certificateWithPrivate.attributes[attributeName]?.sensitive).toBe(true);
	expect(certificate.attributes[attributeName]?.sensitive).toBe(true);

	const attrWithPrivate = certificateWithPrivate.attributes[attributeName]!.value as InstanceType<typeof Certificates._Testing.SensitiveAttribute>;
	const attr = certificate.attributes[attributeName]!.value as InstanceType<typeof Certificates._Testing.SensitiveAttribute>;

	const actualValue = await attrWithPrivate.getValue(attributeName);
	expect(actualValue).toEqual(expectedValue);

	const proof = await attrWithPrivate.prove();
	expect(await attr.validateProof(proof)).toBe(true);

	const proofValue = expectedValue instanceof Date
		? new Date(Buffer.from(proof.value, 'base64').toString('utf-8'))
		: typeof expectedValue === 'string' 
		? Buffer.from(proof.value, 'base64').toString('utf-8')
		: await attrWithPrivate.getValue(attributeName);

	expect(proofValue).toEqual(expectedValue);

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
	
	builder1.set(contactDetails);

	const attribute = await builder1.build();

	/*
	 * Access it with the private key
	 */
	const sensitiveAttribute1 = new Certificates._Testing.SensitiveAttribute(testAccount1, attribute);
	const sensitiveAttribute1Value = await sensitiveAttribute1.get();
	const sensitiveAttribute1ValueObject = JSON.parse(new TextDecoder().decode(sensitiveAttribute1Value));
	expect(sensitiveAttribute1Value).toEqual((new Uint8Array([0x54, 0x65, 0x73, 0x74, 0x20, 0x56, 0x61, 0x6c, 0x75, 0x65])).buffer);
	expect(sensitiveAttribute1ValueObject).toEqual(contactDetails);

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
		 * Verify all sensitive attributes using the helper function
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
	const rustCertificateDER = new Uint8Array([
		48, 130, 4, 62, 48, 130, 3, 229, 160, 3, 2, 1, 2, 2, 2, 48, 57, 48, 10, 6, 8, 42, 134, 72, 206, 61, 4, 3, 2, 48, 23, 49, 21, 48, 19, 6, 3, 85, 4, 3, 22, 12, 84, 101, 115, 116, 32, 83, 117, 98, 106, 101, 99, 116, 48, 34, 24, 15, 50, 48, 50, 53, 49, 48, 48, 51, 50, 50, 48, 56, 49, 49, 90, 24, 15, 50, 48, 50, 54, 49, 48, 48, 51, 50, 50, 48, 56, 49, 49, 90, 48, 23, 49, 21, 48, 19, 6, 3, 85, 4, 3, 22, 12, 84, 101, 115, 116, 32, 83, 117, 98, 106, 101, 99, 116, 48, 54, 48, 16, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6, 5, 43, 129, 4, 0, 10, 3, 34, 0, 2, 166, 65, 98, 40, 127, 185, 203, 239, 220, 177, 149, 18, 61, 18, 25, 192, 227, 116, 235, 86, 172, 26, 58, 218, 115, 59, 51, 95, 82, 203, 216, 123, 163, 130, 3, 62, 48, 130, 3, 58, 48, 14, 6, 3, 85, 29, 15, 1, 1, 255, 4, 4, 3, 2, 0, 192, 48, 130, 3, 38, 6, 10, 43, 6, 1, 4, 1, 131, 233, 83, 0, 0, 4, 130, 3, 22, 48, 130, 3, 18, 48, 130, 1, 133, 6, 10, 43, 6, 1, 4, 1, 131, 233, 83, 1, 2, 129, 130, 1, 117, 48, 130, 1, 113, 2, 1, 0, 48, 129, 173, 6, 9, 96, 134, 72, 1, 101, 3, 4, 1, 46, 4, 12, 167, 111, 172, 159, 65, 145, 79, 179, 177, 231, 172, 219, 4, 129, 145, 4, 121, 199, 172, 251, 166, 96, 93, 101, 140, 84, 144, 58, 255, 10, 150, 20, 5, 116, 124, 174, 63, 77, 146, 118, 46, 116, 71, 136, 51, 242, 247, 238, 34, 233, 202, 101, 11, 9, 116, 157, 173, 59, 32, 134, 214, 215, 240, 137, 27, 193, 205, 55, 122, 177, 68, 132, 245, 214, 97, 72, 32, 105, 233, 0, 228, 85, 119, 205, 192, 239, 145, 145, 189, 10, 210, 218, 232, 220, 181, 110, 134, 83, 219, 175, 151, 222, 110, 121, 228, 83, 194, 30, 189, 71, 26, 123, 140, 20, 93, 222, 179, 39, 30, 89, 206, 1, 84, 164, 88, 180, 206, 13, 100, 177, 213, 59, 158, 225, 36, 114, 142, 144, 178, 83, 110, 0, 122, 100, 224, 11, 105, 18, 152, 35, 153, 52, 146, 146, 140, 13, 119, 77, 202, 64, 48, 95, 4, 48, 245, 151, 165, 44, 77, 115, 161, 13, 75, 254, 24, 44, 231, 216, 23, 164, 67, 8, 42, 31, 125, 87, 28, 44, 26, 216, 129, 152, 188, 234, 89, 146, 31, 66, 232, 177, 124, 90, 132, 54, 95, 175, 153, 68, 27, 144, 234, 211, 6, 9, 96, 134, 72, 1, 101, 3, 4, 2, 8, 4, 32, 140, 231, 161, 203, 72, 87, 102, 133, 3, 95, 22, 220, 211, 150, 23, 4, 156, 82, 187, 22, 205, 33, 69, 232, 42, 41, 83, 205, 251, 41, 162, 11, 4, 91, 147, 198, 98, 14, 188, 124, 120, 78, 151, 90, 13, 93, 221, 217, 170, 109, 151, 209, 225, 207, 238, 180, 8, 220, 233, 86, 9, 233, 164, 239, 147, 194, 244, 125, 190, 196, 62, 115, 189, 61, 134, 70, 237, 254, 6, 209, 252, 192, 146, 177, 119, 208, 187, 132, 98, 178, 46, 162, 238, 198, 56, 76, 236, 182, 193, 163, 175, 146, 234, 156, 120, 53, 81, 229, 179, 142, 19, 255, 139, 153, 65, 241, 201, 167, 52, 139, 54, 3, 215, 29, 213, 48, 130, 1, 133, 6, 10, 43, 6, 1, 4, 1, 131, 233, 83, 1, 9, 129, 130, 1, 117, 48, 130, 1, 113, 2, 1, 0, 48, 129, 173, 6, 9, 96, 134, 72, 1, 101, 3, 4, 1, 46, 4, 12, 62, 8, 218, 161, 115, 130, 189, 7, 160, 42, 249, 104, 4, 129, 145, 4, 118, 128, 216, 179, 111, 82, 3, 246, 91, 227, 3, 197, 183, 145, 65, 18, 140, 192, 193, 85, 45, 151, 149, 88, 105, 238, 92, 79, 183, 226, 36, 12, 156, 31, 229, 17, 22, 8, 166, 98, 34, 194, 193, 132, 121, 233, 136, 148, 147, 69, 79, 222, 188, 121, 247, 143, 48, 31, 121, 253, 121, 154, 248, 15, 206, 69, 17, 172, 249, 75, 242, 156, 166, 205, 64, 228, 244, 15, 139, 9, 196, 153, 130, 27, 48, 234, 159, 98, 200, 38, 81, 3, 25, 133, 252, 53, 182, 68, 174, 251, 63, 37, 88, 244, 180, 168, 11, 83, 133, 130, 27, 0, 156, 255, 100, 128, 40, 215, 227, 29, 75, 170, 124, 146, 103, 89, 144, 216, 88, 78, 134, 124, 248, 231, 229, 8, 77, 107, 129, 61, 112, 55, 196, 124, 48, 95, 4, 48, 98, 98, 123, 203, 124, 104, 62, 55, 19, 181, 245, 6, 69, 22, 9, 53, 193, 188, 153, 81, 25, 248, 16, 61, 239, 124, 44, 34, 95, 160, 176, 18, 161, 222, 222, 88, 111, 34, 149, 39, 95, 88, 45, 136, 29, 45, 75, 83, 6, 9, 96, 134, 72, 1, 101, 3, 4, 2, 8, 4, 32, 109, 181, 247, 9, 61, 19, 111, 58, 158, 95, 248, 221, 41, 91, 6, 249, 31, 25, 105, 73, 37, 103, 135, 210, 40, 38, 205, 125, 146, 122, 154, 224, 4, 91, 167, 169, 72, 29, 179, 97, 31, 10, 104, 84, 55, 101, 11, 178, 16, 99, 48, 254, 18, 106, 71, 252, 16, 139, 169, 52, 142, 146, 221, 210, 252, 229, 99, 86, 21, 28, 19, 215, 69, 124, 181, 102, 112, 69, 247, 128, 186, 67, 192, 65, 30, 11, 149, 108, 71, 200, 7, 74, 124, 249, 104, 150, 233, 254, 245, 237, 129, 122, 1, 148, 79, 83, 230, 195, 127, 203, 212, 172, 26, 115, 31, 190, 168, 48, 206, 220, 197, 28, 4, 85, 39, 48, 10, 6, 8, 42, 134, 72, 206, 61, 4, 3, 2, 3, 71, 0, 48, 68, 2, 32, 117, 75, 112, 244, 203, 137, 0, 35, 229, 158, 138, 242, 11, 210, 255, 9, 40, 165, 87, 188, 189, 151, 8, 239, 46, 115, 222, 187, 63, 151, 75, 202, 2, 32, 86, 18, 159, 21, 19, 93, 165, 79, 204, 205, 196, 18, 222, 253, 109, 48, 214, 74, 224, 139, 47, 35, 139, 145, 90, 96, 201, 243, 71, 19, 146, 190
	]);

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
	const addressAttr = certificate.attributes['address']!.value as InstanceType<typeof Certificates._Testing.SensitiveAttribute>;
	const address = await addressAttr.getValue('address');
	
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
	const contactAttr = certificate.attributes['contactDetails']!.value as InstanceType<typeof Certificates._Testing.SensitiveAttribute>;
	const contact = await contactAttr.getValue('contactDetails');
	
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
	const addressProof = await addressAttr.prove();
	
	/*
	 * Validate the proof using the same attribute instance
	 * The validateProof method only uses the public key and hashed value,
	 * so it works even if the validator does not have the private key
	 */
	expect(await addressAttr.validateProof(addressProof)).toBe(true);
});
