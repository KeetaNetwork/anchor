import type { ServiceMetadata } from '../../lib/resolver.ts';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import type { AccountKeyAlgorithm, IdentifierKeyAlgorithm, TokenAddress, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';
import { createAssert, createAssertEquals, createIs } from 'typia';
import type { ToJSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import type { SharableCertificateAttributes } from '../../lib/certificates.js';
import { KeetaNet } from '../../client/index.js';
import { KeetaAnchorUserError } from '../../lib/error.js';


type HexString = `0x${string}`;

export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
export type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

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

function isHexString(input: unknown): input is HexString {
	if (typeof input === 'string' && input.startsWith('0x')) {
		return(true);
	}

	return(false);
}

export function parseEVMAsset(input: EVMAsset): HexString {
	const parts = input.split(':');
	if (parts.length !== 2 || parts[0] !== 'evm') {
		throw(new Error('Invalid EVMAsset string'));
	}

	const value = parts[1];
	if (!isHexString(value)) {
		throw(new Error('Invalid hex string in EVMAsset'));
	}

	return(value);
}

export function isEVMAsset(input: unknown): input is EVMAsset {
	return(typeof input === 'string' && input.startsWith('evm:0x'));
}

export type AssetLocationInput = AssetLocation | AssetLocationString;
export type AssetLocationCanonical = AssetLocationString;

export type ProviderSearchInput = {
	asset?: MovableAsset;
	from?: AssetLocationInput;
	to?: AssetLocationInput;
	rail?: Rail | Rail[];
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

export type AssetLocationString =
	`chain:${'keeta' | 'evm'}:${bigint}` |
	`bank-account:${BankAccountType}`;

export type AssetLocationLike = AssetLocation | AssetLocationString;

// A given asset should have a location and ID for the contract or public key for that asset
export interface Asset {
	location?: AssetLocationString;
	id: string; // Keeta token public key string, evm contract address, or a currency code
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


export function commonJSONStringify(input: unknown): string {
	return(JSON.stringify(input, function(_, value: unknown) {
		if (typeof value === 'bigint') {
			return(String(value));
		} else if (KeetaNet.lib.Account.isInstance(value)) {
			return(value.publicKeyString.get());
		}

		return(value);
	}));
}

type SignableObjectInput = { [key: string | number | symbol]: SignableObjectInput } | SignableObjectInput[] | Signable[number] | undefined | null | boolean;

function commonToSignable(item: SignableObjectInput): Signable {
	const queue: [ string, SignableObjectInput ][] = [[ '', item ]];
	const result: [ string, Signable[number] ][] = [];

	while (queue.length > 0) {
		const next = queue.shift();

		if (!next) {
			continue;
		}

		const [ prefix, current ] = next;
		if (current === null || current === undefined) {
			continue;
		}

		if (typeof current === 'boolean') {
			result.push([ prefix, current ? 1 : 0 ]);
		} else if (Array.isArray(current)) {
			for (let i = 0; i < current.length; i++) {
				queue.push([ `${prefix}[${i}]`, current[i] ]);
			}
		} else if (typeof current === 'object') {
			for (const [ key, value ] of Object.entries(current)) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				queue.push([ prefix ? `${prefix}.${key}` : key, value as SignableObjectInput ]);
			}
		} else {
			result.push([ prefix, current ]);
		}

		if (result.length > 1000) {
			throw(new KeetaAnchorUserError('Too much data to sign in commonToSignable'));
		}
	}

	result.sort((a, b) => {
		return(a[0].localeCompare(b[0]));
	});

	return(result.map(item => item[1]));
}

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
			// We can ignore this any as we have already checked the type above, and the type here is only for error reporting
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/consistent-type-assertions
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

export type AssetPair<From extends MovableAsset = MovableAsset, To extends MovableAsset = MovableAsset> = { from: From; to: To; };
export type AssetOrPair = MovableAsset | AssetPair;

export type AssetPairCanonical<From extends MovableAssetSearchCanonical = MovableAssetSearchCanonical, To extends MovableAssetSearchCanonical = MovableAssetSearchCanonical> = { from: From; to: To; };
export type AssetOrPairCanonical = MovableAssetSearchCanonical | AssetPairCanonical;

function isAssetPairLike(input: unknown): input is AssetPair {
	return(typeof input === 'object' && input !== null && 'from' in input && 'to' in input);
}

export function toAssetPair(input: AssetOrPair): AssetPair {
	if (isAssetPairLike(input)) {
		return(input);
	}

	return({ from: input, to: input });
}


export function convertAssetOrPairSearchInputToCanonical(input: AssetOrPair): AssetOrPairCanonical {
	if (isAssetPairLike(input)) {
		return({
			from: convertAssetSearchInputToCanonical(input.from),
			to: convertAssetSearchInputToCanonical(input.to)
		});
	} else {
		return(convertAssetSearchInputToCanonical(input));
	}
}


export type Operations = NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations'];
export type OperationNames = keyof Operations;

export type RecipientResolved = AddressResolved | { type: 'persistent-address'; persistentAddressId: string; };

export type KeetaAssetMovementAnchorInitiateTransferClientRequest = {
	account?: KeetaNetAccount | undefined;
	asset: AssetOrPair;
	from: { location: AssetLocationLike; };
	to: { location: AssetLocationLike; recipient: RecipientResolved; };
	value: string | bigint;
	allowedRails?: Rail[];
}

export type KeetaAssetMovementAnchorInitiateTransferRequest = ToJSONSerializable<Omit<KeetaAssetMovementAnchorInitiateTransferClientRequest, 'asset' | 'from' | 'to'>> & {
	asset: AssetOrPairCanonical;
	from: { location: AssetLocationCanonical; };
	to: { location: AssetLocationCanonical; recipient: RecipientResolved; };
	signed?: HTTPSignedField;
};

export function getKeetaAssetMovementAnchorInitiateTransferRequestSigningData(input: KeetaAssetMovementAnchorInitiateTransferClientRequest | KeetaAssetMovementAnchorInitiateTransferRequest): Signable {
	return(commonToSignable({
		asset: convertAssetOrPairSearchInputToCanonical(input.asset),
		from: { location: convertAssetLocationInputToCanonical(input.from.location) },
		to: { location: convertAssetLocationInputToCanonical(input.to.location), recipient: input.to.recipient },
		value: String(input.value)
	}));
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
	type: 'WIRE' | 'ACH' | 'SEPA_PUSH';
	account: BankAccountAddressResolved;
	depositMessage?: string;
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

export interface KeetaAssetMovementAnchorGetTransferStatusClientRequest {
	account?: KeetaNetAccount;
	id: string;
}

export interface KeetaAssetMovementAnchorGetTransferStatusRequest {
	id: string;
}

export function getKeetaAssetMovementAnchorGetTransferStatusRequestSigningData(input: KeetaAssetMovementAnchorGetTransferStatusRequest): Signable {
	return([ 'get-transaction', input.id ]);
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
	} | {
		type: 'unknown';
		beneficiaryName: string;
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

export type KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateClientRequest = {
	account?: KeetaNetAccount;
	asset: MovableAsset;
	location: AssetLocationLike;
	address: AddressResolved;
}


export type KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest = ToJSONSerializable<Omit<KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateClientRequest, 'asset' | 'location' | 'address'>> & {
	asset: AssetOrPairCanonical;
	location: AssetLocationCanonical;
	address: AddressResolved;
	signed?: HTTPSignedField;
}

export function getKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequestSigningData(input: KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateClientRequest | KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest): Signable {
	const pair = toAssetPair(input.asset);
	return(commonToSignable({
		asset: { from: convertAssetSearchInputToCanonical(pair.from), to: convertAssetSearchInputToCanonical(pair.to) },
		location: convertAssetLocationInputToCanonical(input.location),
		address: input.address
	}));
}


export type KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse = (({
	ok: true;
} & PersistentAddressTemplateData) | {
	ok: false;
	error: string;
});

export type KeetaAssetMovementAnchorListForwardingAddressTemplateClientRequest = {
	account?: KeetaNetAccount;
	asset?: MovableAsset[];
	location?: AssetLocationLike[];
	pagination?: PaginationQuery;
}

export type KeetaAssetMovementAnchorListForwardingAddressTemplateRequest = ToJSONSerializable<Pick<KeetaAssetMovementAnchorListForwardingAddressTemplateClientRequest, 'account' | 'pagination'>> & {
	asset?: MovableAssetSearchCanonical[] | undefined;
	location?: AssetLocationCanonical[] | undefined;
	signed?: HTTPSignedField;
}

export function getKeetaAssetMovementAnchorListForwardingAddressTemplateRequestSigningData(_ignore_input: KeetaAssetMovementAnchorListForwardingAddressTemplateClientRequest | KeetaAssetMovementAnchorListForwardingAddressTemplateRequest): Signable {
	return([ 'list-templates' ]);
}


export type KeetaAssetMovementAnchorListForwardingAddressTemplateResponse = (({
	ok: true;
	templates: PersistentAddressTemplateData[];
} & PaginationResponseInformation) | {
	ok: false;
	error: string;
});


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

export type KeetaAssetMovementAnchorCreatePersistentForwardingClientRequest = {
	account?: KeetaNetAccount;
	sourceLocation: AssetLocationLike;
	asset: AssetOrPair;
	outgoingRail?: Rail;
} & ({
	destinationLocation: AssetLocationLike;
	destinationAddress: AddressResolved;
} | {
	persistentAddressTemplateId: string;
});

export type KeetaAssetMovementAnchorCreatePersistentForwardingRequest = {
	account?: ToJSONSerializable<KeetaNetAccount> | undefined;
	signed?: HTTPSignedField;
	sourceLocation: AssetLocationCanonical;
	asset: AssetOrPairCanonical;
	outgoingRail?: Rail | undefined;
} & ({
	destinationLocation: AssetLocationCanonical;
	destinationAddress: AddressResolved;
} | {
	persistentAddressTemplateId: string;
});

export function getKeetaAssetMovementAnchorCreatePersistentForwardingRequestSigningData(input: KeetaAssetMovementAnchorCreatePersistentForwardingClientRequest | KeetaAssetMovementAnchorCreatePersistentForwardingRequest): Signable {
	return(commonToSignable({
		sourceLocation: convertAssetLocationInputToCanonical(input.sourceLocation),
		asset: convertAssetOrPairSearchInputToCanonical(input.asset),
		outgoingRail: input.outgoingRail,
		...('destinationLocation' in input ? {
			destinationLocation: convertAssetLocationInputToCanonical(input.destinationLocation),
			destinationAddress: input.destinationAddress
		} : {
			persistentAddressTemplateId: input.persistentAddressTemplateId
		})
	}))
}

export type KeetaAssetMovementAnchorCreatePersistentForwardingResponse = (({
	ok: true;
} & KeetaPersistentForwardingAddressDetails) | {
	ok: false;
	error: string;
});

export type KeetaAssetMovementAnchorListPersistentForwardingClientRequest = {
	account?: KeetaNetAccount;
	signed?: HTTPSignedField | undefined;
	search?: {
		sourceLocation?: AssetLocationLike;
		destinationLocation?: AssetLocationLike;
		asset?: MovableAsset;
		destinationAddress?: string;
		persistentAddressTemplateId?: string;
	}[];
	pagination?: PaginationQuery;
}

export type KeetaAssetMovementAnchorListPersistentForwardingRequest = {
	account?: ToJSONSerializable<KeetaNetAccount> | undefined;
	signed?: HTTPSignedField | undefined;
	search?: {
		sourceLocation?: AssetLocationCanonical | undefined;
		destinationLocation?: AssetLocationCanonical | undefined;
		asset?: MovableAssetSearchCanonical | undefined;
		destinationAddress?: string | undefined;
		persistentAddressTemplateId?: string | undefined;
	}[] | undefined;
	pagination?: PaginationQuery | undefined;
}

export type KeetaAssetMovementAnchorListPersistentForwardingResponse = (({
	ok: true;
	addresses: KeetaPersistentForwardingAddressDetails[];
} & PaginationResponseInformation) | {
	ok: false;
	error: string;
});

export function getKeetaAssetMovementAnchorListPersistentForwardingRequestSigningData(_ignore_input: KeetaAssetMovementAnchorListPersistentForwardingClientRequest | KeetaAssetMovementAnchorListPersistentForwardingRequest): Signable {
	return([ 'list-persistent-forwarding-addresses' ]);
}

type PaginationQuery = {
	limit?: number;
	offset?: number;
}

type PaginationResponseInformation = {
	total: string;
}

export type KeetaAssetMovementAnchorlistTransactionsClientRequest = {
	account?: KeetaNetAccount;
	persistentAddresses?: ({ location: AssetLocationLike; } & ({ persistentAddress?: string; persistentAddressTemplate: string; } | { persistentAddress: string; persistentAddressTemplate?: string; }))[];
	from?: { location: AssetLocationLike; userAddress?: string; asset?: MovableAsset; };
	to?: { location: AssetLocationLike; userAddress?: string; asset?: MovableAsset; };
	transactions?: { location: AssetLocationLike; transaction: Partial<TransactionId>; }[] | undefined;
	pagination?: PaginationQuery;
}

export type KeetaAssetMovementAnchorlistTransactionsRequest = {
	account?: ToJSONSerializable<KeetaNetAccount> | undefined;
	signed?: HTTPSignedField | undefined;
	persistentAddresses?: ({ location: AssetLocationCanonical; } & ({ persistentAddress?: string | undefined; persistentAddressTemplate: string; } | { persistentAddress: string; persistentAddressTemplate?: string | undefined; }))[] | undefined;
	from?: { location: AssetLocationCanonical; userAddress?: string | undefined; asset?: MovableAsset | undefined; } | undefined;
	to?: { location: AssetLocationCanonical; userAddress?: string | undefined; asset?: MovableAsset | undefined; } | undefined;
	transactions?: { location: AssetLocationCanonical; transaction: Partial<TransactionId>; }[] | undefined;
	pagination?: PaginationQuery | undefined;
}

export function getKeetaAssetMovementAnchorlistTransactionsRequestSigningData(_ignore_input: KeetaAssetMovementAnchorlistTransactionsClientRequest | KeetaAssetMovementAnchorlistTransactionsRequest): Signable {
	return([ 'list-transactions' ]);
}

export type KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = (({
	ok: true;
	transactions: KeetaAssetMovementTransaction[];
} & PaginationResponseInformation) | {
	ok: false;
	error: string;
});

export type KeetaAssetMovementAnchorShareKYCClientRequest = {
	account: KeetaNetAccount;
	attributes: string | SharableCertificateAttributes;
	tosAgreement?: { id: string; };
}

export type KeetaAssetMovementAnchorShareKYCRequest = ToJSONSerializable<Omit<KeetaAssetMovementAnchorShareKYCClientRequest, 'attributes'>> & {
	attributes: string;
	signed: HTTPSignedField;
};

export function getKeetaAssetMovementAnchorShareKYCRequestSigningData(_ignore_input: KeetaAssetMovementAnchorShareKYCClientRequest | KeetaAssetMovementAnchorShareKYCRequest): Signable {
	return([ 'share-kyc' ]);
}

export type KeetaAssetMovementAnchorShareKYCResponse = ({
	ok: true;
} | {
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
export const assertKeetaAssetMovementAnchorShareKYCRequest: (input: unknown) => KeetaAssetMovementAnchorShareKYCRequest = createAssert<KeetaAssetMovementAnchorShareKYCRequest>();
export const assertKeetaAssetMovementAnchorShareKYCResponse: (input: unknown) => KeetaAssetMovementAnchorShareKYCResponse = createAssertEquals<KeetaAssetMovementAnchorShareKYCResponse>();

export const isKeetaAssetMovementAnchorInitiateTransferRequest: (input: unknown) => input is KeetaAssetMovementAnchorInitiateTransferRequest = createIs<KeetaAssetMovementAnchorInitiateTransferRequest>();
export const isKeetaAssetMovementAnchorGetTransferStatusRequest: (input: unknown) => input is KeetaAssetMovementAnchorGetTransferStatusRequest = createIs<KeetaAssetMovementAnchorGetTransferStatusRequest>();
export const isKeetaAssetMovementAnchorListForwardingAddressTemplateRequest: (input: unknown) => input is KeetaAssetMovementAnchorListForwardingAddressTemplateRequest = createIs<KeetaAssetMovementAnchorListForwardingAddressTemplateRequest>();
export const isKeetaAssetMovementAnchorListForwardingAddressTemplateResponse: (input: unknown) => input is KeetaAssetMovementAnchorListForwardingAddressTemplateResponse = createIs<KeetaAssetMovementAnchorListForwardingAddressTemplateResponse>();
export const isKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse: (input: unknown) => input is KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse = createIs<KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse>();
export const isKeetaAssetMovementAnchorCreatePersistentForwardingResponse: (input: unknown) => input is KeetaAssetMovementAnchorCreatePersistentForwardingResponse = createIs<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>();
export const isKeetaAssetMovementAnchorInitiateTransferResponse: (input: unknown) => input is KeetaAssetMovementAnchorInitiateTransferResponse = createIs<KeetaAssetMovementAnchorInitiateTransferResponse>();
export const isKeetaAssetMovementAnchorGetExchangeStatusResponse: (input: unknown) => input is KeetaAssetMovementAnchorGetTransferStatusResponse = createIs<KeetaAssetMovementAnchorGetTransferStatusResponse>();
export const isKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse: (input: unknown) => input is KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = createIs<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>();
export const isKeetaAssetMovementAnchorShareKYCResponse: (input: unknown) => input is KeetaAssetMovementAnchorShareKYCResponse = createIs<KeetaAssetMovementAnchorShareKYCResponse>();

type Account = InstanceType<typeof KeetaNet.lib.Account<Exclude<AccountKeyAlgorithm, IdentifierKeyAlgorithm>>>;

type KeetaAssetMovementAnchorKYCShareNeededErrorTosFlow = {
	type: 'url-flow';
	url: string;
}

interface KeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties {
	tosFlow: KeetaAssetMovementAnchorKYCShareNeededErrorTosFlow | undefined;
	neededAttributes: string[] | undefined;
	shareWithPrincipals: ReturnType<Account['publicKeyString']['get']>[];
	acceptedIssuers: string[];
}

export const assertKeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties: (input: unknown) => KeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties = createAssertEquals<KeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties>();



type KeetaAssetMovementAnchorKYCShareNeededErrorJSON = ReturnType<KeetaAnchorUserError['toJSON']> & KeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties;

type KeetaNetCertificate = InstanceType<typeof KeetaNet.lib.Utils.Certificate.Certificate>
class KeetaAssetMovementAnchorKYCShareNeededError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaAssetMovementAnchorKYCShareNeededError';
	private readonly KeetaAssetMovementAnchorKYCShareNeededErrorObjectTypeID!: string;
	private static readonly KeetaAssetMovementAnchorKYCShareNeededErrorObjectTypeID = '3f4d6acd-8915-40de-94fa-4c6c48c01623';

	readonly shareWithPrincipals: Account[];
	readonly neededAttributes: string[] | undefined;
	readonly tosFlow: KeetaAssetMovementAnchorKYCShareNeededErrorTosFlow | undefined;
	readonly acceptedIssuers: KeetaNetCertificate[];

	constructor(args: {
		neededAttributes?: string[] | undefined;
		shareWithPrincipals: Account[];
		tosFlow?: KeetaAssetMovementAnchorKYCShareNeededErrorTosFlow | undefined;
		acceptedIssuers: KeetaNetCertificate[];
	}, message?: string) {
		super(message ?? 'User Not Onboarded to Asset Movement Service');
		this.statusCode = 403;

		Object.defineProperty(this, 'KeetaAssetMovementAnchorKYCShareNeededErrorObjectTypeID', {
			value: KeetaAssetMovementAnchorKYCShareNeededError.KeetaAssetMovementAnchorKYCShareNeededErrorObjectTypeID,
			enumerable: false
		});

		this.neededAttributes = args.neededAttributes;
		this.tosFlow = args.tosFlow;
		this.shareWithPrincipals = args.shareWithPrincipals;
		this.acceptedIssuers = args.acceptedIssuers;
	}

	static isInstance(input: unknown): input is KeetaAssetMovementAnchorKYCShareNeededError {
		return(this.hasPropWithValue(input, 'KeetaAssetMovementAnchorKYCShareNeededErrorObjectTypeID', KeetaAssetMovementAnchorKYCShareNeededError.KeetaAssetMovementAnchorKYCShareNeededErrorObjectTypeID));
	}


	asErrorResponse(contentType: 'text/plain' | 'application/json'): { error: string; statusCode: number; contentType: string } {
		const { tosFlow, neededAttributes, shareWithPrincipals, acceptedIssuers } = this.toJSON();

		let message = this.message;
		if (contentType === 'application/json') {
			message = JSON.stringify({
				ok: false,
				name: this.name,
				code: 'KEETA_ANCHOR_ASSET_MOVEMENT_KYC_SHARE_NEEDED',
				data: { tosFlow, neededAttributes, shareWithPrincipals, acceptedIssuers },
				error: this.message
			});
		}

		return({
			error: message,
			statusCode: this.statusCode,
			contentType: contentType
		});
	}

	toJSON(): KeetaAssetMovementAnchorKYCShareNeededErrorJSON {
		return({
			...super.toJSON(),
			tosFlow: this.tosFlow,
			neededAttributes: this.neededAttributes,
			shareWithPrincipals: this.shareWithPrincipals.map(function(account) {
				return(account.publicKeyString.get());
			}),
			acceptedIssuers: this.acceptedIssuers.map(function(cert) {
				return(cert.toString());
			})
		});
	}

	static async fromJSON(input: unknown): Promise<KeetaAssetMovementAnchorKYCShareNeededError> {
		const { message, other } = this.extractErrorProperties(input, this);

		if (!('data' in other)) {
			throw(new Error('Invalid KeetaAssetMovementAnchorKYCShareNeededError JSON: missing data property'));
		}

		const parsed = assertKeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties(other.data);

		const error = new this(
			{
				shareWithPrincipals: parsed.shareWithPrincipals.map(function(pubKeyString) {
					return(KeetaNet.lib.Account.fromPublicKeyString(pubKeyString).assertAccount());
				}),
				neededAttributes: parsed.neededAttributes,
				tosFlow: parsed.tosFlow,
				acceptedIssuers: parsed.acceptedIssuers.map(function(certString) {
					return(new KeetaNet.lib.Utils.Certificate.Certificate(certString));
				})
			},
			message
		);

		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	KYCShareNeeded: typeof KeetaAssetMovementAnchorKYCShareNeededError;
} = {
	/**
	 * The user is required to share KYC details
	 */
	KYCShareNeeded: KeetaAssetMovementAnchorKYCShareNeededError
};
