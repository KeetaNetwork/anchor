import type { lib as KeetaNetLib }  from '@keetanetwork/keetanet-client';
import { KeetaFXAnchorProvider } from './client.js';
import type { ServiceSearchCriteria } from '../../lib/resolver.js';
import type { Decimal } from 'decimal.js';

export type ConversionInput = {
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

export type ConversionInputCanonical = {
	[k in keyof ConversionInput]: k extends 'amount' ? string : ConversionInput[k];
};

type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;
export type KeetaFXAnchorEstimateResponse = ({
    ok: true;
    /**
     * Conversion request that was provided
     */
    request: ConversionInput,
    /**
     * Estimate for this conversion
     */
    estimate: {
        /**
         * Amount after the conversion as specified by either `from` or `to`, as specified by the `affinity` property in the request.
         */
        convertedAmount: string;
    },
    /**
     * The expected cost of the fx request, in the form of a
     * token and a range of minimum and maximum expected costs
     */
    expectedCost: {
        min: string;
        max: string;
        token: KeetaNetTokenPublicKeyString;
    }
} | {
	ok: false;
	error: string;
});

export type KeetaFXAnchorEstimateResponseWithProvider = {
    provider: KeetaFXAnchorProvider
} & KeetaFXAnchorEstimateResponse;

export type KeetaFXAnchorQuote = {
    /**
     * The public key of the liquidity provider account
     */
    account: string;
    /**
     * Amount after the conversion as specified by either `from` or `to`, as specified by the `affinity` property in the request.
     */
    convertedAmount: string;
    /**
     * Signature of the returned data to verify authenticity
     */
    signed: {
        nonce: string;
        /* Date and time of the request in ISO 8601 format */
        timestamp: string;
        /* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
        signature: string;
    }
}

export type KeetaFXAnchorQuoteResponse = ({
	ok: true;
    /**
     * Conversion request that was provided
     */
    request: ConversionInput,
    /**
     * Quote for this conversion
     */
    quote: KeetaFXAnchorQuote,
	/**
	 * The cost of the fx request, in the form of a
	 * token and amount that should be included with the swap
	 */
	cost: {
		amount: string;
		token: KeetaNetTokenPublicKeyString;
	};
} | {
	ok: false;
	error: string;
});

export type KeetaFXAnchorExchangeResponse = ({
	ok: true;
    /**
     * ID used to identify the conversion request
     */
    exchangeID: string
} | {
	ok: false;
	error: string;
});
