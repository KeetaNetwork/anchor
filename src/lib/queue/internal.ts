import type { Logger } from '../log/index.ts';
import type {
	KeetaAnchorQueueEntry,
	KeetaAnchorQueueEntryAncillaryData,
	KeetaAnchorQueueRequestID,
	KeetaAnchorQueueStatus
} from './index.ts';
import { Errors } from './common.js';

/* XXX: Move this somewhere more common */
export function MethodLogger<T extends Logger | undefined>(input: T, from: { file: string; method: string; class: string; instanceID: string; }): T extends Logger ? Logger : undefined {
	if (input === undefined) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(undefined as T extends Logger ? Logger : undefined);
	}

	const fromStr = `${from.class}${from.instanceID ? `:${from.instanceID}` : ''}::${from.method}`;
	const retval: Logger = {
		debug: function(...logArgs: unknown[]): void {
			input.debug(fromStr, ...logArgs);
		},
		info: function(...logArgs: unknown[]): void {
			input.info(fromStr, ...logArgs);
		},
		warn: function(...logArgs: unknown[]): void {
			input.warn(fromStr, ...logArgs);
		},
		error: function(...logArgs: unknown[]): void {
			input.error(fromStr, ...logArgs);
		},
		log: function(...logArgs: unknown[]): void {
			input.log(fromStr, ...logArgs);
		}
	};

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(retval as T extends Logger ? Logger : undefined);
}

type StatusUpdateResult<QueueResult> = Pick<Partial<KeetaAnchorQueueEntry<unknown, QueueResult>>, 'lastError' | 'failures' | 'output'> & Pick<KeetaAnchorQueueEntry<unknown, QueueResult>, 'status' | 'worker' | 'updated'>;
export function ManageStatusUpdates<QueueResult>(id: KeetaAnchorQueueRequestID, existingEntry: Pick<KeetaAnchorQueueEntry<unknown, QueueResult>, 'status' | 'failures'>, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<QueueResult>, logger?: Logger): StatusUpdateResult<QueueResult> {
	const retval: StatusUpdateResult<QueueResult> = {
		status: status,
		worker: ancillary?.by ?? null,
		updated: new Date()
	};

	const { oldStatus, output } = ancillary ?? {};
	if (oldStatus && existingEntry.status !== oldStatus) {
		throw(new Errors.IncorrectStateAssertedError(id, oldStatus, existingEntry.status));
	}

	logger?.debug(`Setting request with id ${String(id)} status from "${existingEntry.status}" to "${status}"`);

	if (status === 'failed_temporarily') {
		const existingFailures = existingEntry.failures;
		retval.failures = existingFailures + 1;
		logger?.debug(`Incrementing failure count for request with id ${String(id)} to ${retval.failures}`);
	}

	if (status === 'pending' || status === 'completed') {
		logger?.debug(`Clearing last error for request with id ${String(id)}`);
		retval.lastError = null;
	}

	if (ancillary?.error) {
		retval.lastError = ancillary.error;
		logger?.debug(`Setting last error for request with id ${String(id)} to:`, ancillary.error);
	}

	if (output !== undefined) {
		retval.output = output;
		logger?.debug(`Setting output for request with id ${String(id)} to:`, output);
	}

	return(retval);
}

/**
 * The reserved marker segment prepended to every encoded queue path so that
 * the root partition (an empty path) still has a non-empty storage key.
 */
const QUEUE_PATH_ROOT_MARKER = 'root';

/**
 * The separator used to join partition path segments into a storage key.
 * Segments must never contain it -- see {@link ValidateQueuePartitionSegment}.
 */
export const QUEUE_PATH_SEPARATOR = '.';

/**
 * Encode a partition path into the canonical storage key shared by every
 * queue storage driver.
 */
export function EncodeQueuePath(path: readonly string[]): string {
	const encodedPath = [QUEUE_PATH_ROOT_MARKER, ...path].join(QUEUE_PATH_SEPARATOR);
	return(encodedPath);
}

/**
 * Decode a canonical storage key into partition path segments relative to
 * `basePath`. The input must be a key produced by {@link EncodeQueuePath}
 * for a path at or below `basePath`.
 */
export function DecodeQueuePathRelative(encodedPath: string, basePath: readonly string[]): string[] {
	const absoluteSegments = encodedPath.split(QUEUE_PATH_SEPARATOR).slice(1);
	const relativeSegments = absoluteSegments.slice(basePath.length);
	return(relativeSegments);
}

/**
 * Check whether a canonical storage key addresses `basePath` itself or a
 * partition below it.
 */
export function IsEncodedQueuePathWithin(encodedPath: string, basePath: readonly string[]): boolean {
	const encodedBasePath = EncodeQueuePath(basePath);
	if (encodedPath === encodedBasePath) {
		return(true);
	}

	const within = encodedPath.startsWith(`${encodedBasePath}${QUEUE_PATH_SEPARATOR}`);
	return(within);
}

/**
 * Ensure a partition path segment cannot corrupt the encoded storage key.
 *
 * @throws {@link Error} when the segment contains the path separator
 */
export function ValidateQueuePartitionSegment(segment: string): void {
	if (segment.includes(QUEUE_PATH_SEPARATOR)) {
		throw(new Error(`Partition path segment may not contain "${QUEUE_PATH_SEPARATOR}": ${segment}`));
	}
}

/**
 * Convert a string to a KeetaAnchorQueueRequestID (branded string type)
 *
 * Use only when appropriate, such as when receiving a request ID from an
 * external source or generating a new one.
 */
export function ConvertStringToRequestID(input: string | KeetaAnchorQueueRequestID): KeetaAnchorQueueRequestID;
export function ConvertStringToRequestID(input: string | KeetaAnchorQueueRequestID | undefined): KeetaAnchorQueueRequestID | undefined;
export function ConvertStringToRequestID(input: string | KeetaAnchorQueueRequestID | undefined): KeetaAnchorQueueRequestID | undefined {
	if (input === undefined) {
		return(undefined);
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(input as KeetaAnchorQueueRequestID);
}
