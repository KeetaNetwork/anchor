import { test, expect } from 'vitest';
import * as KeetaNetAnchor from '../../client/index.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { Certificate as KYCCertificate } from '../../lib/certificates.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as util from 'util';

const DEBUG = false;

/*
 * XXX: This test is currently not isolated, it relies on an
 *      external dummy service to be running, but it should
 *      start its own KYC Anchor Provider when that is implemented
 *      in the future.
 */

/* XXX: This is the Test Network CA -- should be replaced with a dummy CA */
const rootCA = `-----BEGIN CERTIFICATE-----
MIIBiDCCAS2gAwIBAgIGAZhi7awAMAsGCWCGSAFlAwQDCjApMScwJQYDVQQDEx5L
ZWV0YSBUZXN0IE5ldHdvcmsgS1lDIFJvb3QgQ0EwHhcNMjUwODAxMDAwMDAwWhcN
MjgwODAxMDAwMDAwWjApMScwJQYDVQQDEx5LZWV0YSBUZXN0IE5ldHdvcmsgS1lD
IFJvb3QgQ0EwNjAQBgcqhkjOPQIBBgUrgQQACgMiAAKK1O9NiYvu2sBYNRPfjOpp
sNSMZ1lOVn+psFdk3Ugq2qNjMGEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8E
BAMCAMYwHwYDVR0jBBgwFoAUap82oKFjJ2jhIj2CGABULiX4h3owHQYDVR0OBBYE
FGqfNqChYydo4SI9ghgAVC4l+Id6MAsGCWCGSAFlAwQDCgNIADBFAiEAqnl85S6v
bw8HLO+YXhnwqq6GmnY+7tCcnwYtoyDzYTMCIEw7ALqHJp0kO9AExm5sSoC7rPOd
GlX42GsZQW3AJ7Jc
-----END CERTIFICATE-----`;

test('KYC Anchor Client Test', async function() {
	const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);

	const logger = DEBUG ? console : undefined;

	/* XXX: This should spin up a new Keeta Network */
	const client = KeetaNet.UserClient.fromNetwork('test', account);

	/* XXX: This is disabled because it is already set on the Test network,
	 *      but it should be re-enabled when a new Keeta Network is created
	 *      for testing purposes.
	 */
	// eslint-disable-next-line no-constant-condition
	if (false) {
		const results = await client.setInfo({
			description: 'KYC Anchor Test Root',
			name: 'TEST',
			metadata: KeetaAnchorResolver.Metadata.formatMetadata({
				version: 1,
				services: {
					kyc: {
						Test: {
							countryCodes: ['US'],
							/* XXX: This is the Test
							 * Network Demo KYC CA --
							 * should be replaced with
							 * a dummy intermediate CA
							 */
							ca: `-----BEGIN CERTIFICATE-----
MIIBhzCCASygAwIBAgIBATALBglghkgBZQMEAwowKTEnMCUGA1UEAxMeS2VldGEg
VGVzdCBOZXR3b3JrIEtZQyBSb290IENBMB4XDTI1MDgwMTAwMDAwMFoXDTI4MDgw
MTAwMDAwMFowLTErMCkGA1UEAxMiS2VldGEgVGVzdCBOZXR3b3JrIEtZQyBEZW1v
IEFuY2hvcjA2MBAGByqGSM49AgEGBSuBBAAKAyIAAlqTHniWXaayjYCkVJBOvHJi
dO4wF7t1f7NB65JQ85GRo2MwYTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQE
AwIAxjAfBgNVHSMEGDAWgBRqnzagoWMnaOEiPYIYAFQuJfiHejAdBgNVHQ4EFgQU
IacME4jKWvFC6nSvr2SuObBeAb8wCwYJYIZIAWUDBAMKA0gAMEUCIQDxnt6atJWz
D/llQ9YwyNVOWwLrqYNeXqnMVw/e4SV+9QIgZ+jy5nATxipnlyv0UH4W9uUfDBYl
0w2KBv059QeckO0=
-----END CERTIFICATE-----`,
							/*
							 *  XXX: These are external
							 * services, should be
							 * replaced with URLs
							 * for a KYC Anchor
							 * Provider that is
							 * created for testing
							 */
							operations: {
								createVerification: 'https://rkeene.org/KEETA/createVerification.json',
								getCertificates: 'https://rkeene.org/KEETA/getCertificates/{id}.json'
							}
						}
					}
				}
			})
		});
		logger?.log('Set info results:', results);
	}

	const kycClient = new KeetaNetAnchor.KYC.Client(client, {
		root: account,
		...(logger ? { logger: logger } : {})
	});

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
	logger?.log('Providers:');
	for (const provider of providers) {
		logger?.log('  Provider:');
		logger?.log('    ID:', provider.id);
		logger?.log('    Name:', (await provider.ca()).subject);
	}
	expect(providers.length).toBeGreaterThan(0);

	/*
	 * Pick a random provider
	 */
	const provider = providers[0];
	if (provider === undefined) {
		throw(new Error('internal error: no providers available'));
	}

	const verification = await provider.startVerification();
	logger?.log('Request ID:', verification.id, 'on provider', verification.providerID);

	/* Direct the user to the WebURL */
	logger?.log('Web URL:', verification.webURL);

	/**
	 * Poll for the verification status
	 */
	const rootCAObject = new KeetaNet.lib.Utils.Certificate.Certificate(rootCA, {
		isTrustedRoot: true
	});

	const checkIssuerCert = await verification.getProviderIssuerCertificate();
	expect(checkIssuerCert.subject).toEqual('commonName=Keeta Test Network KYC Demo Anchor');

	while (true) {
		const results = await verification.getCertificates();
		if (!results.ok) {
			await KeetaNet.lib.Utils.Helper.asleep(results.retryAfter);
			continue;
		}

		logger?.log('Certificates:');
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
						fullName = 'SENSITIVE: ' + await trustedCertificate.attributes['fullName'].value.getString();
					} catch {
						fullName = 'SENSITIVE (unable to retrieve)';
					}
				} else {
					fullName = Buffer.from(trustedCertificate.attributes['fullName'].value).toString('utf-8');
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

		logger?.log(output);
		break;
	}
}, 30000);
