import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

// XXX:TODO: Eliminate when we get native support in KeetaNetLib
import * as nodeCrypto from 'node:crypto';

const crypto: typeof KeetaNetLib.Utils.Helper.crypto & {
	createHash: typeof nodeCrypto.createHash;
	createHmac: typeof nodeCrypto.createHmac;
} = {
	...KeetaNetLib.Utils.Helper.crypto,
	createHash: nodeCrypto.createHash.bind(nodeCrypto),
	createHmac: nodeCrypto.createHmac.bind(nodeCrypto)
};
export default crypto;
