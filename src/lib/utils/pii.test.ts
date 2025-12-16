import { test, expect } from 'vitest';
import * as util from 'util';
import { PIIStore, PIIAttributeNotFoundError } from './pii.js';
import type { PIIAttributeNames } from './pii.js';
import type { CertificateAttributeValue } from '../../services/kyc/iso20022.generated.js';
import { createTestCertificate, testAttributeValues, testAccounts } from './tests/certificates.js';
import { Certificate } from '../certificates.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';

// ============================================================================
// Test Data
// ============================================================================

function attr<K extends PIIAttributeNames>(
	name: K,
	value: CertificateAttributeValue<K>
): { name: K; value: CertificateAttributeValue<K> } {
	return({ name, value });
}

const TEST_ATTRIBUTES = [
	attr('firstName', 'John'),
	attr('lastName', 'Doe'),
	attr('email', 'john.doe@example.com'),
	attr('phoneNumber', '+1-555-123-4567'),
	attr('dateOfBirth', new Date('1990-01-15')),
	attr('address', {
		addressLines: ['123 Main St'],
		townName: 'Springfield',
		postalCode: '12345',
		country: 'US'
	})
];

const REDACTION_METHODS = [
	{ name: 'toString()', expose: (s: PIIStore) => s.toString(), expected: '[PII: REDACTED]' },
	{ name: 'JSON.stringify()', expose: (s: PIIStore) => JSON.stringify(s), expected: '{"type":"PIIStore","message":"REDACTED"}' },
	{ name: 'util.inspect()', expose: (s: PIIStore) => util.inspect(s), expected: '[PII: REDACTED]' },
	{ name: 'string coercion', expose: (s: PIIStore) => String(s), expected: '[PII: REDACTED]' },
	{ name: 'template literal', expose: (s: PIIStore) => `${s}`, expected: '[PII: REDACTED]' }
];

// ============================================================================
// Helpers
// ============================================================================

function createStore(): PIIStore {
	return(new PIIStore(testAccounts.subject));
}

function createPopulatedStore(): PIIStore {
	const store = createStore();
	for (const { name, value } of TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
	}
	return(store);
}

/**
 * Get decrypted value from store
 */
async function getValue<K extends PIIAttributeNames>(
	store: PIIStore,
	name: K
): Promise<CertificateAttributeValue<K>> {
	return(await (await store.toSensitiveAttribute(name)).getValue());
}

/**
 * Create a certificate builder for the subject
 */
function createBuilder(): InstanceType<typeof Certificate.Builder> {
	const subjectNoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(
		testAccounts.subject.publicKeyString.get()
	);
	return(new Certificate.Builder({
		issuer: testAccounts.issuer.assertAccount(),
		subject: subjectNoPrivate.assertAccount(),
		validFrom: new Date(),
		validTo: new Date(Date.now() + 86400000)
	}));
}

// ============================================================================
// Tests: Basic Operations
// ============================================================================

test('setAttribute and toSensitiveAttribute round-trip', async function() {
	const store = createStore();
	for (const { name, value } of TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
		expect(await getValue(store, name)).toEqual(value);
	}
});

test('hasAttribute tracks set attributes', function() {
	const store = createStore();
	for (const { name, value } of TEST_ATTRIBUTES) {
		expect(store.hasAttribute(name)).toBe(false);
		store.setAttribute(name, value);
		expect(store.hasAttribute(name)).toBe(true);
	}
});

test('getAttributeNames returns set attribute names in order', function() {
	const store = createStore();
	expect(store.getAttributeNames()).toEqual([]);

	const expectedNames: PIIAttributeNames[] = [];
	for (const { name, value } of TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
		expectedNames.push(name);
		expect(store.getAttributeNames()).toEqual(expectedNames);
	}
});

test('toSensitiveAttribute throws PIIAttributeNotFoundError for missing', async function() {
	const store = createStore();
	for (const { name } of TEST_ATTRIBUTES) {
		await expect(store.toSensitiveAttribute(name)).rejects.toThrowError(PIIAttributeNotFoundError);
	}
});

test('setAttribute overwrites existing values', async function() {
	const store = createStore();
	store.setAttribute('firstName', 'John');
	expect(await getValue(store, 'firstName')).toBe('John');

	store.setAttribute('firstName', 'Jane');
	expect(await getValue(store, 'firstName')).toBe('Jane');
	expect(store.getAttributeNames()).toEqual(['firstName']);
});

// ============================================================================
// Tests: Redaction
// ============================================================================

test('toJSON returns redacted object', function() {
	expect(createPopulatedStore().toJSON()).toEqual({ type: 'PIIStore', message: 'REDACTED' });
});

test('redaction prevents PII exposure', function() {
	const store = createPopulatedStore();
	for (const { name, expose, expected } of REDACTION_METHODS) {
		const result = expose(store);
		expect(result, name).toBe(expected);

		for (const { value } of TEST_ATTRIBUTES) {
			if (typeof value === 'string') {
				expect(result, `${name} leaked "${value}"`).not.toContain(value);
			}
		}
	}
});

// ============================================================================
// Tests: Certificate Integration
// ============================================================================

test('fromCertificate extracts all attributes', async function() {
	const { certificateWithKey, subjectKey } = await createTestCertificate();
	const store = PIIStore.fromCertificate(certificateWithKey, subjectKey);

	const expectedAttrs: [PIIAttributeNames, unknown][] = [
		['fullName', testAttributeValues.fullName],
		['email', testAttributeValues.email],
		['phoneNumber', testAttributeValues.phoneNumber],
		['dateOfBirth', testAttributeValues.dateOfBirth],
		['address', testAttributeValues.address],
		['entityType', testAttributeValues.entityType]
	];

	for (const [name, expected] of expectedAttrs) {
		expect(await getValue(store, name), name).toEqual(expected);
	}

	expect(store.toString()).toBe('[PII: REDACTED]');
});

test('toCertificateBuilder <-> fromCertificate round-trip', async function() {
	const originalStore = createPopulatedStore();

	const certificate = await originalStore
		.toCertificateBuilder(createBuilder())
		.build({ serial: 1 });

	const certWithKey = new Certificate(certificate, { subjectKey: testAccounts.subject });
	const extractedStore = PIIStore.fromCertificate(certWithKey, testAccounts.subject);
	for (const { name, value } of TEST_ATTRIBUTES) {
		expect(await getValue(extractedStore, name)).toEqual(value);
	}
});

test('toSensitiveAttribute creates encrypted attribute with correct public key', async function() {
	const store = createStore();
	store.setAttribute('email', 'test@example.com');

	const sensitiveAttr = await store.toSensitiveAttribute('email');
	expect(sensitiveAttr.publicKey).toBe(testAccounts.subject.publicKeyString.get());
	expect(await sensitiveAttr.getValue()).toBe('test@example.com');
});

test('setSensitiveAttribute accepts pre-built attribute', async function() {
	const store = createStore();
	store.setAttribute('email', 'secure@example.com');

	const builder = createBuilder();
	builder.setSensitiveAttribute('email', await store.toSensitiveAttribute('email'));
	const certificate = await builder.build({ serial: 1 });

	const certWithKey = new Certificate(certificate, { subjectKey: testAccounts.subject });
	expect(await certWithKey.getAttributeValue('email')).toBe('secure@example.com');
});

test('setSensitiveAttribute rejects wrong subject key', async function() {
	const wrongKeyStore = new PIIStore(testAccounts.other);
	wrongKeyStore.setAttribute('email', 'wrong@example.com');

	const wrongKeyAttr = await wrongKeyStore.toSensitiveAttribute('email');
	expect(function() {
		createBuilder().setSensitiveAttribute('email', wrongKeyAttr);
	}).toThrowError('SensitiveAttribute was encrypted for a different subject');
});
