import { test, expect } from 'vitest';
import * as util from 'util';
import { PIIStore, PIIError } from './pii.js';
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
	{ name: 'toString()', expose: function(s: PIIStore) { return(s.toString()); }, expected: '[PII: REDACTED]' },
	{ name: 'util.inspect()', expose: function(s: PIIStore) { return(util.inspect(s)); }, expected: '[PII: REDACTED]' },
	{ name: 'string coercion', expose: function(s: PIIStore) { return(String(s)); }, expected: '[PII: REDACTED]' },
	{ name: 'template literal', expose: function(s: PIIStore) { return(`${s}`); }, expected: '[PII: REDACTED]' }
];

// ============================================================================
// Helpers
// ============================================================================

function createStore(): PIIStore {
	return(new PIIStore());
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
	return(await (await store.toSensitiveAttribute(name, testAccounts.subject)).getValue());
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

/**
 * Assert that a function throws a PIIError with a specific code
 */
function expectPIIError(fn: () => unknown, code: Parameters<typeof PIIError.isInstance>[1]): PIIError {
	try {
		fn();
		expect.fail(`Expected PIIError with code ${code}`);
	} catch (error) {
		expect(PIIError.isInstance(error, code)).toBe(true);
		if (PIIError.isInstance(error)) {
			return(error);
		}
	}

	throw(new Error('Unreachable'));
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

test('toSensitiveAttribute throws PIIError for missing attributes', async function() {
	const store = createStore();
	for (const { name } of TEST_ATTRIBUTES) {
		await expect(store.toSensitiveAttribute(name, testAccounts.subject)).rejects.toSatisfy(
			function(error: unknown) { return(PIIError.isInstance(error, 'PII_ATTRIBUTE_NOT_FOUND')); }
		);
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

test('toSensitiveAttribute handles external attributes via JSON serialization', async function() {
	const store = createStore();
	const externalData = { provider: 'test', score: 42, verified: true };
	store.setAttribute('externalProvider.result', externalData);

	const sensitiveAttr = await store.toSensitiveAttribute<typeof externalData>('externalProvider.result', testAccounts.subject);
	expect(sensitiveAttr.publicKey).toBe(testAccounts.subject.publicKeyString.get());

	const decrypted = await sensitiveAttr.getValue();
	expect(decrypted).toEqual(externalData);
});

test('run provides scoped access to external attributes', function() {
	const store = createStore();
	const externalData = { provider: 'test', score: 42 };
	store.setAttribute('externalProvider.result', externalData);

	const result = store.run(function(get) {
		return(get<typeof externalData>('externalProvider.result'));
	});
	expect(result).toEqual(externalData);
});

test('run provides scoped access to known attributes', function() {
	const store = createStore();
	store.setAttribute('firstName', 'John');
	store.setAttribute('lastName', 'Doe');

	const fullName = store.run(function(get) {
		return(`${get('firstName')} ${get('lastName')}`);
	});
	expect(fullName).toBe('John Doe');
});

test('run throws PIIError for missing attributes', function() {
	const store = createStore();
	const error = expectPIIError(function() {
		store.run(function(get) { return(get('nonexistent')); });
	}, 'PII_ATTRIBUTE_NOT_FOUND');
	expect(error.attributeName).toBe('nonexistent');
});

// ============================================================================
// Tests: Redaction
// ============================================================================

test('toJSON returns redacted object with attribute names', function() {
	const json = createPopulatedStore().toJSON();
	expect(json.type).toBe('PIIStore');
	expect(Object.keys(json.attributes).sort()).toEqual(
		TEST_ATTRIBUTES.map(function(a) { return(a.name); }).sort()
	);
	for (const value of Object.values(json.attributes)) {
		expect(value).toBe('[REDACTED]');
	}
});

test('redaction prevents PII exposure', function() {
	const store = createPopulatedStore();
	for (const method of REDACTION_METHODS) {
		const result = method.expose(store);
		expect(result, method.name).toBe(method.expected);

		for (const { value } of TEST_ATTRIBUTES) {
			if (typeof value === 'string') {
				expect(result, `${method.name} leaked "${value}"`).not.toContain(value);
			}
		}
	}
});

// ============================================================================
// Tests: Certificate Integration
// ============================================================================

test('fromCertificate extracts all attributes', async function() {
	const { certificateWithKey } = await createTestCertificate();

	const store = PIIStore.fromCertificate(certificateWithKey);
	for (const name of ['fullName', 'email', 'phoneNumber', 'dateOfBirth', 'address', 'entityType'] as const) {
		expect(await getValue(store, name), name).toEqual(testAttributeValues[name]);
	}

	expect(store.toString()).toBe('[PII: REDACTED]');
});

test('toCertificateBuilder <-> fromCertificate round-trip', async function() {
	const originalStore = createPopulatedStore();

	const certificate = await originalStore
		.toCertificateBuilder(createBuilder())
		.build({ serial: 1 });

	const certWithKey = new Certificate(certificate, { subjectKey: testAccounts.subject });
	const extractedStore = PIIStore.fromCertificate(certWithKey);
	for (const { name, value } of TEST_ATTRIBUTES) {
		expect(await getValue(extractedStore, name)).toEqual(value);
	}
});

test('toSensitiveAttribute creates encrypted attribute with correct public key', async function() {
	const store = createStore();
	store.setAttribute('email', 'test@example.com');

	const sensitiveAttr = await store.toSensitiveAttribute('email', testAccounts.subject);
	expect(sensitiveAttr.publicKey).toBe(testAccounts.subject.publicKeyString.get());
	expect(await sensitiveAttr.getValue()).toBe('test@example.com');
});

test('setSensitiveAttribute accepts pre-built attribute', async function() {
	const store = createStore();
	store.setAttribute('email', 'secure@example.com');

	const builder = createBuilder();
	builder.setSensitiveAttribute('email', await store.toSensitiveAttribute('email', testAccounts.subject));
	const certificate = await builder.build({ serial: 1 });

	const certWithKey = new Certificate(certificate, { subjectKey: testAccounts.subject });
	expect(await certWithKey.getAttributeValue('email')).toBe('secure@example.com');
});

test('setSensitiveAttribute rejects wrong subject key', async function() {
	const wrongKeyStore = new PIIStore();
	wrongKeyStore.setAttribute('email', 'wrong@example.com');

	const wrongKeyAttr = await wrongKeyStore.toSensitiveAttribute('email', testAccounts.other);
	expect(function() {
		createBuilder().setSensitiveAttribute('email', wrongKeyAttr);
	}).toThrowError('SensitiveAttribute was encrypted for a different subject');
});
