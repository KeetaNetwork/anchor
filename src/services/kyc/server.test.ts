import { test, expect } from 'vitest';
import { KeetaNetKYCAnchorHTTPServer } from './server.js';
import { Errors } from './common.js';
import { KYCVerificationStatus } from './status.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import Resolver from '../../lib/resolver.js';

test('KYC Anchor HTTP Server', async function() {
	const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient }  = await createNodeAndClient(signer);

	/*
	 * Create a dummy CA for issuing KYC Certificates
	 */
	const kycCAAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const kycCABuilder = new KeetaNet.lib.Utils.Certificate.CertificateBuilder({
		subjectPublicKey: kycCAAccount,
		issuer: kycCAAccount,
		serial: 1,
		validFrom: new Date(Date.now() - 30_000),
		validTo: new Date(Date.now() + 120_000)
	});
	const kycCA = await kycCABuilder.build();

	const ownerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), KeetaNet.lib.Account.AccountKeyAlgorithm.ECDSA_SECP256K1).assertAccount();
	const knownVerificationID = 'verification-id-known';

	/*
	 * Start the Testing KYC Anchor HTTP Server
	 */
	await using server = new KeetaNetKYCAnchorHTTPServer({
		signer: signer,
		ca: kycCA,
		client: userClient,
		homepage: '<html><body>Hello World</body></html>',
		kyc: {
			countryCodes: ['US'],
			verificationStarted: async function(_ignore_request) {
				return({
					ok: true,
					expectedCost: {
						min: '0',
						max: '0',
						token: userClient.baseToken.publicKeyString.get()
					}
				});
			},
			getCertificates: async function(_ignore_verificationID) {
				return([{
					certificate: ''
				}]);
			},
			getVerificationStatus: async function(verificationID, requester) {
				if (verificationID !== knownVerificationID) {
					throw(new Errors.VerificationNotFound());
				}
				if (requester.account.publicKeyString.get() !== ownerAccount.publicKeyString.get()) {
					throw(new Errors.VerificationNotFound());
				}

				return({
					status: KYCVerificationStatus.PASSED,
					requiresManualVerification: true
				});
			}
		}
	});

	await server.start();
	expect(server.url).toBeDefined();

	/*
	 * Add the Testing KYC Anchor Service to the user's metadata and create a resolver
	 */
	await userClient.setInfo({
		name: 'USER',
		description: 'KYC Anchor Test Root',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				kyc: {
					Test: await server.serviceMetadata()
				}
			}
		})
	});

	const resolver = new Resolver({
		client: userClient,
		root: userClient.account,
		trustedCAs: []
	});

	/*
	 * Look up the metadata for the KYC Anchor Service using the resolver, ensuring the
	 * `serviceMetadata()` method generated valid metadata
	 */
	const foundValidMetadata = await resolver.lookup('kyc', {
		countryCodes: ['US']
	});

	expect(foundValidMetadata).toBeDefined();
	if (foundValidMetadata === undefined) {
		throw(new Error('internal error: foundValidMetadata is undefined'));
	}

	expect(foundValidMetadata.Test).toBeDefined();
	if (!('Test' in foundValidMetadata)) {
		throw(new Error('internal error: KYC service "Test" not found in metadata'));
	}

	const checkKYCCA = await foundValidMetadata.Test.ca('string');
	expect(checkKYCCA).toEqual(kycCA.toPEM());

	/*
	 * Verify the home page
	 */
	const homeResponse = await fetch(server.url);
	expect(homeResponse.status).toBe(200);
	const homeText = await homeResponse.text();
	expect(homeText).toBe('<html><body>Hello World</body></html>');
});

test('KYC Anchor HTTP Server - business (KYB) entity type', async function() {
	const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient } = await createNodeAndClient(signer);

	const kycCAAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const kycCABuilder = new KeetaNet.lib.Utils.Certificate.CertificateBuilder({
		subjectPublicKey: kycCAAccount,
		issuer: kycCAAccount,
		serial: 1,
		validFrom: new Date(Date.now() - 30_000),
		validTo: new Date(Date.now() + 120_000)
	});
	const kycCA = await kycCABuilder.build();

	/*
	 * A provider that supports BOTH individual and business verification.
	 * Both are redirect flows to a provider-hosted experience; the entity
	 * type selects which hosted experience the provider presents. The
	 * provider owns detail collection, so the request carries no
	 * entity-specific details.
	 */
	await using server = new KeetaNetKYCAnchorHTTPServer({
		signer: signer,
		ca: kycCA,
		client: userClient,
		kycProviderURL: 'https://example.com/journey/{id}',
		kyc: {
			countryCodes: ['US'],
			entityTypes: ['individual', 'business'],
			verificationStarted: async function(request) {
				/*
				 * The request advertises the entity type; the provider
				 * would present the matching hosted form. Both return a
				 * webURL (filled in by the server from kycProviderURL).
				 */
				expect(request.entityType === undefined || request.entityType === 'individual' || request.entityType === 'business').toBe(true);
				return({
					ok: true,
					expectedCost: {
						min: '0',
						max: '0',
						token: userClient.baseToken.publicKeyString.get()
					}
				});
			},
			getCertificates: async function(_ignore_verificationID) {
				return([{ certificate: '' }]);
			},
			getVerificationStatus: async function() {
				return({ status: KYCVerificationStatus.PASSED });
			}
		}
	});

	await server.start();
	expect(server.url).toBeDefined();

	await userClient.setInfo({
		name: 'USER',
		description: 'KYC Anchor Test Root (business)',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				kyc: {
					Test: await server.serviceMetadata()
				}
			}
		})
	});

	const resolver = new Resolver({
		client: userClient,
		root: userClient.account,
		trustedCAs: []
	});

	/*
	 * The published metadata advertises both entity types.
	 */
	const businessMatch = await resolver.lookup('kyc', {
		countryCodes: ['US'],
		entityType: 'business'
	});
	expect(businessMatch).toBeDefined();
	if (businessMatch === undefined || !('Test' in businessMatch)) {
		throw(new Error('internal error: business-capable KYC service not found'));
	}
	const declaredEntityTypes = await businessMatch.Test.entityTypes?.('object');
	expect(declaredEntityTypes).toBeDefined();
	expect(declaredEntityTypes !== undefined && 'business' in declaredEntityTypes).toBe(true);

	const individualMatch = await resolver.lookup('kyc', {
		countryCodes: ['US'],
		entityType: 'individual'
	});
	expect(individualMatch).toBeDefined();
	expect(individualMatch !== undefined && 'Test' in individualMatch).toBe(true);
});

