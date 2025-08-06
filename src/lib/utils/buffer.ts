import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

export type Buffer = InstanceType<typeof KeetaNetLib.Utils.Buffer.Buffer>;
export const Buffer: typeof KeetaNetLib.Utils.Buffer.Buffer = KeetaNetLib.Utils.Buffer.Buffer;
