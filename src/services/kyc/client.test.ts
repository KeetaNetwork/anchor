import { test, expect } from 'vitest';
import * as KeetaNetAnchor from '../../client/index.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import {
	Certificate as KYCCertificate,
	CertificateBuilder as KYCCertificateBuilder
} from '../../lib/certificates.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { KeetaNetKYCAnchorHTTPServer } from './server.js';
import type { KeetaKYCAnchorCreateVerificationRequest } from './common.ts';
import { Errors as KeetaAnchorKYCErrors } from './common.js';
import * as util from 'util';

const DEBUG = false;

test('KYC Anchor Client Test', async function() {
	/*
	 * Enable Debug logging if requested
	 */
	const loggerBase = DEBUG ? console : undefined;
	const logger = loggerBase ? { logger: loggerBase } : {};

	/*
	 * Create an account to  use for the node
	 */
	const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);

	/*
	 * Start a KeetaNet Node and get the UserClient for it
	 */
	const { userClient: client } = await createNodeAndClient(account);

	/*
	 * Create a dummy Root CA
	 */
	const rootCAAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const rootCABuilder = new KeetaNet.lib.Utils.Certificate.CertificateBuilder({
		subjectPublicKey: rootCAAccount,
		issuerDN: [{ name: 'commonName', value: 'Root CA' }],
		subjectDN: [{ name: 'commonName', value: 'Root CA' }],
		issuer: rootCAAccount,
		serial: 1,
		validFrom: new Date(Date.now() - 30_000),
		validTo: new Date(Date.now() + 120_000)
	});
	const rootCA = await rootCABuilder.build();

	const kycCAAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const kycCABuilder = new KeetaNet.lib.Utils.Certificate.CertificateBuilder({
		subjectPublicKey: kycCAAccount,
		issuerDN: [{ name: 'commonName', value: 'Root CA' }],
		subjectDN: [{ name: 'commonName', value: 'Intermediate/KYC CA' }],
		issuer: rootCAAccount,
		serial: 2,
		isCA: true,
		validFrom: new Date(Date.now() - 30_000),
		validTo: new Date(Date.now() + 120_000)
	});
	const kycCA = await kycCABuilder.build();

	/*
	 * Start a testing KYC Anchor HTTP Server
	 */
	const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const verifications = new Map<string, KeetaKYCAnchorCreateVerificationRequest>;
	const certificates = new Map<string, string>();
	// eslint-disable-next-line prefer-const
	let serverURL: string;
	await using server = new KeetaNetKYCAnchorHTTPServer({
		signer: signer,
		ca: kycCA,
		client: client,
		kyc: {
			countryCodes: ['US'],
			verificationStarted: async function(request) {
				const id = crypto.randomUUID();
				verifications.set(id, request);

				return({
					ok: true,
					id: id,
					expectedCost: {
						min: '0',
						max: '0',
						token: client.baseToken.publicKeyString.get()
					}
				});
			},
			getCertificates: async function(verificationID) {
				const request = verifications.get(verificationID);
				if (request === undefined) {
					throw(new KeetaAnchorKYCErrors.VerificationNotFound(`Verification ID ${verificationID} not found`));
				}

				let certificate = certificates.get(verificationID);
				if (certificate === undefined) {
					/*
					 * Issue a new certificate for this verification
					 */
					const userAccount = KeetaNet.lib.Account.fromPublicKeyString(request.account).assertAccount();
					const certificateBuilder = new KYCCertificateBuilder({
						subject: userAccount,
						subjectDN: [{ name: 'commonName', value: 'KYC Verified User' }],
						issuerDN: kycCA.subjectDN,
						issuer: kycCAAccount,
						serial: 3,
						validFrom: new Date(Date.now() - 30_000),
						validTo: new Date(Date.now() + 120_000)
					});
					certificateBuilder.setAttribute('fullName', true, 'John Doe');
					const builtCertificate = await certificateBuilder.build();
					certificate = builtCertificate.toPEM();
					certificates.set(verificationID, certificate);
				}

				return([{
					certificate: certificate,
					intermediates: [kycCA.toPEM()]
				}]);
			}
		},
		kycProviderURL: function(verificationID: string) {
			return(new URL(`/provider/${verificationID}`, serverURL).toString());
		},
		...logger
	});

	await server.start();
	serverURL = server.url;

	const results = await client.setInfo({
		description: 'KYC Anchor Test Root',
		name: 'TEST',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			services: {
				kyc: {
					Bad: {
						countryCodes: ['XX'],
						ca: 'FOO',
						operations: {
							createVerification: 'https://example.com/createVerification.json',
							getCertificates: 'https://example.com/getCertificates/{id}.json'
						}
					},
					Test: await server.serviceMetadata()
				}
			}
		})
	});
	loggerBase?.log('Set info results:', results);

	const kycClient = new KeetaNetAnchor.KYC.Client(client, {
		root: account,
		...loggerBase
	});

	/*
	 * Test getSupportedCountries method
	 */
	const supportedCountries = await kycClient.getSupportedCountries();
	loggerBase?.log('Supported Countries:', supportedCountries.map(c => c.code));
	expect(supportedCountries).toBeDefined();
	expect(Array.isArray(supportedCountries)).toBe(true);
	expect(supportedCountries.length).toBeGreaterThan(0);
	// The test service is configured with 'US' country code
	const usCountry = supportedCountries.find(c => c.code === 'US');
	expect(usCountry).toBeDefined();
	expect(usCountry?.code).toBe('US');
	// Test negative case: verify a country that shouldn't exist doesn't
	const invalidCountry = supportedCountries.find(c => c.code === 'XX');
	expect(invalidCountry).toBeUndefined();

	const providers = await kycClient.createVerification({
		countryCodes: ['US'],
		account: account
	});

	if (providers.length === 0) {
		throw(new Error('No providers returned'));
	}

	/**
	 * Print out information about the providers
	 */
	loggerBase?.log('Providers:');
	for (const provider of providers) {
		const providerCA = await provider.ca();
		const providerName = providerCA.subject;
		expect(providerName).toBe('commonName=Intermediate/KYC CA');

		loggerBase?.log('  Provider:');
		loggerBase?.log('    ID:', provider.id);
		loggerBase?.log('    Name:', providerName);
	}
	expect(providers.length).toBeGreaterThan(0);

	/*
	 * Pick a random provider
	 */
	const provider = providers[0];
	if (provider === undefined) {
		throw(new Error('internal error: no providers available'));
	}

	const providerCountryCodes = await provider.countryCodes();
	expect(providerCountryCodes).toBeDefined();
	expect(providerCountryCodes?.[0]?.code).toBe('US');

	const verification = await provider.startVerification();
	loggerBase?.log('Request ID:', verification.id, 'on provider', verification.providerID);

	/* Direct the user to the WebURL */
	loggerBase?.log('Web URL:', verification.webURL);

	/**
	 * Poll for the verification status
	 */
	const rootCAObject = new KeetaNet.lib.Utils.Certificate.Certificate(rootCA, {
		isTrustedRoot: true
	});

	const checkIssuerCert = await verification.getProviderIssuerCertificate();
	expect(checkIssuerCert.subject).toEqual('commonName=Intermediate/KYC CA');

	while (true) {
		const results = await verification.getCertificates();
		if (!results.ok) {
			await KeetaNet.lib.Utils.Helper.asleep(results.retryAfter);
			continue;
		}

		loggerBase?.log('Certificates:');
		const output = (await Promise.all(results.results.map(async function(certificateGroup) {
			let intermediates = certificateGroup.intermediates;
			if (intermediates === undefined) {
				intermediates = new Set();
			}
			const trustedCertificate = new KYCCertificate(certificateGroup.certificate.toPEM(), {
				store: {
					root: new Set([rootCAObject]),
					intermediate: intermediates
				},
				/* If you remove this, you will not be able to retrieve the sensitive attributes */
				subjectKey: account
			});

			let fullName: string;
			if ('fullName' in trustedCertificate.attributes) {
				if (trustedCertificate.attributes['fullName'].sensitive) {
					try {
						const result = await trustedCertificate.attributes['fullName'].value.getValue();
						fullName = 'SENSITIVE: ' + result;
					} catch {
						fullName = 'SENSITIVE (unable to retrieve)';
					}
				} else {
					// XXX:TODO Fix depth issue
					// @ts-ignore
					fullName = await trustedCertificate.getAttributeValue('fullName');
				}
			} else {
				fullName = 'Not provided';
			}

			return(util.inspect({
				certificate: trustedCertificate.toPEM(),
				certificateValue: trustedCertificate,
				intermediates: [...certificateGroup.intermediates?.values() ?? []].map(function(intermediate) {
					return(intermediate.toPEM());
				}),
				chain: trustedCertificate.chain,
				attributes: trustedCertificate.attributes,
				fullName: fullName,
				valid: trustedCertificate.checkValid()
			}, { depth: null, colors: true }));
		}))).join('\n\n');

		loggerBase?.log(output);
		break;
	}
}, 30000);
