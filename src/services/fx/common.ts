import type { lib as KeetaNetLib }  from '@keetanetwork/keetanet-client';
import type { Decimal } from 'decimal.js';

import type { ServiceSearchCriteria } from '../../lib/resolver.js';

type KeetaNetToken = InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>;
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

export type ConversionInputCanonical = {
	[k in keyof ConversionInput]: k extends 'amount' ? string : k extends 'from' ? KeetaNetTokenPublicKeyString : k extends 'to' ? KeetaNetTokenPublicKeyString : ConversionInput[k];
};

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
    convertedAmount: string;

	/**
	 * The expected cost of the fx request, in the form of a
	 * token and a range of minimum and maximum expected costs
	 */
	expectedCost: {
		min: string;
		max: string;
		token: KeetaNetTokenPublicKeyString;
	};
};

export type KeetaFXAnchorEstimateResponse = ({
	ok: true;
    estimate: KeetaFXAnchorEstimate;
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
    account: string;

    /**
     * Amount after the conversion as specified by either `from` or `to`, as specified by the `affinity` property in the request.
     */

    convertedAmount: string;

    /**
     * The cost of the fx request, in the form of a
     * token and amount that should be included with the swap
     */
    cost: {
        amount: string;
        token: KeetaNetTokenPublicKeyString;
    };

    /**
     * Signature information to verify the quote
     */
    signed: {
        nonce: string;
        /* Date and time of the request in ISO 8601 format */
        timestamp: string;
        /* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
        signature: string;
    }
};

export type KeetaFXAnchorQuoteResponse = ({
	ok: true;
    quote: KeetaFXAnchorQuote
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
