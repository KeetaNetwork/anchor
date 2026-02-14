import { assertNever } from "../../../lib/utils/never.js";
import type { BankAccountAddressObfuscated, MobileWalletAddressObfuscated } from "../common.js";
import { assertBankAccountType, assertMobileWalletAccountType, isTronNetworkAlias } from "./location.generated.js";

interface BaseLocation<Type extends 'chain' | 'bank-account' | 'mobile-wallet'> {
	type: Type;
}

export interface BankLocation extends BaseLocation<'bank-account'> {
	account: {
		type: BankAccountType;
	}
}

export interface MobileWalletLocation extends BaseLocation<'mobile-wallet'> {
	account: {
		type: MobileWalletAccountType;
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
		/**
		 * The network ID representing the Keeta network to interact with
		 */
		networkId: bigint;
	} | {
		type: 'evm';
		/**
		 * The chain ID representing the EVM-based network to interact with
		 */
		chainId: bigint;
	} | {
		type: 'solana';
		/**
		 * The genesis hash representing Solana network/cluster to interact with
		 */
		genesisHash: string;
	} | {
		type: 'bitcoin';
		/**
		 * The "magic bytes" representing the bitcoin network to interact with
		 */
		magicBytes: string;
	} | {
		type: 'tron';
		/**
		 * The network alias representing the Tron network to interact with
		 * Note: this is not the chain ID, but a human-readable alias because tron does not use chain/network IDs or any similar way to differentiate networks
		 */
		networkAlias: 'mainnet' | 'shasta' | 'nile' | `custom:${string}`;
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

export type AssetLocation = ChainLocation | BankLocation | MobileWalletLocation;

export type BankAccountType = BankAccountAddressObfuscated['accountType'];
export type MobileWalletAccountType = MobileWalletAddressObfuscated['accountType'];

export type AssetLocationString =
	`chain:${'keeta' | 'evm'}:${bigint}` | `chain:${'solana' | 'bitcoin' | 'tron'}:${string}` |
	`bank-account:${BankAccountType}` |
	`mobile-wallet:${MobileWalletAccountType}`;

export type AssetLocationLike = AssetLocation | AssetLocationString;

export type AssetLocationInput = AssetLocation | AssetLocationString;
export type AssetLocationCanonical = AssetLocationString;

export function convertAssetLocationToString(input: AssetLocationLike): AssetLocationString {
	if (typeof input === 'string') {
		return(input);
	}

	if (input.type === 'chain') {
		if (input.chain.type === 'keeta') {
			return(`chain:keeta:${input.chain.networkId}`);
		} else if (input.chain.type === 'evm') {
			return(`chain:evm:${input.chain.chainId}`);
		} else if (input.chain.type === 'solana') {
			return(`chain:solana:${input.chain.genesisHash}`);
		} else if (input.chain.type === 'bitcoin') {
			return(`chain:bitcoin:${input.chain.magicBytes}`);
		} else if (input.chain.type === 'tron') {
			return(`chain:tron:${input.chain.networkAlias}`);
		} else {
			assertNever(input.chain);
		}
	} else if (input.type === 'bank-account') {
		return(`bank-account:${assertBankAccountType(input.account.type)}`);
	} else if (input.type === 'mobile-wallet') {
		return(`mobile-wallet:${assertMobileWalletAccountType(input.account.type)}`);
	} else {
		throw(new Error(`Invalid AssetLocation type: ${JSON.stringify(input)}`));
	}
}

function validateSolanaGenesisHash(hash: string): boolean {
	// Basic validation: Solana genesis hashes are typically 44-character base58 strings
	const genesisHashRegex = /^(?=.{43,44}$)[1-9A-HJ-NP-Za-km-z]+$/;
	return(genesisHashRegex.test(hash));
}

function validateBitcoinMagicBytes(magicBytes: string): boolean {
	if (magicBytes.length !== 8) {
		return(false);
	}

	try {
		const buffer = Buffer.from(magicBytes, 'hex');
		return(buffer.length === 4);
	} catch {
		return(false);
	}
}

export function toAssetLocationFromString(input: string): AssetLocation {
	const [ kind, ...parts ] = input.split(':');

	if (kind === 'chain') {
		if (parts.length !== 2) {
			throw(new Error('Invalid AssetLocation chain string'));
		}

		const chainType = parts[0];
		if (!parts[1] || typeof parts[1] !== 'string') {
			throw(new Error('Invalid chain id in AssetLocation string'));
		}


		return({
			type: 'chain',
			chain: (() => {
				if (chainType === 'keeta' || chainType === 'evm') {
					const chainId = BigInt(parts[1]);

					if (chainId < 0n) {
						throw(new Error(`Invalid chain id in AssetLocation string: ${parts[1]}`));
					}

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
					}
				} else if (chainType === 'solana') {
					const genesisHash = parts[1];
					if (!validateSolanaGenesisHash(genesisHash)) {
						throw(new Error(`Invalid Solana genesis hash in AssetLocation string: ${genesisHash}`));
					}

					return({
						type: 'solana',
						genesisHash: genesisHash
					});
				} else if (chainType === 'bitcoin') {
					const magicBytes = parts[1];

					if (!validateBitcoinMagicBytes(magicBytes)) {
						throw(new Error(`Invalid Bitcoin magic bytes in AssetLocation string: ${magicBytes}`));
					}

					return({
						type: 'bitcoin',
						magicBytes: magicBytes
					});
				} else if (chainType === 'tron') {
					const networkAlias = parts[1];
					if (!isTronNetworkAlias(networkAlias)) {
						throw(new Error(`Invalid Tron network alias in AssetLocation string: ${networkAlias}`));
					}

					return({
						type: 'tron',
						networkAlias: networkAlias
					});
				}

				throw(new Error(`Invalid chain type in AssetLocation string: ${chainType}`));
			})()
		});
	} else if (kind === 'bank-account') {
		if (parts.length !== 1) {
			throw(new Error('Invalid AssetLocation bank-account string'));
		}

		return({
			type: 'bank-account',
			account: { type: assertBankAccountType(parts[0]) }
		});
	} else if (kind === 'mobile-wallet') {
		if (parts.length !== 1) {
			throw(new Error('Invalid AssetLocation mobile-wallet string'));
		}

		return({
			type: 'mobile-wallet',
			account: { type: assertMobileWalletAccountType(parts[0]) }
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
