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
