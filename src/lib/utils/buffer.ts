import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

export type Buffer = InstanceType<typeof KeetaNetLib.Utils.Buffer.Buffer>;
export const Buffer: typeof KeetaNetLib.Utils.Buffer.Buffer = KeetaNetLib.Utils.Buffer.Buffer;

/*
 * Because our public interfaces are ArrayBuffers we often need to convert
 * Buffers to ArrayBuffers -- an alias to the Node function to do that
 */
export const bufferToArrayBuffer: typeof KeetaNetLib.Utils.Helper.bufferToArrayBuffer = KeetaNetLib.Utils.Helper.bufferToArrayBuffer.bind(KeetaNetLib.Utils.Helper);

/*
 * Helper to convert ArrayBuffer back to Buffer
 */
export function arrayBufferToBuffer(arrayBuffer: ArrayBuffer): Buffer {
	// Since ArrayBuffer is a subset of ArrayBufferLike, this conversion is safe
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return globalThis.Buffer.from(arrayBuffer) as Buffer;
}

/*
 * Converts a Buffer backed by ArrayBufferLike storage into one backed by an ArrayBuffer.
 */
export function arrayBufferLikeToBuffer(buffer: globalThis.Buffer): Buffer {
	if (buffer instanceof ArrayBuffer) {
		return arrayBufferToBuffer(buffer);
	}

	const cloned = new ArrayBuffer(buffer.byteLength);
	
	new Uint8Array(cloned).set(new Uint8Array(buffer as any));

	return arrayBufferToBuffer(cloned);
}
