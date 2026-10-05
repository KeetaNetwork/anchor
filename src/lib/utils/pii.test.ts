import { test, expect } from 'vitest';
import * as util from 'util';
import { PIIStore, PIIError } from './pii.js';
import type { PIIAttributeNames } from './pii.js';
import type { CertificateAttributeValue } from '../../services/kyc/iso20022.generated.js';
import { CertificateAttributeOIDDB, SENSITIVE_CERTIFICATE_ATTRIBUTES } from '../../services/kyc/iso20022.generated.js';
import { createTestCertificate, testAttributeValues, testAccounts } from './tests/certificates.js';
import { Certificate } from '../certificates.js';
import { EncryptedContainer } from '../encrypted-container.js';
import { ExternalReferenceBuilder } from './external.js';
import { Buffer } from './buffer.js';
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

test('toSensitiveAttribute rejects external attributes with PIIError', async function() {
	const store = createStore();
	const externalName = 'externalProvider.result';

	store.setAttribute(externalName, { provider: 'test' });

	// @ts-expect-error Testing runtime rejection of external attributes
	await expect(store.toSensitiveAttribute(externalName, testAccounts.subject))
		.rejects.toSatisfy(function(error: unknown) {
			return(PIIError.isInstance(error, 'PII_EXTERNAL_ATTRIBUTE'));
		});
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

	const certificate = await (await originalStore
		.toCertificateBuilder(createBuilder(), testAccounts.subject))
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

// ============================================================================
// Tests: Organization (KYB) Attributes
// ============================================================================

const ORGANIZATION_TEST_ATTRIBUTES = [
	attr('organizationName', 'Maple Creek Ventures LLC'),
	attr('tradeName', 'Maple Creek'),
	attr('legalForm', 'LLC'),
	attr('incorporation', {
		country: 'US',
		countrySubDivision: 'DE',
		incorporationDate: new Date('1990-01-01')
	}),
	attr('website', 'https://maplecreekventures.example'),
	attr('entityType', {
		organization: [{ id: '824531097', schemeName: 'TXID', issuer: 'US' }]
	}),
	attr('businessActivity', 'Selling online courses and related material'),
	attr('sourceOfFunds', { source: 'other', description: 'Grant from a foundation' }),
	attr('expectedAnnualVolume', 'from_1m_to_10m'),
	attr('countriesOfOperation', { countries: ['US', 'BR'] }),
	attr('address', {
		addressLines: ['1 Broadway', 'Floor 3'],
		townName: 'New York',
		postalCode: '10001',
		countrySubDivision: 'NY',
		country: 'US'
	}),
	attr('publiclyTraded', true),
	attr('operatesFromRegisteredAddress', false),
	attr('ubos', {
		owners: [
			{
				fullName: 'Ada Lovelace',
				dateOfBirth: new Date('1970-03-04'),
				countryOfBirth: 'GB',
				nationalities: ['GB', 'US'],
				address: { addressLines: ['742 Evergreen Terrace'], townName: 'Austin', postalCode: '78701', countrySubDivision: 'TX', country: 'US' },
				email: 'ada@maplecreek.example',
				phoneNumber: '+1 512 555 0142',
				percentageHeld: '60',
				ownershipType: 'direct',
				isSigner: true,
				position: 'Director',
				identifications: [{ id: '123-45-6789', schemeName: 'TXID', issuer: 'US' }]
			},
			{
				fullName: 'Alan Turing',
				dateOfBirth: new Date('1972-06-23'),
				countryOfBirth: 'GB',
				nationalities: ['GB'],
				address: { addressLines: ['1 Market Street'], townName: 'London', postalCode: 'SW1A 1AA', countrySubDivision: 'Greater London', country: 'GB' },
				email: 'alan@maplecreek.example',
				percentageHeld: '12.5',
				ownershipType: 'indirect',
				isSigner: false
			}
		]
	})
];

test('organization attributes round-trip through Certificate.Builder', async function() {
	const store = createStore();
	for (const { name, value } of ORGANIZATION_TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
	}

	const certificate = await (await store
		.toCertificateBuilder(createBuilder(), testAccounts.subject))
		.build({ serial: 1 });

	const certificateWithKey = new Certificate(certificate, { subjectKey: testAccounts.subject });

	for (const { name, value } of ORGANIZATION_TEST_ATTRIBUTES) {
		expect(certificateWithKey.attributes[name]?.sensitive, name).toBe(true);
		expect(await certificateWithKey.getAttributeValue(name), name).toEqual(value);
	}
});

test('organization attributes round-trip through toSensitiveAttribute', async function() {
	const store = createStore();
	for (const { name, value } of ORGANIZATION_TEST_ATTRIBUTES) {
		store.setAttribute(name, value);
		expect(await getValue(store, name), name).toEqual(value);
	}
});

test('organization attributes are registered as sensitive certificate attributes', function() {
	const expected = [
		['documentBusinessRegistration', '1.3.6.1.4.1.62675.1.11.7'],
		['documentRegisterOfDirectors', '1.3.6.1.4.1.62675.1.11.8'],
		['documentFinancialStatement', '1.3.6.1.4.1.62675.1.11.9'],
		['documentAdditional', '1.3.6.1.4.1.62675.1.11.10'],
		['businessActivity', '1.3.6.1.4.1.62675.1.16'],
		['sourceOfFunds', '1.3.6.1.4.1.62675.1.17'],
		['expectedAnnualVolume', '1.3.6.1.4.1.62675.1.18'],
		['countriesOfOperation', '1.3.6.1.4.1.62675.1.19'],
		['operatingAddress', '1.3.6.1.4.1.62675.1.20'],
		['publiclyTraded', '1.3.6.1.4.1.62675.1.21'],
		['operatesFromRegisteredAddress', '1.3.6.1.4.1.62675.1.22'],
		['ubos', '1.3.6.1.4.1.62675.1.23'],
		['ubo', '1.3.6.1.4.1.62675.1.23.1']
	] as const;

	for (const [name, oid] of expected) {
		expect(SENSITIVE_CERTIFICATE_ATTRIBUTES, name).toContain(name);
		expect(CertificateAttributeOIDDB[name], name).toBe(oid);
	}
});

async function documentReference(content: string, contentType: string) {
	const bytes = Buffer.from(content);
	const sealed = EncryptedContainer.fromPlaintext(bytes, [testAccounts.subject]);
	const sealedBytes = Buffer.from(await sealed.getEncodedBuffer());
	const builder = new ExternalReferenceBuilder(`data:application/octet-stream;base64,${sealedBytes.toString('base64')}`, contentType);

	return(builder.build(bytes));
}

test('organization documents carry every file of a category, each readable back', async function() {
	const extract = await documentReference('registration extract', 'application/pdf');
	const amendment = await documentReference('registration amendment', 'image/png');
	const passport = await documentReference('owner passport', 'image/jpeg');

	const store = createStore();
	store.setAttribute('documentBusinessRegistration', { documentNumber: '7654321', files: [extract, amendment] });
	store.setAttribute('documentFinancialStatement', { files: [extract] });
	store.setAttribute('ubos', {
		owners: [{
			fullName: 'Ada Lovelace',
			dateOfBirth: new Date('1970-03-04'),
			countryOfBirth: 'GB',
			nationalities: ['GB'],
			address: { addressLines: ['742 Evergreen Terrace'], country: 'US' },
			email: 'ada@maplecreek.example',
			percentageHeld: '100',
			ownershipType: 'direct',
			isSigner: true,
			position: 'Director',
			governmentIssuedID: [passport]
		}]
	});

	const certificate = await (await store
		.toCertificateBuilder(createBuilder(), testAccounts.subject))
		.build({ serial: 1 });
	const certificateWithKey = new Certificate(certificate, { subjectKey: testAccounts.subject });

	const registration = await certificateWithKey.getAttributeValue('documentBusinessRegistration');
	expect(registration.documentNumber).toBe('7654321');
	expect(registration.files.map(function(file) { return(file.external.contentType); })).toEqual(['application/pdf', 'image/png']);
	const amendmentBlob = await registration.files[1]?.$blob([testAccounts.subject]);
	expect(Buffer.from(await amendmentBlob?.arrayBuffer() ?? new ArrayBuffer(0)).toString()).toBe('registration amendment');

	const statement = await certificateWithKey.getAttributeValue('documentFinancialStatement');
	expect(statement.documentNumber).toBeUndefined();
	expect(statement.files).toHaveLength(1);

	const owners = await certificateWithKey.getAttributeValue('ubos');
	const passportBlob = await owners.owners[0]?.governmentIssuedID?.[0]?.$blob([testAccounts.subject]);
	expect(Buffer.from(await passportBlob?.arrayBuffer() ?? new ArrayBuffer(0)).toString()).toBe('owner passport');
});
