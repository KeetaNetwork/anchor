/**
 * Bundles a smallest-unit integer with its decimal precision and asset.
 * Rescaling across locations with different precisions is explicit and
 * loss-checked.
 */

import type { Asset } from '../common.js';
import type { TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

import { KeetaAssetMovementTransferError } from './transfer-error.js';

/**
 * One asset a location serves, with the precision amounts take there.
 */
export interface LocationAssetPrecision {
	readonly id: Asset['id'];
	readonly decimals: number;
}

/**
 * The per-asset precision table of a location, for
 * {@link KeetaAnchorAmount.toLocationDecimals}.
 */
export interface AmountLocation {
	readonly assets: readonly LocationAssetPrecision[];
}

/**
 * The token shape {@link KeetaAnchorAmount.fromToken} accepts.
 */
export interface AmountToken {
	readonly tokenPublicKey: TokenPublicKeyString;
	readonly decimals: number;
}

function stripLeadingZeros(digits: string): string {
	const trimmed = digits.replace(/^0+/, '');
	if (trimmed === '') {
		return('0');
	}

	return(trimmed);
}

/**
 * Smallest-unit integer string to major-unit decimal (e.g. "1000", 2 -> "10.00").
 */
export function minorToMajor(value: string, exponent: number): string {
	if (exponent < 0) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `negative exponent: ${exponent}`));
	}

	let negative = false;
	let digits = value;
	if (value.startsWith('-')) {
		negative = true;
		digits = value.slice(1);
	}

	if (!/^\d+$/.test(digits)) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `not a smallest-unit integer: ${value}`));
	}

	let sign = '';
	if (negative) {
		sign = '-';
	}

	if (exponent === 0) {
		return(`${sign}${stripLeadingZeros(digits)}`);
	}

	const padded = digits.padStart(exponent + 1, '0');
	const whole = padded.slice(0, padded.length - exponent);
	const frac = padded.slice(padded.length - exponent);

	return(`${sign}${stripLeadingZeros(whole)}.${frac}`);
}

/**
 * Major-unit decimal to smallest-unit integer string (e.g. "10.00", 2 -> "1000").
 */
export function majorToMinor(amount: string, exponent: number): string {
	if (exponent < 0) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `negative exponent: ${exponent}`));
	}

	let negative = false;
	let unsigned = amount;
	if (amount.startsWith('-')) {
		negative = true;
		unsigned = amount.slice(1);
	}

	const parts = unsigned.split('.');
	if (parts.length > 2) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `malformed amount: ${amount}`));
	}

	const whole = parts[0] ?? '';
	const frac = parts[1] ?? '';
	if (!/^\d+$/.test(whole)) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `malformed amount: ${amount}`));
	}
	if (frac !== '' && !/^\d+$/.test(frac)) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `malformed amount: ${amount}`));
	}
	if (frac.length > exponent) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `amount ${amount} exceeds ${exponent} minor-unit digits`));
	}

	const normalized = stripLeadingZeros(`${whole}${frac.padEnd(exponent, '0')}`);

	let sign = '';
	if (negative && normalized !== '0') {
		sign = '-';
	}

	return(`${sign}${normalized}`);
}

function assertDecimals(decimals: number): void {
	if (!Number.isInteger(decimals) || decimals < 0) {
		throw(new KeetaAssetMovementTransferError('INVALID_AMOUNT', `decimals must be a non-negative integer: ${String(decimals)}`));
	}
}

/**
 * An immutable amount value object: smallest-unit integer `value` at
 * `decimals` precision, denominated in `asset`.
 */
export class KeetaAnchorAmount {
	readonly #value: bigint;
	readonly #decimals: number;
	readonly #asset: Asset['id'];

	constructor(value: bigint, decimals: number, asset: Asset['id']) {
		assertDecimals(decimals);

		this.#value = value;
		this.#decimals = decimals;
		this.#asset = asset;
	}

	/**
	 * The smallest-unit integer value at {@link decimals} precision.
	 */
	get value(): bigint {
		return(this.#value);
	}

	get decimals(): number {
		return(this.#decimals);
	}

	get asset(): Asset['id'] {
		return(this.#asset);
	}

	/**
	 * An amount of an on-chain token, at the token's precision.
	 */
	static fromToken(value: bigint, token: AmountToken): KeetaAnchorAmount {
		const result = new KeetaAnchorAmount(value, token.decimals, token.tokenPublicKey);
		return(result);
	}

	/**
	 * Rescale to another precision. Scaling down rejects any value that
	 * would lose precision: an anchor must never round funds silently.
	 */
	toDecimals(decimals: number): KeetaAnchorAmount {
		assertDecimals(decimals);

		if (decimals === this.#decimals) {
			return(this);
		}

		if (decimals > this.#decimals) {
			const factor = 10n ** BigInt(decimals - this.#decimals);
			return(new KeetaAnchorAmount(this.#value * factor, decimals, this.#asset));
		}

		const divisor = 10n ** BigInt(this.#decimals - decimals);
		if (this.#value % divisor !== 0n) {
			throw(new KeetaAssetMovementTransferError(
				'INVALID_AMOUNT',
				`rescaling ${this.#value.toString()} from ${this.#decimals} to ${decimals} decimals loses precision`
			));
		}

		const result = new KeetaAnchorAmount(this.#value / divisor, decimals, this.#asset);
		return(result);
	}

	/**
	 * Rescale to the precision `location` declares for this asset.
	 */
	toLocationDecimals(location: AmountLocation): KeetaAnchorAmount {
		const entry = location.assets.find((candidate) => {
			return(String(candidate.id) === String(this.#asset));
		});
		if (entry === undefined) {
			throw(new KeetaAssetMovementTransferError(
				'UNSUPPORTED_LOCATION_ASSET',
				`location does not serve asset "${String(this.#asset)}"`
			));
		}

		const result = this.toDecimals(entry.decimals);
		return(result);
	}

	/**
	 * The smallest-unit integer string at the location's precision for this asset.
	 */
	toLocationValue(location: AmountLocation): string {
		const result = this.toLocationDecimals(location).value.toString();
		return(result);
	}

	/**
	 * Major-unit decimal string for display (`100` at 2 decimals -> `"1.00"`).
	 */
	toMajor(): string {
		const result = minorToMajor(this.#value.toString(), this.#decimals);
		return(result);
	}

	/**
	 * Same asset and an identical value once both sides are rescaled to the
	 * wider precision.
	 */
	equals(other: KeetaAnchorAmount): boolean {
		if (String(this.#asset) !== String(other.#asset)) {
			return(false);
		}

		const decimals = Math.max(this.#decimals, other.#decimals);
		const result = this.toDecimals(decimals).value === other.toDecimals(decimals).value;
		return(result);
	}
}
