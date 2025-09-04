import { lib as KeetaNetLib, type UserClient as KeetaNetUserClient }  from '@keetanetwork/keetanet-client';
import type { Decimal } from 'decimal.js';

import type { ServiceSearchCriteria } from '../../lib/resolver.js';

export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
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

/** @deprecated Use the Node UserClient methods in the future instead of this function */
export async function createSwapRequest(userClient: KeetaNetUserClient, from: { account: KeetaNetAccount, token: KeetaNetToken, amount: bigint }, to: { account: KeetaNetAccount, token: KeetaNetToken, amount: bigint }): Promise<InstanceType<typeof KeetaNetLib.Block>> {
	const builder = userClient.initBuilder();
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

/** @deprecated Use the Node UserClient methods in the future instead of this function */
export async function acceptSwapRequest(userClient: KeetaNetUserClient, request: InstanceType<typeof KeetaNetLib.Block>, expected: { token?: KeetaNetToken, amount?: bigint }): Promise<InstanceType<typeof KeetaNetLib.Block>[]> {
	const builder = userClient.initBuilder();

	const sendOperation = request.operations.find(({ type }) => KeetaNetLib.Block.OperationType.SEND === type);
	if (!sendOperation || sendOperation.type !== KeetaNetLib.Block.OperationType.SEND) {
		throw(new Error('Swap Request is missing send'));
	}
	if (!sendOperation.to.comparePublicKey(userClient.account)) {
		throw(new Error(`Swap Request send account does not match`));
	}
	if (expected.token !== undefined && !sendOperation.token.comparePublicKey(expected.token)) {
		throw(new Error('Swap Request send token does not match expected'))
	}
	if (expected.amount !== undefined && sendOperation.amount !== expected.amount) {
		throw(new Error(`Swap Request send amount ${sendOperation.amount} does not match expected amount ${expected.amount}`))
	}

	const receiveOperation = request.operations.find(({ type }) => KeetaNetLib.Block.OperationType.RECEIVE === type);
	if (!receiveOperation || receiveOperation.type !== KeetaNetLib.Block.OperationType.RECEIVE) {
		throw(new Error("Swap Request is missing receive operation"));
	}
	builder.send(request.account, receiveOperation.amount, receiveOperation.token);

	const blocks = await builder.computeBlocks();
	return([...blocks.blocks, request]);
}
