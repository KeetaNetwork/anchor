import type { ServiceMetadata } from '../../lib/resolver.ts';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import type { TokenAddress, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';
import { createAssert, createAssertEquals, createIs } from 'typia';

type HexString = `0x${string}`;

export type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

type CurrencySearchInput = CurrencyInfo.ISOCurrencyCode | CurrencyInfo.ISOCurrencyNumber | CurrencyInfo.Currency;
type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode; /* XXX:TODO */

type TokenSearchInput = TokenAddress | TokenPublicKeyString;
type TokenSearchCanonical = TokenPublicKeyString;

export type MovableAssetSearchInput = CurrencySearchInput | TokenSearchInput;
export type MovableAssetSearchCanonical = CurrencySearchCanonical | TokenSearchCanonical;
export type MovableAsset = TokenAddress | TokenPublicKeyString | CurrencyInfo.Currency;

export type AssetLocationInput = AssetLocation | AssetLocationString;
export type AssetLocationCanonical = AssetLocationString;

export type AssetMovementRail = unknown;

export type ProviderSearchInput = {
	asset: MovableAsset,
	from?: AssetLocationInput,
	to?: AssetLocationInput
}
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
		inbound?: never;
		outbound?: never;
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
	asset: TokenPublicKeyString,
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
		inbound?: never;
		outbound?: never;
	}) & {
		common?: string[];
	})
}


// Example Asset Paths
// paths: [
// 	{
// 		pair: [
// 			{ location: 'chain:keeta:123', id: 'keeta_KT1EXmXoG7fV8b2c5rYkUu4j3t6b3v6v5X8m', rails: { common: [ 'KEETA_SEND' ] } },
// 			{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] } }
// 		]
// 	},
// 	{
// 		pair: [
// 			{ location: 'chain:keeta:123', id: 'keeta_USDCPUB', rails: ['KEETA_SEND'] },
// 			{ location: 'bank-account:US', id: 'USD', rails: { common: ['ACH_SEND'], inbound: ['ACH_DEBIT'] } }
// 		]
// 	},
// 	{
// 		pair: [
// 			{ location: 'bank-account:EU', id: 'EUR', rails: { inbound: [ 'WIRE_SEND' }] },
// 			{ location: 'chain:keeta:123', id: 'keeta_EURCPUB', rails: { outbound: [ 'KEETA_SEND' ]} }
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

export function toAssetLocationFromString(input: string): AssetLocation {
	const parts = input.split(':');

	if (parts.length === 3 && parts[0] === 'chain') {
		const chainType = parts[1];
		if (!parts[2] || typeof parts[2] !== 'string') {
			throw(new Error('Invalid chain id in AssetLocation string'));
		}

		const chainId = BigInt(parts[2]);

		return({
			type: 'chain',
			chain: (() => {
				if (chainType === 'keeta') {
					return({
						type: 'keeta',
						networkId: chainId
					});
				} else if (chainType === 'evm') {
					return({
						type: 'evm',
						chainId: chainId
					});
				} else {
					throw(new Error(`Invalid chain type in AssetLocation string: ${chainType}`));
				}
			})()
		});
	}

	throw(new Error('unsupported AssetLocation string format'));
}

export function convertAssetLocationInputToCanonical(input: AssetLocationInput): AssetLocationCanonical {
	if (typeof input === 'string') {
		return(input);
	} else if (typeof input === 'object' && input !== null) {
		return(convertAssetLocationToString(input));
	}

	throw(new Error(`Invalid AssetLocationInput type: ${typeof input}`));
}


export function toAssetLocation(input: AssetLocationInput): AssetLocation {
	if (typeof input === 'string') {
		return(toAssetLocationFromString(input));
	} else {
		return(input);
	}
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
	value: string;
	allowedRails?: AssetMovementRail[];
}

export type AssetTransferInstructions = ({
	type: 'KEETA_SEND';
	location: AssetLocationLike;

	sendToAddress: string;
	value: string;
	tokenAddress: string;

	external?: string;
} | {
	type: 'EVM_SEND';
	location: AssetLocationLike;

	sendToAddress: string;
	value: string;
	tokenAddress: HexString;
} | {
	type: 'EVM_CALL';
	location: AssetLocationLike;

	contractAddress: string;
	contractMethodName: string;
	contractMethodArgs: string[];
}) & ({
	assetFee: string;
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

type TransactionStatus = string;

export type TransactionId = {
	id: string;
	nonce: string;
};

type TransactionIds<T extends string> = {
	[type in T]: TransactionId | null;
};

export type KeetaAssetMovementTransaction = {
	id: string;
	status: TransactionStatus;
	asset: MovableAsset;

	from: {
		location: AssetLocationString;
		value: string;
		transactions: TransactionIds<'persistentForwarding' | 'deposit' | 'finalization'>;
	};

	to: {
		location: AssetLocationString;
		value: string;
		transactions: TransactionIds<'withdraw'>;
	};

	fee: {
		asset: MovableAsset;
		value: string;
	} | null;

	createdAt: string;
	updatedAt: string;
}

export type KeetaAssetMovementAnchorGetTransferStatusResponse = ({
	ok: true;
	transaction: KeetaAssetMovementTransaction;
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

type PaginationQuery = {
	limit?: number;
	offset?: number;
}

type PaginationResponseInformation = {
	total: string;
}

export type KeetaAssetMovementAnchorlistTransactionsRequest = {
	persistentAddresses?: { location: AssetLocationLike; persistentAddress: string; }[];
	from?: { location: AssetLocationLike; userAddress?: string; asset?: MovableAsset; };
	to?: { location: AssetLocationLike; userAddress?: string; asset?: MovableAsset; };
	pagination?: PaginationQuery;
}

export type KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = (({
	ok: true;
	transactions: KeetaAssetMovementTransaction[] ;
} & PaginationResponseInformation) | {
	ok: false;
	error: string;
});

export const assertKeetaSupportedAssets: (input: unknown) => SupportedAssets[] = createAssert<SupportedAssets[]>();
export const assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest: (input: unknown) => KeetaAssetMovementAnchorCreatePersistentForwardingRequest = createAssert<KeetaAssetMovementAnchorCreatePersistentForwardingRequest>();
export const assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse: (input: unknown) => KeetaAssetMovementAnchorCreatePersistentForwardingResponse = createAssertEquals<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>();
export const assertKeetaAssetMovementAnchorInitiateTransferRequest: (input: unknown) => KeetaAssetMovementAnchorInitiateTransferRequest = createAssert<KeetaAssetMovementAnchorInitiateTransferRequest>();
export const assertKeetaAssetMovementAnchorInitiateTransferResponse: (input: unknown) => KeetaAssetMovementAnchorInitiateTransferResponse = createAssertEquals<KeetaAssetMovementAnchorInitiateTransferResponse>();
export const assertKeetaAssetMovementAnchorGetTransferStatusRequest: (input: unknown) => KeetaAssetMovementAnchorGetTransferStatusRequest = createAssert<KeetaAssetMovementAnchorGetTransferStatusRequest>();
export const assertKeetaAssetMovementAnchorGetTransferStatusResponse: (input: unknown) => KeetaAssetMovementAnchorGetTransferStatusResponse = createAssertEquals<KeetaAssetMovementAnchorGetTransferStatusResponse>();
export const assertKeetaAssetMovementAnchorlistTransactionsRequest: (input: unknown) => KeetaAssetMovementAnchorlistTransactionsRequest = createAssert<KeetaAssetMovementAnchorlistTransactionsRequest>();
export const assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse: (input: unknown) => KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = createAssertEquals<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>();

export const isKeetaAssetMovementAnchorCreatePersistentForwardingResponse: (input: unknown) => input is KeetaAssetMovementAnchorCreatePersistentForwardingResponse = createIs<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>();
export const isKeetaAssetMovementAnchorInitiateTransferResponse: (input: unknown) => input is KeetaAssetMovementAnchorInitiateTransferResponse = createIs<KeetaAssetMovementAnchorInitiateTransferResponse>();
export const isKeetaAssetMovementAnchorGetExchangeStatusResponse: (input: unknown) => input is KeetaAssetMovementAnchorGetTransferStatusResponse = createIs<KeetaAssetMovementAnchorGetTransferStatusResponse>();
export const isKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse: (input: unknown) => input is KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = createIs<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>();
