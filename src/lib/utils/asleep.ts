import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

export const asleep: (ms: number) => Promise<void> = KeetaNetLib.Utils.Helper.asleep.bind(KeetaNetLib.Utils.Helper);
