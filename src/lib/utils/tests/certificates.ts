import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as Certificates from '../../certificates.js';

type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/**
 * Shared test seed for deterministic account generation
 */
export const testSeed = 'D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D';

/**
 * Pre-generated test accounts from testSeed
 */
export const testAccounts: {
	issuer: KeetaNetAccount;
	subject: KeetaNetAccount;
	other: KeetaNetAccount;
} = {
	issuer: KeetaNetClient.lib.Account.fromSeed(testSeed, 0),
	subject: KeetaNetClient.lib.Account.fromSeed(testSeed, 1),
	other: KeetaNetClient.lib.Account.fromSeed(testSeed, 2)
};

/**
 * Test attribute values matching CertificateAttributeValueMap types
 */
export const testAttributeValues: {
	fullName: string;
	firstName: string;
	lastName: string;
	email: string;
	phoneNumber: string;
	dateOfBirth: Date;
	address: {
		addressLines: string[];
		streetName: string;
		townName: string;
		countrySubDivision: string;
		postalCode: string;
	};
	entityType: {
		person: { id: string; schemeName: 'SSN' }[];
	};
} = {
	fullName: 'Test User',
	firstName: 'Test',
	lastName: 'User',
	email: 'user@example.com',
	phoneNumber: '+1 555 911 3808',
	dateOfBirth: new Date('1980-01-01'),
	address: {
		addressLines: ['100 Belgrave Street'],
		streetName: '100 Belgrave Street',
		townName: 'Oldsmar',
		countrySubDivision: 'FL',
		postalCode: '34677'
	},
	entityType: {
		person: [{ id: '123-45-6789', schemeName: 'SSN' }]
	}
};

/**
 * Options for creating test certificates
 */
export type CreateTestCertificateOptions = {
	/** Attributes to include (defaults to all) */
	attributes?: (keyof typeof testAttributeValues)[];
	/** Whether to mark attributes as sensitive (default: true) */
	sensitive?: boolean;
};

/**
 * Create a test certificate with PII attributes
 *
 * @returns Object containing certificate, subject account, and CA
 */
export async function createTestCertificate(options: CreateTestCertificateOptions = {}): Promise<{
	certificate: Certificates.Certificate;
	certificateWithKey: Certificates.Certificate;
	subjectKey: typeof testAccounts.subject;
	issuerAccount: typeof testAccounts.issuer;
	ca: Certificates.Certificate;
}> {
	const { attributes, sensitive = true } = options;
	const issuerAccount = testAccounts.issuer;
	const subjectAccount = testAccounts.subject;
	const subjectAccountNoPrivate = KeetaNetClient.lib.Account.fromPublicKeyString(
		subjectAccount.publicKeyString.get()
	);

	const builder = new Certificates.Certificate.Builder({
		issuer: issuerAccount.assertAccount(),
		subject: subjectAccountNoPrivate.assertAccount(),
		validFrom: new Date(),
		validTo: new Date(Date.now() + 1000 * 60 * 60 * 24)
	});

	// Build CA certificate
	const ca = await builder.build({
		subject: issuerAccount.assertAccount(),
		serial: 1
	});

	// Add attributes
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const attributesToInclude = attributes ?? (Object.keys(testAttributeValues) as (keyof typeof testAttributeValues)[]);
	for (const name of attributesToInclude) {
		const value = testAttributeValues[name];
		if (value !== undefined) {
			builder.setAttribute(name, sensitive, value);
		}
	}

	// Build user certificate
	const certificate = await builder.build({ serial: 2 });
	return({
		certificate: new Certificates.Certificate(certificate, {
			store: { root: new Set([ca]) }
		}),
		certificateWithKey: new Certificates.Certificate(certificate, {
			subjectKey: subjectAccount,
			store: { root: new Set([ca]) }
		}),
		subjectKey: subjectAccount,
		issuerAccount,
		ca
	});
}

