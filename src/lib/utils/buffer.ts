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
	return(Buffer.from(new Uint8Array(arrayBuffer)));
}

/*
 * Converts a Buffer backed by ArrayBufferLike storage into one backed by an ArrayBuffer.
 */
export function arrayBufferLikeToBuffer(buffer: globalThis.Buffer): Buffer {
	if (buffer instanceof ArrayBuffer) {
		return(arrayBufferToBuffer(buffer));
	}

	const cloned = new ArrayBuffer(buffer.byteLength);

	// If this is a Node.js Buffer (Uint8Array subclass), leverage its view over an underlying ArrayBuffer
	// and copy the exact byte range into a fresh ArrayBuffer to ensure backing store is ArrayBuffer
	const src = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	new Uint8Array(cloned).set(src);

	return(arrayBufferToBuffer(cloned));
}
