/**
 * Shared types for the contract sequencer: a service that orders calls to
 * the contracts it sequences. Representatives run the calls and vote on
 * their outcome; the sequencer only decides the order, by signing a
 * `CONTRACT_ORDER` block on each contract's chain (see the node's
 * `docs/CONTRACTS.md`).
 */
import { createHash } from 'node:crypto';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { Buffer } from '../../lib/utils/buffer.js';

export {
	isKeetaContractsAnchorSubmitResponseJSON
} from './common.generated.js';

/** Base64 text */
export type Base64 = string;
/** Hex text, lower case */
export type Hex = string;
/** A non-negative integer, in decimal */
export type Decimal = string;

/** A state account a call reads or writes: owned by a contract, named by a 32-byte id. */
export interface ContractAccountMeta {
	/** The contract that owns the account */
	owner: string;
	id: Hex;
	writable: boolean;
}

/** A call to a contract: which contract, the state accounts it touches and its data. */
export interface ContractInstruction {
	contract: string;
	accounts: ContractAccountMeta[];
	data: Base64;
}

// #region Requests

/**
 * Blocks with contract calls, for the sequencer to order. Each is signed by
 * its own account: that signature is the call's authorization, so the
 * request needs no other.
 */
export interface KeetaContractsAnchorSubmitRequest {
	blocks: Base64[];
}

export type KeetaContractsAnchorSubmitRequestJSON = KeetaContractsAnchorSubmitRequest;

// #endregion

// #region Responses

type Failed = { ok: false; error: string; };

/** What a call did, as every representative's vote recorded it. */
export interface KeetaContractsAnchorCallOutcome {
	/** The block carrying the call, and the call's index in it */
	block: Hex;
	operationIndex: number;
	contract: string;
	gasUsed: Decimal;
	returnData: Base64;
	/** State accounts written, with their new versions */
	writes: { owner: string; id: Hex; version: Decimal; }[];
	/**
	 * Set when the contract refused the call. It landed anyway, and paid its
	 * fee and gas (all of its gas limit), but changed nothing; the funds its
	 * block sent the contract went back.
	 */
	failure?: { kind: string; message: string; };
}

export interface KeetaContractsAnchorSubmitResult {
	/** Hashes of the published staple's blocks, in order */
	blocks: Hex[];
	/** The submitted blocks' calls, in the order they ran */
	calls: KeetaContractsAnchorCallOutcome[];
}

export type KeetaContractsAnchorSubmitResponseJSON = ({ ok: true; } & KeetaContractsAnchorSubmitResult) | Failed;

// #endregion

// #region Fees

/**
 * What a sequencer charges to order calls, so that every call costs its
 * caller something. A block pays it with a `SEND` of `token` to the
 * sequencer: `perCall` for each `CONTRACT_CALL` in the block, plus `perGas`
 * for each unit of gas the calls may use (their gas limits). Amounts are
 * atomic units, in decimal.
 */
export interface KeetaContractsAnchorFeeSchedule {
	token: string;
	perCall: Decimal;
	perGas: Decimal;
}

/** The fee a block with calls of these gas limits owes under `schedule`. */
export function feeFor(schedule: { perCall: bigint | Decimal; perGas: bigint | Decimal; }, gasLimits: bigint[]): bigint {
	const perCall = BigInt(schedule.perCall);
	const perGas = BigInt(schedule.perGas);
	return(gasLimits.reduce((total, gasLimit) => total + perCall + (perGas * gasLimit), 0n));
}

// #endregion

// #region Helpers

/** A state account id: SHA-256 of the seeds, concatenated (the contract SDK's `state_id`). */
export function stateId(...seeds: (Buffer | string)[]): Buffer {
	const hash = createHash('sha256');
	for (const seed of seeds) {
		hash.update(typeof seed === 'string' ? Buffer.from(seed, 'utf-8') : seed);
	}

	return(hash.digest());
}

/**
 * An account as contracts see it: its key type and public key, padded to
 * 34 bytes (the contract SDK's `Address`).
 */
export function contractAddress(account: { publicKeyAndType: ArrayBuffer | Uint8Array; }): Buffer {
	const raw = Buffer.from(account.publicKeyAndType instanceof ArrayBuffer ? new Uint8Array(account.publicKeyAndType) : account.publicKeyAndType);
	if (raw.length > 34) {
		throw(new Error('An account address is at most 34 bytes'));
	}

	return(Buffer.concat([raw, Buffer.alloc(34 - raw.length)]));
}

// #endregion

// #region Errors

/** Why the sequencer could not get a call published. */
export type KeetaContractsAnchorCallFailedKind =
	/** A block is malformed, unsigned, or carries no contract call */
	'invalidBlock' |
	/** A call touches a contract this sequencer does not order */
	'notSequenced' |
	/** Representatives would not vote for the call: the contract refused it, it ran out of gas, … */
	'refused' |
	/** A block does not pay the sequencer's fee for its calls */
	'fee' |
	/** The contract refused the call; it landed anyway and paid for itself, but changed nothing */
	'reverted';

interface KeetaContractsAnchorCallFailedErrorProperties {
	kind: KeetaContractsAnchorCallFailedKind;
}

type KeetaContractsAnchorCallFailedErrorJSON = ReturnType<KeetaAnchorUserError['toJSON']> & KeetaContractsAnchorCallFailedErrorProperties;

const callFailedKinds: readonly KeetaContractsAnchorCallFailedKind[] = ['invalidBlock', 'notSequenced', 'refused', 'fee', 'reverted'];

function isCallFailedKind(input: unknown): input is KeetaContractsAnchorCallFailedKind {
	return(typeof input === 'string' && callFailedKinds.some((kind) => kind === input));
}

class KeetaContractsAnchorCallFailedError extends KeetaAnchorUserError implements KeetaContractsAnchorCallFailedErrorProperties {
	static override readonly name: string = 'KeetaContractsAnchorCallFailedError';
	private readonly KeetaContractsAnchorCallFailedErrorObjectTypeID!: string;
	private static readonly KeetaContractsAnchorCallFailedErrorObjectTypeID = '6a0b8a52-5c1e-4c55-9d0e-2f1f6a3b7c11';
	override readonly logLevel = 'INFO';
	readonly kind: KeetaContractsAnchorCallFailedKind;

	constructor(properties: KeetaContractsAnchorCallFailedErrorProperties, message?: string) {
		super(message ?? `Contract call failed (${properties.kind})`);
		this.statusCode = properties.kind === 'refused' ? 422 : 400;

		Object.defineProperty(this, 'KeetaContractsAnchorCallFailedErrorObjectTypeID', {
			value: KeetaContractsAnchorCallFailedError.KeetaContractsAnchorCallFailedErrorObjectTypeID,
			enumerable: false
		});

		this.kind = properties.kind;
	}

	static isInstance(input: unknown): input is KeetaContractsAnchorCallFailedError {
		return(this.hasPropWithValue(input, 'KeetaContractsAnchorCallFailedErrorObjectTypeID', KeetaContractsAnchorCallFailedError.KeetaContractsAnchorCallFailedErrorObjectTypeID));
	}

	toJSON(): KeetaContractsAnchorCallFailedErrorJSON {
		return({
			...super.toJSON(),
			kind: this.kind
		});
	}

	static async fromJSON(input: unknown): Promise<KeetaContractsAnchorCallFailedError> {
		const { message, other } = this.extractErrorProperties(input, this);

		if (!('kind' in other) || !isCallFailedKind(other.kind)) {
			throw(new Error('Invalid KeetaContractsAnchorCallFailedError JSON object: missing or invalid kind'));
		}

		const error = new this({ kind: other.kind }, message);
		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	CallFailed: typeof KeetaContractsAnchorCallFailedError;
} = {
	CallFailed: KeetaContractsAnchorCallFailedError
};

// #endregion
