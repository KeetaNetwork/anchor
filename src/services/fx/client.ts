import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { getDefaultResolver } from '../../config.js';
import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceMetadata, ServiceSearchCriteria, SharedLookupCriteria } from '../../lib/resolver.ts';
import { Buffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';
import { validateURL } from '../../lib/utils/url.js';
import type { BrandedString } from '../../lib/utils/brand.ts';
import {
	assertKeetaNetTokenPublicKeyString,
	isKeetaFXAnchorEstimateResponse,
	isKeetaFXAnchorExchangeResponse,
	isKeetaFXAnchorQuoteResponse,
	Errors as FxErrors
} from './common.js';
import type {
	ConversionInput,
	ConversionInputCanonical,
	ConversionInputCanonicalJSON,
	KeetaFXAnchorEstimate,
	KeetaFXAnchorExchange,
	KeetaFXAnchorQuote,
	KeetaNetTokenPublicKeyString
} from './common.ts';
import { KeetaAnchorError, KeetaAnchorUserError } from '../../lib/error.js';

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
	logger?: Logger | undefined;
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

async function getEndpoints(resolver: Resolver, request: Partial<Pick<ConversionInputCanonical, 'from' | 'to'>>, _ignored_account: InstanceType<typeof KeetaNetLib.Account>, sharedCriteria?: SharedLookupCriteria): Promise<GetEndpointsResult | null> {
	const criteria: ServiceSearchCriteria<'fx'> = {};
	if (request.from !== undefined) {
		criteria.inputCurrencyCode = request.from.publicKeyString.get();
	}
	if (request.to !== undefined) {
		criteria.outputCurrencyCode = request.to.publicKeyString.get();
	}
	const response = await resolver.lookup('fx', {
		...criteria
		// kycProviders: 'TODO' XXX:TODO
	}, sharedCriteria);

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

	#parseConversionRequest(input: ConversionInputCanonicalJSON): ConversionInputCanonical {
		return({
			from: KeetaNetLib.Account.fromPublicKeyString(input.from),
			to: KeetaNetLib.Account.fromPublicKeyString(input.to),
			amount: BigInt(input.amount),
			affinity: input.affinity
		});
	}

	async #parseResponseError(data: { ok: false }) {
		if (typeof data !== 'object' || data === null) {
			throw(new Error('Response is not an error'));
		}

		if (!('ok' in data) || data.ok) {
			throw(new Error('Response is not an error'));
		}

		let errorStr;

		try {
			return(await KeetaAnchorError.fromJSON(data));
		} catch (error: unknown) {
			this.logger?.debug('Failed to parse error response as KeetaAnchorError', error, data);
		}

		if ('error' in data && typeof data.error === 'string') {
			errorStr = data.error;
		} else {
			errorStr = 'Unknown error';
		}

		return(new Error(`FX request failed: ${errorStr}`));
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
					request: KeetaNetLib.Utils.Conversion.toJSONSerializable(this.conversion)
				})
			});

			const requestInformationJSON: unknown = await requestInformation.json();
			if (!isKeetaFXAnchorEstimateResponse(requestInformationJSON)) {
				throw(new Error(`Invalid response from FX estimate service: ${JSON.stringify(requestInformationJSON)}`));
			}

			if (!requestInformationJSON.ok) {
				throw(await this.#parseResponseError(requestInformationJSON));
			}

			this.logger?.debug(`FX estimate request successful, to provider ${estimateURL} for ${JSON.stringify(KeetaNetLib.Utils.Conversion.toJSONSerializable(this.conversion))}`);
			const estimateJSON = requestInformationJSON.estimate;
			return({
				request: this.#parseConversionRequest(estimateJSON.request),
				convertedAmount: BigInt(estimateJSON.convertedAmount),
				expectedCost: {
					min: BigInt(estimateJSON.expectedCost.min),
					max: BigInt(estimateJSON.expectedCost.max),
					token: KeetaNetLib.Account.fromPublicKeyString(estimateJSON.expectedCost.token)
				},
				...(estimateJSON.convertedAmountBound !== undefined ? { convertedAmountBound: BigInt(estimateJSON.convertedAmountBound) } : {}),
				...(() => {
					if (estimateJSON.requiresQuote === undefined) {
						return({})
					} else if (estimateJSON.requiresQuote) {
						return({ requiresQuote: true });
					// We have to disable this as doing !estimateJSON.requiresQuote breaks the compiler, and that is what eslint wants us to do
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
					} else if (estimateJSON.requiresQuote === false) {
						return({
							requiresQuote: false,
							account: KeetaNetLib.Account.fromPublicKeyString(estimateJSON.account)
						});
					}
				})()
			});
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
				request: KeetaNetLib.Utils.Conversion.toJSONSerializable(this.conversion)
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaFXAnchorQuoteResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX quote service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(await this.#parseResponseError(requestInformationJSON));
		}

		if (estimate !== undefined && tolerance !== undefined) {
			const quoteAmount = BigInt(requestInformationJSON.quote.convertedAmount);
			const estimateAmount = BigInt(estimate.convertedAmount);
			const lowerBound = estimateAmount * BigInt(Math.round((1 - tolerance) * 100)) / 100n;
			const upperBound = estimateAmount * BigInt(Math.round((1 + tolerance) * 100)) / 100n;
			if (quoteAmount > upperBound || quoteAmount < lowerBound) {
				throw(new Error(`FX Quote amount: ${requestInformationJSON.quote.convertedAmount} differs more than tolerance limit: ${tolerance} from estimate`));
			}
		}

		this.logger?.debug(`FX quote request successful, to provider ${serviceURL} for ${JSON.stringify(KeetaNetLib.Utils.Conversion.toJSONSerializable(this.conversion))}`);
		const quoteJSON = requestInformationJSON.quote;
		return({
			request: this.#parseConversionRequest(quoteJSON.request),
			account: KeetaNetLib.Account.fromPublicKeyString(quoteJSON.account),
			convertedAmount: BigInt(quoteJSON.convertedAmount),
			cost: {
				amount: BigInt(quoteJSON.cost.amount),
				token: KeetaNetLib.Account.fromPublicKeyString(quoteJSON.cost.token)
			},
			signed: quoteJSON.signed
		});
	}

	async createExchange(input: { quote: KeetaFXAnchorQuote } | { estimate: KeetaFXAnchorEstimate; }, block?: InstanceType<typeof KeetaNetLib.Block>): Promise<KeetaFXAnchorExchange> {
		let swapBlock = block;
		if (swapBlock === undefined) {
			/* Liquidity Provider that will complete the swap */
			let liquidityProvider;
			let request;
			let convertedAmountBound: bigint;

			if ('estimate' in input) {
				if (input.estimate.requiresQuote !== false) {
					throw(new FxErrors.QuoteRequired());
				}

				liquidityProvider = input.estimate.account;
				request = input.estimate.request;
				if (input.estimate.convertedAmountBound !== undefined) {
					convertedAmountBound = input.estimate.convertedAmountBound;
				} else {
					convertedAmountBound = input.estimate.convertedAmount;
				}
			} else {
				liquidityProvider = input.quote.account;
				request = input.quote.request;
				convertedAmountBound = input.quote.convertedAmount;
			}


			let sendAmount;
			let receiveAmount;

			if (request.affinity === 'to') {
				sendAmount = convertedAmountBound;
				receiveAmount = request.amount;
			} else if (request.affinity === 'from') {
				sendAmount = request.amount;
				receiveAmount = convertedAmountBound;
			} else {
				throw(new Error('Invalid affinity in conversion request'));
			}

			/* Construct the required operations for the swap request */
			const builder = this.client.initBuilder();

			if ('quote' in input) {
				/* If cost is required then send the required amount as well */
				if (input.quote.cost.amount > 0) {
					builder.send(liquidityProvider, input.quote.cost.amount, input.quote.cost.token);
				}
			} else if ('estimate' in input) {
				if (input.estimate.expectedCost.max > 0) {
					builder.send(liquidityProvider, input.estimate.expectedCost.max, input.estimate.expectedCost.token);
				}
			}

			builder.receive(liquidityProvider, receiveAmount, request.to, request.affinity === 'to');
			builder.send(liquidityProvider, sendAmount, request.from);

			const blocks = await builder.computeBlocks();
			if (blocks.blocks.length !== 1) {
				throw(new Error('Creating Swap Generated more than 1 block'));
			}
			swapBlock = blocks.blocks[0];
		}

		if (swapBlock == undefined) {
			throw(new Error('User Swap Block is undefined'));
		}

		let bodyAdditionalData: { quote: KeetaFXAnchorQuote; } | { request: ConversionInputCanonical; };

		if ('quote' in input) {
			bodyAdditionalData = { quote: input.quote };
		} else {
			bodyAdditionalData = { request: input.estimate.request };
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
					...(KeetaNetLib.Utils.Conversion.toJSONSerializable(bodyAdditionalData)),
					block: Buffer.from(swapBlock.toBytes()).toString('base64')
				}
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaFXAnchorExchangeResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX exchange service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(await this.#parseResponseError(requestInformationJSON));
		}

		this.logger?.debug(`FX exchange request successful, to provider ${serviceURL} for ${swapBlock.hash.toString()}`);
		return(requestInformationJSON);
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
			throw(await this.#parseResponseError(requestInformationJSON));
		}

		this.logger?.debug(`FX exchange status request successful, to provider ${serviceURL} for ${exchangeID}`);
		return(requestInformationJSON);
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

interface CanCreateExchange {
	readonly isQuote: boolean;

	get request(): ConversionInputCanonical;

	createExchange(block?: InstanceType<typeof KeetaNetLib.Block>): Promise<KeetaFXAnchorExchangeWithProvider>;
}

class KeetaFXAnchorQuoteWithProvider implements CanCreateExchange {
	private readonly provider: KeetaFXAnchorProviderBase;
	readonly quote: KeetaFXAnchorQuote;
	readonly isQuote = true as const;

	constructor(provider: KeetaFXAnchorProviderBase, quote: KeetaFXAnchorQuote) {
		this.provider = provider;
		this.quote = quote;
	}

	get request(): ConversionInputCanonical {
		return(this.quote.request);
	}

	async createExchange(block?: InstanceType<typeof KeetaNetLib.Block>): Promise<KeetaFXAnchorExchangeWithProvider> {
		const exchange = await this.provider.createExchange({ quote: this.quote }, block);
		return(new KeetaFXAnchorExchangeWithProvider(this.provider, exchange));
	}
}

class KeetaFXAnchorEstimateWithProvider implements CanCreateExchange {
	private readonly provider: KeetaFXAnchorProviderBase;
	readonly estimate: KeetaFXAnchorEstimate;
	readonly isQuote = false as const;

	constructor(provider: KeetaFXAnchorProviderBase, estimate: KeetaFXAnchorEstimate) {
		this.provider = provider;
		this.estimate = estimate;
	}

	get request(): ConversionInputCanonical {
		return(this.estimate.request);
	}

	async getQuote(tolerance?: number): Promise<KeetaFXAnchorQuoteWithProvider> {
		const quote = await this.provider.getQuote(this.estimate, tolerance);
		return(new KeetaFXAnchorQuoteWithProvider(this.provider, quote));
	}

	async createExchange(block?: InstanceType<typeof KeetaNetLib.Block>): Promise<KeetaFXAnchorExchangeWithProvider> {
		const exchange = await this.provider.createExchange({ estimate: this.estimate }, block);
		return(new KeetaFXAnchorExchangeWithProvider(this.provider, exchange));
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
			let fromToken: ConversionInputCanonical['from'];
			if (KeetaNetLib.Account.isInstance(input.from) && input.from.isToken()) {
				fromToken = input.from;
			} else {
				const tokenLookup = await this.resolver.lookupToken(input.from);
				if (tokenLookup === null) {
					// eslint-disable-next-line @typescript-eslint/no-base-to-string
					throw(new Error(`Could not convert from: ${input.from} to a token address`));
				}
				fromToken = KeetaNetLib.Account.fromPublicKeyString(tokenLookup.token);
			}
			from = { from: fromToken };
		}

		let to = {};
		if (input.to !== undefined) {
			let toToken: ConversionInputCanonical['to'];
			if (KeetaNetLib.Account.isInstance(input.to) && input.to.isToken()) {
				toToken = input.to;
			} else {
				const tokenLookup = await this.resolver.lookupToken(input.to);
				if (tokenLookup === null) {
					// eslint-disable-next-line @typescript-eslint/no-base-to-string
					throw(new Error(`Could not convert to: ${input.to} to a token address`));
				}
				toToken = KeetaNetLib.Account.fromPublicKeyString(tokenLookup.token);
			}
			to = { to: toToken };
		}
		return({ ...from, ...to });
	}

	private async canonicalizeConversionInput(input: ConversionInput): Promise<ConversionInputCanonical> {
		const amount = BigInt(input.amount);
		if (amount < 0) {
			throw(new Error('Invalid Conversion Amount'));
		}

		const { from, to } = await this.canonicalizeConversionTokens(input);

		if (from === undefined || to === undefined) {
			throw(new Error('From and To are both required for a conversion'));
		}

		return({
			from,
			to,
			amount: amount,
			affinity: input.affinity
		});
	}

	async listPossibleConversions(input: Partial<Pick<ConversionInput, 'from' | 'to'>>, options: AccountOptions = {}, sharedCriteria?: SharedLookupCriteria): Promise<{ conversions: KeetaNetTokenPublicKeyString[] } | null> {
		if (input.from !== undefined && input.to !== undefined) {
			throw(new KeetaAnchorUserError('Only one of from or two should be provided'));
		}
		if (input.from === undefined && input.to === undefined) {
			throw(new KeetaAnchorUserError('At least one of from or two should be provided'));
		}
		const conversion = await this.canonicalizeConversionTokens(input);
		const account = options.account ?? this.#account;
		const providerEndpoints = await getEndpoints(this.resolver, conversion, account, sharedCriteria);
		if (providerEndpoints === null) {
			return(null);
		}

		const conversions = new Set<KeetaNetTokenPublicKeyString>();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for (const [_ignored_providerID, serviceInfo] of typedFxServiceEntries(providerEndpoints)) {
			for (const conversionPair of serviceInfo.from) {
				if (conversion.from !== undefined) {
					if (conversionPair.currencyCodes.includes(conversion.from.publicKeyString.get())) {
						conversionPair.to.forEach((token) => {
							if (conversion.from?.publicKeyString.get() !== token) {
								conversions.add(token);
							}
						});
					}
				} else if (conversion.to !== undefined) {
					if (conversionPair.to.includes(conversion.to.publicKeyString.get())) {
						conversionPair.currencyCodes.forEach((token) => {
							if (conversion.to?.publicKeyString.get() !== token) {
								conversions.add(token);
							}
						});
					}
				}
			}
		};

		return({ conversions: [...conversions] });
	}

	async getBaseProvidersForConversion(request: ConversionInput, options: AccountOptions = {}, sharedCriteria?: SharedLookupCriteria): Promise<KeetaFXAnchorProviderBase[] | null> {
		const conversion = await this.canonicalizeConversionInput(request);
		const account = options.account ?? this.#account;
		const providerEndpoints = await getEndpoints(this.resolver, conversion, account, sharedCriteria);
		if (providerEndpoints === null) {
			return(null);
		}

		const providers = typedFxServiceEntries(providerEndpoints).map(([providerID, serviceInfo]) => {
			return(new KeetaFXAnchorProviderBase(serviceInfo, providerID, conversion, this));
		});

		return(providers);
	}

	async getEstimates(request: ConversionInput, options: AccountOptions = {}, sharedCriteria?: SharedLookupCriteria): Promise<KeetaFXAnchorEstimateWithProvider[] | null> {
		const estimateProviders = await this.getBaseProvidersForConversion(request, options, sharedCriteria);
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

	async #multiRequestQuotes(request: ConversionInput, options: AccountOptions = {}, sharedCriteria?: SharedLookupCriteria): Promise<({
		provider: KeetaFXAnchorProviderBase;
	} & ({
		quote: KeetaFXAnchorQuoteWithProvider;
	} | {
		quote: null;
		error: unknown;
	}))[]> {
		const estimateProviders = await this.getBaseProvidersForConversion(request, options, sharedCriteria);
		if (estimateProviders === null) {
			return([]);
		}

		return(await Promise.all(estimateProviders.map(async (provider) => {
			try {
				const quote = await provider.getQuote();
				return({ provider, quote: new KeetaFXAnchorQuoteWithProvider(provider, quote) });
			} catch (error) {
				return({ provider, quote: null, error });
			}
		})));
	}

	async getQuotes(request: ConversionInput, options: AccountOptions = {}, sharedCriteria?: SharedLookupCriteria): Promise<KeetaFXAnchorQuoteWithProvider[] | null> {
		const quotes = await this.#multiRequestQuotes(request, options, sharedCriteria);

		const results = quotes
			.map(function(quote) {
				return(quote.quote);
			})
			.filter(function(quote): quote is KeetaFXAnchorQuoteWithProvider {
				return(quote !== null);
			});

		if (results.length === 0) {
			return(null);
		}

		return(results);
	}

	async getQuotesOrEstimates(request: ConversionInput, options: AccountOptions = {}, sharedCriteria?: SharedLookupCriteria): Promise<(KeetaFXAnchorQuoteWithProvider | KeetaFXAnchorEstimateWithProvider)[] | null> {
		const quotesAndEstimates = await this.#multiRequestQuotes(request, options, sharedCriteria);

		const results = await Promise.allSettled(quotesAndEstimates.map(async (provider) => {
			if (provider.quote) {
				return(provider.quote);
			} else {
				if (!(FxErrors.QuoteIssuanceDisabled.isInstance(provider.error))) {
					throw(provider.error);
				}

				const estimate = await provider.provider.getEstimate();
				return(new KeetaFXAnchorEstimateWithProvider(provider.provider, estimate));
			}
		}));

		const filtered = results.filter(function(result) {
			return(result.status === 'fulfilled');
		}).map(function(result) {
			return(result.value);
		});

		return(filtered);
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
