import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createAssert, createIs } from 'typia';

import type { ToJSONSerializable } from '../../lib/utils/json.js';

export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
export type KeetaNetToken = InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>;
export type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

export type IntervalString = '1m' | '5m' | '15m' | '30m' | '1h' | '6h' | '12h' | '1d' | '7d' | '14d' | '30d' | '90d' | '180d' | '1y' | '3y' | '5y' | '10y';

export type KeetaOrderMatcherPriceHistoryEntry = {
	timestamp: number;
	high: string;
	low: string;
	open: string;
	close: string;
	volume: string;
};

export type KeetaOrderMatcherPriceHistoryResponse = {
	ok: true;
	prices: KeetaOrderMatcherPriceHistoryEntry[];
} | {
	ok: false;
	error: string;
};

export type KeetaOrderMatcherPriceInfo = {
	last: string;
	priceChange?: { [interval in IntervalString]?: string; };
	volume?: { [interval in IntervalString]?: string; };
};

export type KeetaOrderMatcherPriceInfoResponse = ({
	ok: true;
} & KeetaOrderMatcherPriceInfo) | {
	ok: false;
	error: string;
};

export type KeetaOrderMatcherPriceInfoJSON = ToJSONSerializable<KeetaOrderMatcherPriceInfo>;

export type KeetaOrderMatcherPairDepthBucket = {
	price: string;
	volume: string;
};

export type KeetaOrderMatcherPairDepthResponse = {
	ok: true;
	grouping: number;
	buy: KeetaOrderMatcherPairDepthBucket[];
	sell: KeetaOrderMatcherPairDepthBucket[];
} | {
	ok: false;
	error: string;
};

export type KeetaOrderMatcherPairMetadata = {
	base: KeetaNetTokenPublicKeyString[];
	quote: KeetaNetTokenPublicKeyString[];
	fees?: {
		type: 'sell-token-percentage';
		minPercentBasisPoints: number;
	};
};

export const isKeetaOrderMatcherPriceHistoryResponse: (input: unknown) => input is KeetaOrderMatcherPriceHistoryResponse = createIs<KeetaOrderMatcherPriceHistoryResponse>();
export const isKeetaOrderMatcherPriceInfoResponse: (input: unknown) => input is KeetaOrderMatcherPriceInfoResponse = createIs<KeetaOrderMatcherPriceInfoResponse>();
export const isKeetaOrderMatcherPairDepthResponse: (input: unknown) => input is KeetaOrderMatcherPairDepthResponse = createIs<KeetaOrderMatcherPairDepthResponse>();
export const assertKeetaNetTokenPublicKeyString: (input: unknown) => KeetaNetTokenPublicKeyString = createAssert<KeetaNetTokenPublicKeyString>();
