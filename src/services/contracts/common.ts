import { createHash } from 'node:crypto';
import type { ToJSONSerializable } from '../../lib/utils/json.ts';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import type {
	Base64,
	ContractCommitment,
	ContractEngineErrorKind,
	ContractEvent,
	ContractRecord,
	ContractStorageProof,
	Decimal,
	Hex
} from './engine.js';

export {
	isKeetaContractsAnchorUploadResponseJSON,
	isKeetaContractsAnchorCallResponseJSON,
	isKeetaContractsAnchorQueryResponseJSON,
	isKeetaContractsAnchorContractResponseJSON,
	isKeetaContractsAnchorProveResponseJSON,
	isKeetaContractsAnchorSimulateResponseJSON
} from './common.generated.js';
import { Buffer } from '../../lib/utils/buffer.js';

// #region Requests

interface Authenticated {
	/** The caller: signs the request, and the funding block if any */
	account: string;
	signed: HTTPSignedField;
}

interface CallOptions {
	/** The caller's signed block funding the call (funds and fee) */
	fundingBlock?: Base64;
	gasLimit?: Decimal;
}

export interface KeetaContractsAnchorUploadRequest extends Authenticated {
	wasm: Base64;
}

export interface KeetaContractsAnchorInstantiateRequest extends Authenticated, CallOptions {
	codeId: Decimal;
	/** The contract's instantiate message, as JSON text */
	msg: string;
	label: string;
	/** Account allowed to migrate the contract */
	admin?: string | null;
}

export interface KeetaContractsAnchorExecuteRequest extends Authenticated, CallOptions {
	contract: string;
	/** The contract's execute message, as JSON text */
	msg: string;
}

export interface KeetaContractsAnchorMigrateRequest extends Authenticated, CallOptions {
	contract: string;
	newCodeId: Decimal;
	msg: string;
}

export interface KeetaContractsAnchorQueryRequest {
	contract: string;
	msg: string;
}

export interface KeetaContractsAnchorProveRequest {
	contract: string;
	key: Base64;
}

/** A dry run, to estimate gas and the fee. Never published. */
export type KeetaContractsAnchorSimulateRequest = {
	account: string;
	funds?: { token: string; amount: Decimal; }[];
	gasLimit?: Decimal;
} & ({
	kind: 'instantiate';
	codeId: Decimal;
	msg: string;
	label: string;
} | {
	kind: 'execute';
	contract: string;
	msg: string;
});

export type KeetaContractsAnchorUploadRequestJSON = ToJSONSerializable<KeetaContractsAnchorUploadRequest>;
export type KeetaContractsAnchorInstantiateRequestJSON = ToJSONSerializable<KeetaContractsAnchorInstantiateRequest>;
export type KeetaContractsAnchorExecuteRequestJSON = ToJSONSerializable<KeetaContractsAnchorExecuteRequest>;
export type KeetaContractsAnchorMigrateRequestJSON = ToJSONSerializable<KeetaContractsAnchorMigrateRequest>;
export type KeetaContractsAnchorQueryRequestJSON = ToJSONSerializable<KeetaContractsAnchorQueryRequest>;
export type KeetaContractsAnchorProveRequestJSON = ToJSONSerializable<KeetaContractsAnchorProveRequest>;
export type KeetaContractsAnchorSimulateRequestJSON = ToJSONSerializable<KeetaContractsAnchorSimulateRequest>;

// #endregion

// #region Responses

type Failed = { ok: false; error: string; };

export type KeetaContractsAnchorUploadResponseJSON = {
	ok: true;
	codeId: Decimal;
	checksum: Hex;
	requiredCapabilities: string[];
} | Failed;

export interface KeetaContractsAnchorCallResult {
	contract: string;
	data: Base64 | null;
	events: ContractEvent[];
	gasUsed: Decimal;
	fee: Decimal;
	refund: Decimal;
	/** Hashes of the published staple's blocks, in order */
	blocks: Hex[];
	commitments: ContractCommitment[];
}

export type KeetaContractsAnchorCallResponseJSON = ({ ok: true; } & KeetaContractsAnchorCallResult) | Failed;

export type KeetaContractsAnchorQueryResponseJSON = { ok: true; result: Base64; } | Failed;

export type KeetaContractsAnchorContractResponseJSON = { ok: true; contract: ContractRecord; } | Failed;

export type KeetaContractsAnchorProveResponseJSON = { ok: true; proof: ContractStorageProof; } | Failed;

export type KeetaContractsAnchorSimulateResponseJSON = {
	ok: true;
	gasUsed: Decimal;
	/** Fee the call would cost at the sequencer's gas price */
	fee: Decimal;
	events: ContractEvent[];
	data: Base64 | null;
} | Failed;

// #endregion

// #region Signing

const contractsNamespace = '0d6d4d3e-1f6b-4a36-9b8e-6c3c7f2a9e51';

export function sha256Hex(data: Buffer | string): Hex {
	return(createHash('sha256').update(data).digest('hex'));
}

function fundingHash(fundingBlock: Base64 | undefined): string {
	return(fundingBlock === undefined ? '' : sha256Hex(Buffer.from(fundingBlock, 'base64')));
}

export function getContractUploadSignable(request: Pick<KeetaContractsAnchorUploadRequest, 'wasm'>): Signable {
	return([contractsNamespace, 'UPLOAD', sha256Hex(Buffer.from(request.wasm, 'base64'))]);
}

export function getContractInstantiateSignable(request: Omit<KeetaContractsAnchorInstantiateRequest, 'account' | 'signed'>): Signable {
	return([
		contractsNamespace,
		'INSTANTIATE',
		request.codeId,
		sha256Hex(request.msg),
		request.label,
		request.admin ?? '',
		fundingHash(request.fundingBlock),
		request.gasLimit ?? ''
	]);
}

export function getContractExecuteSignable(request: Omit<KeetaContractsAnchorExecuteRequest, 'account' | 'signed'>): Signable {
	return([
		contractsNamespace,
		'EXECUTE',
		request.contract,
		sha256Hex(request.msg),
		fundingHash(request.fundingBlock),
		request.gasLimit ?? ''
	]);
}

export function getContractMigrateSignable(request: Omit<KeetaContractsAnchorMigrateRequest, 'account' | 'signed'>): Signable {
	return([
		contractsNamespace,
		'MIGRATE',
		request.contract,
		request.newCodeId,
		sha256Hex(request.msg),
		fundingHash(request.fundingBlock),
		request.gasLimit ?? ''
	]);
}

// #endregion

// #region Errors

interface KeetaContractsAnchorCallFailedErrorProperties {
	kind: ContractEngineErrorKind;
}

type KeetaContractsAnchorCallFailedErrorJSON = ReturnType<KeetaAnchorUserError['toJSON']> & KeetaContractsAnchorCallFailedErrorProperties;

const callFailedKinds: readonly ContractEngineErrorKind[] = [
	'vm', 'contract', 'ledger', 'unsupported', 'unknownContract', 'unknownCode', 'invalidAddress', 'invalidField',
	'outOfGas', 'depthExceeded', 'serialization', 'block', 'setup', 'host', 'merkle', 'funding', 'unauthorized'
];

function isCallFailedKind(input: unknown): input is ContractEngineErrorKind {
	return(typeof input === 'string' && callFailedKinds.some((kind) => kind === input));
}

/** The engine refused the call: the contract failed, gas ran out, the funding did not fit, … */
class KeetaContractsAnchorCallFailedError extends KeetaAnchorUserError implements KeetaContractsAnchorCallFailedErrorProperties {
	static override readonly name: string = 'KeetaContractsAnchorCallFailedError';
	private readonly KeetaContractsAnchorCallFailedErrorObjectTypeID!: string;
	private static readonly KeetaContractsAnchorCallFailedErrorObjectTypeID = '6a0b8a52-5c1e-4c55-9d0e-2f1f6a3b7c11';
	override readonly logLevel = 'INFO';
	readonly kind: ContractEngineErrorKind;

	constructor(properties: KeetaContractsAnchorCallFailedErrorProperties, message?: string) {
		super(message ?? `Contract call failed (${properties.kind})`);
		this.statusCode = properties.kind === 'unknownContract' || properties.kind === 'unknownCode' ? 404 : 422;

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
