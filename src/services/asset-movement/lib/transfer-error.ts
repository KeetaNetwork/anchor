/**
 * Typed errors for the asset-movement transfer layer, carrying a stable
 * {@link MovementErrorCode} for programmatic handling.
 */

import { KeetaAnchorError } from '../../../lib/error.js';

export const MovementErrorCodes = [
	'ILLEGAL_TRANSITION',
	'UNKNOWN_STATUS',
	'MALFORMED_MESSAGE',
	'INVALID_AMOUNT',
	'UNSUPPORTED_LOCATION_ASSET',
	'INBOUND_DELIVERY_MISMATCH',
	'MISSING_LEDGER_EFFECT',
	'EFFECT_AMOUNT_UNRESOLVED',
	'EFFECT_RECIPIENT_UNRESOLVED',
	'EFFECT_ABORTED',
	'EFFECT_WITHDRAW_UNRESOLVED',
	'UNKNOWN_ROUTE'
] as const;

export type MovementErrorCode = typeof MovementErrorCodes[number];

/**
 * HTTP status per code. Most movement errors are programmer/setup bugs.
 */
const STATUS_BY_CODE: { [Code in MovementErrorCode]: number } = {
	ILLEGAL_TRANSITION: 500,
	UNKNOWN_STATUS: 500,
	MALFORMED_MESSAGE: 400,
	INVALID_AMOUNT: 400,
	UNSUPPORTED_LOCATION_ASSET: 400,
	INBOUND_DELIVERY_MISMATCH: 422,
	MISSING_LEDGER_EFFECT: 500,
	EFFECT_AMOUNT_UNRESOLVED: 500,
	EFFECT_RECIPIENT_UNRESOLVED: 500,
	EFFECT_ABORTED: 503,
	EFFECT_WITHDRAW_UNRESOLVED: 503,
	UNKNOWN_ROUTE: 500
};

/*
 * A withdrawal whose source hash is consumed on-chain but whose transaction
 * is not yet locatable must keep retrying resolution.
 */
const RETRYABLE_BY_CODE: { [Code in MovementErrorCode]?: true } = {
	EFFECT_WITHDRAW_UNRESOLVED: true
};

/**
 * Error raised by the movement state machine and transfer compiler.
 */
export class KeetaAssetMovementTransferError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAssetMovementTransferError';
	private readonly KeetaAssetMovementTransferErrorObjectTypeID!: string;
	private static readonly KeetaAssetMovementTransferErrorObjectTypeID = 'a3f5c8e2-9b14-4e6d-8a72-6c0d2f1b4e57';
	readonly code: MovementErrorCode;

	constructor(code: MovementErrorCode, message?: string) {
		super(message ?? code);

		this.code = code;
		this.statusCode = STATUS_BY_CODE[code];
		this.retryable = RETRYABLE_BY_CODE[code] ?? false;

		Object.defineProperty(this, 'KeetaAssetMovementTransferErrorObjectTypeID', {
			value: KeetaAssetMovementTransferError.KeetaAssetMovementTransferErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaAssetMovementTransferError {
		return(this.hasPropWithValue(input, 'KeetaAssetMovementTransferErrorObjectTypeID', KeetaAssetMovementTransferError.KeetaAssetMovementTransferErrorObjectTypeID));
	}

	static isValidCode(value: string): value is MovementErrorCode {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(MovementErrorCodes.includes(value as MovementErrorCode));
	}

	override toJSON(): { ok: false; retryable: boolean; error: string; name: string; statusCode: number; code: MovementErrorCode } {
		return({
			...super.toJSON(),
			code: this.code
		});
	}

	static async fromJSON(input: unknown): Promise<KeetaAssetMovementTransferError> {
		const { message, other } = this.extractErrorProperties(input, this);

		if (!('code' in other) || typeof other.code !== 'string' || !this.isValidCode(other.code)) {
			throw(new TypeError('Invalid KeetaAssetMovementTransferError JSON object: missing or invalid code'));
		}

		const error = new this(other.code, message);
		error.restoreFromJSON(other);
		return(error);
	}
}
