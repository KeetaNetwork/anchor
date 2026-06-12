import { test, expect } from 'vitest';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { SensitiveAttribute } from './sensitive-attribute.js';
import type { CertificateAttributeNames } from './sensitive-attribute.js';
import type { CertificateAttributeValue } from '../services/kyc/iso20022.generated.js';
import { arrayBufferToBuffer, bufferToArrayBuffer } from './utils/buffer.js';
import { testAccounts } from './utils/tests/certificates.js';

// ============================================================================
// Test Accounts
// ============================================================================
const accounts = {
	withPrivateKey: testAccounts.subject,
	publicKeyOnly: KeetaNetClient.lib.Account.fromPublicKeyString(
		testAccounts.subject.publicKeyString.get()
	),
	wrong: testAccounts.other
};

// ============================================================================
// Test Data
// ============================================================================
function attr<K extends CertificateAttributeNames>(
	name: K,
	value: CertificateAttributeValue<K>
): { name: K; value: CertificateAttributeValue<K> } {
	return({ name, value });
}

const SCHEMA_ATTRIBUTES = [
	attr('firstName', 'John'),
	attr('lastName', 'Doe'),
	attr('email', 'john.doe@example.com'),
	attr('dateOfBirth', new Date('1990-01-15'))
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build an encrypted attribute using a named schema attribute
 */
async function buildEncrypted(): Promise<{
	encrypted: SensitiveAttribute<string>;
	der: ArrayBuffer;
}> {
	const encrypted = await SensitiveAttribute.create(accounts.publicKeyOnly, 'firstName', 'secret-value');
	return({ encrypted, der: encrypted.toDER() });
}

/**
 * Generate a proof using the private key
 */
async function generateProof(der: ArrayBuffer): Promise<{
	proof: Awaited<ReturnType<SensitiveAttribute['getProof']>>;
	attrWithKey: SensitiveAttribute;
}> {
	const attrWithKey = new SensitiveAttribute(accounts.withPrivateKey, der);
	return({ proof: await attrWithKey.getProof(), attrWithKey });
}

/**
 * Tamper with DER data
 */
function tamperDER(der: ArrayBuffer): ArrayBuffer {
	const buffer = arrayBufferToBuffer(der);
	buffer.set([0x00], buffer.length - 3);
	return(bufferToArrayBuffer(buffer));
}

// ============================================================================
// Tests: Building & Decryption
// ============================================================================

test('encrypt and decrypt round-trip', async function() {
	const encrypted = await SensitiveAttribute.create(accounts.withPrivateKey, 'firstName', 'secret-value');
	expect(await encrypted.getValue()).toBe('secret-value');
});

test('encrypt and decrypt with type preservation', async function() {
	for (const { name, value } of SCHEMA_ATTRIBUTES) {
		const encrypted = await SensitiveAttribute.create(accounts.withPrivateKey, name, value);
		expect(await encrypted.getValue(), name).toEqual(value);
	}
});

test('dateOfBirth round-trip preserves pre-2000 years', async function() {
	const dates = [
		new Date('1905-06-15'),
		new Date('1950-01-01'),
		new Date('1955-06-15'),
		new Date('1969-01-01'),
		new Date('1990-12-31'),
		new Date('1999-12-31')
	];
	for (const dob of dates) {
		const encrypted = await SensitiveAttribute.create(accounts.withPrivateKey, 'dateOfBirth', dob);
		const decrypted = await encrypted.getValue();
		expect(decrypted).toBeInstanceOf(Date);
		expect((decrypted).getUTCFullYear(), dob.toISOString()).toBe(dob.getUTCFullYear());
	}
});

test('publicKey getter matches encryption key', async function() {
	const { encrypted } = await buildEncrypted();
	expect(encrypted.publicKey).toBe(accounts.publicKeyOnly.publicKeyString.get());
});

test('toDER returns re-constructable bytes', async function() {
	const { der } = await buildEncrypted();
	expect(der).toBeInstanceOf(ArrayBuffer);
	expect(der.byteLength).toBeGreaterThan(0);

	const reconstructed = new SensitiveAttribute(accounts.withPrivateKey, der);
	const raw = await reconstructed.get();
	expect(raw).toBeInstanceOf(ArrayBuffer);
	expect(raw.byteLength).toBeGreaterThan(0);
});

test('toJSON contains expected structure', async function() {
	const { encrypted } = await buildEncrypted();
	const json = encrypted.toJSON();
	expect(typeof json).toBe('object');
	expect(json).not.toBeNull();

	const keys = Object.keys(json ?? {});
	const expectedKeys = ['version', 'cipher', 'publicKey', 'hashedValue', 'encryptedValue'];
	expect(keys.sort()).toEqual(expectedKeys.sort());
	expect(JSON.parse(JSON.stringify(json))).toEqual(json);
});

// ============================================================================
// Tests: Proof Validation
// ============================================================================

test('proof: valid proof passes validation', async function() {
	const { der } = await buildEncrypted();
	const { proof } = await generateProof(der);
	expect(proof).toHaveProperty('value');
	expect(proof).toHaveProperty('hash');
	expect(proof.hash).toHaveProperty('salt');

	const valid = await new SensitiveAttribute(accounts.publicKeyOnly, der).validateProof(proof);
	expect(valid).toBe(true);
});

type ProofTestCase = {
	name: string;
	modify: (der: ArrayBuffer) => Promise<{
		der: ArrayBuffer;
		proof: Awaited<ReturnType<SensitiveAttribute['getProof']>>;
		account?: typeof accounts.publicKeyOnly;
	}>;
};

const INVALID_PROOF_CASES: ProofTestCase[] = [
	{
		name: 'tampered value',
		modify: async function(der) {
			const { proof } = await generateProof(der);
			return({ der, proof: { ...proof, value: 'tampered' }});
		}
	},
	{
		name: 'wrong public key',
		modify: async function(der) {
			const { proof } = await generateProof(der);
			return({ der, proof, account: accounts.wrong });
		}
	},
	{
		name: 'tampered DER',
		modify: async function(der) {
			const { proof } = await generateProof(der);
			return({ der: tamperDER(der), proof });
		}
	}
];

for (const { name, modify } of INVALID_PROOF_CASES) {
	test(`proof: fails with ${name}`, async function() {
		const { der } = await buildEncrypted();
		const { der: testDER, proof, account = accounts.publicKeyOnly } = await modify(der);
		const valid = await new SensitiveAttribute(account, testDER).validateProof(proof);
		expect(valid).toBe(false);
	});
}

// ============================================================================
// Tests: Error Cases
// ============================================================================

test('error: decryption fails with wrong private key', async function() {
	const { der } = await buildEncrypted();
	await expect(async function() {
		return(await new SensitiveAttribute(accounts.wrong, der).getProof());
	}).rejects.toThrow();
});
