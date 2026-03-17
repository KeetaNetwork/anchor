import { type JSONSerializable, type ToJSONSerializable, toJSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { KeetaNet } from '../../client/index.js';

const debugPrintableObject: (input: any) => JSONSerializable = KeetaNet.lib.Utils.Helper.debugPrintableObject;

export type { JSONSerializable, ToJSONSerializable };

export { toJSONSerializable, debugPrintableObject };
