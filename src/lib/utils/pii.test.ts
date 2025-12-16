import { test, expect } from 'vitest';
import * as util from 'util';
import { PIIStore, PIIAttributeNotFoundError } from './pii.js';
import type { PIIAttributeNames } from './pii.js';
import type { CertificateAttributeValue } from '../../services/kyc/iso20022.generated.js';
import { createTestCertificate, testAttributeValues, testAccounts } from './tests/certificates.js';
import { Certificate } from '../certificates.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';

/**
 * Type-safe helper for defining test attributes
 */
function attr<K extends PIIAttributeNames>(
	name: K,
	value: CertificateAttributeValue<K>
): { name: K; value: CertificateAttributeValue<K> } {
	return({ name, value });
}

/**
 * Test data for attribute operations
 */
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

/**
 * Redaction exposure methods to verify PII is never leaked
 */
const REDACTION_METHODS: {
	name: string;
	expose: (store: PIIStore) => string;
	expected: string;
}[] = [
	{ name: 'toString()', expose: (s) => s.toString(), expected: '[PII: REDACTED]' },
	{ name: 'JSON.stringify()', expose: (s) => JSON.stringify(s), expected: '{"type":"PIIStore","message":"REDACTED"}' },
	{ name: 'util.inspect()', expose: (s) => util.inspect(s), expected: '[PII: REDACTED]' },
	{ name: 'string coercion', expose: (s) => String(s), expected: '[PII: REDACTED]' },
	{ name: 'template literal', expose: (s) => `${s}`, expected: '[PII: REDACTED]' }
];

/**
 * Helper to create a populated store
 */
function createPopulatedStore(): PIIStore {
	const store = new PIIStore();
	for (const { name, value } of TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
	}

	return(store);
}

test('PIIStore: setAttribute and run', function() {
	const store = new PIIStore();
	for (const { name, value } of TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
		store.run([name], function(v) {
			expect(v).toEqual(value);
		});
	}
});

test('PIIStore: hasAttribute', function() {
	const store = new PIIStore();
	for (const { name, value } of TEST_ATTRIBUTES) {
		expect(store.hasAttribute(name)).toBe(false);
		store.setAttribute(name, value);
		expect(store.hasAttribute(name)).toBe(true);
	}
});

test('PIIStore: getAttributeNames', function() {
	const store = new PIIStore();
	expect(store.getAttributeNames()).toEqual([]);

	const expectedNames: PIIAttributeNames[] = [];
	for (const { name, value } of TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
		expectedNames.push(name);
		expect(store.getAttributeNames()).toEqual(expectedNames);
	}
});

test('PIIStore: run throws for missing attributes', function() {
	const store = new PIIStore();
	for (const { name } of TEST_ATTRIBUTES) {
		expect(function() { store.run([name], function() {}); }).toThrowError(PIIAttributeNotFoundError);
	}
});

test('PIIStore: setAttribute overwrites existing values', function() {
	const store = new PIIStore();

	store.setAttribute('firstName', 'John');
	store.run(['firstName'], function(v) { expect(v).toBe('John'); });

	store.setAttribute('firstName', 'Jane');
	store.run(['firstName'], function(v) { expect(v).toBe('Jane'); });
	expect(store.getAttributeNames()).toEqual(['firstName']);
});

test('PIIStore: run with multiple attributes', function() {
	const store = createPopulatedStore();

	store.run(['firstName', 'lastName'], function(first, last) {
		expect(first).toBe('John');
		expect(last).toBe('Doe');
	});

	store.run(['email', 'phoneNumber', 'dateOfBirth'], function(email, phone, dob) {
		expect(email).toBe('john.doe@example.com');
		expect(phone).toBe('+1-555-123-4567');
		expect(dob).toEqual(new Date('1990-01-15'));
	});
});

test('PIIStore: toJSON returns redacted object', function() {
	const store = createPopulatedStore();
	expect(store.toJSON()).toEqual({ type: 'PIIStore', message: 'REDACTED' });
});

test('PIIStore: redaction prevents PII exposure', function() {
	const store = createPopulatedStore();
	for (const { name, expose, expected } of REDACTION_METHODS) {
		const result = expose(store);
		expect(result, `${name} should return redacted value`).toBe(expected);

		// Verify no PII values leaked
		for (const { value } of TEST_ATTRIBUTES) {
			if (typeof value === 'string') {
				expect(result, `${name} should not contain "${value}"`).not.toContain(value);
			}
		}
	}
});

test('PIIStore.fromCertificate: extracts attributes from certificate', async function() {
	const { certificateWithKey, subjectKey } = await createTestCertificate();

	const store = await PIIStore.fromCertificate(certificateWithKey, subjectKey);
	store.run(['fullName'], function(v) { expect(v).toBe(testAttributeValues.fullName); });
	store.run(['email'], function(v) { expect(v).toBe(testAttributeValues.email); });
	store.run(['phoneNumber'], function(v) { expect(v).toBe(testAttributeValues.phoneNumber); });
	store.run(['dateOfBirth'], function(v) { expect(v).toEqual(testAttributeValues.dateOfBirth); });
	store.run(['address'], function(v) { expect(v).toEqual(testAttributeValues.address); });
	store.run(['entityType'], function(v) { expect(v).toEqual(testAttributeValues.entityType); });

	// Verify redaction still works
	expect(store.toString()).toBe('[PII: REDACTED]');
});

test('PIIStore round-trip: toCertificateBuilder <-> fromCertificate', async function() {
	const issuerAccount = testAccounts.issuer;
	const subjectKey = testAccounts.subject;
	const subjectAccountNoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(
		subjectKey.publicKeyString.get()
	);

	// Create PIIStore with test attributes
	const originalStore = new PIIStore();
	for (const { name, value } of TEST_ATTRIBUTES) {
		originalStore.setAttribute(name, value);
	}

	// Build certificate using toCertificateBuilder
	const certificate = await originalStore
		.toCertificateBuilder(new Certificate.Builder({
			issuer: issuerAccount.assertAccount(),
			subject: subjectAccountNoPrivate.assertAccount(),
			validFrom: new Date(),
			validTo: new Date(Date.now() + 1000 * 60 * 60 * 24)
		}))
		.build({ serial: 1 });

	// Create a certificate with the private key
	const certificateWithKey = new Certificate(certificate, { subjectKey });
	const extractedStore = await PIIStore.fromCertificate(certificateWithKey, subjectKey);
	for (const { name, value } of TEST_ATTRIBUTES) {
		extractedStore.run([name], function(v) { expect(v).toEqual(value); });
	}
});
