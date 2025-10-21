import { lib } from '@keetanetwork/keetanet-client';
export type * from '@keetanetwork/keetanet-client/lib/log/index.js';

const Log: typeof lib.Log = lib.Log;
const LegacyLog: typeof Log.Legacy = Log.Legacy;
const NullLog: typeof Log.Null = Log.Null;

export {
	Log,
	LegacyLog,
	NullLog
};
export default Log;
