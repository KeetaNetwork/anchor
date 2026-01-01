import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import type { Routes } from '../../lib/http-server/index.ts';
import { KeetaNet } from '../../client/index.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type {
	KeetaNetAccount,
	KeetaOrderMatcherPairDepthResponse,
	KeetaOrderMatcherPriceHistoryResponse,
	KeetaOrderMatcherPriceInfoResponse
} from './common.ts';

type TokenAccount = InstanceType<typeof KeetaNet.lib.Account<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>>;

type OrderMatcherPairConfig = {
	base: TokenAccount[];
	quote: TokenAccount[];
	fees?: {
		type: 'sell-token-percentage';
		minPercentBasisPoints: number;
	};
};

export interface KeetaAnchorOrderMatcherServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	homepage?: string | (() => Promise<string> | string);
	orderMatcher: {
		matchingAccounts: KeetaNetAccount[];
		pairs: OrderMatcherPairConfig[];
		getPairHistory?: (pair: [ TokenAddress, TokenAddress ]) => Promise<KeetaOrderMatcherPriceHistoryResponse>;
		getPairInfo: (pair: [ TokenAddress, TokenAddress ]) => Promise<KeetaOrderMatcherPriceInfoResponse>;
		getPairDepth?: (pair: [ TokenAddress, TokenAddress ], grouping: number) => Promise<KeetaOrderMatcherPairDepthResponse>;
	};
}

function canonicalizeTokenAccounts(accounts: TokenAccount[]): TokenAccount[] {
	return(accounts.map((account) => account.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)));
}

function canonicalizeAccounts(accounts: KeetaNetAccount[]): KeetaNetAccount[] {
	return(accounts.map((account) => account));
}

function canonicalizePairs(pairs: OrderMatcherPairConfig[]): OrderMatcherPairConfig[] {
	return(pairs.map((pair) => {
		const canonicalPair: OrderMatcherPairConfig = {
			base: canonicalizeTokenAccounts(pair.base),
			quote: canonicalizeTokenAccounts(pair.quote)
		};
		if (pair.fees !== undefined) {
			canonicalPair.fees = pair.fees;
		}
		return(canonicalPair);
	}));
}

function parseTokenParameter(params: Map<string, string>): [ TokenAddress, TokenAddress ] {
	const tokensParam = params.get('tokens');
	if (typeof tokensParam !== 'string') {
		throw(new Error('Missing tokens in params'));
	}

	const segments = tokensParam.split(':');
	if (segments.length !== 2) {
		throw(new Error('Invalid tokens parameter, expected format {tokenA}:{tokenB}'));
	}

	const [tokenAPublicKey, tokenBPublicKey] = segments as [string, string];
	if (tokenAPublicKey === '' || tokenBPublicKey === '') {
		throw(new Error('Invalid tokens parameter, expected non-empty token identifiers'));
	}

	const tokenA = KeetaNet.lib.Account.fromPublicKeyString(tokenAPublicKey).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const tokenB = KeetaNet.lib.Account.fromPublicKeyString(tokenBPublicKey).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	return([ tokenA, tokenB ]);
}

export class KeetaNetOrderMatcherHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorOrderMatcherServerConfig> {
	readonly homepage: KeetaAnchorOrderMatcherServerConfig['homepage'];
	readonly orderMatcher: {
		matchingAccounts: KeetaNetAccount[];
		pairs: OrderMatcherPairConfig[];
		getPairHistory?: KeetaAnchorOrderMatcherServerConfig['orderMatcher']['getPairHistory'];
		getPairInfo: KeetaAnchorOrderMatcherServerConfig['orderMatcher']['getPairInfo'];
		getPairDepth?: KeetaAnchorOrderMatcherServerConfig['orderMatcher']['getPairDepth'];
	};

	constructor(config: KeetaAnchorOrderMatcherServerConfig) {
		super(config);

		if (config.orderMatcher.getPairInfo === undefined) {
			throw(new Error('orderMatcher.getPairInfo is required'));
		}

		this.homepage = config.homepage;
		this.orderMatcher = {
			matchingAccounts: canonicalizeAccounts(config.orderMatcher.matchingAccounts),
			pairs: canonicalizePairs(config.orderMatcher.pairs),
			getPairHistory: config.orderMatcher.getPairHistory,
			getPairInfo: config.orderMatcher.getPairInfo,
			getPairDepth: config.orderMatcher.getPairDepth
		};
	}

	protected override async initRoutes(_config: KeetaAnchorOrderMatcherServerConfig): Promise<Routes> {
		const routes: Routes = {};

		if (this.homepage !== undefined) {
			routes['GET /'] = async () => {
				const resolvedHomepage = typeof this.homepage === 'function' ? await this.homepage() : this.homepage;
				return({
					output: resolvedHomepage ?? '',
					contentType: 'text/html'
				});
			};
		}

		if (this.orderMatcher.getPairHistory !== undefined) {
			routes['GET /api/price-history/:tokens'] = async (urlParams) => {
				const pair = parseTokenParameter(urlParams);
				const response = await this.orderMatcher.getPairHistory?.(pair);
				if (response === undefined) {
					throw(new Error('Price history handler returned undefined response'));
				}
				return({
					output: JSON.stringify(response),
					contentType: 'application/json'
				});
			};
		}

		routes['GET /api/price-info/:tokens'] = async (urlParams) => {
			const pair = parseTokenParameter(urlParams);
			const response = await this.orderMatcher.getPairInfo(pair);
			return({
				output: JSON.stringify(response),
				contentType: 'application/json'
			});
		};

		if (this.orderMatcher.getPairDepth !== undefined) {
			routes['GET /api/pair-depth/:tokens'] = async (urlParams, _body, _headers, requestUrl) => {
				const pair = parseTokenParameter(urlParams);
				const groupingParam = requestUrl.searchParams.get('grouping');
				if (groupingParam === null) {
					throw(new Error('Missing grouping query parameter'));
				}

				const grouping = Number.parseFloat(groupingParam);
				if (!Number.isFinite(grouping) || grouping <= 0) {
					throw(new Error('Invalid grouping query parameter, expected positive numeric value'));
				}

				const response = await this.orderMatcher.getPairDepth?.(pair, grouping);
				if (response === undefined) {
					throw(new Error('Pair depth handler returned undefined response'));
				}

				return({
					output: JSON.stringify(response),
					contentType: 'application/json'
				});
			};
		}

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['orderMatcher']>[string]> {
		const operations: NonNullable<ServiceMetadata['services']['orderMatcher']>[string]['operations'] = {};

		if (this.orderMatcher.getPairHistory !== undefined) {
			operations.getPairHistory = (new URL('/api/price-history', this.url)).toString() + '/{tokenA}:{tokenB}';
		}
		operations.getPairInfo = (new URL('/api/price-info', this.url)).toString() + '/{tokenA}:{tokenB}';
		if (this.orderMatcher.getPairDepth !== undefined) {
			operations.getPairDepth = (new URL('/api/pair-depth', this.url)).toString() + '/{tokenA}:{tokenB}?grouping={grouping}';
		}

		return({
			operations,
			matchingAccounts: this.orderMatcher.matchingAccounts.map((account) => account.publicKeyString.get()),
			pairs: this.orderMatcher.pairs.map((pair) => ({
				base: pair.base.map((token) => token.publicKeyString.get()),
				quote: pair.quote.map((token) => token.publicKeyString.get()),
				...(pair.fees !== undefined ? { fees: pair.fees } : {})
			}))
		});
	}
}
