import type {
	KeetaKYCAnchorClientConfig
} from '../services/kyc/client.ts';
import type {
	KeetaFXAnchorClientConfig
} from '../services/fx/client.ts';
import type {
	KeetaStorageAnchorClientConfig
} from '../services/storage/client.ts';
import KeetaKYCAnchorClient from '../services/kyc/client.js';
import KeetaFXAnchorClient from '../services/fx/client.js';
import KeetaStorageAnchorClient from '../services/storage/client.js';
import * as lib from '../lib/index.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type {
	KeetaAssetMovementClientConfig
} from '../services/asset-movement/client.ts';
import KeetaAssetMovementAnchorClient from '../services/asset-movement/client.js';

// TODO: Determine how we want to export the client
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace KYC {
	export type ClientConfig = KeetaKYCAnchorClientConfig;
	export const Client: typeof KeetaKYCAnchorClient = KeetaKYCAnchorClient;
}
// TODO: Determine how we want to export the client
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace FX {
	export type ClientConfig = KeetaFXAnchorClientConfig;
	export const Client: typeof KeetaFXAnchorClient = KeetaFXAnchorClient;
}
// TODO: Determine how we want to export the client
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace AssetMovement {
	export type ClientConfig = KeetaAssetMovementClientConfig;
	export const Client: typeof KeetaAssetMovementAnchorClient = KeetaAssetMovementAnchorClient;
}
// TODO: Determine how we want to export the client
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Storage {
	export type ClientConfig = KeetaStorageAnchorClientConfig;
	export const Client: typeof KeetaStorageAnchorClient = KeetaStorageAnchorClient;
}

export {
	lib,
	KeetaNet
};
