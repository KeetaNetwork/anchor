import type { lib as KeetaNetLib }  from '@keetanetwork/keetanet-client';

import type { ServiceSearchCriteria } from '../../lib/resolver.js';
import type { ToJSONSerializable } from '../../lib/utils/json.js';
import { createAssert, createIs } from 'typia';
import type { HTTPSignedField } from '../../lib/http-server-shared.js';

export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
export type KeetaNetStorageAccount = InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.STORAGE>>;
export type KeetaNetToken = InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>;
export type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

export type ConversionInput = {
	/**
	 * The currency code to convert from (i.e., what the user has).
	 */
	from: ServiceSearchCriteria<'fx'>['inputCurrencyCode'] | KeetaNetToken;
	/**
	 * The currency code to convert to (i.e., what the user wants).
	 */
	to: ServiceSearchCriteria<'fx'>['outputCurrencyCode'] | KeetaNetToken;
	/**
	 * The amount to convert. This is a bigint representing the
	 * amount in the currency specified by either `from` or `to`, as
	 * specified by the `affinity` property.
	 */
	amount: bigint;
	/**
	 * Indicates whether the amount specified is in terms of the `from`
	 * currency (i.e., the user has this much) or the `to` currency
	 * (i.e., the user wants this much).
	 */
	affinity: 'from' | 'to';
};

export type ConversionInputCanonical = {
	[k in keyof ConversionInput]: k extends 'amount' ? bigint : k extends 'from' ? KeetaNetToken : k extends 'to' ? KeetaNetToken : ConversionInput[k];
};

export type ConversionInputCanonicalJSON = ToJSONSerializable<ConversionInputCanonical>;

export type KeetaFXAnchorClientCreateExchangeRequest = {
	quote: KeetaFXAnchorQuote;
	block: InstanceType<typeof KeetaNetLib.Block>;
};

export type KeetaFXAnchorClientGetExchangeStatusRequest = {
	exchangeID: string
};

export type KeetaFXAnchorEstimate = {
	/**
	 * Conversion request that was provided
	 */
	request: ConversionInputCanonical;

	/**
	 * Amount after the conversion as specified by either `from` or `to`, as specified by the `affinity` property in the request.
	 */
	convertedAmount: bigint;

	/**
	 * The expected cost of the fx request, in the form of a
	 * token and a range of minimum and maximum expected costs
	 */
	expectedCost: {
		min: bigint;
		max: bigint;
		token: KeetaNetToken;
	};
};

export type KeetaFXAnchorEstimateResponse = ({
	ok: true;
	estimate: ToJSONSerializable<KeetaFXAnchorEstimate>;
} | {
	ok: false;
	error: string;
});

export type KeetaFXAnchorQuote = {
	/**
	 * Conversion request that was provided
	 */
	request: ConversionInputCanonical;

	/**
	 * The public key of the liquidity provider account
	 */
	account: KeetaNetAccount | KeetaNetStorageAccount;

	/**
	 * Amount after the conversion as specified by either `from` or `to`, as specified by the `affinity` property in the request.
	 */

	convertedAmount: bigint;

	/**
	 * The cost of the fx request, in the form of a
	 * token and amount that should be included with the swap
	 */
	cost: {
		amount: bigint;
		token: KeetaNetToken;
	};

	/**
	 * Signature information to verify the quote
	 */
	signed: HTTPSignedField;
};

export type KeetaFXAnchorQuoteJSON = ToJSONSerializable<KeetaFXAnchorQuote>;

export type KeetaFXAnchorQuoteResponse = ({
	ok: true;
	quote: ToJSONSerializable<KeetaFXAnchorQuote>
} | {
	ok: false;
	error: string;
});

export type KeetaFXAnchorExchange = {
	/**
	 * ID used to identify the conversion request
	 */
	exchangeID: string
}

export type KeetaFXAnchorExchangeResponse = KeetaFXAnchorExchange &
({
	ok: true;
} | {
	ok: false;
	error: string;
});

export const isKeetaFXAnchorEstimateResponse: (input: unknown) => input is KeetaFXAnchorEstimateResponse = createIs<KeetaFXAnchorEstimateResponse>();
export const isKeetaFXAnchorQuoteResponse: (input: unknown) => input is KeetaFXAnchorQuoteResponse = createIs<KeetaFXAnchorQuoteResponse>();
export const isKeetaFXAnchorExchangeResponse: (input: unknown) => input is KeetaFXAnchorExchangeResponse = createIs<KeetaFXAnchorExchangeResponse>();
export const assertKeetaNetTokenPublicKeyString: (input: unknown)  => KeetaNetTokenPublicKeyString = createAssert<KeetaNetTokenPublicKeyString>();
export const assertConversionInputCanonicalJSON: (input: unknown) => ConversionInputCanonicalJSON = createAssert<ConversionInputCanonicalJSON>();
export const assertConversionQuoteJSON: (input: unknown) => KeetaFXAnchorQuoteJSON= createAssert<KeetaFXAnchorQuoteJSON>();
