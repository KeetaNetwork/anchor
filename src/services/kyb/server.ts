import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';

import type * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import type { KeetaAnchorMetadataServerConfig } from '../../lib/anchor-metadata-server.js';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type {
	KeetaKYBAnchorCreateVerificationRequest,
	KeetaKYBAnchorCreateVerificationResponse,
	KeetaKYBAnchorGetCertificateResponse
} from './common.ts';
import {
	assertCreateVerificationRequest,
	assertCreateVerificationResponse
} from './common.generated.js';
import {
	verifySignedData
} from './common.js';
import type * as Signing from '../../lib/utils/signing.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import { KeetaAnchorMetadataServer } from '../../lib/anchor-metadata-server.js';

/**
 * The Base certificate type, from the KeetaNet Client
 *
 * The KYB Certificate type is a subclass of this, so it will also work
 */
type BaseCertificate = InstanceType<typeof KeetaNet.lib.Utils.Certificate.Certificate>;

export interface KeetaAnchorKYBServerConfig extends KeetaAnchorMetadataServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The network client to use for submitting blocks
	 */
	client: { client: KeetaNet.Client; network: bigint; networkAlias: typeof KeetaNet.Client.Config.networksArray[number] } | KeetaNet.UserClient;

	/**
	 * Configuration for the KYB Anchor
	 *
	 * The flow for a KYB Anchor is as follows:
	 *      1. Client requests a new verification with a country code,
	 *           account, and business details from the KYB Anchor Server
	 *      2. KYB Anchor Server performs the business verification
	 *           synchronously and responds with a verification ID
	 *      3. Client requests the certificate for the verification ID
	 *           (polling) from the KYB Anchor Server
	 *      4. KYB Anchor Server responds with the certificate(s) for the
	 *           verification ID (if complete, pending if still in
	 *           progress, an error if failed)
	 *      5. Client installs the certificate(s) in their wallet using
	 *           the KeetaNet Client library
	 *
	 * Unlike the KYC flow, there is no hosted journey / web URL: a KYB
	 * verification is completed from the supplied business details, so
	 * the user is never redirected.
	 *
	 *
	 *   +-------------------+            +---------------------+             +------------------+
	 *   |       Client      |            |   KYB Anchor Server |             |   KYB Provider   |
	 *   +-------------------+            +---------------------+             +------------------+
	 *         |                                   |                                  |
	 * (1) Create Verification                     |                                  |
	 * countryCode, account, business ------------>|                                  |
	 *         |                           (2) Verify business synchronously -------->|
	 *         |                                   |<-------------------------- result |
	 *         |<------------------------- verificationID                             |
	 *         |                                   |
	 * (3) Poll certificate for verificationID --->|
	 *         |                                   |
	 *         |<-------------------------- (4) Pending / Certificate(s) / Error
	 *         |                    (repeat #3 until complete)
	 *         |
	 * (5) Install certificate(s) in wallet using KeetaNet Client library
	 */
	kyb: {
		/**
		 * Notification that a verification has been started (optional)
		 *
		 * This method performs the business verification.  Because KYB
		 * is synchronous, the provider typically completes the
		 * verification here and stores the result keyed by the returned
		 * verification ID, which the client then polls with
		 * `getCertificates`.
		 *
		 * If this method is not provided, the server will generate a
		 * random verification ID and the provider is expected to resolve
		 * the verification out of band before `getCertificates` is
		 * called.
		 */
		verificationStarted?: (request: KeetaKYBAnchorCreateVerificationRequest) => Promise<Partial<KeetaKYBAnchorCreateVerificationResponse> | undefined>;

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
		getCertificates: (verificationID: string) => Promise<Extract<KeetaKYBAnchorGetCertificateResponse, { ok: true; }>['results']>;

		/**
		 * Country codes that this KYB provider can service (default is all country codes)
		 */
		countryCodes?: (CurrencyInfo.Country | CurrencyInfo.ISOCountryCode)[];
	}

	/**
	 * The certificate to use for signing certificates
	 */
	ca: BaseCertificate;

	/**
	 * The account to use for signing certificates
	 */
	signer: Signing.SignableAccount;

	/**
	 * Additional routes to add to the server (optional)
	 */
	routes?: KeetaAnchorHTTPServer.Routes;
};

export class KeetaNetKYBAnchorHTTPServer extends KeetaAnchorMetadataServer<NonNullable<ServiceMetadata['services']['kyb']>[string], KeetaAnchorKYBServerConfig> implements Required<KeetaAnchorKYBServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorKYBServerConfig['homepage']>;
	readonly client: KeetaAnchorKYBServerConfig['client'];
	readonly signer: NonNullable<KeetaAnchorKYBServerConfig['signer']>;
	readonly ca: KeetaAnchorKYBServerConfig['ca'];
	readonly kyb: KeetaAnchorKYBServerConfig['kyb'];
	readonly routes: NonNullable<KeetaAnchorKYBServerConfig['routes']>;
	readonly #countryCodes?: CurrencyInfo.Country[] | undefined;

	constructor(config: KeetaAnchorKYBServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.client = config.client;
		this.signer = config.signer;
		this.ca = config.ca;
		this.kyb = config.kyb;
		this.routes = config.routes ?? {};

		if (config.kyb.countryCodes) {
			this.#countryCodes = config.kyb.countryCodes.map(function(inputCode) {
				if (CurrencyInfo.Country.isCountryCode(inputCode)) {
					return(new CurrencyInfo.Country(inputCode));
				}

				return(inputCode);
			});
		}
	}

	protected async initRoutes(config: KeetaAnchorKYBServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
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
		 * Begin the KYB verification process
		 * with this KYB provider
		 */
		routes['POST /api/createVerification'] = async function(_ignore_params, bodyInput) {
			if (bodyInput === null || typeof bodyInput !== 'object' || !('request' in bodyInput)) {
				throw(new KeetaAnchorUserError('Invalid request'));
			}

			const body = assertCreateVerificationRequest(bodyInput.request);
			const valid = await verifySignedData(body);
			if (!valid) {
				throw(new KeetaAnchorUserError('Invalid signature'));
			}

			/* XXX:TODO: Validate that the nonce is unique (within a reasonable time frame) */

			let response: Partial<KeetaKYBAnchorCreateVerificationResponse> | undefined = {};
			if (config.kyb.verificationStarted) {
				response = await config.kyb.verificationStarted(body);
			}

			response ??= {};

			if (response?.ok === false) {
				throw(new KeetaAnchorUserError(response.error ?? 'Unknown error'));
			}

			response.ok = true;
			if (!response.ok) {
				throw(new Error('internal error: invalid response'));
			}
			response.id ??= crypto.randomUUID();

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
		 * Get the certificate for the
		 * KYB verification
		 */
		routes['GET /api/getCertificates/:verificationID'] = async function(params) {
			const verificationID = params.get('verificationID');
			if (verificationID === undefined) {
				throw(new KeetaAnchorUserError('No verification ID provided'));
			}

			const certificates = await config.kyb.getCertificates(verificationID);

			const response: KeetaKYBAnchorGetCertificateResponse = {
				ok: true,
				results: certificates
			};

			return({
				output: JSON.stringify(response)
			});
		};

		return({
			...config.routes,
			...routes
		});
	}

	protected async buildServiceMetadata(): Promise<NonNullable<ServiceMetadata['services']['kyb']>[string]> {
		return({
			ca: this.ca.toPEM(),
			countryCodes: this.#countryCodes?.map(function(country) {
				return(country.code);
			}) ?? [],
			operations: {
				createVerification: (new URL('/api/createVerification', this.url)).toString(),
				getCertificates: (new URL('/api/getCertificates', this.url)).toString() + '/{id}'
			}
		});
	}
}
