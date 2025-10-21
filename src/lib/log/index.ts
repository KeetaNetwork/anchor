import { lib } from '@keetanetwork/keetanet-client';
export type * from '@keetanetwork/keetanet-client/lib/log/index.js';

const Log: typeof lib.Log = lib.Log;
const LegacyLog: typeof Log.Legacy = Log.Legacy.bind(Log);
const NullLog: typeof Log.Null = Log.Null.bind(Log);

export {
	Log,
	LegacyLog,
	NullLog
};
export default Log;
