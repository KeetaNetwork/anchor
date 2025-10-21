import type { ServiceMetadata } from '../../lib/resolver.ts';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import type { TokenAddress, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';
import { createAssert, createAssertEquals, createIs } from 'typia';

type HexString = `0x${string}`;

export type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

type CountrySearchInput = CurrencyInfo.ISOCountryCode | CurrencyInfo.Country;
type CountrySearchCanonical = CurrencyInfo.ISOCountryCode; 

type CurrencySearchInput = CurrencyInfo.ISOCurrencyCode | CurrencyInfo.Currency;
type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode; /* XXX:TODO */

type TokenSearchInput = TokenAddress | TokenPublicKeyString;
type TokenSearchCanonical = TokenPublicKeyString;

export type EVMAsset = `evm:${HexString}`;
export type MovableAssetSearchInput = CurrencySearchInput | TokenSearchInput | EVMAsset;
export type MovableAssetSearchCanonical = CurrencySearchCanonical | TokenSearchCanonical | EVMAsset;
export type MovableAsset = TokenAddress | TokenPublicKeyString | CurrencyInfo.Currency | CurrencyInfo.ISOCurrencyCode | EVMAsset;

export function toEVMAsset(input: HexString): EVMAsset {
	return(`evm:${input}`);
}

export function parseEVMAsset(input: EVMAsset): HexString {
	const parts = input.split(':');
	if (parts.length !== 2 || parts[0] !== 'evm') {
		throw(new Error('Invalid EVMAsset string'));
	}
	return(parts[1] as HexString);
}

export function isEVMAsset(input: unknown): input is EVMAsset {
	return(typeof input === 'string' && input.startsWith('evm:0x'));
}

export type AssetLocationInput = AssetLocation | AssetLocationString;
export type AssetLocationCanonical = AssetLocationString;

export type ProviderSearchInput = {
	asset?: MovableAsset,
	from?: AssetLocationInput,
	to?: AssetLocationInput
}
/**
 * Defines the chain and id for a supported asset location
 */

interface BaseLocation<Type extends 'chain' | 'bank-account'> {
	type: Type;
}

export interface BankLocation extends BaseLocation<'bank-account'> {
	account: {
		type: BankAccountType;
	}
}

interface BaseChainLocation<Data> extends BaseLocation<'chain'> {
	type: 'chain';
	chain: Data;
}

export type ChainLocation = {
	type: 'chain';
	chain: {
		type: 'keeta';
		networkId: bigint;
	} | {
		type: 'evm';
		chainId: bigint;
	}
};

export type ChainLocationType = ChainLocation['chain']['type'];

export type PickChainLocation<T extends ChainLocationType = ChainLocationType> = BaseChainLocation<Extract<ChainLocation['chain'], { type: T }>>;

export function isChainLocation<T extends ChainLocationType>(input: AssetLocation, chainType?: T): input is PickChainLocation<T> {
	if (input.type !== 'chain') {
		return(false);
	}

	if (chainType !== undefined) {
		return(input.chain.type === chainType);
	}

	return(true);
}

export type AssetLocation = ChainLocation | BankLocation;

export type BankAccountType = 'us' | 'iban-swift' | 'clabe' | 'pix';
export const assertBankAccountType: (input: unknown) => BankAccountType = createAssert<BankAccountType>();

// Disable bank-account until it's implemented
export type AssetLocationString =
	`chain:${'keeta' | 'evm'}:${bigint}` |
	`bank-account:${BankAccountType}`;

export type AssetLocationLike = AssetLocation | AssetLocationString;

// A given asset should have a location and ID for the contract or public key for that asset
export interface Asset {
	location?: AssetLocationString;
	id: string; // keeta token pub or evm contract address or currency code
}

export type Rail =
	'ACH' | 'ACH_DEBIT' | 'KEETA_SEND' | 'EVM_SEND' | 'EVM_CALL' | 'WIRE' | 'WIRE_RECEIVE' | 'PIX_PUSH' | 'SPEI_PUSH' | 'WIRE_INTL_PUSH' | 'CLABE_PUSH' | 'SEPA_PUSH';

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
	asset: TokenPublicKeyString;
	paths: AssetPath[];
}

export interface AssetWithRailsMetadata {
	location: string;
	id: string;
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
		} else {
			throw(new Error(`Invalid chain type in AssetLocation ${(input.chain as any).type}`));
		}
	} else if (input.type === 'bank-account') {
		return(`bank-account:${assertBankAccountType(input.account.type)}`);
	} else {
		throw(new Error(`Invalid AssetLocation type: ${JSON.stringify(input)}`));
	}
}

export function toAssetLocationFromString(input: string): AssetLocation {
	const parts = input.split(':');

	if (!parts || parts.length === 0) {
		throw(new Error('Invalid AssetLocation string'));
	}

	if (parts[0] === 'chain') {
		if (parts.length !== 3) {
			throw(new Error('Invalid AssetLocation chain string'));
		}

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
	} else if (parts[0] === 'bank-account') {
		if (parts.length !== 2) {
			throw(new Error('Invalid AssetLocation bank-account string'));
		}

		return({
			type: 'bank-account',
			account: { type: assertBankAccountType(parts[1]) }
		});
	} else {
		throw(new Error('Invalid AssetLocation string'));
	}
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

export type RecipientResolved = AddressResolved | { type: 'persistent-address'; persistentAddressId: string; };

export type KeetaAssetMovementAnchorInitiateTransferRequest = {
	asset: AssetOrPair;
	from: { location: AssetLocationLike; };
	to: { location: AssetLocationLike; recipient: RecipientResolved; };
	value: string;
	allowedRails?: Rail[];
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
} | {
	type: 'WIRE' | 'ACH';
	account: BankAccountAddressResolved;
	value: string;
}) & ({
	assetFee: string;
	totalReceiveAmount?: string;
	persistentAddressId?: string;
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
	asset: AssetOrPair;

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

type PhysicalAddress = {
	line1: string;
	line2?: string;
	country: CountrySearchCanonical;
	postalCode: string;
	subdivision: string;
	city: string;
};

type USBankAccountType = 'checking' | 'savings';

export type BankAccountAddressResolved = {
	type: 'bank-account';
	accountAddress?: PhysicalAddress | string;
	obfuscated?: false;

	bankName?: string;

	accountOwner: {
		type: 'individual';
		firstName: string;
		lastName: string;
	} | {
		type: 'business';
		businessName: string;
	}
} & ({
	accountType: 'us';

	accountNumber: string;
	routingNumber: string;
	accountTypeDetail: USBankAccountType;
} | {
	accountType: 'iban-swift';


	country?: CountrySearchCanonical;

	accountNumber: string;
	bic?: string;

	iban?: string;

	bankAddress?: PhysicalAddress;

	swift?: {
		category: string;
		purposeOfFunds: string[];
		businessDescription: string;
	}
} | {
	accountType: 'clabe';

	accountNumber: string;
} | ({
	accountType: 'pix';
	document?: {
		type?: 'cpf' | 'cnpj';
		number: string;
	}
} & ({
	brCode: string;
} | {
	pixKey: string;
})));

export type BankAccountAddressObfuscated = {
	type: 'bank-account';
	obfuscated: true;

	accountOwner?: {
		type?: 'individual' | 'business';
		name?: string;
		businessName?: string;
	}

	bankName?: string;

	accountNumberEnding?: string;
} & ({
	accountType: 'us';

	routingNumber: string;
	accountTypeDetail?: USBankAccountType;

} | {
	accountType: 'iban-swift';
	country?: CountrySearchCanonical;
	bic?: string;
} | {
	accountType: 'clabe';
} | {
	accountType: 'pix';
})

type CryptoAddress = string;
type AddressResolved = BankAccountAddressResolved | CryptoAddress;
type AddressObfuscated = BankAccountAddressObfuscated | CryptoAddress;

export type PersistentAddressTemplateData = {
	id: string;
	location: AssetLocationLike;
	asset: MovableAsset;
	address: AddressObfuscated;
}

export type KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest = {
	asset: MovableAsset;
	location: AssetLocationLike;
	address: AddressResolved;
}

export type KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse = (({
	ok: true;
} & PersistentAddressTemplateData) | {
	ok: false;
	error: string;
});

export type KeetaAssetMovementAnchorListForwardingAddressTemplateRequest = {
	asset?: MovableAsset[];
	locations?: AssetLocationLike[];
	pagination?: PaginationQuery;
}

export type KeetaAssetMovementAnchorListForwardingAddressTemplateResponse = (({
	ok: true;
	templates: PersistentAddressTemplateData[];
} & PaginationResponseInformation) | {
	ok: false;
	error: string;
});

export type AssetPair<From extends MovableAsset = MovableAsset, To extends MovableAsset = MovableAsset> = { from: From; to: To; };
export type AssetOrPair = MovableAsset | AssetPair;

export function toAssetPair(input: AssetOrPair): AssetPair {
	if (typeof input === 'object' && 'from' in input && 'to' in input) {
		return(input);
	}

	return({ from: input, to: input });
}



export type KeetaPersistentForwardingAddressDetails = {
	id?: string;
	address: AddressObfuscated | AddressResolved;
	asset?: AssetOrPair;
	sourceLocation?: AssetLocationLike;
	destinationLocation?: AssetLocationLike;
	destinationAddress?: AddressResolved | AddressObfuscated;
	outgoingRail?: Rail;
	incomingRail?: Rail[];
}

export type KeetaAssetMovementAnchorCreatePersistentForwardingRequest = {
	sourceLocation: AssetLocationLike;
	asset: AssetOrPair;
	outgoingRail?: Rail;
} & ({
	destinationLocation: AssetLocationLike;
	destinationAddress: AddressResolved;
} | {
	persistentAddressTemplateId: string;
});

export type KeetaAssetMovementAnchorCreatePersistentForwardingResponse = (({
	ok: true;
} & KeetaPersistentForwardingAddressDetails) | {
	ok: false;
	error: string;
});

export type KeetaAssetMovementAnchorListPersistentForwardingRequest = {
	search?: {
		sourceLocation?: AssetLocationLike;
		destinationLocation?: AssetLocationLike;
		asset?: MovableAsset;
		destinationAddress?: string;
		persistentAddressTemplateId?: string;
	}[];
	pagination?: PaginationQuery;
}

export type KeetaAssetMovementAnchorListPersistentForwardingResponse = (({
	ok: true;
	addresses: KeetaPersistentForwardingAddressDetails[];
} & PaginationResponseInformation) | {
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
	persistentAddresses?: ({ location: AssetLocationLike; } & ({ persistentAddress?: string; persistentAddressTemplate: string; } | { persistentAddress: string; persistentAddressTemplate?: string; }))[];
	from?: { location: AssetLocationLike; userAddress?: string; asset?: MovableAsset; };
	to?: { location: AssetLocationLike; userAddress?: string; asset?: MovableAsset; };
	pagination?: PaginationQuery;
}

export type KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = (({
	ok: true;
	transactions: KeetaAssetMovementTransaction[];
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
export const assertKeetaAssetMovementAnchorListPersistentForwardingRequest: (input: unknown) => KeetaAssetMovementAnchorListPersistentForwardingRequest = createAssert<KeetaAssetMovementAnchorListPersistentForwardingRequest>();
export const assertKeetaAssetMovementAnchorListPersistentForwardingResponse: (input: unknown) => KeetaAssetMovementAnchorListPersistentForwardingResponse = createAssertEquals<KeetaAssetMovementAnchorListPersistentForwardingResponse>();
export const assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse: (input: unknown) => KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = createAssertEquals<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>();
export const assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest: (input: unknown) => KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest = createAssert<KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest>();
export const assertKeetaAssetMovementAnchorListForwardingAddressTemplateRequest: (input: unknown) => KeetaAssetMovementAnchorListForwardingAddressTemplateRequest = createAssert<KeetaAssetMovementAnchorListForwardingAddressTemplateRequest>();
export const assertKeetaAssetMovementAnchorListForwardingAddressTemplateResponse: (input: unknown) => KeetaAssetMovementAnchorListForwardingAddressTemplateResponse = createAssertEquals<KeetaAssetMovementAnchorListForwardingAddressTemplateResponse>();
export const assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse: (input: unknown) => KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse = createAssertEquals<KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse>();
export const assertBankAccountAddressObfuscated: (input: unknown) => BankAccountAddressObfuscated = createAssert<BankAccountAddressObfuscated>();
export const assertBankAccountAddressResolved: (input: unknown) => BankAccountAddressResolved = createAssert<BankAccountAddressResolved>();

export const isKeetaAssetMovementAnchorListForwardingAddressTemplateRequest: (input: unknown) => input is KeetaAssetMovementAnchorListForwardingAddressTemplateRequest = createIs<KeetaAssetMovementAnchorListForwardingAddressTemplateRequest>();
export const isKeetaAssetMovementAnchorListForwardingAddressTemplateResponse: (input: unknown) => input is KeetaAssetMovementAnchorListForwardingAddressTemplateResponse = createIs<KeetaAssetMovementAnchorListForwardingAddressTemplateResponse>();
export const isKeetaAssetMovementAnchorCreatePersistentForwardingResponse: (input: unknown) => input is KeetaAssetMovementAnchorCreatePersistentForwardingResponse = createIs<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>();
export const isKeetaAssetMovementAnchorInitiateTransferResponse: (input: unknown) => input is KeetaAssetMovementAnchorInitiateTransferResponse = createIs<KeetaAssetMovementAnchorInitiateTransferResponse>();
export const isKeetaAssetMovementAnchorGetExchangeStatusResponse: (input: unknown) => input is KeetaAssetMovementAnchorGetTransferStatusResponse = createIs<KeetaAssetMovementAnchorGetTransferStatusResponse>();
export const isKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse: (input: unknown) => input is KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = createIs<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>();
