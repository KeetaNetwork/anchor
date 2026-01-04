import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { getDefaultResolver } from '../../config.js';
import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceSearchCriteria } from '../../lib/resolver.ts';
import { validateURL } from '../../lib/utils/url.js';
import type { BrandedString } from '../../lib/utils/brand.ts';
import crypto from '../../lib/utils/crypto.js';
import {
	assertKeetaNetTokenPublicKeyString,
	isKeetaOrderMatcherPriceHistoryResponse,
	isKeetaOrderMatcherPriceInfoResponse,
	isKeetaOrderMatcherPairDepthResponse
} from './common.js';
import type {
	KeetaNetAccount,
	KeetaNetToken,
	KeetaOrderMatcherPairMetadata,
	KeetaOrderMatcherPriceHistoryResponse,
	KeetaOrderMatcherPriceInfoResponse,
	KeetaOrderMatcherPairDepthResponse
} from './common.ts';
import type { TokenAddress, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

type ProviderID = BrandedString<'OrderMatcherProviderID'>;

type TokenInput = TokenAddress | TokenPublicKeyString | KeetaNetToken;

type TokenPairInput = [ TokenInput, TokenInput ];

type KeetaOrderMatcherTokenPair = [ KeetaNetToken, KeetaNetToken ];

type OperationHandler = (params: { [key: string]: string; }) => URL;

type KeetaOrderMatcherPairFeeMetadata = NonNullable<KeetaOrderMatcherPairMetadata['fees']>;

type KeetaOrderMatcherPairMetadataCanonical = {
	base: KeetaNetToken[];
	quote: KeetaNetToken[];
	fees?: KeetaOrderMatcherPairFeeMetadata;
};

type KeetaOrderMatcherServiceInfo = {
	operations: {
		getPairHistory?: Promise<OperationHandler>;
		getPairInfo?: Promise<OperationHandler>;
		getPairDepth?: Promise<OperationHandler>;
	};
	matchingAccounts: KeetaNetAccount[];
	pairs: KeetaOrderMatcherPairMetadataCanonical[];
};

type GetEndpointsResult = { [key: string]: KeetaOrderMatcherServiceInfo };

function typedServiceEntries<T extends { [key: string]: unknown }>(obj: T): [keyof T, T[keyof T]][] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.entries(obj) as [keyof T, T[keyof T]][]);
}

function toProviderID(value: string): ProviderID {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(value as unknown as ProviderID);
}

function fromTokenPublicKeyString(value: string): KeetaNetToken {
	const account = KeetaNetLib.Account.fromPublicKeyString(assertKeetaNetTokenPublicKeyString(value));
	return(account.assertKeyType(KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN));
}

function fromAccountPublicKeyString(value: string): KeetaNetAccount {
	return(KeetaNetLib.Account.fromPublicKeyString(value));
}

function canonicalizePair(pair: TokenPairInput): { tokenA: string; tokenB: string; } {
	return({
		tokenA: KeetaNetLib.Account.toPublicKeyString(pair[0]),
		tokenB: KeetaNetLib.Account.toPublicKeyString(pair[1])
	});
}

async function getEndpoints(resolver: Resolver, criteria: Partial<ServiceSearchCriteria<'orderMatcher'>>): Promise<GetEndpointsResult | null> {
	const response = await resolver.lookup('orderMatcher', criteria);
	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaOrderMatcherServiceInfo]> {
		const operations = await serviceInfo.operations('object');
		const operationsFunctions: Partial<KeetaOrderMatcherServiceInfo['operations']> = {};
		for (const [operationKey, operation] of Object.entries(operations)) {
			if (operation === undefined) {
				continue;
			}

			const asyncFactory = (async function(): Promise<OperationHandler> {
				const url = await operation('string');
				return(function(params: { [key: string]: string; } = {}): URL {
					let substitutedURL = url;
					for (const [paramKey, paramValue] of Object.entries(params)) {
						substitutedURL = substitutedURL.replace(`{${paramKey}}`, encodeURIComponent(paramValue));
					}
					return(validateURL(substitutedURL));
				});
			})();

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			operationsFunctions[operationKey as keyof KeetaOrderMatcherServiceInfo['operations']] = asyncFactory;
		}

		const matchingAccountsEntries = await serviceInfo.matchingAccounts('array');
		const matchingAccounts = await Promise.all(matchingAccountsEntries.map(async (entry) => {
			const accountString = await entry('string');
			return(fromAccountPublicKeyString(accountString));
		}));

		const pairsEntries = await serviceInfo.pairs('array');
		const pairs = await Promise.all(pairsEntries.map(async function(pairEntry) {
			const pairInfo = await pairEntry('object');

			const baseEntries = await pairInfo.base('array');
			const baseTokens = await Promise.all(baseEntries.map(async (baseEntry) => {
				const baseTokenString = await baseEntry('string');
				return(fromTokenPublicKeyString(baseTokenString));
			}));

			const quoteEntries = await pairInfo.quote('array');
			const quoteTokens = await Promise.all(quoteEntries.map(async (quoteEntry) => {
				const quoteTokenString = await quoteEntry('string');
				return(fromTokenPublicKeyString(quoteTokenString));
			}));

			let fees: KeetaOrderMatcherPairFeeMetadata | undefined;
			if (pairInfo.fees !== undefined) {
				const feesObject = await pairInfo.fees('object');
				const typeValue = await feesObject.type('string');
				if (typeValue === 'sell-token-percentage') {
					const minPercentBasisPointsValue = await feesObject.minPercentBasisPoints('number');
					fees = {
						type: typeValue,
						minPercentBasisPoints: Number(minPercentBasisPointsValue)
					};
				} else {
					throw(new Error(`Unsupported pair fee type: ${typeValue}`));
				}

			}

			const pairMetadata: KeetaOrderMatcherPairMetadataCanonical = {
				base: baseTokens,
				quote: quoteTokens
			};
			if (fees !== undefined) {
				pairMetadata.fees = fees;
			}

			return(pairMetadata);
		}));

		return([
			toProviderID(id),
			{
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				operations: operationsFunctions as KeetaOrderMatcherServiceInfo['operations'],
				matchingAccounts,
				pairs
			}
		]);
	});

	if (serviceInfoPromises.length === 0) {
		return(null);
	}

	const endpoints = Object.fromEntries(await Promise.all(serviceInfoPromises));

	return(endpoints);
}

export type KeetaOrderMatcherClientConfig = {
	id?: string;
	logger?: Logger | undefined;
	resolver?: Resolver;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

export class KeetaOrderMatcherProvider {
	readonly serviceInfo: KeetaOrderMatcherServiceInfo;
	readonly providerID: ProviderID;
	private readonly parent: KeetaOrderMatcherClient;

	constructor(serviceInfo: KeetaOrderMatcherServiceInfo, providerID: ProviderID, parent: KeetaOrderMatcherClient) {
		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.parent = parent;
	}

	get matchingAccounts(): readonly KeetaNetAccount[] {
		return(this.serviceInfo.matchingAccounts);
	}

	get pairs(): readonly KeetaOrderMatcherPairMetadataCanonical[] {
		return(this.serviceInfo.pairs);
	}

	/**
	 * Fetch price history for a given token pair
	 * @param pair The pair fetch history for
	 * @returns The price history of the pair, priced in pair[0] (the base token)
	 */
	async getPairHistory(pair: TokenPairInput): Promise<KeetaOrderMatcherPriceHistoryResponse> {
		const operationFactory = await this.serviceInfo.operations.getPairHistory;
		if (operationFactory === undefined) {
			throw(new Error('Service getPairHistory does not exist'));
		}

		const canonicalPair = canonicalizePair(pair);
		const requestURL = operationFactory(canonicalPair);
		const response = await fetch(requestURL, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		const responseJSON: unknown = await response.json();
		if (!isKeetaOrderMatcherPriceHistoryResponse(responseJSON)) {
			throw(new Error(`Invalid response from order matcher price history service: ${JSON.stringify(responseJSON)}`));
		}

		if (!responseJSON.ok) {
			throw(new Error(`Order matcher price history request failed: ${responseJSON.error}`));
		}

		this.parent.logger?.debug(`Order matcher price history request successful, provider ${String(this.providerID)} for ${canonicalPair.tokenA}:${canonicalPair.tokenB}`);
		return(responseJSON);
	}

	/**
	 * Fetch latest price info for a given token pair
	 * @param pair The pair to fetch
	 * @returns {@link KeetaOrderMatcherPriceInfoResponse} the latest price info for the pair, priced in pair[0] (the base token)
	 */
	async getPairInfo(pair: TokenPairInput): Promise<KeetaOrderMatcherPriceInfoResponse> {
		const operationFactory = await this.serviceInfo.operations.getPairInfo;
		if (operationFactory === undefined) {
			throw(new Error('Service getPairInfo does not exist'));
		}

		const canonicalPair = canonicalizePair(pair);
		const requestURL = operationFactory(canonicalPair);
		const response = await fetch(requestURL, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		const responseJSON: unknown = await response.json();
		if (!isKeetaOrderMatcherPriceInfoResponse(responseJSON)) {
			throw(new Error(`Invalid response from order matcher price info service: ${JSON.stringify(responseJSON)}`));
		}

		if (!responseJSON.ok) {
			throw(new Error(`Order matcher price info request failed: ${responseJSON.error}`));
		}

		this.parent.logger?.debug(`Order matcher price info request successful, provider ${String(this.providerID)} for ${canonicalPair.tokenA}:${canonicalPair.tokenB}`);
		return(responseJSON);
	}

	/**
	 * Fetch price depth for a given token pair
	 * @param pair The pair to fetch depth for
	 * @param grouping The grouping to fetch the depth in, as an integer representing the price in pair[0] (the base token)
	 * @returns The price depth buckets with volume for the pair, priced in pair[0] (the base token)
	 */
	async getPairDepth(pair: TokenPairInput, grouping: number): Promise<KeetaOrderMatcherPairDepthResponse> {
		const operationFactory = await this.serviceInfo.operations.getPairDepth;
		if (operationFactory === undefined) {
			throw(new Error('Service getPairDepth does not exist'));
		}

		if (!Number.isFinite(grouping) || grouping <= 0) {
			throw(new Error('Grouping must be a positive numeric value'));
		}

		const canonicalPair = canonicalizePair(pair);
		const requestURL = operationFactory({
			...canonicalPair,
			grouping: grouping.toString()
		});
		const response = await fetch(requestURL, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		const responseJSON: unknown = await response.json();
		if (!isKeetaOrderMatcherPairDepthResponse(responseJSON)) {
			throw(new Error(`Invalid response from order matcher pair depth service: ${JSON.stringify(responseJSON)}`));
		}

		if (!responseJSON.ok) {
			throw(new Error(`Order matcher pair depth request failed: ${responseJSON.error}`));
		}

		this.parent.logger?.debug(`Order matcher pair depth request successful, provider ${String(this.providerID)} for ${canonicalPair.tokenA}:${canonicalPair.tokenB} grouping ${grouping}`);
		return(responseJSON);
	}
}

class KeetaOrderMatcherClient {
	readonly resolver: Resolver;
	readonly id: string;
	readonly logger?: Logger | undefined;
	readonly client: KeetaNetUserClient;

	constructor(client: KeetaNetUserClient, config: KeetaOrderMatcherClientConfig = {}) {
		this.client = client;
		this.logger = config.logger;
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
	}

	async getProviders(criteria: Partial<{ base: TokenInput; quote: TokenInput; }> = {}): Promise<KeetaOrderMatcherProvider[] | null> {
		const lookupCriteria: Partial<ServiceSearchCriteria<'orderMatcher'>> = {};
		if (criteria.base !== undefined) {
			const basePublicKey = KeetaNetLib.Account.toPublicKeyString(criteria.base);
			lookupCriteria.base = assertKeetaNetTokenPublicKeyString(basePublicKey);
		}
		if (criteria.quote !== undefined) {
			const quotePublicKey = KeetaNetLib.Account.toPublicKeyString(criteria.quote);
			lookupCriteria.quote = assertKeetaNetTokenPublicKeyString(quotePublicKey);
		}

		const providerEndpoints = await getEndpoints(this.resolver, lookupCriteria);
		if (providerEndpoints === null) {
			return(null);
		}

		return(typedServiceEntries(providerEndpoints).map(([ providerID, serviceInfo ]) => {
			return(new KeetaOrderMatcherProvider(serviceInfo, toProviderID(String(providerID)), this));
		}));
	}

	/**
	 * List all token pairs supported by all discovered Order Matcher providers
	 * @returns {@link KeetaOrderMatcherTokenPair[]} List of all token pairs supported by all discovered Order Matcher providers
	 */
	async listAllPairs(): Promise<KeetaOrderMatcherTokenPair[]> {
		const providerEndpoints = await getEndpoints(this.resolver, {});
		if (providerEndpoints === null) {
			return([]);
		}

		const seenPairs = new Set<string>();
		const pairs: KeetaOrderMatcherTokenPair[] = [];
		for (const serviceInfo of Object.values(providerEndpoints)) {
			for (const pairMetadata of serviceInfo.pairs) {
				for (const baseToken of pairMetadata.base) {
					for (const quoteToken of pairMetadata.quote) {
						const canonical = canonicalizePair([baseToken, quoteToken]);
						const key = `${canonical.tokenA}:${canonical.tokenB}`;
						if (seenPairs.has(key)) {
							continue;
						}
						seenPairs.add(key);
						pairs.push([baseToken, quoteToken]);
					}
				}
			}
		}

		return(pairs);
	}

	/**
	 * List all providers that support a given pair
	 * @param pair The pair to search
	 * @returns A list of providers that support the given pair, or null if no providers were found
	 */
	async getProvidersForPair(pair: TokenPairInput): Promise<KeetaOrderMatcherProvider[] | null> {
		return(await this.getProviders({ base: pair[0], quote: pair[1] }));
	}
}

export default KeetaOrderMatcherClient;
