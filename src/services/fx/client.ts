import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import { createIs } from 'typia';
import { Decimal } from 'decimal.js';

import { getDefaultResolver } from '../../config.js';

import type {
	Client as KeetaNetClient,
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import { Buffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';
import { validateURL } from '../../lib/utils/url.js';
import type { Brand, BrandedString } from '../../lib/utils/brand.ts';
import type {
	ConversionInput,
	ConversionInputCanonical,
	KeetaFXAnchorEstimateResponse,
	KeetaFXAnchorEstimateResponseWithProvider,
	KeetaFXAnchorExchangeResponse,
	KeetaFXAnchorQuote,
	KeetaFXAnchorQuoteResponse
} from './common.ts';

const PARANOID = true;

/**
 * An opaque type that represents a provider ID.
 */
type ProviderID = BrandedString<'FXProviderID'>;

/**
 * An opaque type that represents a FX Anchor request ID
 */
type RequestID = BrandedString<'FXRequestID'>;


type AccountOptions = {
	/**
	 * The account to use for signing requests. If not provided, the
	 * account associated with the provided client will be used. If there
	 * is no account associated with the client, an error occurs.
	 */
	signer?: InstanceType<typeof KeetaNetLib.Account>;
	/**
	 * Account to perform changes on. If not provided, the account
	 * associated with the provided client will be used. If there is no
	 * account associated with the client, an error occurs.
	 */
	account?: InstanceType<typeof KeetaNetLib.Account>;
};

/**
 * The configuration options for the FX Anchor client.
 */
export type KeetaFXAnchorClientConfig = {
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
	 * The resolver to use for resolving FX Anchor services. If not
	 * provided, a default resolver will be created using the provided
	 * client and network (if the network is also not provided and the
	 * client is not a UserClient, an error occurs).
	 */
	resolver?: Resolver;
	/**
	 * The account to use for signing requests. If not provided, the
	 * account associated with the provided client will be used. If there
	 * is no account associated with the client, an error occurs.
	 */
	signer?: InstanceType<typeof KeetaNetLib.Account>;
	/**
	 * Account to perform changes on. If not provided, the account
	 * associated with the provided client will be used. If there is no
	 * account associated with the client, an error occurs.
	 */
	account?: InstanceType<typeof KeetaNetLib.Account>;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'> & AccountOptions;

type KeetaFXAnchorClientCreateExchangeRequest = {
	quote: KeetaFXAnchorQuote,
	block: InstanceType<typeof KeetaNetLib.Block>
};

type KeetaFXAnchorClientGetExchangeStatusRequest = {
	exchangeID: string
};

function typedFxServiceEntries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.entries(obj) as [keyof T, T[keyof T]][]);
}

type KeetaFXAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['fx']>[string]['operations']]: (params?: { [key: string]: string; }) => URL;
};

type KeetaFXServiceInfo = {
	operations: {
		[operation in keyof KeetaFXAnchorOperations]: Promise<KeetaFXAnchorOperations[operation]>;
	}
}

type GetEndpointsResult = {
	[providerID: ProviderID]: KeetaFXServiceInfo;
};

const KeetaFXAnchorClientAccessToken = Symbol('KeetaFXAnchorClientAccessToken');

async function getEndpoints(resolver: Resolver, request: ConversionInput, account: InstanceType<typeof KeetaNetLib.Account>): Promise<GetEndpointsResult | null> {
	const response = await resolver.lookup('fx', {
		inputCurrencyCode: request.from,
		outputCurrencyCode: request.to,
	});
	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaFXServiceInfo]> {
		const operations = await serviceInfo.operations('object');
		const operationsFunctions: Partial<KeetaFXServiceInfo['operations']> = {};
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
			id as unknown as ProviderID,
			{
				operations: operationsFunctions as KeetaFXServiceInfo['operations']
			}
		]);
	});

	const retval = Object.fromEntries(await Promise.all(serviceInfoPromises)) satisfies GetEndpointsResult as GetEndpointsResult;

	return(retval);
}

const isKeetaFXAnchorEstimateResponse = createIs<KeetaFXAnchorEstimateResponse>();
const isKeetaFXAnchorQuoteResponse = createIs<KeetaFXAnchorQuoteResponse>();
const isKeetaFXAnchorExchangeResponse = createIs<KeetaFXAnchorExchangeResponse>();

export class KeetaFXAnchorProvider {
	readonly serviceInfo: KeetaFXServiceInfo;
	readonly providerID: ProviderID;
	readonly client: KeetaFXAnchorClient['client'];
	readonly conversion: ConversionInputCanonical;
	private readonly logger?: KeetaFXAnchorClient['logger'];

	constructor(serviceInfo: KeetaFXServiceInfo, providerID: ProviderID, conversion: ConversionInputCanonical,  parent: KeetaFXAnchorClient) {
		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.conversion = conversion;

		const parentPrivate = parent._private(KeetaFXAnchorClientAccessToken);
		this.client = parentPrivate.client;
		this.logger = parentPrivate.logger;
	}

	async getEstimate(): Promise<KeetaFXAnchorEstimateResponse> {
		const serviceURL = await this.serviceInfo.operations.getEstimate;
		if (serviceURL !== undefined) {
			const estimateURL = serviceURL();
			const requestInformation = await fetch(estimateURL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				},
				body: JSON.stringify({
					request: this.conversion
				})
			});

			const requestInformationJSON: unknown = await requestInformation.json();
			if (!isKeetaFXAnchorEstimateResponse(requestInformationJSON)) {
				throw(new Error(`Invalid response from FX estimate service: ${JSON.stringify(requestInformationJSON)}`));
			}

			if (!requestInformationJSON.ok) {
				throw(new Error(`FX estimate request failed: ${requestInformationJSON.error}`));
			}

			this.logger?.debug(`FX estimate request successful, to provider ${estimateURL} for ${JSON.stringify(this.conversion)}`);
			return(requestInformationJSON);
		} else {
			throw(new Error('Service getEstimate does not exist'));
		}
	}

	async getQuote(): Promise<KeetaFXAnchorQuoteResponse> {
		const serviceURL = (await this.serviceInfo.operations.getQuote)();
		const requestInformation = await fetch(serviceURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				request: this.conversion
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaFXAnchorQuoteResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX quote service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`FX quote request failed: ${requestInformationJSON.error}`));
		}

		this.logger?.debug(`FX quote request successful, to provider ${serviceURL} for ${JSON.stringify(this.conversion)}`);
		return(requestInformationJSON);
	}

	async createExchange(request: KeetaFXAnchorClientCreateExchangeRequest): Promise<KeetaFXAnchorExchangeResponse> {
		const serviceURL = (await this.serviceInfo.operations.createExchange)();
		const requestInformation = await fetch(serviceURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				quote: request.quote,
				block: Buffer.from(request.block.toBytes()).toString('base64')
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaFXAnchorExchangeResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX exchange service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`FX exchange request failed: ${requestInformationJSON.error}`));
		}

		this.logger?.debug(`FX exchange request successful, to provider ${serviceURL} for ${request.block.hash.toString()}`);
		return(requestInformationJSON);
	}

	async getExchangeStatus(request: KeetaFXAnchorClientGetExchangeStatusRequest): Promise<KeetaFXAnchorExchangeResponse> {
		const serviceURL = (await this.serviceInfo.operations.getExchangeStatus)(request);
		const requestInformation = await fetch(serviceURL, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaFXAnchorExchangeResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX exchange status service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`FX exchange status failed: ${requestInformationJSON.error}`));
		}

		this.logger?.debug(`FX exchange status request successful, to provider ${serviceURL} for ${request}`);
		return(requestInformationJSON);
	}
}

class KeetaFXAnchorClient {
	readonly resolver: Resolver;
	readonly id: string;
	readonly #signer: InstanceType<typeof KeetaNetLib.Account>;
	readonly #account: InstanceType<typeof KeetaNetLib.Account>;
	private readonly logger?: Logger | undefined;
	private readonly client: KeetaNetClient | KeetaNetUserClient;

	constructor(client: KeetaNetClient | KeetaNetUserClient, config: KeetaFXAnchorClientConfig = {}) {
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
		this.logger = config.logger;
		this.client = client;

		if (config.signer) {
			this.#signer = config.signer;
		} else if ('signer' in client && client.signer !== null) {
			this.#signer = client.signer;
		} else if ('account' in client && client.account.hasPrivateKey) {
			this.#signer = client.account;
		} else {
			throw new Error('KeetaFXAnchorClient requires a Signer or a UserClient with an associated Signer');
		}

		if (config.account) {
			this.#account = config.account;
		} else if ('account' in client) {
			this.#account = client.account;
		} else {
			throw new Error('KeetaFXAnchorClient requires an Account or a UserClient with an associated Account');
		}
	}

	private async canonicalizeConversionInput(input: ConversionInput): Promise<ConversionInputCanonical> {
		const amount = new Decimal(input.amount);
		if (amount.isNaN() || amount.lte(0)) {
			throw(new Error('invalid amount'));
		}

		return({
			...input,
			amount: amount.toString()
		});
	}

	async getProviders(request: ConversionInput, options: AccountOptions = {}): Promise<KeetaFXAnchorProvider[] | null> {
		const conversion = await this.canonicalizeConversionInput(request);
		const account = options.account ?? this.#account;
		const providerEndpoints = await getEndpoints(this.resolver, request, account);
		if (providerEndpoints === null) {
			return(null);
		}

		const providers = typedFxServiceEntries(providerEndpoints).map(([providerID, serviceInfo]) => {
			return(new KeetaFXAnchorProvider(serviceInfo, providerID, conversion, this));
		});

		return(providers);
	}

	async getEstimates(request: ConversionInput, options: AccountOptions = {}): Promise<KeetaFXAnchorEstimateResponseWithProvider[] | null> {
		const estimateProviders = await this.getProviders(request);
		if (estimateProviders === null) {
			return(null);
		}

		const estimates = await Promise.allSettled(estimateProviders.map(async (provider) => {
			const estimate = await provider.getEstimate();
			return({
				provider,
				...estimate
			})
		}));

		const results = estimates.filter(result => result.status === 'fulfilled').map(estimate => estimate.value);
		return(results);
	}

	/** @internal */
	_private(accessToken: symbol) {
		if (accessToken !== KeetaFXAnchorClientAccessToken) {
			throw new Error('invalid access token');
		}

		return({
			logger: this.logger,
			client: this.client,
			signer: this.#signer,
			account: this.#account
		});

	}
}

export default KeetaFXAnchorClient;
