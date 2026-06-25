import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { AssetLocationLike, KeetaPersistentForwardingAddressDetails, RecipientResolved } from '../../../services/asset-movement/common.js';
import type { ChainingStepRecord, PublishedInputRecord } from '../store.js';
import type {
	AnchorChainingPathExecuteOptions,
	AssetMovementTransfer,
	ExecutedStep,
	PreviewStep,
	SendingToType
} from '../types.js';

/**
 * A reference to a destination-chain withdraw transaction produced by an
 * asset-movement leg, used to correlate a downstream forwarded leg.
 */
export interface WithdrawRef {
	location: AssetLocationLike;
	transaction: { id: string };
}

/**
 * The resolved recipient for an asset-movement leg and where it is delivering.
 */
export interface ResolvedRecipient {
	recipient: RecipientResolved;
	sendingTo: SendingToType;
}

/**
 * Settlement-poll cadence and deadline for a single leg.
 */
export interface PollSettings {
	intervalMs: number;
	timeoutMs: number;
	abortSignal?: AbortSignal | undefined;
}

/**
 * Everything a {@link StepExecutor.run} needs from the engine for one leg. The
 * engine owns durability (persistence), the per-leg output floor, user-action
 * prompting, cross-step recipient resolution, and forwarding-address creation;
 * the step owns the provider-specific irreversible work.
 */
export interface StepRunInput {
	/**
	 * The value actually driven into this leg (the prior leg's real output).
	 */
	actualInput: bigint;
	/**
	 * This leg's pre-execution estimate.
	 */
	preview: PreviewStep;
	/**
	 * Stable per-step idempotency key (`correlationID:stepIndex`).
	 */
	idempotencyKey: string;
	/**
	 * Mutable, engine-persisted write-ahead record for this leg.
	 */
	record: ChainingStepRecord;
	/**
	 * Chain-level published on-chain operations to thread into this leg's
	 * external correlation envelope, in publication order.
	 */
	publishedInputs: readonly PublishedInputRecord[];
	/**
	 * Destination-chain withdraw produced by the prior leg, if any.
	 */
	prevWithdrawTx: WithdrawRef | null;
	options: AnchorChainingPathExecuteOptions;
	poll: PollSettings;
	/**
	 * Persist the current execution state (called after intent writes).
	 */
	persist(): Promise<void>;
	/**
	 * Gate an irreversible send on the per-leg floor. Resolves to proceed, or
	 * rejects (aborting before any irreversible work) when the expected output
	 * falls below the leg minimum and the consumer declines to proceed.
	 */
	checkFloor(expectedOutput: bigint): Promise<void>;
	/**
	 * Publish a recoverable Keeta send, returning the published block hash.
	 */
	authorizedSend(args: {
		to: string | GenericAccount;
		value: bigint;
		token: TokenAddress | string;
		external?: string | undefined;
	}): Promise<string | undefined>;
	/**
	 * Await user execution of a provider-managed asset-movement transfer.
	 */
	awaitAssetMovementExecution(transfer: AssetMovementTransfer): Promise<void>;
	/**
	 * Resolve the recipient and delivery target for this asset-movement leg,
	 * accounting for the next leg (final destination, in-account hold, next
	 * forwarded address, or next provider deposit instruction).
	 */
	resolveRecipient(): Promise<ResolvedRecipient>;
	/**
	 * Ensure this forwarded leg's persistent-forwarding address exists,
	 * creating it if needed.
	 */
	ensureForwardedAddress(): Promise<KeetaPersistentForwardingAddressDetails>;
}

/**
 * The outcome of running one leg.
 */
export interface StepRunResult {
	actualOutput: bigint;
	executed: ExecutedStep;
	/**
	 * On-chain operations this leg published, to append to the chain-level
	 * accumulator for downstream external envelopes.
	 */
	publishedInputs: PublishedInputRecord[];
	withdrawTx: WithdrawRef | null;
}
