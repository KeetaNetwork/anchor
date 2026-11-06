/**
 * The contract engine, as the sequencer sees it.
 *
 * The engine itself is the native addon `@keetanetwork/contract-engine`
 * (built from node-rs). This module describes its wire format, loads it
 * lazily (so only servers need the native binary), and answers the
 * engine's reads from two places: the sequencer's own state
 * ({@link ContractStateBackend}) and the Keeta ledger
 * ({@link ContractChainReader}).
 */
import { createHash } from 'node:crypto';
import type * as KeetaNet from '@keetanetwork/keetanet-client';
import type { ContractStateBackend } from './state.js';
import { Buffer } from '../../lib/utils/buffer.js';

// #region Wire format (mirrors keetanetwork-contract-napi/src/wire.rs)

/** Base64 bytes. */
export type Base64 = string;
/** Lowercase hex. */
export type Hex = string;
/** A u64 or other big integer, in decimal. */
export type Decimal = string;

export interface ContractAccountInfo {
	name: string;
	description: string;
	metadata: string;
}

export interface ContractCodeRecord {
	checksum: Hex;
	creator: string;
}

export interface ContractRecord {
	address: string;
	codeId: Decimal;
	codeHash: Hex;
	creator: string;
	admin: string | null;
	label: string;
	/** Name, description and the metadata the contract set itself */
	info: ContractAccountInfo;
	/** Commitments published so far */
	sequence: Decimal;
	treeVersion: Decimal | null;
	stateRoot: Hex;
}

export interface ContractTokenRecord {
	token: string;
	creator: string;
	subdenom: string;
}

export interface ContractStorageRecord {
	key: Base64;
	value: Base64;
}

export interface ContractKeyBound {
	key: Base64;
	inclusive: boolean;
}

export type ContractHostRequest =
	{ op: 'code'; codeId: Decimal; } |
	{ op: 'wasm'; checksum: Hex; } |
	{ op: 'contract'; address: string; } |
	{ op: 'storageGet'; contract: string; key: Base64; } |
	{ op: 'storageNext'; contract: string; lower: ContractKeyBound | null; upper: ContractKeyBound | null; order: 'ascending' | 'descending'; } |
	{ op: 'storageByHash'; contract: string; keyHash: Hex; } |
	{ op: 'treeNode'; contract: string; nodeKey: Base64; } |
	{ op: 'token'; creator: string; subdenom: string; } |
	{ op: 'tokenRecord'; token: string; } |
	{ op: 'balance'; account: string; token: string; } |
	{ op: 'accountInfo'; account: string; } |
	{ op: 'tokenSupply'; token: string; } |
	{ op: 'head'; account: string; };

export interface ContractBlockContext {
	height: Decimal;
	timeMillis: number;
}

export interface ContractCall extends ContractBlockContext {
	sender: string;
	/** The caller's signed funding block */
	fundingBlock?: Base64;
	/** Unsigned funding, for simulation only */
	funds?: { token: string; amount: Decimal; }[];
	fee?: Decimal;
	gasLimit?: Decimal;
}

export interface ContractEvent {
	type: string;
	attributes: [string, string][];
}

export interface ContractStapleBlock {
	signed: boolean;
	account: string;
	hash: Hex;
	bytes: Base64;
	signers: string[];
}

export interface ContractCommitment {
	contract: string;
	codeHash: Hex;
	stateRoot: Hex;
	sequence: Decimal;
	metadata: string;
}

export interface ContractChanges {
	contracts: ContractRecord[];
	storage: { contract: string; key: Base64; value: Base64 | null; }[];
	treeNodes: { contract: string; key: Base64; node: Base64; }[];
	staleTreeNodes: { contract: string; staleSinceVersion: Decimal; key: Base64; }[];
	tokens: ContractTokenRecord[];
}

export interface ContractExecution {
	contract: string;
	data: Base64 | null;
	events: ContractEvent[];
	gasUsed: Decimal;
	fee: Decimal;
	refund: Decimal;
	blocks: ContractStapleBlock[];
	commitments: ContractCommitment[];
	changes: ContractChanges;
}

export interface ContractStoredCode {
	checksum: Hex;
	requiredCapabilities: string[];
	entryPoints: string[];
}

export interface ContractStorageProof {
	value: Base64 | null;
	stateRoot: Hex;
	proof: Base64;
}

export type ContractEngineErrorKind =
	'vm' | 'contract' | 'ledger' | 'unsupported' | 'unknownContract' | 'unknownCode' | 'invalidAddress' |
	'invalidField' | 'outOfGas' | 'depthExceeded' | 'serialization' | 'block' | 'setup' | 'host' | 'merkle' |
	'funding' | 'unauthorized';

export type ContractOutcome<T> = { ok: T; } | { error: { kind: ContractEngineErrorKind; message: string; }; };

export interface ContractEngineConfig {
	network: Decimal;
	sequencer: string;
	chainId?: string;
	maxCallDepth?: number;
	cacheDir?: string;
	gasPrice?: { token: string; numerator: Decimal; denominator: Decimal; };
}

// #endregion

// #region The native addon

/** One engine instance, as exported by `@keetanetwork/contract-engine`. */
export interface ContractEngineInstance {
	storeCode(wasm: Buffer): Promise<string>;
	instantiate(call: string, codeId: string, msg: string, label: string, admin?: string | null): Promise<string>;
	execute(call: string, contract: string, msg: string): Promise<string>;
	migrate(call: string, contract: string, newCodeId: string, msg: string): Promise<string>;
	query(block: string, contract: string, msg: string): Promise<string>;
	prove(contract: string, key: Buffer): Promise<string>;
}

/** The addon's exports. */
export interface ContractEngineBinding {
	ContractEngine: new (config: string, host: (request: string) => Promise<string>) => ContractEngineInstance;
	sealBlock(unsigned: Buffer, signatures: Buffer[]): Buffer;
	verifyProof(stateRoot: string, key: Buffer, value: Buffer | null, proof: Buffer): boolean;
	decodeCommitment(contract: string, metadata: string): string;
	capabilities(): string[];
}

function isContractEngineBinding(input: unknown): input is ContractEngineBinding {
	if (typeof input !== 'object' || input === null) {
		return(false);
	}

	return(['ContractEngine', 'sealBlock', 'verifyProof', 'decodeCommitment', 'capabilities'].every(function(name) {
		return(name in input && typeof Reflect.get(input, name) === 'function');
	}));
}

export const CONTRACT_ENGINE_PACKAGE = '@keetanetwork/contract-engine';

/**
 * Load the native engine. Throws a descriptive error if the addon is not
 * installed or not built for this platform.
 */
export async function loadContractEngine(packageName: string = CONTRACT_ENGINE_PACKAGE): Promise<ContractEngineBinding> {
	let loaded: unknown;
	try {
		loaded = await import(packageName);
	} catch (error) {
		throw(new Error(`The contract sequencer needs the native contract engine (${packageName}); it could not be loaded: ${String(error)}`));
	}

	const binding: unknown = typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : loaded;
	if (!isContractEngineBinding(binding)) {
		throw(new Error(`${packageName} does not look like the contract engine`));
	}

	return(binding);
}

/** The engine refused or failed a call. */
export class ContractEngineCallError extends Error {
	readonly kind: ContractEngineErrorKind;

	constructor(kind: ContractEngineErrorKind, message: string) {
		super(message);
		this.name = 'ContractEngineCallError';
		this.kind = kind;
	}
}

/**
 * Unwrap an engine outcome, or throw {@link ContractEngineCallError}.
 */
export function unwrapOutcome<T>(json: string): T {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const outcome = JSON.parse(json) as ContractOutcome<T>;
	if ('error' in outcome) {
		throw(new ContractEngineCallError(outcome.error.kind, outcome.error.message));
	}

	return(outcome.ok);
}

// #endregion

// #region Answering the engine

/** Ledger reads the engine needs. */
export interface ContractChainReader {
	balance(account: string, token: string): Promise<bigint>;
	accountInfo(account: string): Promise<ContractAccountInfo>;
	/** `null` if the token does not exist */
	tokenSupply(token: string): Promise<bigint | null>;
	/** Hex hash of the account's latest block, `null` before its first */
	head(account: string): Promise<string | null>;
}

/** Reads the ledger through a KeetaNet client. */
export class KeetaNetChainReader implements ContractChainReader {
	readonly #client: KeetaNet.Client;

	constructor(client: KeetaNet.Client) {
		this.#client = client;
	}

	async #state(account: string): Promise<{ head: string | null; info: { [key: string]: unknown; }; }> {
		const states = await this.#client.getAccountsInfo([account]);
		const state = states[account];
		if (state === undefined) {
			return({ head: null, info: {}});
		}

		return({ head: state.currentHeadBlock, info: { ...state.info }});
	}

	async balance(account: string, token: string): Promise<bigint> {
		return(await this.#client.getBalance(account, token));
	}

	async accountInfo(account: string): Promise<ContractAccountInfo> {
		const { info } = await this.#state(account);
		const text = function(key: string): string {
			const value = info[key];
			return(typeof value === 'string' ? value : '');
		};

		return({ name: text('name'), description: text('description'), metadata: text('metadata') });
	}

	async tokenSupply(token: string): Promise<bigint | null> {
		const { head, info } = await this.#state(token);
		if (head === null) {
			return(null);
		}

		const supply = info['supply'];
		if (typeof supply === 'bigint') {
			return(supply);
		}
		if (typeof supply === 'string' || typeof supply === 'number') {
			return(BigInt(supply));
		}

		return(0n);
	}

	async head(account: string): Promise<string | null> {
		const { head } = await this.#state(account);
		return(head === null ? null : head.toLowerCase());
	}
}

function fromBase64(text: Base64): Buffer {
	return(Buffer.from(text, 'base64'));
}

function toBase64(bytes: Buffer | null): Base64 | null {
	return(bytes === null ? null : bytes.toString('base64'));
}

/** SHA-256 of a storage key, as the engine's Merkle trees key it. */
export function storageKeyHash(key: Buffer): Hex {
	return(createHash('sha256').update(key).digest('hex'));
}

/**
 * The `host` callback for {@link ContractEngineBinding.ContractEngine}:
 * answers each engine read from the sequencer's state or the ledger.
 */
export function createHostCallback(state: ContractStateBackend, chain: ContractChainReader): (request: string) => Promise<string> {
	async function answer(request: ContractHostRequest): Promise<unknown> {
		switch (request.op) {
			case 'code':
				return(await state.code(BigInt(request.codeId)));
			case 'wasm':
				return(toBase64(await state.wasm(request.checksum)));
			case 'contract':
				return(await state.contract(request.address));
			case 'storageGet':
				return(toBase64(await state.storageGet(request.contract, fromBase64(request.key))));
			case 'storageNext': {
				const bound = function(input: ContractKeyBound | null) {
					return(input === null ? null : { key: fromBase64(input.key), inclusive: input.inclusive });
				};
				const record = await state.storageNext(request.contract, bound(request.lower), bound(request.upper), request.order);
				return(record === null ? null : { key: record.key.toString('base64'), value: record.value.toString('base64') });
			}
			case 'storageByHash':
				return(toBase64(await state.storageByHash(request.contract, request.keyHash)));
			case 'treeNode':
				return(toBase64(await state.treeNode(request.contract, fromBase64(request.nodeKey))));
			case 'token':
				return(await state.token(request.creator, request.subdenom));
			case 'tokenRecord':
				return(await state.tokenRecord(request.token));
			case 'balance':
				return((await chain.balance(request.account, request.token)).toString());
			case 'accountInfo':
				return(await chain.accountInfo(request.account));
			case 'tokenSupply': {
				const supply = await chain.tokenSupply(request.token);
				return(supply === null ? null : supply.toString());
			}
			case 'head':
				return(await chain.head(request.account));
		}
	}

	return(async function(request: string): Promise<string> {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(JSON.stringify(await answer(JSON.parse(request) as ContractHostRequest)));
	});
}

// #endregion
