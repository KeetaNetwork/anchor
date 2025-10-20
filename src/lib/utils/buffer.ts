import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

export type Buffer = InstanceType<typeof KeetaNetLib.Utils.Buffer.Buffer>;
export const Buffer: typeof KeetaNetLib.Utils.Buffer.Buffer = KeetaNetLib.Utils.Buffer.Buffer;

/*
 * Because our public interfaces are ArrayBuffers we often need to convert
 * Buffers to ArrayBuffers -- an alias to the Node function to do that
 */
export const bufferToArrayBuffer: typeof KeetaNetLib.Utils.Helper.bufferToArrayBuffer = KeetaNetLib.Utils.Helper.bufferToArrayBuffer.bind(KeetaNetLib.Utils.Helper);

function toBuffer(src: ArrayBufferView | ArrayBuffer): Buffer {
	if (ArrayBuffer.isView(src)) {
		// Zero-copy: Buffer will reference the same ArrayBuffer range.
		return(Buffer.from(src.buffer, src.byteOffset, src.byteLength));
	}

	// src is ArrayBuffer
	// Zero-copy: shares memory with the ArrayBuffer
	return(Buffer.from(src));
}

/*
 * Helper to convert ArrayBuffer back to Buffer
 */
export function arrayBufferToBuffer(arrayBuffer: ArrayBuffer): Buffer {
	return(toBuffer(arrayBuffer));
}

/*
 * Converts a Buffer backed by ArrayBufferLike storage into one backed by an ArrayBuffer.
 */
export function arrayBufferLikeToBuffer(buffer: ArrayBufferLike): Buffer {
	return(toBuffer(buffer));
}
