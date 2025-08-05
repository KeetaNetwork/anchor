import type {
	KeetaKYCAnchorClientConfig
} from '../services/kyc/client.ts';
import KeetaKYCAnchorClient from '../services/kyc/client.js';

// TODO: Determine how we want to export the client
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace KYC {
	export type ClientConfig = KeetaKYCAnchorClientConfig;
	export const Client: typeof KeetaKYCAnchorClient = KeetaKYCAnchorClient;
}
