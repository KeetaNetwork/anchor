import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { AnchorTokenLocationMetadata, AssetLocationLike, PickChainLocation, Rail, RecipientResolved } from '../../services/asset-movement/common.js';
import { convertAssetLocationToString } from '../../services/asset-movement/common.js';
import type { Resolver } from '../index.js';
import type { ISOCurrencyCode } from '@keetanetwork/currency-info';
import type { Account, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { KeetaAssetMovementTransaction } from '../../services/asset-movement/common.js';
import type KeetaFXAnchorClient from '../../services/fx/client.js';
import type KeetaAssetMovementAnchorClient from '../../services/asset-movement/client.js';
import type { ExternalChainAsset } from '../asset.js';
import type { Logger } from '../log/index.js';
import type { AnchorMetadataLegalField } from '../metadata.types.js';

/**
 * A single FX quote or estimate as returned by the FX anchor client.
 */
export type FXQuoteOrEstimate = NonNullable<Awaited<ReturnType<KeetaFXAnchorClient['getQuotesOrEstimates']>>>[number];

/**
 * An asset-movement provider resolved for a particular transfer pair.
 */
export type AssetMovementProvider = NonNullable<Awaited<ReturnType<KeetaAssetMovementAnchorClient['getProvidersForTransfer']>>>[number];

/**
 * A managed asset-movement transfer handle returned by `initiateTransfer`.
 */
export type AssetMovementTransfer = Awaited<ReturnType<AssetMovementProvider['initiateTransfer']>>;

/**
 * A created FX exchange handle returned by `createExchange`.
 */
export type FXExchange = Awaited<ReturnType<FXQuoteOrEstimate['createExchange']>>;

/**
 * Where an asset-movement step is delivering its output value.
 */
export type SendingToType = 'SELF' | 'NEXT_STEP' | 'FINAL_DESTINATION';

/**
 * A single legal disclaimer entry attached to a provider.
 */
export type Disclaimer = Exclude<AnchorMetadataLegalField['disclaimers'], undefined>[number];

/**
 * Disclaimers grouped under a single provider.
 */
export interface ProviderDisclaimers {
	providerID: string;
	disclaimers: Disclaimer[];
}

/**
 * All provider disclaimers gathered for a path.
 */
export type PlanDisclaimers = ProviderDisclaimers[];

/**
 * Operations a rail supports, as advertised by the provider metadata.
 */
export interface RailSupportedOperations {
	createPersistentForwarding?: boolean;
	initiateTransfer?: boolean;
}

/**
 * A rail paired with the operations it supports.
 */
export interface RailWithSupportedOperations {
	rail: Rail;
	supportedOperations?: RailSupportedOperations;
}

/**
 * A chainable asset: a Keeta token, an ISO currency code, or an external
 * (off-chain / other-chain) asset.
 */
export type AnchorChainingAsset = TokenAddress | ISOCurrencyCode | ExternalChainAsset;

/**
 * An asset located on a rail at a location, with an optional value.
 */
export interface AnchorChainingAssetAndLocation<AssetType extends AnchorChainingAsset = AnchorChainingAsset, Location extends AssetLocationLike = AssetLocationLike> {
	asset: AssetType;
	location: Location;
	rail: Rail;
	supportedOperations?: RailSupportedOperations;
	value?: bigint;
}

/**
 * The terminal destination of a chain, carrying the resolved recipient.
 */
export interface AnchorChainingDestination extends AnchorChainingAssetAndLocation {
	recipient: RecipientResolved;
}

/**
 * The user-facing request describing a source and destination to chain between.
 */
export interface AnchorChainingPathInput {
	source: AnchorChainingAssetAndLocation;
	destination: AnchorChainingDestination;
}

/**
 * Configuration for constructing an {@link AnchorChaining} instance.
 */
export interface AnchorChainingConfig {
	client: KeetaNet.UserClient;
	resolver?: Resolver;
	signer?: InstanceType<typeof KeetaNetLib.Account>;
	account?: InstanceType<typeof KeetaNetLib.Account>;
	logger?: Logger;
}

interface BaseGraphNodeLike<Type extends 'fx' | 'assetMovement', AssetType extends AnchorChainingAsset> {
	type: Type;
	providerID: string;

	from: AnchorChainingAssetAndLocation<AssetType>;
	to: AnchorChainingAssetAndLocation<AssetType>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FXGraphNode extends BaseGraphNodeLike<'fx', Exclude<AnchorChainingAsset, ExternalChainAsset>> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AssetMovementGraphNode extends BaseGraphNodeLike<'assetMovement', AnchorChainingAsset> {}
export type GraphNodeLike = FXGraphNode | AssetMovementGraphNode;

export type KeetaLocationLike = Extract<AssetLocationLike, `chain:keeta:${bigint}`> | PickChainLocation<'keeta'>;

/**
 * A direct, on-Keeta send step. Always the only step in a path.
 */
export interface KeetaSendStepLike {
	type: 'keetaSend';

	providerID?: null;

	from: AnchorChainingAssetAndLocation<AnchorChainingAsset, KeetaLocationLike>;
	to: AnchorChainingAssetAndLocation<AnchorChainingAsset, KeetaLocationLike>;
}

export type AnchorChainingStepLike = GraphNodeLike | KeetaSendStepLike;

/**
 * Returns true when both inputs parse to equal Keeta token accounts.
 */
export function areBothTokenAndEqual(a: string | TokenAddress, b: string | TokenAddress): boolean {
	try {
		const aParsed = KeetaNet.lib.Account.toAccount(a);
		const bParsed = KeetaNet.lib.Account.toAccount(b);

		if (!aParsed.isToken() || !bParsed.isToken()) {
			return(false);
		}

		return(aParsed.comparePublicKey(bParsed));
	} catch {
		return(false);
	}
}

/**
 * Compare two chaining assets for equality, handling both string codes and
 * token accounts.
 */
export function isAnchorChainingAssetEqual(a: AnchorChainingAsset, b: AnchorChainingAsset): boolean {
	if (typeof a === 'string' && typeof b === 'string' && a === b) {
		return(true);
	} else if (areBothTokenAndEqual(a, b)) {
		return(true);
	} else {
		return(false);
	}
}

/**
 * Returns true when a node side satisfies the required asset/location/rail.
 */
export function nodeSideSupports(side: AnchorChainingAssetAndLocation, required: AnchorChainingAssetAndLocation): boolean {
	if (side.rail !== required.rail) {
		return(false);
	}

	if (convertAssetLocationToString(side.location) !== convertAssetLocationToString(required.location)) {
		return(false);
	}

	if (!isAnchorChainingAssetEqual(side.asset, required.asset)) {
		return(false);
	}

	return(true);
}

/**
 * Returns true for nodes that keep assets on Keeta: FX nodes, plus
 * asset-movement nodes whose from and to share the same Keeta chain location
 * (custodial FX anchors that don't actually move funds off-chain).
 */
export function isFXLikeNode(node: GraphNodeLike): boolean {
	if (node.type === 'fx') {
		return(true);
	}
	const fromStr = convertAssetLocationToString(node.from.location);
	const toStr = convertAssetLocationToString(node.to.location);
	return(fromStr === toStr && fromStr.startsWith('chain:keeta:'));
}

/**
 * Inbound/outbound/common rails resolved for one side of an asset-movement
 * pair.
 */
export interface AssetMovementResolvedRails {
	common: RailWithSupportedOperations[];
	inbound: RailWithSupportedOperations[];
	outbound: RailWithSupportedOperations[];
}

export type AnchorChainingListAssetsSideFilter = {
	location?: AssetLocationLike | undefined;
	asset?: AnchorChainingAsset | undefined;
	rail?: Rail | undefined;
};

type AnchorChainingListAssetsShared = {
	maxStepCount?: number;
	onlyAllowFXLike?: boolean;
};

export type AnchorChainingListAssetsFilter =
	| ({ from: AnchorChainingListAssetsSideFilter; to?: never } & AnchorChainingListAssetsShared)
	| ({ to: AnchorChainingListAssetsSideFilter; from?: never } & AnchorChainingListAssetsShared)
	| ({ from?: never; to?: never } & AnchorChainingListAssetsShared);

export type AnchorChainingResolveAssetsFilter = {
	from?: AnchorChainingListAssetsSideFilter;
	to?: AnchorChainingListAssetsSideFilter;
	maxStepCount?: number;
	onlyAllowFXLike?: boolean;
};

export interface AnchorChainingResolveAssetsResult {
	from: AnchorChainingAssetInfo[];
	to: AnchorChainingAssetInfo[];
}

export interface AnchorChainingAssetInfo {
	asset: AnchorChainingAsset;
	location: AssetLocationLike;
	rails: {
		inbound: Rail[];
		outbound: Rail[];
	};

	distance: {
		pathLength: number;
	} | null;
}

export type AnchorChainingAssetInfoWithMetadata = AnchorChainingAssetInfo & {
	metadata?: AnchorTokenLocationMetadata;
};

export interface AnchorChainingResolveAssetsWithMetadataResult {
	from: AnchorChainingAssetInfoWithMetadata[];
	to: AnchorChainingAssetInfoWithMetadata[];
}

export type AnchorChainingWithMetadataOptions = {
	providerID?: string;
};

/**
 * Identifies the provider action an account/signer is being resolved for.
 */
export type GetAccountForActionPayload = {
	type: 'assetMovement';
	providerMethod: 'initiateTransfer';
	provider?: AssetMovementProvider;
} | {
	type: 'fx';
	providerMethod: 'getAccountForAction';
};

export type AccountLike = InstanceType<typeof KeetaNetLib.Account> | undefined | ((providerMethodPayload: GetAccountForActionPayload) => Promise<Account> | Account);

/**
 * Per-execution overrides for the signing account and signer.
 */
export interface AnchorChainingAccountOverrides {
	account?: AccountLike;
	signer?: AccountLike;
}

/**
 * The four kinds of chain step the engine knows how to preview and execute.
 */
export type ChainStepType = 'fx' | 'assetMovement' | 'forwarded' | 'keetaSend';

/**
 * Which side of a step is known going into a preview: the input value (driven
 * from upstream, affinity `from`) or the output value (pulled from downstream,
 * affinity `to`).
 */
export type PreviewKnownValue =
	| { side: 'in'; value: bigint }
	| { side: 'out'; value: bigint };

/**
 * A single side-effect-free step estimate. Carries projected amounts and a
 * per-leg output floor (`minOutput`); it never references an initiated
 * transfer or created exchange.
 */
export interface PreviewStep {
	type: ChainStepType;
	index: number;
	providerID: string | null;
	from: AnchorChainingAssetAndLocation;
	to: AnchorChainingAssetAndLocation;
	estimatedValueIn: bigint;
	estimatedValueOut: bigint;
	/**
	 * Minimum acceptable delivered output for this leg. Execution aborts before
	 * an irreversible send when the actual output would fall below this.
	 */
	minOutput: bigint;
}

/**
 * The full side-effect-free preview of a path: per-step estimates, projected
 * totals, and the chain-level minimum the destination must receive.
 */
export interface AnchorChainingPreview {
	affinity: 'from' | 'to';
	steps: PreviewStep[];
	totalValueIn: bigint;
	totalValueOut: bigint;
	minDestinationValue: bigint;
}

interface ExecutedStepBase<Type extends ChainStepType> {
	type: Type;
	index: number;
	/**
	 * The leg's pre-execution estimate, for reference against the actual values.
	 */
	preview: PreviewStep;
	/**
	 * Value actually driven into the leg (the prior leg's real output).
	 */
	actualValueIn: bigint;
	/**
	 * Value the leg actually delivered.
	 */
	actualValueOut: bigint;
}

export interface ExecutedStepFX extends ExecutedStepBase<'fx'> {
	exchange: FXExchange;
}

export interface ExecutedStepAssetMovement extends ExecutedStepBase<'assetMovement'> {
	transfer: AssetMovementTransfer;
}

export interface ExecutedStepForwarded extends ExecutedStepBase<'forwarded'> {
	observedTransaction: KeetaAssetMovementTransaction;
}

export interface ExecutedStepKeetaSend extends ExecutedStepBase<'keetaSend'> {
	sendBlockHash?: string | undefined;
}

export type ExecutedStep = ExecutedStepFX | ExecutedStepAssetMovement | ExecutedStepForwarded | ExecutedStepKeetaSend;

/**
 * The terminal result of a successful execution.
 */
export interface AnchorChainingPathExecuteResult {
	steps: ExecutedStep[];
	correlationID: string;
	totalValueIn: bigint;
	totalValueOut: bigint;
}

/**
 * Options for a single {@link execute} invocation.
 */
export interface AnchorChainingPathExecuteOptions {
	requireSendAuth?: boolean;
	abortSignal?: AbortSignal;
	/**
	 * Stable correlation id for idempotency and resume. Generated when omitted.
	 */
	correlationID?: string;
	/**
	 * Per-poll interval and overall deadline for settlement polling.
	 */
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
}

/**
 * The externally-observable execution state machine.
 */
export type AnchorChainingPathState =
	| { status: 'idle' }
	| { status: 'executing'; completedSteps: ExecutedStep[]; currentStepIndex: number }
	| { status: 'completed'; result: AnchorChainingPathExecuteResult }
	| { status: 'failed'; error: Error; completedSteps: ExecutedStep[]; failedAtStepIndex: number };

interface StepNeededActionEventPayloadBase<ActionType, ActionPayload, CompletedPayload extends readonly unknown[] = []> {
	type: ActionType;

	markCompleted: (...args: CompletedPayload) => void;
	markFailed: (error?: unknown) => void;

	action: ActionPayload;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StepNeededActionEventAssetMovement extends StepNeededActionEventPayloadBase<'assetMovementUserExecutionRequired', { assetMovementTransfer: AssetMovementTransfer; }, []> {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StepNeededActionEventKeetaSend extends StepNeededActionEventPayloadBase<'keetaSendAuthRequired', {
	sendToAddress: GenericAccount;
	value: bigint;
	token: TokenAddress;
	external?: string;
}, [ { sent: boolean | BlockHash; } ]> {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StepNeededActionEventUnderDelivery extends StepNeededActionEventPayloadBase<'underDeliveryReview', {
	index: number;
	expectedOutput: bigint;
	actualOutput: bigint;
	minimumOutput: bigint;
}, [ { proceed: boolean; } ]> {}

export type StepNeededActionEventPayload = StepNeededActionEventKeetaSend | StepNeededActionEventAssetMovement | StepNeededActionEventUnderDelivery;

export type AnchorChainingPathEventMap = {
	stateChange: [state: AnchorChainingPathState];
	stepExecuted: [step: ExecutedStep, index: number];
	completed: [result: AnchorChainingPathExecuteResult];
	failed: [error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number];
	stepNeedsAction: [StepNeededActionEventPayload];
};
