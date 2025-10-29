import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

const util: typeof KeetaNetLib.Utils.Helper.util = KeetaNetLib.Utils.Helper.util;

const types: typeof util.types = util.types;
const inspect: typeof util.inspect = util.inspect;

export {
	types,
	inspect
}

export default util;
