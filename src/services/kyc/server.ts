import KeetaNet from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';

import * as KeetaAnchorHTTPServer from '../../lib/http-server.js';
import * as Certificate from '../../lib/certificates.js';
import { createAssert } from 'typia';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type {
	KeetaKYCAnchorCreateVerificationRequest,
	KeetaKYCAnchorCreateVerificationResponse,
	KeetaKYCAnchorGetCertificateResponse
} from './common.ts';
import * as Signing from '../../lib/utils/signing.js';
import type { AssertNever } from '../../lib/utils/never.ts';
import type { ServiceMetadata } from '../../lib/resolver.ts';

const assertCreateVerificationRequest = createAssert<KeetaKYCAnchorCreateVerificationRequest>();

export interface KeetaAnchorKYCServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The network client to use for submitting blocks
	 */
	client: { client: KeetaNet.Client; network: bigint; networkAlias: typeof KeetaNet.Client.Config.networksArray[number] } | KeetaNet.UserClient;

	kyc: {
		/**
		 * Method to get the next serial number for a certificate 
		 */
		getNextSerialNumber: () => Promise<bigint>;

		/**
		 * Method to call when a certificate is ready
		 */
		certificateReady?: (verificationId: string, certificate: Certificate.Certificate) => Promise<void>;

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
};

export class KeetaNetKYCAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorKYCServerConfig> implements Required<KeetaAnchorKYCServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorKYCServerConfig['homepage']>;
	readonly client: KeetaAnchorKYCServerConfig['client'];
	readonly signer: NonNullable<KeetaAnchorKYCServerConfig['signer']>;
	readonly ca: KeetaAnchorKYCServerConfig['ca'];
	readonly kyc: KeetaAnchorKYCServerConfig['kyc'];
	readonly #countryCodes?: CurrencyInfo.Country[] | undefined;

	constructor(config: KeetaAnchorKYCServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.client = config.client;
		this.signer = config.signer;
		this.ca = config.ca;
		this.kyc = config.kyc;

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
		routes['POST /api/createVerification'] = async function(params, body) {
			throw(new Error('not implemented'));
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
		routes['GET /api/getCertificateStatus/:verificationId'] = async function(params) {
			throw(new Error('not implemented'));
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
		routes['POST /api/paymentNotification/:verificationId'] = async function(params, body) {
			throw(new Error('not implemented'));
		};

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['kyc']>[string]> {
		return({
			ca: this.ca.toPEM(),
			countryCodes: this.#countryCodes?.map(function(country) {
				return(country.code);
			}) ?? [],
			operations: {
				checkLocality: (new URL('/api/checkLocality', this.url)).toString(),
				getEstimate: (new URL('/api/createEstimate', this.url)).toString(),
				createVerification: (new URL('/api/createVerification', this.url)).toString(),
				getCertificates: (new URL('/api/getCertificateStatus/{id}', this.url)).toString(),
			}
		});
	}
}
