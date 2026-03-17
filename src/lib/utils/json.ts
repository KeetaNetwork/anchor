import type { JSONSerializable, ToJSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';

const debugPrintableObject: (input: any) => JSONSerializable = KeetaNet.lib.Utils.Helper.debugPrintableObject;
const toJSONSerializable: typeof KeetaNet.lib.Utils.Conversion.toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

export type { JSONSerializable, ToJSONSerializable };
export { toJSONSerializable, debugPrintableObject };
