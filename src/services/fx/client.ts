import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createAssert, createIs } from 'typia';
import { Decimal } from 'decimal.js';

import { getDefaultResolver } from '../../config.js';

import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceMetadata, ServiceSearchCriteria } from '../../lib/resolver.ts';
import { Buffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';
import { validateURL } from '../../lib/utils/url.js';
import type { BrandedString } from '../../lib/utils/brand.ts';
import type {
	ConversionInput,
	ConversionInputCanonical,
	KeetaFXAnchorEstimate,
	KeetaFXAnchorEstimateResponse,
	KeetaFXAnchorExchange,
	KeetaFXAnchorExchangeResponse,
	KeetaFXAnchorQuote,
	KeetaFXAnchorQuoteResponse,
	KeetaNetAccount,
	KeetaNetToken,
	KeetaNetTokenPublicKeyString
} from './common.ts';
import { KeetaAnchorUserError } from '../../lib/error.js';

/**
 * An opaque type that represents a provider ID.
 */
type ProviderID = BrandedString<'FXProviderID'>;

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
	},
	from: NonNullable<ServiceMetadata['services']['fx']>[string]['from'];
}

type GetEndpointsResult = {
	[providerID: ProviderID]: KeetaFXServiceInfo;
};

const KeetaFXAnchorClientAccessToken = Symbol('KeetaFXAnchorClientAccessToken');

const assertKeetaNetTokenPublicKeyString = createAssert<KeetaNetTokenPublicKeyString>();
async function getEndpoints(resolver: Resolver, request: Partial<Pick<ConversionInputCanonical, 'from' | 'to'>>, _ignored_account: InstanceType<typeof KeetaNetLib.Account>): Promise<GetEndpointsResult | null> {
	const criteria: ServiceSearchCriteria<'fx'> = {};
	if (request.from !== undefined) {
		criteria.inputCurrencyCode = request.from;
	}
	if (request.to !== undefined) {
		criteria.outputCurrencyCode = request.to;
	}

	const response = await resolver.lookup('fx', {
		...criteria
		// kycProviders: 'TODO' XXX:TODO
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

		const fromInfo = await serviceInfo.from('array');
		const allFrom = await Promise.all(fromInfo.map(async function(fromFn) {
			const from = await fromFn('object');

			const currencyCodes = await Promise.all((await from.currencyCodes('array')).map(async (currencyCode) => {
				const code = await currencyCode('string');
				return(assertKeetaNetTokenPublicKeyString(code));
			}));

			const to = await Promise.all((await from.to('array')).map(async (currencyCode) => {
				const code = await currencyCode('string');
				return(assertKeetaNetTokenPublicKeyString(code));
			}));

			const kycProvidersEntry = (await from.kycProviders?.('array'))?.map(async (providerFn) => {
				const provider = await providerFn('string');
				return(provider);
			});

			// eslint-disable-next-line @typescript-eslint/no-empty-object-type
			let kycProviders: { kycProviders: string[] } | {} = {};
			if (kycProvidersEntry && kycProvidersEntry.length > 0) {
				kycProviders = { kycProviders: await Promise.all(kycProvidersEntry) }
			}

			return({ currencyCodes, to, ...kycProviders });
		}));
		return([
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			id as unknown as ProviderID,
			{
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				operations: operationsFunctions as KeetaFXServiceInfo['operations'],
				from: allFrom
			}
		]);
	});

	if (serviceInfoPromises.length === 0) {
		return(null);
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const retval = Object.fromEntries(await Promise.all(serviceInfoPromises)) satisfies GetEndpointsResult as GetEndpointsResult;

	return(retval);
}

const isKeetaFXAnchorEstimateResponse = createIs<KeetaFXAnchorEstimateResponse>();
const isKeetaFXAnchorQuoteResponse = createIs<KeetaFXAnchorQuoteResponse>();
const isKeetaFXAnchorExchangeResponse = createIs<KeetaFXAnchorExchangeResponse>();

interface KeetaFXAnchorBaseConfig {
	client: KeetaNetUserClient;
	logger?: Logger | undefined;
}

class KeetaFXAnchorBase {
	protected readonly logger?: Logger | undefined;
	protected readonly client: KeetaNetUserClient;

	constructor(config: KeetaFXAnchorBaseConfig) {
		this.client = config.client;
		this.logger = config.logger;
	}
}

class KeetaFXAnchorProviderBase extends KeetaFXAnchorBase {
	readonly serviceInfo: KeetaFXServiceInfo;
	readonly providerID: ProviderID;
	readonly conversion: ConversionInputCanonical;
	private readonly parent: KeetaFXAnchorClient;

	constructor(serviceInfo: KeetaFXServiceInfo, providerID: ProviderID, conversion: ConversionInputCanonical, parent: KeetaFXAnchorClient) {
		const parentPrivate = parent._internals(KeetaFXAnchorClientAccessToken);
		super(parentPrivate);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.conversion = conversion;
		this.parent = parent;
	}

	async getEstimate(): Promise<KeetaFXAnchorEstimate> {
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
			return(requestInformationJSON.estimate);
		} else {
			throw(new Error('Service getEstimate does not exist'));
		}
	}

	/**
	 * Get a quote from the provider.  If an estimate is provided, it will
	 * be used to validate the quote is within the tolerance range.
	 *
	 * @param estimate An optional estimate to validate the quote against
	 * @param tolerance The tolerance, in percentage points, to allow the
	 *                  quote to vary from the estimate.  For example, a
	 *                  tolerance of 1.0 allows the quote to be 100% more
	 *                  or less than the estimate.  The default is 0.10
	 *                  (10%).
	 * @returns A promise that resolves to the quote response
	 */
	async getQuote(estimate?: KeetaFXAnchorEstimate, tolerance: number = 0.1): Promise<KeetaFXAnchorQuote> {
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

		if (estimate !== undefined && tolerance !== undefined) {
			const quoteAmount = new Decimal(requestInformationJSON.quote.convertedAmount);
			const estimateAmount = new Decimal(estimate.convertedAmount);
			const variation = Math.abs(quoteAmount.dividedBy(estimateAmount).toNumber() - 1);
			if (variation > tolerance) {
				throw(new Error(`FX Quote amount: ${requestInformationJSON.quote.convertedAmount} differs more than tolerance limit: ${tolerance} from estimate`));
			}
		}

		this.logger?.debug(`FX quote request successful, to provider ${serviceURL} for ${JSON.stringify(this.conversion)}`);
		return(requestInformationJSON.quote);
	}

	async createExchange(quote: KeetaFXAnchorQuote, block?: InstanceType<typeof KeetaNetLib.Block>): Promise<KeetaFXAnchorExchange> {
		let swapBlock = block;
		if (swapBlock === undefined) {
			/* Liquidity Provider that will complete the swap */
			const liquidityProvider = KeetaNetLib.Account.fromPublicKeyString(quote.account);

			/* Assume affinity is 'from' and assign appropriate variables */
			let sendAmount = BigInt(quote.request.amount);
			let receiveAmount = BigInt(quote.convertedAmount);

			/* If affinity is 'to' then reverse amounts */
			if (quote.request.affinity === 'to') {
				sendAmount = BigInt(quote.convertedAmount);
				receiveAmount = BigInt(quote.request.amount);
			}

			const from = { account: this.client.account, token: KeetaNetLib.Account.fromPublicKeyString(quote.request.from), amount: sendAmount };
			const to = { account: liquidityProvider, token: KeetaNetLib.Account.fromPublicKeyString(quote.request.to), amount: receiveAmount };
			swapBlock = await this.parent.createSwapRequest(from, to);
		}

		if (swapBlock == undefined) {
			throw(new Error('User Swap Block is undefined'));
		}

		const serviceURL = (await this.serviceInfo.operations.createExchange)();
		const requestInformation = await fetch(serviceURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				request: {
					quote: quote,
					block: Buffer.from(swapBlock.toBytes()).toString('base64')
				}
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaFXAnchorExchangeResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX exchange service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`FX exchange request failed: ${requestInformationJSON.error}`));
		}

		this.logger?.debug(`FX exchange request successful, to provider ${serviceURL} for ${swapBlock.hash.toString()}`);
		return({ exchangeID: requestInformationJSON.exchangeID });
	}

	async getExchangeStatus(exchangeID: string): Promise<KeetaFXAnchorExchange> {
		const serviceURL = (await this.serviceInfo.operations.getExchangeStatus)({ exchangeID });
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

		this.logger?.debug(`FX exchange status request successful, to provider ${serviceURL} for ${exchangeID}`);
		return({ exchangeID: requestInformationJSON.exchangeID });
	}

	/** @internal */
	_internals(accessToken: symbol) {
		if (accessToken !== KeetaFXAnchorClientAccessToken) {
			throw(new Error('invalid access token'));
		}

		return({
			parent: this.parent
		});

	}
}

/*
 * Various classes for the state machine:
 *   Estimate(optional) -> Quote(optional) -> Exchange -> ExchangeStatus
 */
class KeetaFXAnchorExchangeWithProvider {
	private readonly provider: KeetaFXAnchorProviderBase;
	readonly exchange: KeetaFXAnchorExchange

	constructor(provider: KeetaFXAnchorProviderBase, exchange: KeetaFXAnchorExchange) {
		this.provider = provider;
		this.exchange = exchange;
	}

	async getExchangeStatus(): Promise<KeetaFXAnchorExchange> {
		/* XXX:TODO: This should return something useful -- right now  it just returns the exchange ID... */
		return(await this.provider.getExchangeStatus(this.exchange.exchangeID));
	}
}

class KeetaFXAnchorQuoteWithProvider {
	private readonly provider: KeetaFXAnchorProviderBase;
	readonly quote: KeetaFXAnchorQuote;

	constructor(provider: KeetaFXAnchorProviderBase, quote: KeetaFXAnchorQuote) {
		this.provider = provider;
		this.quote = quote;
	}

	async createExchange(block?: InstanceType<typeof KeetaNetLib.Block>): Promise<KeetaFXAnchorExchangeWithProvider> {
		const exchange = await this.provider.createExchange(this.quote, block);
		return(new KeetaFXAnchorExchangeWithProvider(this.provider, exchange));
	}
}

class KeetaFXAnchorEstimateWithProvider {
	private readonly provider: KeetaFXAnchorProviderBase;
	readonly estimate: KeetaFXAnchorEstimate;

	constructor(provider: KeetaFXAnchorProviderBase, estimate: KeetaFXAnchorEstimate) {
		this.provider = provider;
		this.estimate = estimate;
	}

	async getQuote(tolerance?: number): Promise<KeetaFXAnchorQuoteWithProvider> {
		const quote = await this.provider.getQuote(this.estimate, tolerance);
		return(new KeetaFXAnchorQuoteWithProvider(this.provider, quote));
	}
}

class KeetaFXAnchorClient extends KeetaFXAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;
	readonly #signer: InstanceType<typeof KeetaNetLib.Account>;
	readonly #account: InstanceType<typeof KeetaNetLib.Account>;

	constructor(client: KeetaNetUserClient, config: KeetaFXAnchorClientConfig = {}) {
		super({ client, logger: config.logger });
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();

		if (config.signer) {
			this.#signer = config.signer;
		} else if ('signer' in client && client.signer !== null) {
			this.#signer = client.signer;
		} else if ('account' in client && client.account.hasPrivateKey) {
			this.#signer = client.account;
		} else {
			throw(new Error('KeetaFXAnchorClient requires a Signer or a UserClient with an associated Signer'));
		}

		if (config.account) {
			this.#account = config.account;
		} else if ('account' in client) {
			this.#account = client.account;
		} else {
			throw(new Error('KeetaFXAnchorClient requires an Account or a UserClient with an associated Account'));
		}
	}

	private async canonicalizeConversionTokens(input: Partial<ConversionInput>): Promise<Partial<Pick<ConversionInputCanonical, 'from' | 'to'>>> {
		let from = {}
		if (input.from !== undefined) {
			let fromToken: KeetaNetTokenPublicKeyString;
			if (KeetaNetLib.Account.isInstance(input.from) && input.from.isToken()) {
				fromToken = input.from.publicKeyString.get();
			} else {
				const tokenLookup = await this.resolver.lookupToken(input.from);
				if (tokenLookup === null) {
					// eslint-disable-next-line @typescript-eslint/no-base-to-string
					throw(new Error(`Could not convert from: ${input.from} to a token address`));
				}
				fromToken = tokenLookup.token;
			}
			from = { from: fromToken };
		}

		let to = {};
		if (input.to !== undefined) {
			let toToken: KeetaNetTokenPublicKeyString;
			if (KeetaNetLib.Account.isInstance(input.to) && input.to.isToken()) {
				toToken = input.to.publicKeyString.get();
			} else {
				const tokenLookup = await this.resolver.lookupToken(input.to);
				if (tokenLookup === null) {
					// eslint-disable-next-line @typescript-eslint/no-base-to-string
					throw(new Error(`Could not convert to: ${input.to} to a token address`));
				}
				toToken = tokenLookup.token;
			}
			to = { to: toToken };
		}
		return({ ...from, ...to });
	}

	private async canonicalizeConversionInput(input: ConversionInput): Promise<ConversionInputCanonical> {
		const amount = new Decimal(input.amount);
		if (amount.isNaN() || amount.lte(0)) {
			throw(new Error('invalid amount'));
		}

		const { from, to } = await this.canonicalizeConversionTokens(input);

		if (from === undefined || to === undefined) {
			throw(new Error('From and To are both required for a conversion'));
		}

		return({
			from,
			to,
			amount: amount.toString(),
			affinity: input.affinity
		});
	}

	async listPossibleConversions(input: Partial<Pick<ConversionInput, 'from' | 'to'>>, options: AccountOptions = {}): Promise<{ conversions: KeetaNetTokenPublicKeyString[] } | null> {
		if (input.from !== undefined && input.to !== undefined) {
			throw(new KeetaAnchorUserError('Only one of from or two should be provided'));
		}
		if (input.from === undefined && input.to === undefined) {
			throw(new KeetaAnchorUserError('At least one of from or two should be provided'));
		}
		const conversion = await this.canonicalizeConversionTokens(input);
		const account = options.account ?? this.#account;
		const providerEndpoints = await getEndpoints(this.resolver, conversion, account);
		if (providerEndpoints === null) {
			return(null);
		}

		const conversions = new Set<KeetaNetTokenPublicKeyString>();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for (const [_ignored_providerID, serviceInfo] of typedFxServiceEntries(providerEndpoints)) {
			for (const conversionPair of serviceInfo.from) {
				if (conversion.from !== undefined) {
					if (conversionPair.currencyCodes.includes(conversion.from)) {
						conversionPair.to.forEach(token => conversions.add(token));
					}
				} else if (conversion.to !== undefined) {
					if (conversionPair.to.includes(conversion.to)) {
						conversionPair.currencyCodes.forEach(token => conversions.add(token));
					}
				}
			}
		};

		return({ conversions: [...conversions] });
	}

	async getBaseProvidersForConversion(request: ConversionInput, options: AccountOptions = {}): Promise<KeetaFXAnchorProviderBase[] | null> {
		const conversion = await this.canonicalizeConversionInput(request);
		const account = options.account ?? this.#account;
		const providerEndpoints = await getEndpoints(this.resolver, conversion, account);
		if (providerEndpoints === null) {
			return(null);
		}

		const providers = typedFxServiceEntries(providerEndpoints).map(([providerID, serviceInfo]) => {
			return(new KeetaFXAnchorProviderBase(serviceInfo, providerID, conversion, this));
		});

		return(providers);
	}

	async getEstimates(request: ConversionInput, options: AccountOptions = {}): Promise<KeetaFXAnchorEstimateWithProvider[] | null> {
		const estimateProviders = await this.getBaseProvidersForConversion(request, options);
		if (estimateProviders === null) {
			return(null);
		}

		const estimates = await Promise.allSettled(estimateProviders.map(async (provider) => {
			const estimate = await provider.getEstimate();

			return(new KeetaFXAnchorEstimateWithProvider(provider, estimate));
		}));

		const results = estimates.filter(function(result) {
			return(result.status === 'fulfilled');
		}).map(function(result) {
			return(result.value);
		});

		if (results.length === 0) {
			return(null);
		}

		return(results);
	}

	async getQuotes(request: ConversionInput, options: AccountOptions = {}): Promise<KeetaFXAnchorQuoteWithProvider[] | null> {
		const estimateProviders = await this.getBaseProvidersForConversion(request, options);
		if (estimateProviders === null) {
			return(null);
		}

		const quotes = await Promise.allSettled(estimateProviders.map(async (provider) => {
			const quote = await provider.getQuote();

			return(new KeetaFXAnchorQuoteWithProvider(provider, quote));
		}));

		const results = quotes.filter(function(result) {
			return(result.status === 'fulfilled');
		}).map(function(result) {
			return(result.value);
		});

		if (results.length === 0) {
			return(null);
		}

		return(results);
	}

	async createSwapRequest(from: { account: KeetaNetAccount, token: KeetaNetToken, amount: bigint }, to: { account: KeetaNetAccount, token: KeetaNetToken, amount: bigint }): Promise<InstanceType<typeof KeetaNetLib.Block>> {
		const builder = this.client.initBuilder();
		builder.send(to.account, from.amount, from.token);
		builder.receive(to.account, to.amount, to.token, true)
		const blocks = await builder.computeBlocks();

		if (blocks.blocks.length !== 1) {
			throw(new Error('Compute Swap Request Generated more than 1 block'));
		}

		const block = blocks.blocks[0];
		if (block === undefined) {
			throw(new Error('Swap Block is undefined'));
		}

		return(block);
	}

	async acceptSwapRequest(request: InstanceType<typeof KeetaNetLib.Block>, expected: { token?: KeetaNetToken, amount?: bigint }): Promise<InstanceType<typeof KeetaNetLib.Block>[]> {
		const builder = this.client.initBuilder();

		const sendOperation = request.operations.find(({ type }) => KeetaNetLib.Block.OperationType.SEND === type);
		if (!sendOperation || sendOperation.type !== KeetaNetLib.Block.OperationType.SEND) {
			throw(new Error('Swap Request is missing send'));
		}
		if (!sendOperation.to.comparePublicKey(this.client.account)) {
			throw(new Error(`Swap Request send account does not match`));
		}
		if (expected.token !== undefined && !sendOperation.token.comparePublicKey(expected.token)) {
			throw(new Error('Swap Request send token does not match expected'))
		}
		if (expected.amount !== undefined && sendOperation.amount !== expected.amount) {
			throw(new Error('Swap Request send amount does not match expected'))
		}

		const receiveOperation = request.operations.find(({ type }) => KeetaNetLib.Block.OperationType.RECEIVE === type);
		if (!receiveOperation || receiveOperation.type !== KeetaNetLib.Block.OperationType.RECEIVE) {
			throw(new Error("Swap Request is missing receive operation"));
		}
		builder.send(request.account, receiveOperation.amount, receiveOperation.token);

		const blocks = await builder.computeBlocks();
		return([...blocks.blocks, request]);
	}


	/** @internal */
	_internals(accessToken: symbol) {
		if (accessToken !== KeetaFXAnchorClientAccessToken) {
			throw(new Error('invalid access token'));
		}

		return({
			resolver: this.resolver,
			logger: this.logger,
			client: this.client,
			signer: this.#signer,
			account: this.#account
		});

	}
}

export default KeetaFXAnchorClient;
