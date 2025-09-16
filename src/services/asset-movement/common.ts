import type { ServiceMetadata } from '../../lib/resolver.ts';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import type { TokenAddress, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

type HexString = `0x${string}`;

export type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

type CurrencySearchInput = CurrencyInfo.ISOCurrencyCode | CurrencyInfo.ISOCurrencyNumber | CurrencyInfo.Currency;
type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode; /* XXX:TODO */

type TokenSearchInput = TokenAddress | TokenPublicKeyString;
type TokenSearchCanonical = TokenPublicKeyString;

export type MovableAssetSearchInput = CurrencySearchInput | TokenSearchInput;
export type MovableAssetSearchCanonical = CurrencySearchCanonical | TokenSearchCanonical;
export type MovableAsset = TokenAddress | TokenPublicKeyString | CurrencyInfo.Currency;

export function assertMovableAsset(input: unknown): asserts input is MovableAsset {

}

export type AssetLocationInput = AssetLocation | AssetLocationString;
export type AssetLocationCanonical = AssetLocationString;

export type AssetMovementRail = unknown;

/**
 * Defines the chain and id for a supported asset location
 */
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

// Disable bank-account until it's implemented
export type AssetLocationString =
	`chain:${'keeta' | 'evm'}:${bigint}` |
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	`bank-account:${never}`;

export type AssetLocationLike = AssetLocation | AssetLocationString;

// A given asset should have a location and ID for the contract or public key for that asset
export interface Asset {
	location?: AssetLocationString;
	id: string; // keeta token pub or evm contract address or currency code
}

export type Rail = 'ACH_SEND' | 'ACH_DEBIT' | 'KEETA_SEND' | 'EVM_SEND' | 'EVM_CALL';

// Rails can be inbound, outbound or common (inbound and outbound)
export interface AssetWithRails extends Asset {
	rails: (({
		inbound: Rail[];
		outbound?: Rail[];
	} | {
		inbound?: Rail[];
		outbound: Rail[];
	} | {
		inbound: never;
		outbound: never;
	}) & {
		common?: Rail[];
	});
};

// A given asset path should consist of exactly one tuple of locations
export interface AssetPath {
	pair: [ AssetWithRails, AssetWithRails ];
	kycProviders?: string[];
};

export interface SupportedAssets {
	asset: MovableAsset,
	paths: AssetPath[]
}

export interface AssetWithRailsMetadata {
	location: string;
	id: string;
	rails: (({
		inbound: string[];
		outbound?: string[];
	} | {
		inbound?: string[];
		outbound: string[];
	} | {
		inbound: never;
		outbound: never;
	}) & {
		common?: string[];
	})
}


// Example Asset Paths
// paths: [
// 	{
// 		pair: [
// 			{ location: 'keeta:123', id: 'keeta_KT1EXmXoG7fV8b2c5rYkUu4j3t6b3v6v5X8m', rails: { common: [ 'KEETA_SEND' ] } },
// 			{ location: 'evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] } }
// 		]
// 	},
// 	{
// 		pair: [
// 			{ location: 'keeta:123', id: 'keeta_USDCPUB', rails: ['KEETA_SEND'] },
// 			{ location: 'bank-account:US', id: 'USD', rails: { common: ['ACH_SEND'], inbound: ['ACH_DEBIT'] } }
// 		]
// 	},
// 	{
// 		pair: [
// 			{ location: 'bank-account:EU', id: 'EUR', rails: { inbound: [ 'WIRE_SEND' }] },
// 			{ location: 'keeta:123', id: 'keeta_EURCPUB', rails: { outbound: [ 'KEETA_SEND' ]} }
// 		]
// 	}
// ];

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

export function toAssetLocationFromString(_ignore_input: string): AssetLocation {
	throw(new Error('Not Implemented'));
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

		input.assertKeyType(KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN);
		return(input.publicKeyString.get());
	}
}

export type Operations = NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations'];
export type OperationNames = keyof Operations;

export type KeetaAssetMovementAnchorInitiateTransferRequest = {
	asset: MovableAsset;
	from: { location: AssetLocationLike };
	to: { location: AssetLocationLike; recipient: string; };
	value: bigint;
	allowedRails?: AssetMovementRail[];
}

export type AssetTransferInstructions = ({
	type: 'KEETA_SEND';
	location: AssetLocationLike;

	sendToAddress: string;
	value: bigint;
	tokenAddress: string;

	external?: string;
} | {
	type: 'EVM_SEND';
	location: AssetLocationLike;

	sendToAddress: string;
	value: bigint;
	tokenAddress: HexString;
} | {
	type: 'EVM_CALL';
	location: AssetLocationLike;

	contractAddress: string;
	contractMethodName: string;
	contractMethodArgs: string[];
}) & ({
	assetFee: bigint;
});

export type KeetaAssetMovementAnchorInitiateTransferResponse = ({
	ok: true;
	id: string;
	instructionChoices: AssetTransferInstructions[];
}) | ({
	ok: false;
	error: string;
})

export interface KeetaAssetMovementAnchorGetTransferStatusRequest {
	id: string;
}

type TransactionStatus = 'A' | 'B' | 'C';

export type KeetaAssetMovementAnchorGetTransferStatusResponse = ({
	ok: true;

	status: TransactionStatus;
	// additional
} | {
	ok: false;
	error: string;
});

export type KeetaAssetMovementAnchorCreatePersistentForwardingRequest = {
	asset: MovableAsset;
	destinationLocation: AssetLocationLike;
	destinationAddress: string;
	sourceLocation: AssetLocationLike;
}

export type KeetaAssetMovementAnchorCreatePersistentForwardingResponse = ({
	ok: true;
	address: string;
} | {
	ok: false;
	error: string;
});

export type KeetaAssetMovementAnchorlistTransactionsRequest = {
	persistentAddress: string;
	fromAddress: string;
	asset?: MovableAsset;
	location?: AssetLocationLike;
}

export type KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = ({
	ok: true;
	transactions: string[] // TODO What format should this be?
} | {
	ok: false;
	error: string;
});
