import type { MovableAssetSearchCanonical } from './asset.js';

/**
 * A fee value denominated in a specific asset.
 * Values are strings representing the amount in the asset's smallest unit
 * (e.g. cents for USD, satoshis for BTC).
 */
export interface Fee {
	asset: MovableAssetSearchCanonical;
	value: string;
}

/**
 * A fee range denominated in a specific asset, representing
 * a minimum and maximum expected fee.
 * Values are strings representing the amount in the asset's smallest unit
 * (e.g. cents for USD, satoshis for BTC).
 */
export interface FeeRange {
	asset: MovableAssetSearchCanonical;
	min: string;
	max: string;
}
