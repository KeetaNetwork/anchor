import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import CurrencyInfo from '@keetanetwork/currency-info';
import { createIs } from 'typia';
import { Decimal } from 'decimal.js';

import { getDefaultResolver } from '../../config.js';

import type {
	Client as KeetaNetClient,
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
// import type {
// 	KeetaKYCAnchorCreateVerificationRequest,
// 	KeetaKYCAnchorCreateVerificationResponse,
// 	KeetaKYCAnchorGetCertificateResponse
// } from './common.ts';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceMetadata, ServiceSearchCriteria } from '../../lib/resolver.ts';
import { Buffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';
import { validateURL } from '../../lib/utils/url.js';
import type { Brand, BrandedString } from '../../lib/utils/brand.ts';

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

type ConversionInput = {
	/**
	 * The currency code to convert from (i.e., what the user has).
	 */
	from: ServiceSearchCriteria<'fx'>['inputCurrencyCode'];
	/**
	 * The currency code to convert to (i.e., what the user wants).
	 */
	to: ServiceSearchCriteria<'fx'>['outputCurrencyCode'];
	/**
	 * The amount to convert. This is a string or Decimal representing the
	 * amount in the currency specified by either `from` or `to`, as
	 * specified by the `affinity` property.
	 */
	amount: string | number | Decimal;
	/**
	 * Indicates whether the amount specified is in terms of the `from`
	 * currency (i.e., the user has this much) or the `to` currency
	 * (i.e., the user wants this much).
	 */
	affinity: 'from' | 'to';
};

type ConversionInputCanonical = {
	[k in keyof ConversionInput]: k extends 'amount' ? string : ConversionInput[k];
};

type KeetaFXAnchorClientGetEstimateRequest = ConversionInput;

function typedFxServiceEntries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.entries(obj) as [keyof T, T[keyof T]][]);
}
type KeetaFXServiceInfo = {
	operations: {
		[key in keyof NonNullable<ServiceMetadata['services']['fx']>[string]['operations']]: (params?: { [key: string]: string; }) => Promise<URL>;
	};
};

type GetEndpointsResult = {
	[providerID: ProviderID]: KeetaFXServiceInfo;
};

const KeetaFXAnchorClientAccessToken = Symbol('KeetaFXAnchorClientAccessToken');

async function getEndpoints(resolver: Resolver, request: ConversionInputCanonical, account: InstanceType<typeof KeetaNetLib.Account>): Promise<GetEndpointsResult | null> {
	const response = await resolver.lookup('fx', {
		inputCurrencyCode: request.from,
		outputCurrencyCode: request.to,
		/* XXX:TODO: kycProviders from account */
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

function generateKeetaFXProviderForOperation<Operation extends keyof KeetaFXServiceInfo['operations']>(operation: Operation) {
	const retval = class KeetaFXProviderOperation {
		readonly serviceInfo: KeetaFXServiceInfo;
		readonly providerID: ProviderID;
		readonly client: KeetaFXAnchorClient['client'];;
		private readonly operation: Operation;
		private readonly logger?: KeetaFXAnchorClient['logger'];

		constructor(serviceInfo: KeetaFXServiceInfo, providerID: ProviderID, parent: KeetaFXAnchorClient) {
			this.operation = operation;
			this.serviceInfo = serviceInfo;
			this.providerID = providerID;

			const parentPrivate = parent._private(KeetaFXAnchorClientAccessToken);
			this.client = parentPrivate.client;
			this.logger = parentPrivate.logger;
		}

		async [operation](): Promise<'not implemented'> {
			throw(new Error('not implemented'));
		}
	};

	return(retval);
}

const KeetaFXProviderGetEstimate = generateKeetaFXProviderForOperation('getEstimate');
const KeetaFXProviderGetQuote = generateKeetaFXProviderForOperation('getQuote');
const KeetaFXProviderCreateExchange = generateKeetaFXProviderForOperation('createExchange');
const KeetaFXProviderGetExchangeStatus = generateKeetaFXProviderForOperation('getExchangeStatus');

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

	// XXX:TODO: We should also support to receive `from` or `to` and list the available currencies accordingly
	async listCurrencies(): ReturnType<typeof this.resolver.listTokens> {
		return await this.resolver.listTokens();
	}

	async getEstimate(request: KeetaFXAnchorClientGetEstimateRequest, options: AccountOptions = {}): Promise<any | null> {
		const conversion = await this.canonicalizeConversionInput(request);
		const account = options.account ?? this.#account;
		const providers = await getEndpoints(this.resolver, conversion, account);
		if (providers === null) {
			return(null);
		}

		const estimateProviders = typedFxServiceEntries(providers).map(async ([providerID, serviceInfo]) => {
			return(new KeetaFXProviderGetEstimate(serviceInfo, providerID, this));
		});
	}

	async getQuote(..._ignore_args: any[]): Promise<any> {
		throw(new Error('not implemented'));
	}

	async createExchange(..._ignore_args: any[]): Promise<any> {
		throw(new Error('not implemented'));
	}

	async getExchangeStatus(..._ignore_args: any[]): Promise<any> {
		throw(new Error('not implemented'));
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
