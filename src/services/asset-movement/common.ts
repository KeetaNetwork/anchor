import type { ServiceMetadata } from '../../lib/resolver.ts';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import CurrencyInfo from '@keetanetwork/currency-info';
import { TokenAddress, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

type CurrencySearchInput = CurrencyInfo.ISOCurrencyCode | CurrencyInfo.ISOCurrencyNumber | CurrencyInfo.Currency;
type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode; /* XXX:TODO */

type TokenSearchInput = TokenAddress | TokenPublicKeyString;
type TokenSearchCanonical = TokenPublicKeyString;

export type MovableAssetSearchInput = CurrencySearchInput | TokenSearchInput;
export type MovableAssetSearchCanonical = CurrencySearchCanonical | TokenSearchCanonical;
export type MovableAsset = TokenAddress | CurrencyInfo.Currency;

export function assertMovableAsset(input: unknown): asserts input is MovableAsset {
	
}

export type AssetLocationInput = AssetLocation | AssetLocationString;
export type AssetLocationCanonical = AssetLocationString;

export type AssetMovementRail = unknown;

export type AssetLocation = {
	type: 'chain';
	chain: {
		type: 'keeta';
		networkId: bigint;
	} | {
		type: 'evm';
		chainId: bigint;
	}
} | {
	type: 'bank-account';
	workInProgress?: never;
}

export type AssetLocationString = 
	`chain:${'keeta' | 'evm'}:${bigint}` |
	`bank-account:${never}`;

export type AssetLocationLike = AssetLocation | AssetLocationString;

export function convertAssetLocationToString(input: AssetLocationLike): AssetLocationString {
	if (typeof input === 'string') {
		return(input);
	}

	if (input.type === 'chain') {
		if (input.chain.type === 'keeta') {
			return(`chain:keeta:${input.chain.networkId}`);
		} else if (input.chain.type === 'evm') {
			return(`chain:evm:${input.chain.chainId}`);
		}
	} else if (input.type === 'bank-account') {
		throw(new Error('Cannot convert bank-account AssetLocation to string'));
	}

	throw(new Error(`Invalid AssetLocation type: ${JSON.stringify(input)}`));
}

export function toAssetLocationFromString(input: string): AssetLocation {
	return({} as any);
}

export function convertAssetLocationInputToCanonical(input: AssetLocationInput): AssetLocationCanonical {
	if (typeof input === 'string') {
		return(input);
	} else if (typeof input === 'object' && input !== null) {
		return(convertAssetLocationToString(input));
	}

	throw(new Error(`Invalid AssetLocationInput type: ${typeof input}`));
}


export function convertAssetSearchInputToCanonical(input: MovableAssetSearchInput): MovableAssetSearchCanonical {
	if (input instanceof CurrencyInfo.Currency || CurrencyInfo.Currency.isCurrencyCode(input) || CurrencyInfo.Currency.isISOCurrencyNumber(input)) {
		if (CurrencyInfo.Currency.isCurrencyCode(input)) {
			return(input);
		} else if (CurrencyInfo.Currency.isISOCurrencyNumber(input)) {
			input = new CurrencyInfo.Currency(input);
		}
		
		return(input.code);
	} else {
		if (typeof input === 'string') {
			return(input);
		}

		input.assertKeyType(KeetaNetClient.lib.Account.AccountKeyAlgorithm.TOKEN);
		return(input.publicKeyString.get());
	}
}


export type Operations = NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations'];
export type OperationNames = keyof Operations;

export interface KeetaAssetMovementAnchorInitiateTransferRequest {
	asset: MovableAsset;
	from: { location: AssetLocationLike; };
	to: { location: AssetLocationLike; recipient: string; };
	value: bigint;
	allowedRails?: AssetMovementRail[];
}

type AssetTransferInstructions = ({
	type: 'SEND';
	location: AssetLocationLike;

	sendToAddress: string;
	value: bigint;
	tokenAddress: string;

	external?: string;
} | {
	type: 'EVM_CALL';
	location: AssetLocationLike;

	contractAddress: string;
	contractMethodName: string;
	contractMethodArgs: string[];
}) & ({
	chain: AssetLocation;
	assetFee: bigint;
});

export type KeetaAssetMovementAnchorInitiateTransferResponse = ({
	ok: true;
	id: string;
	instructions: AssetTransferInstructions[];
}) | ({
	ok: false;
	error: string;
})

export interface KeetaAssetMovementAnchorGetStatusRequest {
	id: string;
}

type TransactionStatus = 'A' | 'B' | 'C';

export type KeetaAssetMovementAnchorGetStatusResponse = ({
	ok: true;

	status: TransactionStatus;

	// additional
} | {
	ok: false;
	error: string;
});
