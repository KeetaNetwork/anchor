import KeetaNet from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';

import * as KeetaAnchorHTTPServer from '../../lib/http-server.js';
import type * as Certificate from '../../lib/certificates.js';
import { createAssert } from 'typia';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type {
	KeetaKYCAnchorCreateVerificationRequest,
	KeetaKYCAnchorCreateVerificationResponse,
	KeetaKYCAnchorGetCertificateResponse
} from './common.ts';
import type * as Signing from '../../lib/utils/signing.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';

export interface KeetaAnchorKYCServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The network client to use for submitting blocks
	 */
	client: { client: KeetaNet.Client; network: bigint; networkAlias: typeof KeetaNet.Client.Config.networksArray[number] } | KeetaNet.UserClient;

	/**
	 * Configuration for the KYC Anchor
	 *
	 * The flow for a KYC Anchor is as follows:
	 *      1. Client requests a new verification with a country code and
	 *           account from the KYC Anchor Server
	 *      2. KYC Anchor Server responds with a verification ID and a URL
	 *           to the KYC provider's web URL, including the verification ID
	 *      3. Client visits the KYC provider's web URL to complete the
	 *           verification
	 *      4. KYC provider notifies the Anchor server that the
	 *           verification is complete
	 *      5. Client requests the certificate for the verification ID
	 *           (polling) from the KYC Anchor Server
	 *      6. KYC Anchor Server responds with the certificate(s) for the
	 *           verification ID (if complete, pending if still in progress,
	 *           an error if failed)
	 *      7. Client installs the certificate(s) in their wallet using
	 *           the KeetaNet Client library
	 *
	 *
	 *   +-------------------+            +---------------------+             +------------------+
	 *   |       Client      |            |   KYC Anchor Server |             |   KYC Provider   |
	 *   +-------------------+            +---------------------+             +------------------+
	 *         |                                   |                                  |
	 * (1) Create Verification                     |                                  |
	 * countryCode, account ---------------------->|                                  |
	 *         |                                   |                                  |
	 *         |                           (2) Create verification                    |
	 *         |----------------------------------- verificationID, providerURL       |
	 *         |                                   |                                  |
	 * (3) Open providerURL (with verificationID)------------------------------------>|
	 *         |                                   |                                  |
	 *         |                                   |                           (4)  Notify
	 *         |                                   |<-------- verificationID, verificationStatus, certificates?
	 *         |                                   |
	 * (5) Poll certificate for verificationID --->|
	 *         |                                   |
	 *         |<-------------------------- (6) Pending / Certificate(s) / Error
	 *         |                    (repeat #5 until complete)
	 *         |
	 * (7) Install certificate(s) in wallet using KeetaNet Client library
	 */
	kyc: {
		/**
		 * Notification that a verification has been started (optional)
		 *
		 * This method can be used to notify the KYC provider that
		 * a verification has been started.  It can return additional
		 * information about the verification, such as the web URL
		 * where the user can complete the verification.
		 *
		 * If this method is not provided, the server will generate
		 * a random verification ID and use the `kycProviderURL` from
		 * the server configuration, replacing `{id}` with the
		 * verification ID.
		 */
		verificationStarted?: (request: KeetaKYCAnchorCreateVerificationRequest) => Promise<Partial<KeetaKYCAnchorCreateVerificationResponse> | undefined>;

		/**
		 * Retrieve the certificate for a verification
		 *
		 * This should return the certificate(s) for the
		 * verification ID.  If the verification is still
		 * in progress, it should throw an `CertificateNotFound`
		 * error.
		 * If the verification has failed permanently, it should
		 * throw a `KeetaAnchorUserError` with an appropriate
		 * error message or `VerificationNotFound` if the
		 * verification ID is not found.
		 */
		getCertificates: (verificationID: string) => Promise<Extract<KeetaKYCAnchorGetCertificateResponse, { ok: true; }>['results']>;

		/**
		 * Country codes that this KYC provider can service (default is all country codes)
		 */
		countryCodes?: (CurrencyInfo.Country | CurrencyInfo.ISOCountryCode)[];
	}

	/**
	 * The certificate to use for signing certificates
	 */
	ca: Certificate.Certificate;

	/**
	 * The account to use for signing certificates
	 */
	signer: Signing.SignableAccount;

	/**
	 * URL for the KYC Provider (optional)
	 *
	 * This is the URL that clients will be directed to in order to
	 * complete the KYC verification process.  It is optional because
	 * the `kyc.verificationStarted` method can also return a `webURL`.
	 * If both are provided, the URL from `kyc.verificationStarted` takes
	 * precedence.
	 */
	kycProviderURL?: string;
};

export class KeetaNetKYCAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorKYCServerConfig> implements Required<KeetaAnchorKYCServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorKYCServerConfig['homepage']>;
	readonly client: KeetaAnchorKYCServerConfig['client'];
	readonly signer: NonNullable<KeetaAnchorKYCServerConfig['signer']>;
	readonly ca: KeetaAnchorKYCServerConfig['ca'];
	readonly kyc: KeetaAnchorKYCServerConfig['kyc'];
	readonly kycProviderURL: NonNullable<KeetaAnchorKYCServerConfig['kycProviderURL']>;
	readonly #countryCodes?: CurrencyInfo.Country[] | undefined;

	constructor(config: KeetaAnchorKYCServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.client = config.client;
		this.signer = config.signer;
		this.ca = config.ca;
		this.kyc = config.kyc;
		this.kycProviderURL = config.kycProviderURL ?? new URL('/provider/{id}', this.url).toString();

		if (config.kyc.countryCodes) {
			this.#countryCodes = config.kyc.countryCodes.map(function(inputCode) {
				if (CurrencyInfo.Country.isCountryCode(inputCode)) {
					return(new CurrencyInfo.Country(inputCode));
				}

				return(inputCode);
			});
		}
	}

	protected async initRoutes(config: KeetaAnchorKYCServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = {};

		/**
		 * If a homepage is provided, setup the route for it
		 */
		if ('homepage' in config) {
			routes['GET /'] = async function() {
				let homepageData: string;
				if (typeof config.homepage === 'string') {
					homepageData = config.homepage;
				} else {
					if (!config.homepage) {
						throw(new Error('internal error: No homepage function provided'));
					}

					homepageData = await config.homepage();
				}

				return({
					output: homepageData,
					contentType: 'text/html'
				});
			};
		}

		/**
		 * Begin the KYC verification process
		 * with this KYC provider
		 */
		routes['POST /api/createVerification'] = async function(_ignore_params, bodyInput) {
			const body = assertCreateVerificationRequest(bodyInput);
			let response: Partial<KeetaKYCAnchorCreateVerificationResponse> | undefined = {};
			if (config.kyc.verificationStarted) {
				response = await config.kyc.verificationStarted(body);
			}

			if (response === undefined) {
				response = {};
			}

			if (response?.ok === false) {
				throw(new KeetaAnchorUserError(response.error ?? 'Unknown error'));
			}

			response.ok = true;
			if (!response.ok) {
				throw(new Error('internal error: invalid response'));
			}
			response.id ??= crypto.randomUUID();
			response.webURL ??= (config.kycProviderURL ?? '').replace('{id}', encodeURIComponent(response.id));

			if (!response.webURL) {
				throw(new KeetaAnchorUserError('No webURL provided -- cannot proceed with verification'));
			}

			response.expectedCost = {
				min: '0',
				max: '0',
				token: KeetaNet.lib.Account.generateBaseAddresses(config.client.network).baseToken.publicKeyString.get(),
				...response.expectedCost
			};

			const responseValidated = assertCreateVerificationResponse(response);

			return({
				output: JSON.stringify(responseValidated)
			});
		};

		/**
		 * Request an estimate for a KYC
		 * verification (optional)
		 */
		if (false) {
			routes['POST /api/createEstimate'] = async function(params, body) {
				throw(new Error('not implemented'));
			};
		}

		/**
		 * Get the certificate for the
		 * KYC verification
		 */
		routes['GET /api/getCertificates/:verificationID'] = async function(params) {
			const verificationID = params.get('verificationID');
			if (verificationID === undefined) {
				throw(new KeetaAnchorUserError('No verification ID provided'));
			}

			const certificates = await config.kyc.getCertificates(verificationID);

			const response: KeetaKYCAnchorGetCertificateResponse = {
				ok: true,
				results: certificates
			};

			return({
				output: JSON.stringify(response)
			});
		};

		/**
		 * Check if the KYC provider can
		 * service a more specific locality
		 * (optional)
		 */
		if (false) {
			routes['GET /api/checkLocality'] = async function(params, body) {
				throw(new Error('not implemented'));
			};
		}

		/**
		 * Notification that payment has been received for the KYC verification
		 * XXX:TODO
		 */
		if (false) {
			routes['POST /api/notifyPayment/:verificationID'] = async function(params, body) {
				throw(new Error('not implemented'));
			};
		}

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['kyc']>[string]> {
		return({
			ca: this.ca.toPEM(),
			countryCodes: this.#countryCodes?.map(function(country) {
				return(country.code);
			}) ?? [],
			operations: {
				// checkLocality: (new URL('/api/checkLocality', this.url)).toString(),
				// getEstimate: (new URL('/api/createEstimate', this.url)).toString(),
				// notifyPayment: (new URL('/api/notifyPayment/{id}', this.url)).toString(),
				createVerification: (new URL('/api/createVerification', this.url)).toString(),
				getCertificates: (new URL('/api/getCertificates/{id}', this.url)).toString()
			}
		});
	}
}

const assertCreateVerificationRequest = createAssert<KeetaKYCAnchorCreateVerificationRequest>();
const assertCreateVerificationResponse = createAssert<KeetaKYCAnchorCreateVerificationResponse>();
