import type { TokenAddress, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';

export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
export type KeetaNetStorageAccount = InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.STORAGE>>;
export type KeetaNetToken = InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>;
export type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

export type HexString = `0x${string}`;

export type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode | `$${string}`; /* XXX:TODO */
export type CurrencySearchInput = CurrencySearchCanonical | CurrencyInfo.Currency;

export type TokenSearchInput = TokenAddress | TokenPublicKeyString;
export type TokenSearchCanonical = TokenPublicKeyString;

export type EVMAsset = `evm:${HexString}`;
export type TronAsset = `tron:${string}`;
export type SolanaAsset = `solana:${string}`;
export type ChainAssetString = SolanaAsset | EVMAsset | TronAsset | TokenPublicKeyString;
export type MovableAssetSearchInput = CurrencySearchInput | TokenSearchInput | ChainAssetString;
export type MovableAssetSearchCanonical = CurrencySearchCanonical | TokenSearchCanonical | ChainAssetString;
export type MovableAsset = TokenAddress | TokenPublicKeyString | CurrencySearchInput | ChainAssetString;

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

export function toTronAsset(input: string): TronAsset {
	return(`tron:${input}`);
}

export function parseTronAsset(input: TronAsset): string {
	const parts = input.split(':');
	if (parts.length !== 2 || parts[0] !== 'tron') {
		throw(new Error('Invalid TronAsset string'));
	}

	const value = parts[1];
	if (!value || typeof value !== 'string' || value.length === 0) {
		throw(new Error('Invalid hex string in TronAsset'));
	}

	return(value);
}

export function isTronAsset(input: unknown): input is TronAsset {
	return(typeof input === 'string' && input.startsWith('tron:'));
}

export function toSolanaAsset(input: string): SolanaAsset {
	return(`solana:${input}`);
}

export function parseSolanaAsset(input: SolanaAsset): string {
	const parts = input.split(':');
	if (parts.length !== 2 || parts[0] !== 'solana') {
		throw(new Error('Invalid SolanaAsset string'));
	}

	const value = parts[1];
	if (!value || typeof value !== 'string' || value.length === 0) {
		throw(new Error('Invalid string in SolanaAsset'));
	}

	return(value);
}

export function isSolanaAsset(input: unknown): input is SolanaAsset {
	return(typeof input === 'string' && input.startsWith('solana:'));
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
