import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import type { ServiceSearchCriteria } from '../../lib/resolver.js';
import type { ToJSONSerializable } from '../../lib/utils/json.js';
import { createAssert, createIs } from 'typia';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';

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
	block: InstanceType<typeof KeetaNetLib.Block>;
} & ({
	quote: KeetaFXAnchorQuote;
} | {
	request: ConversionInputCanonical;
});

export type KeetaFXAnchorClientCreateExchangeRequestJSON = {
	block: string;
} & ({
	quote: KeetaFXAnchorQuoteJSON;
	request?: undefined;
} | {
	quote?: undefined;
	request: ConversionInputCanonicalJSON;
})

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
	 * Outer bound of the converted amount.
	 * if affinity is 'to', this is the maximum amount the user would need to send, if its 'from', this is the minimum amount the user would receive.
	 */
	convertedAmountBound?: bigint;

	/**
	 * The expected cost of the fx request, in the form of a
	 * token and a range of minimum and maximum expected costs
	 */
	expectedCost: {
		min: bigint;
		max: bigint;
		token: KeetaNetToken;
	};
} & ({
	/**
	 * Indicates that a quote is required before proceeding with the exchange
	 */
	requiresQuote: false;

	/**
	 * Liquidity provider account if the user is not going to request a quote before the exchange
	 */
	account: KeetaNetAccount | KeetaNetStorageAccount;
} | {
	/**
	 * Indicates that a quote is required before proceeding with the exchange, defaults to true
	 */
	requiresQuote?: true;
});

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
} & ({
	/**
	 * Status of the exchange request
	 */
	status: 'pending' | 'failed';
} | {
	/**
	 * Status of the exchange request
	 */
	status: 'completed';
	/**
	 * Blockhash where the exchange was completed -- the user-supplied
	 * blockhash for their portion of the exchange transaction can be
	 * used to look up the transaction on-chain as well, but we return
	 * a value here so that it can be looked up without needing to store
	 * that initial block.
	 */
	blockhash: string;
});

export type KeetaFXAnchorExchangeResponse = (KeetaFXAnchorExchange & {
	ok: true;
}) | (Partial<KeetaFXAnchorExchange> & {
	ok: false;
	error: string;
});

export const isKeetaFXAnchorEstimateResponse: (input: unknown) => input is KeetaFXAnchorEstimateResponse = createIs<KeetaFXAnchorEstimateResponse>();
export const isKeetaFXAnchorQuoteResponse: (input: unknown) => input is KeetaFXAnchorQuoteResponse = createIs<KeetaFXAnchorQuoteResponse>();
export const isKeetaFXAnchorExchangeResponse: (input: unknown) => input is KeetaFXAnchorExchangeResponse = createIs<KeetaFXAnchorExchangeResponse>();
export const assertKeetaNetTokenPublicKeyString: (input: unknown)  => KeetaNetTokenPublicKeyString = createAssert<KeetaNetTokenPublicKeyString>();
export const assertConversionInputCanonicalJSON: (input: unknown) => ConversionInputCanonicalJSON = createAssert<ConversionInputCanonicalJSON>();
export const assertKeetaFXAnchorClientCreateExchangeRequestJSON: (input: unknown) => KeetaFXAnchorClientCreateExchangeRequestJSON = createAssert<KeetaFXAnchorClientCreateExchangeRequestJSON>();

class KeetaFXAnchorQuoteValidationFailedError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaFXAnchorQuoteValidationFailedError';
	private readonly KeetaFXAnchorQuoteValidationFailedErrorObjectTypeID!: string;
	private static readonly KeetaFXAnchorQuoteValidationFailedErrorObjectTypeID = 'a8f3c2d1-9b4e-4f2a-8c1d-5e6f7a8b9c0d';

	constructor(message?: string) {
		super(message ?? 'Quote validation failed');
		this.statusCode = 400;

		Object.defineProperty(this, 'KeetaFXAnchorQuoteValidationFailedErrorObjectTypeID', {
			value: KeetaFXAnchorQuoteValidationFailedError.KeetaFXAnchorQuoteValidationFailedErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaFXAnchorQuoteValidationFailedError {
		return(this.hasPropWithValue(input, 'KeetaFXAnchorQuoteValidationFailedErrorObjectTypeID', KeetaFXAnchorQuoteValidationFailedError.KeetaFXAnchorQuoteValidationFailedErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<InstanceType<typeof this>> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaFXAnchorQuoteRequiredError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaFXAnchorQuoteRequiredError';
	private readonly KeetaFXAnchorQuoteRequiredErrorObjectTypeID!: string;
	private static readonly KeetaFXAnchorQuoteRequiredErrorObjectTypeID = '9f22067f-52b3-40f2-84c1-ad9285260980';

	constructor(message?: string) {
		super(message ?? 'Quote required to perform exchange');
		this.statusCode = 400;

		Object.defineProperty(this, 'KeetaFXAnchorQuoteRequiredErrorObjectTypeID', {
			value: KeetaFXAnchorQuoteRequiredError.KeetaFXAnchorQuoteRequiredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaFXAnchorQuoteRequiredError {
		return(this.hasPropWithValue(input, 'KeetaFXAnchorQuoteRequiredErrorObjectTypeID', KeetaFXAnchorQuoteRequiredError.KeetaFXAnchorQuoteRequiredErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<InstanceType<typeof this>> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaFXAnchorQuoteIssuanceDisabledError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaFXAnchorQuoteIssuanceDisabledError';
	private readonly KeetaFXAnchorQuoteIssuanceDisabledErrorObjectTypeID!: string;
	private static readonly KeetaFXAnchorQuoteIssuanceDisabledErrorObjectTypeID = 'a0f70c0b-6e17-41f0-825a-d086983209e1';

	constructor(message?: string) {
		super(message ?? 'Anchor cannot issue quotes');
		this.statusCode = 501;

		Object.defineProperty(this, 'KeetaFXAnchorQuoteIssuanceDisabledErrorObjectTypeID', {
			value: KeetaFXAnchorQuoteIssuanceDisabledError.KeetaFXAnchorQuoteIssuanceDisabledErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaFXAnchorQuoteIssuanceDisabledError {
		return(this.hasPropWithValue(input, 'KeetaFXAnchorQuoteIssuanceDisabledErrorObjectTypeID', KeetaFXAnchorQuoteIssuanceDisabledError.KeetaFXAnchorQuoteIssuanceDisabledErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<InstanceType<typeof this>> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	QuoteValidationFailed: typeof KeetaFXAnchorQuoteValidationFailedError;
	QuoteRequired: typeof KeetaFXAnchorQuoteRequiredError;
	QuoteIssuanceDisabled: typeof KeetaFXAnchorQuoteIssuanceDisabledError;
} = {
	/**
	 * The quote validation failed
	 */
	QuoteValidationFailed: KeetaFXAnchorQuoteValidationFailedError,

	/**
	 * Quote is required to perform the exchange
	 */
	QuoteRequired: KeetaFXAnchorQuoteRequiredError,

	/**
	 * The anchor cannot issue quotes
	 */
	QuoteIssuanceDisabled: KeetaFXAnchorQuoteIssuanceDisabledError
};
