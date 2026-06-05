import { test, expect } from 'vitest';
import { KeetaNetKYBAnchorHTTPServer } from './server.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import Resolver from '../../lib/resolver.js';

test('KYB Anchor HTTP Server', async function() {
	const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient }  = await createNodeAndClient(signer);

	/*
	 * Create a dummy CA for issuing KYB Certificates
	 */
	const kybCAAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const kybCABuilder = new KeetaNet.lib.Utils.Certificate.CertificateBuilder({
		subjectPublicKey: kybCAAccount,
		issuer: kybCAAccount,
		serial: 1,
		validFrom: new Date(Date.now() - 30_000),
		validTo: new Date(Date.now() + 120_000)
	});
	const kybCA = await kybCABuilder.build();

	/*
	 * Start the Testing KYB Anchor HTTP Server
	 */
	await using server = new KeetaNetKYBAnchorHTTPServer({
		signer: signer,
		ca: kybCA,
		client: userClient,
		homepage: '<html><body>Hello World</body></html>',
		kyb: {
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
	 * Add the Testing KYB Anchor Service to the user's metadata and create a resolver
	 */
	await userClient.setInfo({
		name: 'USER',
		description: 'KYB Anchor Test Root',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				kyb: {
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
	 * Look up the metadata for the KYB Anchor Service using the resolver, ensuring the
	 * `serviceMetadata()` method generated valid metadata
	 */
	const foundValidMetadata = await resolver.lookup('kyb', {
		countryCodes: ['US']
	});

	expect(foundValidMetadata).toBeDefined();
	if (foundValidMetadata === undefined) {
		throw(new Error('internal error: foundValidMetadata is undefined'));
	}

	expect(foundValidMetadata.Test).toBeDefined();
	if (!('Test' in foundValidMetadata)) {
		throw(new Error('internal error: KYB service "Test" not found in metadata'));
	}

	const checkKYBCertificate = await foundValidMetadata.Test.ca('string');
	expect(checkKYBCertificate).toEqual(kybCA.toPEM());

	/*
	 * Verify the home page
	 */
	const homeResponse = await fetch(server.url);
	expect(homeResponse.status).toBe(200);
	const homeText = await homeResponse.text();
	expect(homeText).toBe('<html><body>Hello World</body></html>');
});
