/**
 * Durable, resume-forward state for an anchor-chaining execution.
 *
 * The engine writes intent before each irreversible operation (write-ahead
 * logging) and records the actual delivered output after each step settles.
 * Every shape here is JSON-serializable so a backing store can persist and
 * reload it to resume a partially-completed chain. `bigint` values are carried
 * as decimal strings for portability.
 */

import type { AssetLocationLike } from '../../services/asset-movement/common.js';

/**
 * Lifecycle status of a single step within an execution.
 *
 * - `pending`  no irreversible work has begun.
 * - `intent`   intent recorded (WAL); the irreversible op may be in flight.
 * - `settled`  the step's output has been observed and recorded.
 * - `failed`   the step terminated without settling.
 */
export type ChainingStepStatus = 'pending' | 'intent' | 'settled' | 'failed';

/**
 * A reference to a published on-chain operation, used to rebuild the anchor
 * `external` correlation envelope on resume.
 */
export interface PublishedInputRecord {
	blockHash: string;
	operationIndex?: number;
}

/**
 * Write-ahead intent recorded immediately before an irreversible operation, so
 * a crash between performing and persisting can be reconciled on resume rather
 * than blindly re-performing (which would double-send).
 */
export interface ChainingStepIntent {
	/**
	 * Per-step idempotency key (`correlationID:stepIndex`). Stable across
	 * resumes; the natural key the engine reconciles against before performing.
	 */
	idempotencyKey: string;
	kind: 'fx' | 'assetMovement' | 'forwarded' | 'keetaSend';
	/**
	 * Minimal details to reconcile a user-funded Keeta send before re-sending.
	 */
	send?: {
		to: string;
		value: string;
		token: string;
		external?: string;
	};
	createdAtMs: number;
}

/**
 * Persisted record of a single chain step.
 */
export interface ChainingStepRecord {
	index: number;
	type: 'fx' | 'assetMovement' | 'forwarded' | 'keetaSend';
	status: ChainingStepStatus;
	intent?: ChainingStepIntent;
	/**
	 * Actual input value driven into this step (decimal string), i.e. the prior
	 * step's actual delivered output.
	 */
	actualInput?: string;
	/**
	 * Actual delivered output value of this step (decimal string).
	 */
	actualOutput?: string;
	transferID?: string;
	exchangeID?: string;
	sendBlockHash?: string;
	/**
	 * Destination-chain withdraw produced by this step, persisted so a resumed
	 * forwarded step can correlate against it.
	 */
	withdraw?: {
		location: AssetLocationLike;
		id: string;
	};
	/**
	 * On-chain operations published by this step, contributing to the chain's
	 * external-correlation inputs.
	 */
	publishedInputs: PublishedInputRecord[];
}

/**
 * Serializable, resumable state for a whole chaining execution.
 */
export interface ExecutionState {
	correlationID: string;
	status: 'idle' | 'executing' | 'completed' | 'failed';
	currentStepIndex: number;
	steps: ChainingStepRecord[];
	/**
	 * Chain-level accumulator of published inputs threaded into each downstream
	 * step's external envelope, in publication order.
	 */
	publishedInputs: PublishedInputRecord[];
	createdAtMs: number;
	updatedAtMs: number;
	error?: {
		code: string;
		message: string;
	};
}

/**
 * Derive the stable per-step idempotency key for a correlation.
 */
export function stepIdempotencyKey(correlationID: string, stepIndex: number): string {
	return(`${correlationID}:${stepIndex}`);
}

/**
 * Persistence boundary for {@link ExecutionState}. The default backing store is
 * in-memory; a durable backend can implement this interface to enable
 * cross-session resume without touching the engine.
 */
export interface AnchorChainingStore {
	/**
	 * Load the state for a correlation, or `undefined` when none is stored.
	 */
	load(correlationID: string): Promise<ExecutionState | undefined>;
	/**
	 * Persist the full state for a correlation.
	 */
	save(state: ExecutionState): Promise<void>;
	/**
	 * Remove any stored state for a correlation.
	 */
	delete(correlationID: string): Promise<void>;
}

/**
 * Round-trip a state through JSON to both deep-clone it and enforce the
 * serializable contract callers rely on for durability.
 */
function cloneState(state: ExecutionState): ExecutionState {
	return(structuredClone(state));
}

/**
 * Process-lifetime, in-memory {@link AnchorChainingStore}. The default when a
 * consumer does not supply a durable backend. Clones on read and write so held
 * references cannot mutate persisted state out of band.
 */
export class AnchorChainingStoreMemory implements AnchorChainingStore {
	readonly #entries = new Map<string, ExecutionState>();

	load(correlationID: string): Promise<ExecutionState | undefined> {
		const found = this.#entries.get(correlationID);
		if (found === undefined) {
			return(Promise.resolve(undefined));
		}

		return(Promise.resolve(cloneState(found)));
	}

	save(state: ExecutionState): Promise<void> {
		this.#entries.set(state.correlationID, cloneState(state));
		return(Promise.resolve());
	}

	delete(correlationID: string): Promise<void> {
		this.#entries.delete(correlationID);
		return(Promise.resolve());
	}
}
