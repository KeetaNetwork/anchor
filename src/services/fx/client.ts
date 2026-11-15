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
	isKeetaFXAnchorMarketPricesResponse,
	isKeetaFXAnchorQuoteResponse,
	Errors as FXErrors
} from './common.js';
import type {
	ConversionInput,
	ConversionInputCanonical,
	ConversionInputCanonicalJSON,
	KeetaFXAnchorEstimate,
	KeetaFXAnchorExchange,
	KeetaFXAnchorMarketPrices,
	KeetaFXAnchorMarketPricesRequest,
	KeetaFXAnchorMarketPriceRatio,
	KeetaFXAnchorQuote,
	KeetaNetToken,
	KeetaNetTokenPublicKeyString
} from './common.ts';
import { AnchorExternalBuilder } from '../../lib/anchor-external.js';
import type { AnchorExternalInput } from '../../lib/anchor-external.js';
import { KeetaAnchorError, KeetaAnchorUserError } from '../../lib/error.js';
import { resolveSharedAnchorMetadataLegalExtension } from '../../lib/metadata.types.js';
import type { AnchorMetadataLegalField, SharedAnchorMetadataLegalExtension } from '../../lib/metadata.types.js';
import type { AnchorReference } from '../../lib/anchor-status.js';

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
 * Controls how {@link KeetaFXAnchorClient.getPrices} coalesces concurrent
 * calls that share the same base (`priceIn`) into fewer `getMarketPrices`
 * requests.
 */
export interface KeetaFXAnchorClientGetPricesBatching {
	/**
	 * How long to wait after each `getPrices` call for additional calls
	 * with the same base before sending the batched `getMarketPrices`
	 * request. Each new same-base call resets this timer.
	 *
	 * Defaults to `25`.
	 */
	waitMs: number;
	/**
	 * Maximum time to wait from the first `getPrices` call in a batch
	 * before flushing, even if new same-base calls keep arriving.
	 *
	 * Defaults to `100` for the client default. When omitted from a custom
	 * object, defaults to `4 * waitMs`.
	 */
	maxWaitMs?: number;
}

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
	/**
	 * How long `getPrices` waits for additional calls with the same base
	 * so their provider `getMarketPrices` requests can be batched together.
	 *
	 * - `true` / omitted - (`waitMs: 25`, `maxWaitMs: 100`)
	 * - `false` - disable batching
	 * - `{ waitMs, maxWaitMs? }` - custom timing (`maxWaitMs` defaults to `4 * waitMs`)
	 */
	getPricesBatching?: KeetaFXAnchorClientGetPricesBatching | boolean;
	/**
	 * Caps the client applies to every quote and estimate. See
	 * {@link KeetaFXAnchorClientDefaultLimits}.
	 */
	defaultLimits?: KeetaFXAnchorClientDefaultLimits;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'> & AccountOptions;

function typedFxServiceEntries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.entries(obj) as [keyof T, T[keyof T]][]);
}

type KeetaFXAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['fx']>[string]['operations']]: (params?: { [key: string]: string; }) => URL;
};

interface KeetaFXServiceInfo extends SharedAnchorMetadataLegalExtension {
	operations: {
		[operation in keyof KeetaFXAnchorOperations]: Promise<KeetaFXAnchorOperations[operation]>;
	},
	from: NonNullable<ServiceMetadata['services']['fx']>[string]['from'];
}

type GetEndpointsResult = {
	[providerID: ProviderID]: KeetaFXServiceInfo;
};

const KeetaFXAnchorClientAccessToken = Symbol('KeetaFXAnchorClientAccessToken');

async function getEndpoints(
	resolver: Resolver,
	request: Partial<Pick<ConversionInputCanonical, 'from' | 'to' | 'affinity'>> & Pick<GetProvidersOptions, 'requiredOperations'>,
	_ignored_account: InstanceType<typeof KeetaNetLib.Account>,
	sharedCriteria?: SharedLookupCriteria,
	options?: { logger?: Logger | undefined; }
): Promise<GetEndpointsResult | null> {
	const criteria: ServiceSearchCriteria<'fx'> = {};
	if (request.from !== undefined) {
		criteria.inputCurrencyCode = request.from.publicKeyString.get();
	}
	if (request.to !== undefined) {
		criteria.outputCurrencyCode = request.to.publicKeyString.get();
	}

	if (request.requiredOperations) {
		criteria.requiredOperations = request.requiredOperations;
	}

	if (request.affinity !== undefined) {
		criteria.supportedAffinity = request.affinity;
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
				...(await resolveSharedAnchorMetadataLegalExtension(serviceInfo.legal, { logger: options?.logger })),
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

/**
 * Limits the caller sets on the block that `createExchange` builds, from
 * the terms it showed the user. The limits apply only when
 * `createExchange` builds the block, not to a block the caller gives.
 *
 * The limits add to the client's `defaultLimits`; they never lift them.
 * - With affinity `to`, the anchor sets the amount sent, so `maxSend` is
 *   required. With affinity `from`, it sets the amount received, so
 *   `minReceive` is required.
 * - A fee in a token other than `from` or `to` needs `maxCost`, since no
 *   default can price it.
 * - A fee in `from` or `to` must also be within `defaultLimits.maxCostBps`.
 * - An estimate bound must also be within
 *   `defaultLimits.maxEstimateBoundBps` of its converted amount.
 */
export interface KeetaFXAnchorExchangeLimits {
	/**
	 * The most of the `from` token the block may send for the conversion,
	 * not counting the fee. Required for affinity `to`.
	 */
	maxSend?: bigint;
	/**
	 * The least of the `to` token the block may receive. Required for
	 * affinity `from`.
	 */
	minReceive?: bigint;
	/**
	 * The most the fee may be. A non-zero fee must also be in this token.
	 * A fee in `from` or `to` must also be within the default fee cap.
	 */
	maxCost?: { token: KeetaNetToken; amount: bigint; };
}

export interface KeetaFXAnchorCreateExchangeOptions {
	inputs?: readonly AnchorExternalInput[];
	limits?: KeetaFXAnchorExchangeLimits;
}

/**
 * Caps `createExchange` applies to every block it builds, on top of any
 * caller limits. They do not filter quotes or estimates. Set a cap to
 * `null` to turn it off, or raise it to accept larger terms.
 */
export interface KeetaFXAnchorClientDefaultLimits {
	/**
	 * The most a fee in the `from` or `to` token may be, in basis points
	 * of the amount the conversion sends or receives in that token.
	 *
	 * Defaults to `100` (1%).
	 */
	maxCostBps?: number | null;
	/**
	 * The furthest an estimate's bound may be from its converted amount,
	 * in basis points of the converted amount.
	 *
	 * Defaults to `500` (5%).
	 */
	maxEstimateBoundBps?: number | null;
}

type ResolvedDefaultLimits = { [K in keyof KeetaFXAnchorClientDefaultLimits]-?: number | null; };

function resolveDefaultLimits(input: KeetaFXAnchorClientDefaultLimits | undefined): ResolvedDefaultLimits {
	const resolved: ResolvedDefaultLimits = {
		maxCostBps: input?.maxCostBps === undefined ? 100 : input.maxCostBps,
		maxEstimateBoundBps: input?.maxEstimateBoundBps === undefined ? 500 : input.maxEstimateBoundBps
	};

	for (const [ name, value ] of Object.entries(resolved)) {
		if (value !== null && (!Number.isInteger(value) || value < 0)) {
			throw(new Error(`defaultLimits.${name} must be a non-negative integer or null`));
		}
	}

	if (resolved.maxEstimateBoundBps !== null && resolved.maxEstimateBoundBps > 10000) {
		throw(new Error('defaultLimits.maxEstimateBoundBps must be at most 10000'));
	}

	return(resolved);
}

type ExchangeTerms = { sendAmount: bigint; receiveAmount: bigint; costAmount: bigint; costToken: KeetaNetToken; };

/**
 * The amounts an exchange block sends and receives for a conversion, given
 * the converted amount it commits to and its fee.
 */
function exchangeTerms(conversion: ConversionInputCanonical, convertedAmount: bigint, cost: { amount: bigint; token: KeetaNetToken; }): ExchangeTerms {
	if (conversion.affinity === 'to') {
		return({ sendAmount: convertedAmount, receiveAmount: conversion.amount, costAmount: cost.amount, costToken: cost.token });
	}

	return({ sendAmount: conversion.amount, receiveAmount: convertedAmount, costAmount: cost.amount, costToken: cost.token });
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

export class KeetaFXAnchorProviderBase extends KeetaFXAnchorBase {
	readonly serviceInfo: KeetaFXServiceInfo;
	readonly providerID: ProviderID;
	readonly conversion: ConversionInputCanonical;
	readonly options: Pick<AccountOptions, 'account'> | undefined;
	private readonly parent: KeetaFXAnchorClient;
	readonly #defaultLimits: ResolvedDefaultLimits;

	constructor(serviceInfo: KeetaFXServiceInfo, providerID: ProviderID, conversion: ConversionInputCanonical, parent: KeetaFXAnchorClient, options?: Pick<AccountOptions, 'account'>) {
		const parentPrivate = parent._internals(KeetaFXAnchorClientAccessToken);
		super(parentPrivate);

		this.#defaultLimits = parentPrivate.defaultLimits;
		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.conversion = conversion;
		this.parent = parent;
		this.options = options;
	}

	/**
	 * Checks that the anchor's echoed request matches this conversion and
	 * returns `this.conversion`. Throws when any field differs.
	 */
	#bindConversion(echoed: ConversionInputCanonical | ConversionInputCanonicalJSON): ConversionInputCanonical {
		const own = this.conversion;
		const mismatched: string[] = [];
		if (!KeetaNetLib.Account.toAccount(echoed.from).comparePublicKey(own.from)) {
			mismatched.push('from');
		}
		if (!KeetaNetLib.Account.toAccount(echoed.to).comparePublicKey(own.to)) {
			mismatched.push('to');
		}
		if (BigInt(echoed.amount) !== own.amount) {
			mismatched.push('amount');
		}
		if (echoed.affinity !== own.affinity) {
			mismatched.push('affinity');
		}
		if (echoed.preferredCostAsset !== own.preferredCostAsset) {
			mismatched.push('preferredCostAsset');
		}
		if (mismatched.length > 0) {
			throw(new FXErrors.ResponseMismatch(`FX provider ${String(this.providerID)} answered for a different conversion than requested (${mismatched.join(', ')})`));
		}

		return(own);
	}

	/**
	 * Checks that the anchor's amounts are possible: a positive converted
	 * amount and bound, and a fee range that is not negative or reversed.
	 */
	#assertAmounts(convertedAmount: bigint, convertedAmountBound: bigint | undefined, costMin: bigint, costMax: bigint): void {
		const isConvertedInvalid = convertedAmount <= 0n || (convertedAmountBound ?? 1n) <= 0n;
		const isCostInvalid = costMin < 0n || costMax < costMin;
		if (isConvertedInvalid || isCostInvalid) {
			throw(new FXErrors.ResponseMismatch(`FX provider ${String(this.providerID)} gave invalid amounts (converted ${convertedAmount}, bound ${convertedAmountBound ?? 'none'}, fee ${costMin} to ${costMax})`));
		}
	}

	/**
	 * Checks that a non-zero fee is in a token the user expects to pay
	 * with: the `from` or `to` token, the network base token, or the
	 * requested `preferredCostAsset`. Throws when it is any other token.
	 */
	#assertCostToken(cost: { amount: bigint; token: KeetaNetToken }): void {
		if (cost.amount === 0n) {
			return;
		}

		const own = this.conversion;
		const allowed = [ own.from, own.to, this.client.baseToken ];
		if (own.preferredCostAsset !== undefined) {
			allowed.push(KeetaNetLib.Account.fromPublicKeyString(own.preferredCostAsset));
		}

		const isAllowed = allowed.some(function(token) {
			return(token.comparePublicKey(cost.token));
		});
		if (!isAllowed) {
			throw(new FXErrors.ResponseMismatch(`FX provider ${String(this.providerID)} charges its fee in a token that is not part of the conversion (${cost.token.publicKeyString.get()})`));
		}
	}

	/**
	 * Checks that an estimate's bound is on the safe side of its converted
	 * amount: no more for affinity `from`, no less for affinity `to`.
	 * Throws when it is on the other side.
	 */
	#assertEstimateBound(convertedAmount: bigint, convertedAmountBound: bigint | undefined): void {
		if (convertedAmountBound === undefined) {
			return;
		}

		const affinity = this.conversion.affinity;
		const isInvalid = affinity === 'from' ? convertedAmountBound > convertedAmount : convertedAmountBound < convertedAmount;
		if (isInvalid) {
			throw(new FXErrors.ResponseMismatch(`FX provider ${String(this.providerID)} gave an estimate bound of ${convertedAmountBound} that is on the wrong side of its converted amount ${convertedAmount} for affinity "${affinity}"`));
		}
	}

	/**
	 * Checks every amount the anchor sets in the block against the
	 * caller's limits and the client's default caps. Both must hold, so
	 * a limit copied from the anchor's own quote cannot lift a default.
	 * Throws when an amount is not bounded or is past its bound. See
	 * {@link KeetaFXAnchorExchangeLimits}.
	 */
	#assertSigningLimits(terms: ExchangeTerms, estimate: { convertedAmount: bigint; convertedAmountBound: bigint; } | undefined, limits: KeetaFXAnchorExchangeLimits | undefined): void {
		this.#assertAmountLimits(terms, limits);
		if (estimate !== undefined) {
			this.#assertBoundCap(estimate.convertedAmount, estimate.convertedAmountBound);
		}
		this.#assertCostLimits(terms, limits?.maxCost);
	}

	/**
	 * Checks the amounts sent and received against the caller's limits.
	 * The side the provider sets must have a limit: `maxSend` for affinity
	 * `to`, `minReceive` for affinity `from`.
	 */
	#assertAmountLimits(terms: ExchangeTerms, limits: KeetaFXAnchorExchangeLimits | undefined): void {
		const affinity = this.conversion.affinity;
		if (affinity === 'to' && limits?.maxSend === undefined) {
			throw(new FXErrors.ExchangeLimitExceeded('FX exchange with affinity "to" needs limits.maxSend, because the provider sets the amount sent'));
		}
		if (affinity === 'from' && limits?.minReceive === undefined) {
			throw(new FXErrors.ExchangeLimitExceeded('FX exchange with affinity "from" needs limits.minReceive, because the provider sets the amount received'));
		}

		if (limits?.maxSend !== undefined && terms.sendAmount > limits.maxSend) {
			throw(new FXErrors.ExchangeLimitExceeded(`FX exchange would send ${terms.sendAmount}, more than the limit of ${limits.maxSend}`));
		}
		if (limits?.minReceive !== undefined && terms.receiveAmount < limits.minReceive) {
			throw(new FXErrors.ExchangeLimitExceeded(`FX exchange would receive ${terms.receiveAmount}, less than the limit of ${limits.minReceive}`));
		}
	}

	/**
	 * Checks that an estimate's bound is within the default cap of its
	 * converted amount.
	 */
	#assertBoundCap(convertedAmount: bigint, convertedAmountBound: bigint): void {
		const maxBps = this.#defaultLimits.maxEstimateBoundBps;
		if (maxBps === null) {
			return;
		}

		const distance = convertedAmount > convertedAmountBound ? convertedAmount - convertedAmountBound : convertedAmountBound - convertedAmount;
		if (distance * 10000n > convertedAmount * BigInt(maxBps)) {
			throw(new FXErrors.ExchangeLimitExceeded(`FX estimate bound of ${convertedAmountBound} is more than ${maxBps} basis points from its converted amount ${convertedAmount}; raise defaultLimits.maxEstimateBoundBps to accept it`));
		}
	}

	/**
	 * Checks a non-zero fee against the caller's `maxCost` and, for a fee
	 * in `from` or `to`, against the default fee cap. A fee in any other
	 * token needs `maxCost`.
	 */
	#assertCostLimits(terms: ExchangeTerms, maxCost: KeetaFXAnchorExchangeLimits['maxCost']): void {
		if (terms.costAmount === 0n) {
			return;
		}

		if (maxCost !== undefined) {
			if (!maxCost.token.comparePublicKey(terms.costToken)) {
				throw(new FXErrors.ExchangeLimitExceeded(`FX exchange fee is in ${terms.costToken.publicKeyString.get()}, not in the limit token ${maxCost.token.publicKeyString.get()}`));
			}
			if (terms.costAmount > maxCost.amount) {
				throw(new FXErrors.ExchangeLimitExceeded(`FX exchange fee of ${terms.costAmount} is more than the limit of ${maxCost.amount}`));
			}
		}

		const base = this.#costBase(terms);
		if (base === null) {
			if (maxCost === undefined) {
				throw(new FXErrors.ExchangeLimitExceeded(`FX exchange fee is in ${terms.costToken.publicKeyString.get()}, which is not part of the conversion; set limits.maxCost to accept it`));
			}
			return;
		}

		const maxBps = this.#defaultLimits.maxCostBps;
		if (maxBps !== null && terms.costAmount * 10000n > base * BigInt(maxBps)) {
			throw(new FXErrors.ExchangeLimitExceeded(`FX exchange fee of ${terms.costAmount} is more than ${maxBps} basis points of ${base}; raise defaultLimits.maxCostBps to accept it`));
		}
	}

	/**
	 * The amount a fee is capped against: what the conversion sends when
	 * the fee is in `from`, what it receives when the fee is in `to`, or
	 * `null` for a fee in any other token.
	 */
	#costBase(terms: ExchangeTerms): bigint | null {
		if (terms.costToken.comparePublicKey(this.conversion.from)) {
			return(terms.sendAmount);
		}
		if (terms.costToken.comparePublicKey(this.conversion.to)) {
			return(terms.receiveAmount);
		}
		return(null);
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

	async #getEndpoint(operation: keyof KeetaFXAnchorOperations, params?: { [key: string]: string; }): Promise<URL> {
		const operationFn = await this.serviceInfo.operations[operation];
		if (operationFn === undefined) {
			throw(new KeetaAnchorUserError(`Provider ${String(this.providerID)} does not support "${operation}" operation`));
		}
		return(operationFn(params));
	}

	async getEstimate(): Promise<KeetaFXAnchorEstimate> {
		const estimateURL = await this.#getEndpoint('getEstimate');

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
		const estimate: KeetaFXAnchorEstimate = {
			request: this.#bindConversion(estimateJSON.request),
			convertedAmount: BigInt(estimateJSON.convertedAmount),
			expectedCost: {
				min: BigInt(estimateJSON.expectedCost.min),
				max: BigInt(estimateJSON.expectedCost.max),
				token: KeetaNetLib.Account.fromPublicKeyString(estimateJSON.expectedCost.token)
			},
			...(estimateJSON.convertedAmountBound !== undefined ? { convertedAmountBound: BigInt(estimateJSON.convertedAmountBound) } : {}),
			...(() => {
				if (estimateJSON.canPerformExchange === false) {
					return({ canPerformExchange: false });
				} else if (estimateJSON.requiresQuote === undefined) {
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
		};

		const estimateCost = { amount: estimate.expectedCost.max, token: estimate.expectedCost.token };
		this.#assertAmounts(estimate.convertedAmount, estimate.convertedAmountBound, estimate.expectedCost.min, estimate.expectedCost.max);
		this.#assertEstimateBound(estimate.convertedAmount, estimate.convertedAmountBound);
		this.#assertCostToken(estimateCost);

		return(estimate);
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
		const serviceURL = await this.#getEndpoint('getQuote');
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
		const quote: KeetaFXAnchorQuote = {
			request: this.#bindConversion(quoteJSON.request),
			account: KeetaNetLib.Account.fromPublicKeyString(quoteJSON.account),
			convertedAmount: BigInt(quoteJSON.convertedAmount),
			cost: {
				amount: BigInt(quoteJSON.cost.amount),
				token: KeetaNetLib.Account.fromPublicKeyString(quoteJSON.cost.token)
			},
			signed: quoteJSON.signed
		};

		this.#assertAmounts(quote.convertedAmount, undefined, quote.cost.amount, quote.cost.amount);
		this.#assertCostToken(quote.cost);

		return(quote);
	}

	/**
	 * Checks the terms of a quote or estimate as `createExchange` would
	 * before it signs, without building or sending anything. Throws the
	 * same errors `createExchange` would.
	 */
	checkExchange(input: { quote: KeetaFXAnchorQuote } | { estimate: KeetaFXAnchorEstimate; }, options?: Pick<KeetaFXAnchorCreateExchangeOptions, 'limits'>): void {
		this.#bindConversion('quote' in input ? input.quote.request : input.estimate.request);
		this.#checkExchangeTerms(input, options?.limits);
	}

	/**
	 * Every check `createExchange` runs on the anchor's terms before it
	 * builds the block. Returns the terms the block commits to.
	 */
	#checkExchangeTerms(input: { quote: KeetaFXAnchorQuote } | { estimate: KeetaFXAnchorEstimate; }, limits: KeetaFXAnchorExchangeLimits | undefined): { liquidityProvider: KeetaFXAnchorQuote['account']; terms: ExchangeTerms; } {
		let liquidityProvider;
		let convertedAmountBound: bigint;
		let costAmount;
		let costToken;
		let estimateTerms;

		if ('estimate' in input) {
			if (input.estimate.canPerformExchange === false) {
				throw(new KeetaAnchorUserError('The provided estimate indicates that the exchange cannot be performed'));
			}

			if (input.estimate.requiresQuote !== false) {
				throw(new FXErrors.QuoteRequired());
			}

			liquidityProvider = input.estimate.account;
			convertedAmountBound = input.estimate.convertedAmountBound ?? input.estimate.convertedAmount;
			costAmount = input.estimate.expectedCost.max;
			costToken = input.estimate.expectedCost.token;
			this.#assertAmounts(input.estimate.convertedAmount, input.estimate.convertedAmountBound, input.estimate.expectedCost.min, costAmount);
			this.#assertEstimateBound(input.estimate.convertedAmount, input.estimate.convertedAmountBound);
			estimateTerms = { convertedAmount: input.estimate.convertedAmount, convertedAmountBound: convertedAmountBound };
		} else {
			liquidityProvider = input.quote.account;
			convertedAmountBound = input.quote.convertedAmount;
			costAmount = input.quote.cost.amount;
			costToken = input.quote.cost.token;
			this.#assertAmounts(input.quote.convertedAmount, undefined, costAmount, costAmount);
		}

		this.#assertCostToken({ amount: costAmount, token: costToken });
		const terms = exchangeTerms(this.conversion, convertedAmountBound, { amount: costAmount, token: costToken });
		this.#assertSigningLimits(terms, estimateTerms, limits);

		return({ liquidityProvider, terms });
	}

	/**
	 * Builds the swap block from this conversion and the anchor's checked
	 * terms. Throws when a term fails a check; see `checkExchange`.
	 */
	async #buildSwapBlock(input: { quote: KeetaFXAnchorQuote } | { estimate: KeetaFXAnchorEstimate; }, options: KeetaFXAnchorCreateExchangeOptions | undefined): Promise<InstanceType<typeof KeetaNetLib.Block>> {
		const request = this.conversion;
		const { liquidityProvider, terms } = this.#checkExchangeTerms(input, options?.limits);
		const { sendAmount, receiveAmount, costAmount, costToken } = terms;

		/* Construct the required operations for the swap request */
		const builder = this.client.initBuilder(this.options);

		/*
		 * When the fee is charged in the same token as the swap send,
		 * combine them into a single SEND. The principal send carries an
		 * external, so the builder will not merge a separate cost send
		 * of the same token into that operation.
		 */
		const costUsesSendToken = costAmount > 0n && costToken.comparePublicKey(request.from);

		if (costAmount > 0n && !costUsesSendToken) {
			builder.send(liquidityProvider, costAmount, costToken);
		}

		builder.receive(liquidityProvider, receiveAmount, request.to, request.affinity === 'to');

		/*
		 * Tag the principal send with an anchor external naming the FX
		 * provider and a client-chosen correlation id.
		 */
		const correlationId = crypto.randomUUID();
		const externalBuilder = new AnchorExternalBuilder().setAnchor(liquidityProvider, { transactionId: correlationId });
		for (const inputReference of options?.inputs ?? []) {
			externalBuilder.addInput(inputReference.blockHash, inputReference.operationIndex);
		}

		const external = await externalBuilder.build();
		const taggedSendAmount = costUsesSendToken ? sendAmount + costAmount : sendAmount;
		builder.send(liquidityProvider, taggedSendAmount, request.from, external);

		const blocks = await builder.computeBlocks();
		if (blocks.blocks.length !== 1) {
			throw(new Error('Creating Swap Generated more than 1 block'));
		}
		const swapBlock = blocks.blocks[0];
		if (swapBlock === undefined) {
			throw(new Error('User Swap Block is undefined'));
		}

		return(swapBlock);
	}

	async createExchange(input: { quote: KeetaFXAnchorQuote } | { estimate: KeetaFXAnchorEstimate; }, block?: InstanceType<typeof KeetaNetLib.Block>, options?: KeetaFXAnchorCreateExchangeOptions): Promise<KeetaFXAnchorExchange> {
		const request = this.#bindConversion('quote' in input ? input.quote.request : input.estimate.request);
		if (block !== undefined && options?.limits !== undefined) {
			throw(new KeetaAnchorUserError('createExchange applies limits only to a block it builds, not to a given block'));
		}

		const swapBlock = block ?? await this.#buildSwapBlock(input, options);

		let bodyAdditionalData: { quote: KeetaFXAnchorQuote; } | { request: ConversionInputCanonical; };

		if ('quote' in input) {
			bodyAdditionalData = { quote: { ...input.quote, request }};
		} else {
			bodyAdditionalData = { request };
		}

		const serviceURL = await this.#getEndpoint('createExchange');
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

		const exchange = await this.#parseExchangeResponse(await requestInformation.json(), swapBlock);
		this.logger?.debug(`FX exchange request successful, to provider ${serviceURL} for ${swapBlock.hash.toString()}`);
		return(exchange);
	}

	async #parseExchangeResponse(requestInformationJSON: unknown, swapBlock: InstanceType<typeof KeetaNetLib.Block>): Promise<KeetaFXAnchorExchange> {
		// Ensure status defaults to 'completed' if not provided (for backward compatibility)
		if (typeof requestInformationJSON === 'object' && requestInformationJSON !== null && !('status' in requestInformationJSON)) {
			Object.assign(requestInformationJSON, { status: 'completed' });
			Object.assign(requestInformationJSON, { blockhash: swapBlock.hash.toString() });
		}

		// Validate response
		if (!isKeetaFXAnchorExchangeResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX exchange service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(await this.#parseResponseError(requestInformationJSON));
		}

		return(requestInformationJSON);
	}

	async getMarketPrices(request: KeetaFXAnchorMarketPricesRequest): Promise<KeetaFXAnchorMarketPrices> {
		const serviceURL = await this.#getEndpoint('getMarketPrices');
		serviceURL.searchParams.set('quoteAssets', request.quoteAssets.join(','));
		serviceURL.searchParams.set('base', request.base);

		const requestInformation = await fetch(serviceURL, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaFXAnchorMarketPricesResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from FX market prices service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(await this.#parseResponseError(requestInformationJSON));
		}

		this.logger?.debug(`FX market prices request successful, to provider ${serviceURL} for quoteAssets=${request.quoteAssets.join(',')} base=${request.base}`);
		return({
			base: requestInformationJSON.base,
			quoteAssets: requestInformationJSON.quoteAssets
		});
	}

	async getExchangeStatus(exchangeID: string): Promise<KeetaFXAnchorExchange> {
		const serviceURL = await this.#getEndpoint('getExchangeStatus', { id: exchangeID });
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
	readonly provider: KeetaFXAnchorProviderBase;
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

	createExchange(block?: InstanceType<typeof KeetaNetLib.Block>, options?: KeetaFXAnchorCreateExchangeOptions): Promise<KeetaFXAnchorExchangeWithProvider>;

	checkExchange(options?: Pick<KeetaFXAnchorCreateExchangeOptions, 'limits'>): void;
}

class KeetaFXAnchorQuoteWithProvider implements CanCreateExchange {
	readonly provider: KeetaFXAnchorProviderBase;
	readonly quote: KeetaFXAnchorQuote;
	readonly isQuote = true as const;

	constructor(provider: KeetaFXAnchorProviderBase, quote: KeetaFXAnchorQuote) {
		this.provider = provider;
		this.quote = quote;
	}

	get request(): ConversionInputCanonical {
		return(this.quote.request);
	}

	async createExchange(block?: InstanceType<typeof KeetaNetLib.Block>, options?: KeetaFXAnchorCreateExchangeOptions): Promise<KeetaFXAnchorExchangeWithProvider> {
		const exchange = await this.provider.createExchange({ quote: this.quote }, block, options);
		return(new KeetaFXAnchorExchangeWithProvider(this.provider, exchange));
	}

	/**
	 * Checks this quote's terms as `createExchange` would, without
	 * signing. See {@link KeetaFXAnchorProviderBase.checkExchange}.
	 */
	checkExchange(options?: Pick<KeetaFXAnchorCreateExchangeOptions, 'limits'>): void {
		this.provider.checkExchange({ quote: this.quote }, options);
	}

	/**
	 * Re-fetch the quote from the provider.
	 *
	 * @returns a new KeetaFXAnchorQuoteWithProvider with the updated quote
	 */
	async refetch(): Promise<KeetaFXAnchorQuoteWithProvider> {
		const quote = await this.provider.getQuote();
		return(new KeetaFXAnchorQuoteWithProvider(this.provider, quote));
	}
}

class KeetaFXAnchorEstimateWithProvider implements CanCreateExchange {
	readonly provider: KeetaFXAnchorProviderBase;
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

	async createExchange(block?: InstanceType<typeof KeetaNetLib.Block>, options?: KeetaFXAnchorCreateExchangeOptions): Promise<KeetaFXAnchorExchangeWithProvider> {
		const exchange = await this.provider.createExchange({ estimate: this.estimate }, block, options);
		return(new KeetaFXAnchorExchangeWithProvider(this.provider, exchange));
	}

	/**
	 * Checks this estimate's terms as `createExchange` would, without
	 * signing. See {@link KeetaFXAnchorProviderBase.checkExchange}.
	 */
	checkExchange(options?: Pick<KeetaFXAnchorCreateExchangeOptions, 'limits'>): void {
		this.provider.checkExchange({ estimate: this.estimate }, options);
	}

	/**
	 * Re-fetch the estimate from the provider.
	 *
	 * @returns a new KeetaFXAnchorEstimateWithProvider with the updated estimate
	 */
	async refetch(): Promise<KeetaFXAnchorEstimateWithProvider> {
		const estimate = await this.provider.getEstimate();
		return(new KeetaFXAnchorEstimateWithProvider(this.provider, estimate));
	}
}

interface GetProvidersOptions extends AccountOptions {
	requiredOperations?: (keyof KeetaFXAnchorOperations)[];
}

interface GetPricesAssetReturnValue {
	value: bigint;
	averageConvertedAmount: number;
	providerMarketPrices: {
		provider: KeetaFXAnchorProviderBase;
		price: KeetaFXAnchorMarketPriceRatio;
	}[];
	providerEstimates: KeetaFXAnchorEstimateWithProvider[];
}

function providerSupportsGetMarketPrices(provider: KeetaFXAnchorProviderBase): boolean {
	return(Object.prototype.hasOwnProperty.call(provider.serviceInfo.operations, 'getMarketPrices'));
}

function convertUsingMarketPriceRatio(
	ratio: KeetaFXAnchorMarketPriceRatio,
	conversionValue: bigint,
	affinity: 'from' | 'to'
): bigint {
	const quote = BigInt(ratio.quote);
	const base = BigInt(ratio.base);
	if (quote === 0n || base === 0n) {
		throw(new Error(`Invalid market price ratio: quote=${ratio.quote} base=${ratio.base}`));
	}

	if (affinity === 'from') {
		return(conversionValue * base / quote);
	}

	return(conversionValue * quote / base);
}

export interface GetPricesArgs<Asset extends ConversionInput['from']> {
	assets: Asset[],
	priceIn: ConversionInput['from'],
	conversionValue?: bigint | ((input: Asset) => bigint | Promise<bigint>)
	conversionAffinity?: ConversionInput['affinity']
	/**
	 * Behavior when a provider returns an invalid market price ratio
	 * (e.g. zero quote/base). Defaults to `'omit'`.
	 *
	 * Invalid ratios are always logged regardless of this setting.
	 */
	onInvalidRatio?: 'omit' | 'throw';
}

class KeetaFXAnchorClient extends KeetaFXAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;
	readonly #signer: InstanceType<typeof KeetaNetLib.Account>;
	readonly #account: InstanceType<typeof KeetaNetLib.Account>;
	readonly #getPricesBatching: Required<KeetaFXAnchorClientGetPricesBatching>;
	readonly #defaultLimits: ResolvedDefaultLimits;
	readonly #pendingGetMarketPricesBatches = new Map<string, {
		provider: KeetaFXAnchorProviderBase;
		base: KeetaNetTokenPublicKeyString;
		quoteAssets: Set<KeetaNetTokenPublicKeyString>;
		waiters: {
			resolve: (prices: KeetaFXAnchorMarketPrices) => void;
			reject: (error: unknown) => void;
		}[];
		waitTimer: ReturnType<typeof setTimeout> | null;
		maxWaitTimer: ReturnType<typeof setTimeout> | null;
	}>();

	static #resolveGetPricesBatching(input?: KeetaFXAnchorClientGetPricesBatching | boolean): Required<KeetaFXAnchorClientGetPricesBatching> {
		if (input === false) {
			return({ waitMs: 0, maxWaitMs: 0 });
		} else {
			if (input === true || input === undefined) {
				input = { waitMs: 25 }
			}

			return({
				waitMs: input.waitMs,
				maxWaitMs: input.maxWaitMs ?? (input.waitMs * 4)
			});
		}
	}

	constructor(client: KeetaNetUserClient, config: KeetaFXAnchorClientConfig = {}) {
		super({ client, logger: config.logger });
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
		this.#getPricesBatching = KeetaFXAnchorClient.#resolveGetPricesBatching(config.getPricesBatching);
		this.#defaultLimits = resolveDefaultLimits(config.defaultLimits);

		if (!Number.isFinite(this.#getPricesBatching.waitMs) || this.#getPricesBatching.waitMs < 0) {
			throw(new Error('getPricesBatching.waitMs must be a non-negative finite number'));
		}
		if (!Number.isFinite(this.#getPricesBatching.maxWaitMs) || this.#getPricesBatching.maxWaitMs < 0) {
			throw(new Error('getPricesBatching.maxWaitMs must be a non-negative finite number'));
		}
		if (this.#getPricesBatching.maxWaitMs < this.#getPricesBatching.waitMs) {
			throw(new Error('getPricesBatching.maxWaitMs must be greater than or equal to waitMs'));
		}

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

	#getMarketPricesBatchKey(providerID: ProviderID, base: KeetaNetTokenPublicKeyString): string {
		return(`${String(providerID)}\0${base}`);
	}

	#flushGetMarketPricesBatch(batchKey: string) {
		const batch = this.#pendingGetMarketPricesBatches.get(batchKey);
		if (batch === undefined) {
			return;
		}

		this.#pendingGetMarketPricesBatches.delete(batchKey);
		if (batch.waitTimer !== null) {
			clearTimeout(batch.waitTimer);
		}
		if (batch.maxWaitTimer !== null) {
			clearTimeout(batch.maxWaitTimer);
		}

		const quoteAssets = [...batch.quoteAssets];
		batch.provider.getMarketPrices({ quoteAssets, base: batch.base }).then(function(marketPrices) {
			for (const waiter of batch.waiters) {
				waiter.resolve(marketPrices);
			}
		}, function(error: unknown) {
			for (const waiter of batch.waiters) {
				waiter.reject(error);
			}
		});
	}

	#getMarketPricesBatched(provider: KeetaFXAnchorProviderBase, request: KeetaFXAnchorMarketPricesRequest): Promise<KeetaFXAnchorMarketPrices> {
		const batching = this.#getPricesBatching;
		if (batching.waitMs === 0 && batching.maxWaitMs === 0) {
			return(provider.getMarketPrices(request));
		}

		const batchKey = this.#getMarketPricesBatchKey(provider.providerID, request.base);
		let batch = this.#pendingGetMarketPricesBatches.get(batchKey);
		if (batch === undefined) {
			batch = {
				provider,
				base: request.base,
				quoteAssets: new Set(),
				waiters: [],
				waitTimer: null,
				maxWaitTimer: null
			};
			this.#pendingGetMarketPricesBatches.set(batchKey, batch);

			batch.maxWaitTimer = setTimeout(() => {
				this.#flushGetMarketPricesBatch(batchKey);
			}, batching.maxWaitMs);
		}

		for (const quoteAsset of request.quoteAssets) {
			batch.quoteAssets.add(quoteAsset);
		}

		const activeBatch = batch;
		const result = new Promise<KeetaFXAnchorMarketPrices>(function(resolve, reject) {
			activeBatch.waiters.push({ resolve, reject });
		});

		if (activeBatch.waitTimer !== null) {
			clearTimeout(activeBatch.waitTimer);
		}

		if (batching.waitMs === 0) {
			this.#flushGetMarketPricesBatch(batchKey);
		} else {
			activeBatch.waitTimer = setTimeout(() => {
				this.#flushGetMarketPricesBatch(batchKey);
			}, batching.waitMs);
		}

		return(result);
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

		const canonical: ConversionInputCanonical = {
			from,
			to,
			amount: amount,
			affinity: input.affinity
		};

		if (input.preferredCostAsset !== undefined) {
			canonical.preferredCostAsset = input.preferredCostAsset;
		}

		return(canonical);
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
		const providerEndpoints = await getEndpoints(this.resolver, conversion, account, sharedCriteria, { logger: this.logger });
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

	async getBaseProvidersForConversion(request: ConversionInput, options: GetProvidersOptions = {}, sharedCriteria?: SharedLookupCriteria): Promise<KeetaFXAnchorProviderBase[] | null> {
		const conversion = await this.canonicalizeConversionInput(request);
		const account = options.account ?? this.#account;
		const providerEndpoints = await getEndpoints(this.resolver, conversion, account, sharedCriteria, { logger: this.logger });
		if (providerEndpoints === null) {
			return(null);
		}

		const providers = typedFxServiceEntries(providerEndpoints).map(([providerID, serviceInfo]) => {
			return(new KeetaFXAnchorProviderBase(serviceInfo, providerID, conversion, this, options));
		});

		return(providers);
	}

	/**
	 * Resolve an FX provider by the account that signs its advertised service metadata.
	 */
	async getProviderByAccount(anchor: AnchorReference, requiredOperations?: (keyof KeetaFXAnchorOperations)[]): Promise<KeetaFXAnchorProviderBase | null> {
		const request: Parameters<typeof getEndpoints>[1] = {};
		if (requiredOperations !== undefined) {
			request.requiredOperations = requiredOperations;
		}

		const providerEndpoints = await getEndpoints(this.resolver, request, this.#account, { accounts: [ anchor ] }, { logger: this.logger });
		if (providerEndpoints === null) {
			return(null);
		}

		const [ entry ] = typedFxServiceEntries(providerEndpoints);
		if (entry === undefined) {
			return(null);
		}

		const [ providerID, serviceInfo ] = entry;

		const pair = serviceInfo.from[0];
		if (pair === undefined) {
			return(null);
		}

		const fromCode = pair.currencyCodes[0];
		const toCode = pair.to[0];
		if (fromCode === undefined || toCode === undefined) {
			return(null);
		}

		const conversion: ConversionInputCanonical = {
			from: KeetaNetLib.Account.fromPublicKeyString(fromCode),
			to: KeetaNetLib.Account.fromPublicKeyString(toCode),
			amount: 0n,
			affinity: 'from'
		};

		const provider = new KeetaFXAnchorProviderBase(serviceInfo, providerID, conversion, this);
		return(provider);
	}

	async getEstimates(request: ConversionInput, options: Omit<GetProvidersOptions, 'requiredOperations'> = {}, sharedCriteria?: SharedLookupCriteria): Promise<KeetaFXAnchorEstimateWithProvider[] | null> {
		const estimateProviders = await this.getBaseProvidersForConversion(request, {
			...options,
			requiredOperations: ['getEstimate']
		}, sharedCriteria);

		if (estimateProviders === null) {
			return(null);
		}

		const estimates = await Promise.all(estimateProviders.map(async (provider) => {
			try {
				const estimate = await provider.getEstimate();

				return(new KeetaFXAnchorEstimateWithProvider(provider, estimate));
			} catch (error) {
				if (FXErrors.ResponseMismatch.isInstance(error)) {
					this.logger?.warn(`Ignoring estimate from FX provider ${String(provider.providerID)}:`, error);
				} else {
					this.logger?.error(`Failed to get estimate from provider ${String(provider.providerID)}:`, error);
				}

				return(null);
			}
		}));

		const results = estimates.filter(function(result) {
			return(result !== null);
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
		const estimateProviders = await this.getBaseProvidersForConversion(request, {
			...options,
			requiredOperations: ['getQuote']
		}, sharedCriteria);
		if (estimateProviders === null) {
			return([]);
		}

		return(await Promise.all(estimateProviders.map(async (provider) => {
			try {
				const quote = await provider.getQuote();
				return({ provider, quote: new KeetaFXAnchorQuoteWithProvider(provider, quote) });
			} catch (error) {
				if (FXErrors.ResponseMismatch.isInstance(error)) {
					this.logger?.warn(`Ignoring quote from FX provider ${String(provider.providerID)}:`, error);
				}

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
		const [ quotesAndEstimates, estimateProviders ] = await Promise.all([
			this.#multiRequestQuotes(request, options, sharedCriteria),
			this.getBaseProvidersForConversion(request, {
				...options,
				requiredOperations: ['getEstimate']
			}, sharedCriteria)
		]);

		const estimateProviderIDs = new Set<ProviderID>();

		if (estimateProviders !== null) {
			for (const provider of estimateProviders) {
				estimateProviderIDs.add(provider.providerID);
			}
		}

		const retval = [];

		for (const quoteOrEstimate of quotesAndEstimates) {
			if (!quoteOrEstimate.quote) {
				if (quoteOrEstimate.error && !FXErrors.QuoteIssuanceDisabled.isInstance(quoteOrEstimate.error)) {
					this.logger?.debug(`Failed to get quote from provider ${String(quoteOrEstimate.provider.providerID)}:`, quoteOrEstimate.error);
				}

				continue;
			}

			retval.push(quoteOrEstimate.quote);
			estimateProviderIDs.delete(quoteOrEstimate.provider.providerID);
		}

		const estimates = await this.getEstimates(request, options, {
			...sharedCriteria,
			providerIDs: Array.from(estimateProviderIDs).map(function(id) {
				return(String(id));
			})
		});

		if (estimates !== null) {
			retval.push(...estimates);
		}

		if (retval.length === 0) {
			return(null);
		}

		return(retval);
	}

	async getPrices<Asset extends ConversionInput['from']>(input: GetPricesArgs<Asset>, options: Omit<GetProvidersOptions, 'requiredOperations'> = {}, sharedCriteria?: SharedLookupCriteria): Promise<Map<Asset, GetPricesAssetReturnValue | null>> {
		const priceInCanonical = await this.canonicalizeConversionTokens({ to: input.priceIn ?? 'USD' });
		if (priceInCanonical.to === undefined) {
			throw(new Error('Could not canonicalize priceIn asset'));
		}

		const base = priceInCanonical.to.publicKeyString.get();
		const affinity = input.conversionAffinity ?? 'from';
		const priceIn = input.priceIn ?? 'USD';
		const onInvalidRatio = input.onInvalidRatio ?? 'omit';

		const assetEntries = await Promise.all(input.assets.map(async (asset) => {
			const canonical = await this.canonicalizeConversionTokens({ from: asset });
			if (canonical.from === undefined) {
				throw(new Error(`Could not canonicalize asset: ${String(asset)}`));
			}

			let conversionValue: bigint;
			if (input.conversionValue !== undefined) {
				if (typeof input.conversionValue === 'function') {
					conversionValue = await input.conversionValue(asset);
				} else {
					conversionValue = input.conversionValue;
				}
			} else {
				conversionValue = 1n;
			}

			const providers = await this.getBaseProvidersForConversion({
				from: asset,
				to: priceIn,
				amount: conversionValue,
				affinity
			}, options, sharedCriteria);

			return({
				asset,
				quoteAsset: canonical.from.publicKeyString.get(),
				conversionValue,
				providers
			});
		}));

		type ProviderAssetEntry = {
			asset: Asset;
			quoteAsset: KeetaNetTokenPublicKeyString;
			conversionValue: bigint;
			provider: KeetaFXAnchorProviderBase;
		};

		type EstimateAssetEntry = {
			asset: Asset;
			conversionValue: bigint;
			provider: KeetaFXAnchorProviderBase;
		};

		const providerAssets = new Map<ProviderID, ProviderAssetEntry[]>();
		const estimateEntries: EstimateAssetEntry[] = [];
		for (const entry of assetEntries) {
			if (entry.providers === null) {
				continue;
			}

			for (const provider of entry.providers) {
				if (providerSupportsGetMarketPrices(provider)) {
					const existing = providerAssets.get(provider.providerID) ?? [];
					existing.push({
						asset: entry.asset,
						quoteAsset: entry.quoteAsset,
						conversionValue: entry.conversionValue,
						provider
					});
					providerAssets.set(provider.providerID, existing);
				} else {
					estimateEntries.push({
						asset: entry.asset,
						conversionValue: entry.conversionValue,
						provider
					});
				}
			}
		}

		const providerPriceResults = await Promise.all([...providerAssets.entries()].map(async ([_ignore_providerID, entries]) => {
			const firstEntry = entries[0];
			if (firstEntry === undefined) {
				return(null);
			}

			const provider = firstEntry.provider;
			const quoteAssets = [...new Set(entries.map(function(entry) {
				return(entry.quoteAsset);
			}))];

			try {
				const marketPrices = await this.#getMarketPricesBatched(provider, { quoteAssets, base });
				return({ provider, marketPrices, entries });
			} catch (error) {
				this.logger?.error(`Failed to get market prices from provider ${String(provider.providerID)}:`, error);
				return(null);
			}
		}));

		const assetProviderPrices = new Map<Asset, GetPricesAssetReturnValue['providerMarketPrices']>();
		for (const result of providerPriceResults) {
			if (result === null) {
				continue;
			}

			for (const entry of result.entries) {
				const priceEntry = result.marketPrices.quoteAssets[entry.quoteAsset];
				if (priceEntry === undefined) {
					continue;
				}

				try {
					// Validate ratio early so convertUsingMarketPriceRatio cannot crash the batch later.
					convertUsingMarketPriceRatio(priceEntry.valueRatio, entry.conversionValue, affinity);
				} catch (error) {
					this.logger?.error(`Invalid market price ratio from provider ${String(result.provider.providerID)} for quote asset ${entry.quoteAsset} against base ${base}:`, error, priceEntry.valueRatio);
					if (onInvalidRatio === 'throw') {
						throw(error);
					}
					continue;
				}

				const prices = assetProviderPrices.get(entry.asset) ?? [];
				prices.push({
					provider: result.provider,
					price: priceEntry.valueRatio
				});
				assetProviderPrices.set(entry.asset, prices);
			}
		}

		const estimateResults = await Promise.all(estimateEntries.map(async (entry) => {
			try {
				const estimate = await entry.provider.getEstimate();
				return({
					asset: entry.asset,
					estimate: new KeetaFXAnchorEstimateWithProvider(entry.provider, estimate)
				});
			} catch (error) {
				this.logger?.error(`Failed to get estimate from provider ${String(entry.provider.providerID)}:`, error);
				return(null);
			}
		}));

		const assetProviderEstimates = new Map<Asset, KeetaFXAnchorEstimateWithProvider[]>();
		for (const result of estimateResults) {
			if (result === null) {
				continue;
			}

			const estimates = assetProviderEstimates.get(result.asset) ?? [];
			estimates.push(result.estimate);
			assetProviderEstimates.set(result.asset, estimates);
		}

		const retval = new Map<Asset, GetPricesAssetReturnValue | null>();
		for (const entry of assetEntries) {
			const providerMarketPrices = assetProviderPrices.get(entry.asset) ?? [];
			const providerEstimates = assetProviderEstimates.get(entry.asset) ?? [];
			if (providerMarketPrices.length === 0 && providerEstimates.length === 0) {
				retval.set(entry.asset, null);
				continue;
			}

			const convertedAmountSum = [
				...providerMarketPrices.map(function(providerPrice) {
					return(convertUsingMarketPriceRatio(providerPrice.price, entry.conversionValue, affinity));
				}),
				...providerEstimates.map(function(providerEstimate) {
					return(providerEstimate.estimate.convertedAmount);
				})
			].reduce(function(sum, convertedAmount) {
				return(sum + convertedAmount);
			}, 0n);

			const providerCount = providerMarketPrices.length + providerEstimates.length;

			retval.set(entry.asset, {
				value: entry.conversionValue,
				averageConvertedAmount: Number(convertedAmountSum) / providerCount,
				providerMarketPrices,
				providerEstimates
			});
		}

		return(retval);
	}

	async getLegalDisclaimersById(providerID: string): Promise<NonNullable<AnchorMetadataLegalField['disclaimers']> | null>{
		const endpoints = await getEndpoints(this.resolver, {}, this.#account, { providerIDs: [providerID] }, { logger: this.logger });
		if (endpoints === null) {
			return(null);
		}

		const serviceEntry = typedFxServiceEntries(endpoints)[0];
		if (!serviceEntry) {
			return(null);
		}

		const disclaimers = serviceEntry[1].legal?.disclaimers;
		if (!disclaimers || disclaimers.length === 0) {
			return(null)
		}

		return(disclaimers);
	}

	async getMarketPrices(providerID: string, request: KeetaFXAnchorMarketPricesRequest): Promise<KeetaFXAnchorMarketPrices | null> {
		const endpoints = await getEndpoints(this.resolver, {
			requiredOperations: ['getMarketPrices']
		}, this.#account, { providerIDs: [providerID] }, { logger: this.logger });
		if (endpoints === null) {
			return(null);
		}

		const serviceEntry = typedFxServiceEntries(endpoints)[0];
		if (!serviceEntry) {
			return(null);
		}

		const [ resolvedProviderID, serviceInfo ] = serviceEntry;
		const provider = new KeetaFXAnchorProviderBase(serviceInfo, resolvedProviderID, {
			from: KeetaNetLib.Account.fromPublicKeyString(request.quoteAssets[0] ?? request.base),
			to: KeetaNetLib.Account.fromPublicKeyString(request.base),
			amount: 1n,
			affinity: 'from'
		}, this);

		return(await provider.getMarketPrices(request));
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
			account: this.#account,
			defaultLimits: this.#defaultLimits
		});

	}
}

export default KeetaFXAnchorClient;
