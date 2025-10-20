import { test, expect } from 'vitest';
import { KeetaNetKYCAnchorHTTPServer } from './server.js';
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
