import { test, expect } from 'vitest';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { SensitiveAttribute, SensitiveAttributeBuilder } from './sensitive-attribute.js';
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

const RAW_PAYLOAD = bufferToArrayBuffer(Buffer.from('secret-value', 'utf-8'));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build an encrypted attribute from raw bytes
 */
async function buildRaw(data: ArrayBuffer = RAW_PAYLOAD): Promise<{
	encrypted: SensitiveAttribute<ArrayBuffer>;
	der: ArrayBuffer;
}> {
	const encrypted = await new SensitiveAttributeBuilder(accounts.publicKeyOnly)
		.set(data)
		.build();

	return({ encrypted, der: encrypted.toDER() });
}

/**
 * Generate a proof using the private key
 */
async function generateProof(der: ArrayBuffer): Promise<{
	proof: Awaited<ReturnType<SensitiveAttribute<ArrayBuffer>['getProof']>>;
	attrWithKey: SensitiveAttribute<ArrayBuffer>;
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

test('raw bytes: encrypt and decrypt round-trip', async function() {
	const { der } = await buildRaw();
	const decrypted = await new SensitiveAttribute(accounts.withPrivateKey, der).getValue();
	expect(arrayBufferToBuffer(decrypted).toString('utf-8')).toBe('secret-value');
});

test('schema-aware: encrypt and decrypt with type preservation', async function() {
	for (const { name, value } of SCHEMA_ATTRIBUTES) {
		const encrypted = await new SensitiveAttributeBuilder(accounts.withPrivateKey)
			.set(name, value)
			.build();
		expect(await encrypted.getValue(), name).toEqual(value);
	}
});

test('publicKey getter matches encryption key', async function() {
	const { encrypted } = await buildRaw();
	expect(encrypted.publicKey).toBe(accounts.publicKeyOnly.publicKeyString.get());
});

test('toDER returns re-constructable bytes', async function() {
	const { der } = await buildRaw();
	expect(der).toBeInstanceOf(ArrayBuffer);
	expect(der.byteLength).toBeGreaterThan(0);

	const decrypted = await new SensitiveAttribute(accounts.withPrivateKey, der).getValue();
	expect(arrayBufferToBuffer(decrypted).toString('utf-8')).toBe('secret-value');
});

test('toJSON contains expected structure', async function() {
	const { encrypted } = await buildRaw();
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
	const { der } = await buildRaw();
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
		proof: Awaited<ReturnType<SensitiveAttribute<ArrayBuffer>['getProof']>>;
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
		const { der } = await buildRaw();
		const { der: testDER, proof, account = accounts.publicKeyOnly } = await modify(der);
		const valid = await new SensitiveAttribute(account, testDER).validateProof(proof);
		expect(valid).toBe(false);
	});
}

// ============================================================================
// Tests: Error Cases
// ============================================================================

test('error: decryption fails with wrong private key', async function() {
	const { der } = await buildRaw();
	await expect(async function() {
		return(await new SensitiveAttribute(accounts.wrong, der).getProof());
	}).rejects.toThrow();
});

test('error: build throws when value not set', async function() {
	await expect(async function() {
		return(await new SensitiveAttributeBuilder(accounts.publicKeyOnly).build());
	}).rejects.toThrow();
});

