import type {
	KeetaKYCAnchorClientConfig
} from '../services/kyc/client.ts';
import KeetaKYCAnchorClient from '../services/kyc/client.js';
import * as lib from '../lib/index.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import KeetaAssetMovementAnchorClient, { KeetaAssetMovementClientConfig } from '../services/asset-movement/client.js';

// TODO: Determine how we want to export the client
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace KYC {
	export type ClientConfig = KeetaKYCAnchorClientConfig;
	export const Client: typeof KeetaKYCAnchorClient = KeetaKYCAnchorClient;
}

export namespace AssetMovement {
	export type ClientConfig = KeetaAssetMovementClientConfig;
	export const Client: typeof KeetaAssetMovementAnchorClient = KeetaAssetMovementAnchorClient;
}

export {
	lib,
	KeetaNet
};
