import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

export const AsyncDisposableStack: typeof KeetaNetLib.Utils.Helper.AsyncDisposableStack = KeetaNetLib.Utils.Helper.AsyncDisposableStack;
export type AsyncDisposableStack = InstanceType<typeof AsyncDisposableStack>;
