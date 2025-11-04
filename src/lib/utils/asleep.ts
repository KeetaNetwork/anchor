/**
 * Asynchronously sleep for a specified duration with optional abort signal support.
 *
 * @param ms - The duration to sleep in milliseconds
 * @param signal - Optional AbortSignal to cancel the sleep operation
 * @returns A promise that resolves after the specified duration or rejects if aborted
 * @throws Error if the operation is aborted via the signal
 *
 * @remarks
 * This function should be replaced when the `@keetanetwork/keetanet-client`
 * `KeetaNet.lib.Utils.Helper.asleep` method is updated to support `AbortSignal`.
 */
export function asleep(ms: number, signal?: AbortSignal): Promise<void> {
	return(new Promise<void>((resolve, reject) => {
		let abortHandler: (() => void) | undefined;

		// Check if already aborted
		if (signal?.aborted) {
			reject(new Error('Sleep aborted'));
			return;
		}

		const timeout = setTimeout(() => {
			if (abortHandler) {
				signal?.removeEventListener('abort', abortHandler);
			}
			resolve();
		}, ms);

		if (signal) {
			abortHandler = () => {
				clearTimeout(timeout);
				reject(new Error('Sleep aborted'));
			};
			signal.addEventListener('abort', abortHandler, { once: true });
		}
	}));
}
