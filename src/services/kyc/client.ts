import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import { createIs } from 'typia';

import { getDefaultResolver } from '../../config.js';
import { Certificate as KYCCertificate } from '../../lib/certificates.js';

import type {
	Client as KeetaNetClient,
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type {
	KeetaKYCAnchorCreateVerificationRequest,
	KeetaKYCAnchorCreateVerificationResponse,
	KeetaKYCAnchorGetCertificateResponse
} from './common.ts';
import {
	verifySignedData,
	generateSignedData
} from './common.js';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import crypto from '../../lib/utils/crypto.js';
import { validateURL } from '../../lib/utils/url.js';

const PARANOID = true;

/**
 * The configuration options for the KYC Anchor client.
 */
export type KeetaKYCAnchorClientConfig = {
	/**
	 * The ID of the client. This is used to identify the client in logs.
	 * If not provided, a random ID will be generated.
	 */
	id?: string;
	/**
	 * The logger to use for logging messages. If not provided, no logging
	 * will be done.
	 */
	logger?: Logger;
	/**
	 * The resolver to use for resolving KYC Anchor services. If not
	 * provided, a default resolver will be created using the provided
	 * client and network (if the network is also not provided and the
	 * client is not a UserClient, an error occurs).
	 */
	resolver?: Resolver;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

/**
 * Any kind of X.509v3 Certificate.  This may or may not be a KYC certificate.
 */
type BaseCertificate = InstanceType<typeof KeetaNetLib.Utils.Certificate.Certificate>;

/**
 * The response type for the {@link KeetaKYCAnchorClient['getCertificates']()} method of the KYC Anchor client.
 * It contains the certificate and optionally a set of intermediate certificates.
 */
type KeetaKYCAnchorClientGetCertificateResponse = ({
	ok: true;
	results: {
		certificate: KYCCertificate;
		intermediates?: Set<BaseCertificate> | undefined;
	}[]
} | {
	ok: false;
	retryAfter: number;
	reason: string;
});

type KeetaKYCAnchorClientCreateVerificationRequest = Omit<KeetaKYCAnchorCreateVerificationRequest, 'signed' | 'account'> & {
	account: InstanceType<typeof KeetaNetLib.Account>;
};

/**
 * An opaque type that represents a provider ID.
 */
type ProviderID = string & {
	readonly __providerID: unique symbol;
};

/**
 * An opaque type that represents a KYC Anchor request ID
 */
type RequestID = string & {
	readonly __requestID: unique symbol;
};

/**
 * A list of operations that can be performed by the KYC Anchor service.
 */
type KeetaKYCAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['kyc']>[string]['operations']]?: (params?: { [key: string]: string; }) => URL;
};

/**
 * The service information for a KYC Anchor service.
 */
type KeetaKYCVerificationServiceInfo = {
	operations: {
		[operation in keyof KeetaKYCAnchorOperations]: Promise<KeetaKYCAnchorOperations[operation]>;
	};
	countryCodes?: CurrencyInfo.Country[] | undefined;
	ca: () => Promise<KYCCertificate>;
};

/**
 * For each matching KYC Anchor service, this type describes the
 * operations available and the country codes that the service supports.
 */
type GetEndpointsResult = {
	[id: ProviderID]: KeetaKYCVerificationServiceInfo;
};

const isKeetaKYCAnchorCreateVerificationResponse = createIs<KeetaKYCAnchorCreateVerificationResponse>();
const isKeetaKYCAnchorGetCertificateResponse = createIs<KeetaKYCAnchorGetCertificateResponse>();

async function getEndpoints(resolver: Resolver, request: KeetaKYCAnchorCreateVerificationRequest): Promise<GetEndpointsResult | null> {
	const response = await resolver.lookup('kyc', {
		countryCodes: request.countryCodes
	});

	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaKYCVerificationServiceInfo]> {
		const countryCodesPromises = (await serviceInfo.countryCodes?.('array'))?.map(async function(countryCode) {
			return(new CurrencyInfo.Country(CurrencyInfo.Country.assertCountryCode(await countryCode('string'))));
		});

		let countryCodes: CurrencyInfo.Country[] | undefined;
		if (countryCodesPromises !== undefined) {
			const countryCodesResults = await Promise.allSettled(countryCodesPromises);
			countryCodes = countryCodesResults.map(function(result) {
				if (result.status === 'fulfilled') {
					return(result.value);
				}
				throw(result.reason);
			});
		}

		const operations = await serviceInfo.operations('object');
		const operationsFunctions: KeetaKYCVerificationServiceInfo['operations'] = {};
		for (const [key, operation] of Object.entries(operations)) {
			if (operation === undefined) {
				continue;
			}

			Object.defineProperty(operationsFunctions, key, {
				get: async function() {
					const url = await operation('string');
					return(function(params?: { [key: string]: string; }): URL {
						let substitutedURL = url;
						for (const [paramKey, paramValue] of Object.entries(params ?? {})) {
							substitutedURL = substitutedURL.replace(`{${paramKey}}`, encodeURIComponent(paramValue));
						}

						return(validateURL(substitutedURL));
					});
				},
				enumerable: true,
				configurable: true
			});
		}
		return([
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			id as ProviderID,
			{
				countryCodes: countryCodes,
				operations: operationsFunctions,
				ca: async function() {
					const certificatePEM = await serviceInfo.ca?.('string');
					const certificate = new KYCCertificate(certificatePEM);

					return(certificate);
				}
			}
		]);
	});

	const retval = Object.fromEntries(await Promise.all(serviceInfoPromises));

	return(retval);
}

type KeetaKYCAnchorCommonConfig = {
	id: ProviderID;
	serviceInfo: KeetaKYCVerificationServiceInfo;
	request: KeetaKYCAnchorCreateVerificationRequest;
	client: KeetaKYCAnchorClient;
	operations: NonNullable<Pick<KeetaKYCAnchorOperations, 'createVerification' | 'getCertificates'>>;
	logger?: Logger | undefined;
};

/**
 * Represents an in-progress KYC verification request.
 */
class KeetaKYCVerification {
	readonly providerID: KeetaKYCAnchorCommonConfig['id'];
	readonly id: RequestID;
	private readonly serviceInfo: KeetaKYCAnchorCommonConfig['serviceInfo'];
	private readonly request: KeetaKYCAnchorCommonConfig['request'];
	private readonly logger?: KeetaKYCAnchorCommonConfig['logger'] | undefined;
	private readonly client: KeetaKYCAnchorCommonConfig['client'];
	private readonly response: Extract<KeetaKYCAnchorCreateVerificationResponse, { ok: true }>;

	private constructor(args: KeetaKYCAnchorCommonConfig, response: Extract<KeetaKYCAnchorCreateVerificationResponse, { ok: true }>) {
		this.providerID = args.id;
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		this.id = response.id as RequestID;
		this.serviceInfo = args.serviceInfo;
		this.request = args.request;
		this.client = args.client;
		this.logger = args.logger;
		this.response = response;

		this.logger?.debug(`Created KYC verification for provider ID: ${this.providerID}, request: ${JSON.stringify(args.request)}, response: ${JSON.stringify(response)}`);
	}

	static async start(args: KeetaKYCAnchorCommonConfig): Promise<KeetaKYCVerification> {
		args.logger?.debug(`Starting KYC verification for provider ID: ${args.id}, request: ${JSON.stringify(args.request)}`);

		const endpoints = args.operations;
		const createVerification = endpoints.createVerification?.();
		if (createVerification === undefined) {
			throw(new Error('KYC verification service does not support createVerification operation'));
		}

		const requestInformation = await fetch(createVerification, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				request: args.request
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaKYCAnchorCreateVerificationResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from KYC verification service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`KYC verification request failed: ${requestInformationJSON.error}`));
		}

		args.logger?.debug(`KYC verification request successful, request ID ${requestInformationJSON.id}`);

		return(new KeetaKYCVerification(args, requestInformationJSON));

	}

	get expectedCost(): typeof this.response.expectedCost {
		return(this.response.expectedCost);
	}

	get webURL(): URL {
		return(validateURL(this.response.webURL));
	}

	async getProviderIssuerCertificate(): Promise<KYCCertificate> {
		return(await this.serviceInfo.ca());
	}

	getCertificates(): Promise<KeetaKYCAnchorClientGetCertificateResponse> {
		return(this.client.getCertificates(this.providerID, {
			id: this.id,
			...this.request
		}));
	}

	/**
	 * Wait for the certificates to be available, polling at the given interval
	 * and timing out after the given timeout period.
	 */
	async waitForCertificates(pollInterval: number = 500, timeout: number = 600000): Promise<KeetaKYCAnchorClientGetCertificateResponse> {
		for (const startTime = Date.now(); Date.now() - startTime < timeout; ) {
			try {
				return(await this.getCertificates());
			} catch (getCertificatesError) {
				/* XXX:TODO */
				throw(getCertificatesError);
			}
		}
		throw(new Error('Timeout waiting for KYC certificates'));
	}
}

/**
 * Represents the KYC operations for a specific provider
 */
class KeetaKYCProvider {
	readonly id: ProviderID;
	private readonly serviceInfo: KeetaKYCVerificationServiceInfo;
	private readonly request: KeetaKYCAnchorCreateVerificationRequest;
	private readonly logger?: Logger | undefined;
	private readonly client: KeetaKYCAnchorClient;
	private readonly operations: NonNullable<Pick<KeetaKYCAnchorOperations, 'createVerification' | 'getCertificates'>>;

	private cachedCA?: KYCCertificate;

	constructor(args: KeetaKYCAnchorCommonConfig) {
		this.id = args.id;
		this.serviceInfo = args.serviceInfo;
		this.request = args.request;
		this.client = args.client;
		this.operations = args.operations;
		this.logger = args.logger;

		this.logger?.debug(`Created KYC verification for provider ID: ${args.id}, request: ${JSON.stringify(args.request)}`);
	}

	async countryCodes(): Promise<CurrencyInfo.Country[] | undefined> {
		return(this.serviceInfo.countryCodes);
	}

	async ca(): Promise<KYCCertificate> {
		if (this.cachedCA !== undefined) {
			return(this.cachedCA);
		}

		this.cachedCA = await this.serviceInfo.ca();

		return(this.cachedCA);
	}

	async startVerification(): Promise<KeetaKYCVerification> {
		return(await KeetaKYCVerification.start({
			id: this.id,
			serviceInfo: this.serviceInfo,
			request: this.request,
			client: this.client,
			operations: this.operations,
			logger: this.logger
		}));
	}
}


class KeetaKYCAnchorClient {
	readonly resolver: Resolver;
	readonly id: string;
	private readonly logger?: Logger | undefined;

	constructor(client: KeetaNetClient | KeetaNetUserClient, config: KeetaKYCAnchorClientConfig = {}) {
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
		this.logger = config.logger;
	}

	async createVerification(request: KeetaKYCAnchorClientCreateVerificationRequest): Promise<KeetaKYCProvider[]> {
		const signedData = await generateSignedData(request.account.assertAccount());

		if (PARANOID) {
			const check = await verifySignedData({ account: request.account.publicKeyString.get(), signed: signedData });
			if (!check) {
				throw(new Error('Failed to verify signed data'));
			}
		}

		const signedRequest: KeetaKYCAnchorCreateVerificationRequest = {
			...request,
			account: request.account.publicKeyString.get(),
			signed: signedData
		};

		const endpoints = await getEndpoints(this.resolver, signedRequest);
		if (endpoints === null) {
			throw(new Error('No KYC endpoints found for the given criteria'));
		}

		const validEndpoints = await Promise.allSettled(Object.entries(endpoints).map(async ([id, serviceInfo]) => {
			const endpoints = serviceInfo.operations;
			/*
			 * Verify that we have the required operations
			 * available to perform a KYC verification.
			 */
			const createVerification = await endpoints.createVerification;
			const getCertificates = await endpoints.getCertificates;
			if (createVerification === undefined || getCertificates === undefined) {
				this.logger?.warn(`KYC verification provider ${id} does not support required operations (createVerification, getCertificates)`);

				return(null);
			}

			/*
			 * We can safely cast the ID to a ProviderID because it's a branded type
			 * for this specific type
			 */
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const providerID = id as ProviderID;
			return(new KeetaKYCProvider({
				id: providerID,
				serviceInfo: serviceInfo,
				request: signedRequest,
				client: this,
				logger: this.logger,
				operations: {
					createVerification,
					getCertificates
				}
			}));
		}));

		/*
		 * Filter out any endpoints that were not able to be resolved
		 * or that did not have the required operations.
		 */
		const retval = validEndpoints.map(function(result) {
			if (result.status !== 'fulfilled') {
				return(null);
			}
			if (result.value === null) {
				return(null);
			}
			return(result.value);
		}).filter(function(result) {
			return(result !== null);
		});

		if (retval.length === 0) {
			throw(new Error('No valid KYC verification endpoints found'));
		}

		return(retval);
	}

	async getCertificates(providerID: ProviderID, request: KeetaKYCAnchorCreateVerificationRequest & { id: RequestID; }): Promise<KeetaKYCAnchorClientGetCertificateResponse> {
		const endpoints = await getEndpoints(this.resolver, request);
		if (endpoints === null) {
			throw(new Error('No KYC endpoints found for the given criteria'));
		}
		const providerEndpoints = endpoints[providerID];
		if (providerEndpoints === undefined) {
			throw(new Error(`No KYC endpoints found for provider ID: ${providerID}`));
		}

		const requestID = request.id;
		const operations = providerEndpoints.operations;
		const getCertificate = (await operations.getCertificates)?.({ id: requestID });
		if (getCertificate === undefined) {
			throw(new Error('internal error: KYC verification service does not support getCertificate operation'));
		}

		const response = await fetch(getCertificate, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		/*
		 * Handle retryable errors by passing them up to the caller to
		 * retry.
		 */
		if (response.status === 404) {
			return({
				ok: false,
				retryAfter: 500,
				reason: 'Certificate not found'
			});
		}

		/*
		 * Handle other errors as fatal errors that should not be retried.
		 */
		if (!response.ok) {
			throw(new Error(`Failed to get certificate: ${response.statusText}`));
		}

		const responseJSON: unknown = await response.json();
		if (!isKeetaKYCAnchorGetCertificateResponse(responseJSON)) {
			throw(new Error(`Invalid response from KYC certificate service: ${JSON.stringify(responseJSON)}`));
		}

		if (!responseJSON.ok) {
			throw(new Error(`KYC certificate request failed: ${responseJSON.error}`));
		}

		return({
			ok: true,
			results: responseJSON.results.map(function(result) {
				const intermediates = result.intermediates?.map(function(intermediate) {
					return(new KeetaNetLib.Utils.Certificate.Certificate(intermediate));
				});

				let intermediatesSet;
				if (intermediates !== undefined && intermediates.length > 0) {
					intermediatesSet = new Set(intermediates);
				}

				return({
					certificate: new KYCCertificate(result.certificate),
					intermediates: intermediatesSet
				});
			})
		});
	}

	async getSupportedCountries(): Promise<CurrencyInfo.Country[]> {
		return(await this.resolver.listSupportedKYCCountries());
	}

	async getEstimate(..._ignore_args: unknown[]): Promise<never> {
		throw(new Error('not implemented'));
	}

	async checkLocality(..._ignore_args: unknown[]): Promise<never> {
		throw(new Error('not implemented'));
	}
}

export default KeetaKYCAnchorClient;
