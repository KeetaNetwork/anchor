import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as KeetaNet from "@keetanetwork/keetanet-client";
import type { AnchorTokenLocationMetadata, AssetLocationLike, AssetFeeBreakdown, AssetFeeLineItemType, AssetTransferInstructions, AssetWithRails, FiatPushRails, KeetaAssetMovementTransaction, KeetaPersistentForwardingAddressDetails, MovableAssetSearchCanonical, PersistentAddressAssetFeeBreakdown, PickChainLocation, Rail, RailOrRailWithExtendedDetails, RecipientResolved, ResolvedFeeLineItem, SimulatedAssetTransferInstructions, UnresolvedFeeLineItem } from "../services/asset-movement/common.js";
import { convertAssetLocationToString, convertAssetSearchInputToCanonical, doesAssetOrPairMatch, isChainLocation, toAssetLocation } from "../services/asset-movement/common.js";
import type { Resolver } from "./index.js";
import { getDefaultResolver } from '../config.js';
import type { ISOCurrencyCode } from '@keetanetwork/currency-info';
import { Currency } from '@keetanetwork/currency-info';
import type { Account, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { isAssetLocationLike } from '../services/asset-movement/lib/location.generated.js';
import type { ToValuizable } from './resolver.js';
import { isFiatRail, isMovableAssetSearchCanonical, isRail } from '../services/asset-movement/common.generated.js';
import { assertNever } from './utils/never.js';
import KeetaFXAnchorClient from '../services/fx/client.js';
import KeetaAssetMovementAnchorClient from '../services/asset-movement/client.js';
import type { ExternalChainAsset, EVMChecksumCache } from './asset.js';
import { isExternalChainAsset, isMovableAssetEqual } from './asset.js';
import type { Logger } from './log/index.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { AnchorExternalInput } from './anchor-external.js';
import type { AnchorMetadataLegalField } from './metadata.types.js';
import type { ClientRenderableContent } from './metadata.types.js';
import { AnchorExternalBuilder } from './anchor-external.js';

type FXQuoteOrEstimate = NonNullable<Awaited<ReturnType<KeetaFXAnchorClient['getQuotesOrEstimates']>>>[number];
type AssetMovementProvider = NonNullable<Awaited<ReturnType<KeetaAssetMovementAnchorClient['getProvidersForTransfer']>>>[number];
type AssetMovementTransfer = Awaited<ReturnType<AssetMovementProvider['initiateTransfer']>>;
type FXExchange = Awaited<ReturnType<FXQuoteOrEstimate['createExchange']>>;

interface ChainStepResolutionBase<Type extends 'fx' | 'assetMovement' | 'keetaSend' | 'forwarded'> {
	type: Type;
	valueIn: bigint;
	valueOut: bigint;
	step: Type extends 'keetaSend' ? null : (
		Type extends 'forwarded' ? AssetMovementGraphNode : Extract<GraphNodeLike, { type: Type }>
	);
}

interface ChainStepResolutionFX extends ChainStepResolutionBase<'fx'> {
	type: 'fx';
	result: FXQuoteOrEstimate;
};

type SendingToType = 'SELF' | 'NEXT_STEP' | 'FINAL_DESTINATION';

interface ChainStepResolutionAssetMovement extends ChainStepResolutionBase<'assetMovement'> {
	usingInstruction: AssetTransferInstructions;
	sendingTo: SendingToType;
	transfer: AssetMovementTransfer;
	provider: AssetMovementProvider;
};

interface ChainStepResolutionKeetaSend extends ChainStepResolutionBase<'keetaSend'> {
	usingInstruction: Extract<AssetTransferInstructions, { type: 'KEETA_SEND' }>;
};

interface ChainStepResolutionForwarded extends ChainStepResolutionBase<'forwarded'> {
	persistentAddress: KeetaPersistentForwardingAddressDetails;
	provider: AssetMovementProvider;
	/** Present when simulateTransfer succeeded during plan computation (non-forwardingOnly). */
	simulatedTransfer?: Awaited<ReturnType<AssetMovementProvider['simulateTransfer']>>;
};

export type Disclaimer = Exclude<AnchorMetadataLegalField['disclaimers'], undefined>[number];
type ProviderDisclaimers = {
	providerID: string;
	disclaimers: Disclaimer[];
}
type PlanDisclaimers = ProviderDisclaimers[];

export type ChainStepResolution = ChainStepResolutionFX | ChainStepResolutionAssetMovement | ChainStepResolutionKeetaSend | ChainStepResolutionForwarded;

type AnchorChainingPathComputedPlan = {
	steps: ChainStepResolution[];
	totalValueIn: bigint;
	totalValueOut: bigint;
};

type ExecutedStepFX = {
	type: 'fx';
	plan: ChainStepResolutionFX;
	exchange: FXExchange;
};

type ExecutedStepAssetMovement = {
	type: 'assetMovement';
	plan: ChainStepResolutionAssetMovement;
};

type ExecutedStepKeetaSend = {
	type: 'keetaSend';
	plan: ChainStepResolutionKeetaSend;
};

type ExecutedStepForwarded = {
	type: 'forwarded';
	plan: ChainStepResolutionForwarded;
	observedTransaction: KeetaAssetMovementTransaction;
};


export type ExecutedStep = ExecutedStepFX | ExecutedStepAssetMovement | ExecutedStepKeetaSend | ExecutedStepForwarded;

export type AnchorChainingPathExecuteResult = {
	steps: ExecutedStep[];
};

export type AnchorChainingPathExecuteOptions = {
	requireSendAuth?: boolean;
};

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
interface StepNeededActionEventAssetMovement extends StepNeededActionEventPayloadBase<'assetMovementUserExecutionRequired', { assetMovementTransfer: AssetMovementTransfer; }, []> {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface StepNeededActionEventKeetaSend extends StepNeededActionEventPayloadBase<'keetaSendAuthRequired', {
	sendToAddress: GenericAccount;
	value: bigint;
	token: TokenAddress;
	external?: string;
}, [ { sent: boolean | BlockHash; }]> {}

type StepNeededActionEventPayload = StepNeededActionEventKeetaSend | StepNeededActionEventAssetMovement;

type AnchorChainingPathEventMap = {
	stateChange: [state: AnchorChainingPathState];
	stepExecuted: [step: ExecutedStep, index: number];
	completed: [result: AnchorChainingPathExecuteResult];
	failed: [error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number];
	stepNeedsAction: [StepNeededActionEventPayload];
	transactionObserved: [payload: AnchorChainingTransactionObservedEvent];
}

export type AnchorChainingTransactionObservedSource = 'getTransferStatus' | 'listTransactions';

export type AnchorChainingTransactionObservedEvent = {
	stepIndex: number;
	planStep: ChainStepResolution;
	transaction: KeetaAssetMovementTransaction;
	source: AnchorChainingTransactionObservedSource;
};

interface RailSupportedOperations {
	createPersistentForwarding?: boolean;
	initiateTransfer?: boolean;
}

interface RailWithSupportedOperations {
	rail: Rail;
	supportedOperations?: RailSupportedOperations;
}

interface AnchorChainingAssetAndLocation<AssetType extends AnchorChainingAsset = AnchorChainingAsset, Location extends AssetLocationLike = AssetLocationLike> {
	asset: AssetType;
	location: Location;
	rail: Rail;
	supportedOperations?: RailSupportedOperations;
	value?: bigint;

}

interface AnchorChainingDestination extends AnchorChainingAssetAndLocation {
	recipient: RecipientResolved;
}

export interface AnchorChainingPathInput {
	source: AnchorChainingAssetAndLocation;
	destination: AnchorChainingDestination;
}

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
interface FXGraphNode extends BaseGraphNodeLike<'fx', Exclude<AnchorChainingAsset, ExternalChainAsset>> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface AssetMovementGraphNode extends BaseGraphNodeLike<'assetMovement', AnchorChainingAsset> {}
export type GraphNodeLike = FXGraphNode | AssetMovementGraphNode;

type KeetaLocationLike = Extract<AssetLocationLike, `chain:keeta:${bigint}`> | PickChainLocation<'keeta'>;
interface KeetaSendStepLike {
	type: 'keetaSend';

	providerID?: null;

	from: AnchorChainingAssetAndLocation<AnchorChainingAsset, KeetaLocationLike>;
	to: AnchorChainingAssetAndLocation<AnchorChainingAsset, KeetaLocationLike>;
}

export type AnchorChainingStepLike = GraphNodeLike | KeetaSendStepLike;

export type AnchorChainingAsset = TokenAddress | ISOCurrencyCode | ExternalChainAsset;

function isAnchorChainingAssetEqual(a: AnchorChainingAsset, b: AnchorChainingAsset): boolean {
	return(isMovableAssetEqual(a, b));
}

/**
 * Returns true for nodes that keep assets on Keeta: FX nodes, plus
 * asset-movement nodes whose from and to share the same Keeta chain location
 * (custodial FX anchors that don't actually move funds off-chain).
 */
function isFXLikeNode(node: GraphNodeLike): boolean {
	if (node.type === 'fx') {
		return(true);
	}
	const fromStr = convertAssetLocationToString(node.from.location);
	const toStr = convertAssetLocationToString(node.to.location);
	return(fromStr === toStr && fromStr.startsWith('chain:keeta:'));
}

interface AssetMovementResolvedRails {
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

export type ForwardingOnlyMethod = 'explicit' | 'implied';

export type ForwardingOnlyOptions = {
	method: ForwardingOnlyMethod;
	/** Max asset-movement legs (default 2, matching deposit UX). */
	maxLegs?: number;
};

const DEFAULT_FORWARDING_MAX_LEGS = 2;

function normalizeForwardingOnlyOptions(forwardingOnly: boolean | ForwardingOnlyOptions | undefined): ForwardingOnlyOptions | undefined {
	if (!forwardingOnly) {
		return(undefined);
	}

	if (forwardingOnly === true) {
		return({ method: 'explicit', maxLegs: DEFAULT_FORWARDING_MAX_LEGS });
	}

	return({
		maxLegs: DEFAULT_FORWARDING_MAX_LEGS,
		...forwardingOnly
	});
}

export type AnchorChainingResolveAssetsFilter = {
	from?: AnchorChainingListAssetsSideFilter;
	to?: AnchorChainingListAssetsSideFilter;
	maxStepCount?: number;
	onlyAllowFXLike?: boolean;
	/**
	 * When set, only consider persistent-forwarding-eligible crypto hops
	 * (asset-movement, non-Keeta origin). `true` means `{ method: 'explicit' }`.
	 * Depth is controlled by `maxStepCount` when provided; otherwise defaults to
	 * {@link DEFAULT_FORWARDING_MAX_LEGS} (same as getPlans' maxLegs default).
	 */
	forwardingOnly?: boolean | Pick<ForwardingOnlyOptions, 'method'>;
};

export const DEFAULT_MAX_PATH_LENGTH = 5;
export const DEFAULT_MAX_PATHS = 50;

export type AnchorChainingFindPathsOptions = {
	/**
	 * Maximum number of legs a path may contain. Defaults to DEFAULT_MAX_PATH_LENGTH,
	 * or to forwarding `maxLegs` when `forwardingOnly` is set.
	 */
	maxPathLength?: number;
	/**
	 * Maximum number of paths to collect before halting the search. Defaults to DEFAULT_MAX_PATHS.
	 */
	maxPaths?: number;
	/**
	 * When set, only traverse persistent-forwarding-eligible crypto hops.
	 * `true` means `{ method: 'explicit' }` with default maxLegs.
	 */
	forwardingOnly?: boolean | ForwardingOnlyOptions;
};

/** Options for {@link AnchorChaining.getPaths}; same shape as graph findPaths. */
export type GetPathsOptions = AnchorChainingFindPathsOptions;

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

type AnchorChainingAssetInfoWithMetadata = AnchorChainingAssetInfo & {
	metadata?: AnchorTokenLocationMetadata;
}

interface AnchorChainingResolveAssetsWithMetadataResult {
	from: AnchorChainingAssetInfoWithMetadata[];
	to: AnchorChainingAssetInfoWithMetadata[];
}

type AnchorChainingWithMetadataOptions = {
	providerID?: string;
};

type GetAccountForActionPayload = {
	type: 'assetMovement';
	providerMethod: 'initiateTransfer';
	provider?: AssetMovementProvider;
} | {
	type: 'fx';
	providerMethod: 'getAccountForAction';
}

type AccountLike = InstanceType<typeof KeetaNetLib.Account> | undefined | ((providerMethodPayload: GetAccountForActionPayload) => Promise<Account> | Account);
interface AnchorChainingAccountOverrides {
	account?: AccountLike;
	signer?: AccountLike;
}

/**
 * Graph-invariant index for resolveAssets, computed once per graph and reused
 * across every resolveAssets / listAssets call. Rebuilding these per call (they
 * depend only on the graph, not the filter) is what makes fan-out patterns --
 * e.g. one listAssets per source asset -- O(callers * nodes) and blow up on a
 * large graph.
 */
interface ResolveIndex {
	nodes: GraphNodeLike[];
	/** Rail-free (asset, location) key per node side, for marking and results. */
	fromAssetKeys: string[];
	toAssetKeys: string[];
	/** Rail-inclusive join keys: edge i -> j exists iff toKeys[i] === fromKeys[j]. */
	fromKeys: string[];
	toKeys: string[];
	nodesByFromKey: Map<string, number[]>;
	nodesByToKey: Map<string, number[]>;
	/** Rail-free (asset, location) buckets, for finding filter start nodes by key. */
	nodesByFromAssetKey: Map<string, number[]>;
	nodesByToAssetKey: Map<string, number[]>;
	railInfo: Map<string, { asset: AnchorChainingAsset; location: AssetLocationLike; inbound: Set<Rail>; outbound: Set<Rail> }>;
}

export type ForwardingAssetRef = {
	asset: AnchorChainingAsset;
	location: AssetLocationLike;
};

const forwardingAssetKeyCache: EVMChecksumCache = new Map();

function forwardingAssetKey(asset: AnchorChainingAsset, location: AssetLocationLike): string {
	return(`${convertAssetSearchInputToCanonical(asset, forwardingAssetKeyCache)}@${convertAssetLocationToString(location)}`);
}

function isCryptoChainLocation(location: AssetLocationLike): boolean {
	return(toAssetLocation(location).type === 'chain');
}

/**
 * Whether a rail's supportedOperations qualify for forwarding-only filtering.
 * - explicit: createPersistentForwarding must be true
 * - implied: supportedOperations omitted, or createPersistentForwarding is true
 *   (a partial object like `{ initiateTransfer: true }` does not qualify)
 */
export function supportsPersistentForwarding(
	supportedOperations: RailSupportedOperations | undefined,
	method: ForwardingOnlyMethod
): boolean {
	if (method === 'explicit') {
		return(supportedOperations?.createPersistentForwarding === true);
	}

	if (supportedOperations === undefined) {
		return(true);
	}

	return(supportedOperations.createPersistentForwarding === true);
}

/**
 * Whether a graph node is a forwarding-eligible crypto hop (asset-movement,
 * crypto locations, non-Keeta origin, and createPersistentForwarding per method).
 */
function isForwardingEligibleNode(node: GraphNodeLike, method: ForwardingOnlyMethod): boolean {
	if (node.type !== 'assetMovement') {
		return(false);
	}

	if (!isCryptoChainLocation(node.from.location) || !isCryptoChainLocation(node.to.location)) {
		return(false);
	}

	if (isChainLocation(toAssetLocation(node.from.location), 'keeta')) {
		return(false);
	}

	return(supportsPersistentForwarding(node.from.supportedOperations, method));
}

/**
 * Adjacency over crypto persistent-forwarding edges only - excludes FX edges and
 * any hop that starts on Keeta.
 */
export function buildForwardingAdjacency(nodes: GraphNodeLike[]): Map<string, ForwardingAssetRef[]> {
	const adjacency = new Map<string, ForwardingAssetRef[]>();

	for (const node of nodes) {
		if (!isForwardingEligibleNode(node, 'explicit')) {
			continue;
		}

		const key = forwardingAssetKey(node.from.asset, node.from.location);
		const list = adjacency.get(key) ?? [];
		list.push({ asset: node.to.asset, location: node.to.location });
		adjacency.set(key, list);
	}

	return(adjacency);
}

/** Whether `dest` is reachable from `source` over <=`maxLegs` forwarding edges. */
export function hasForwardingRoute(
	adjacency: Map<string, ForwardingAssetRef[]>,
	source: ForwardingAssetRef,
	dest: ForwardingAssetRef,
	maxLegs: number = DEFAULT_FORWARDING_MAX_LEGS
): boolean {
	const destKey = forwardingAssetKey(dest.asset, dest.location);
	let frontier = [ forwardingAssetKey(source.asset, source.location) ];

	for (let depth = 0; depth < maxLegs; depth++) {
		const next: string[] = [];

		for (const key of frontier) {
			for (const edge of adjacency.get(key) ?? []) {
				const edgeKey = forwardingAssetKey(edge.asset, edge.location);
				if (edgeKey === destKey) {
					return(true);
				}

				next.push(edgeKey);
			}
		}

		frontier = next;
	}

	return(false);
}

class AnchorGraph {
	client: KeetaNet.UserClient;
	resolver: Resolver;
	logger?: Logger | undefined;

	readonly assetMovementClient: KeetaAssetMovementAnchorClient;
	readonly fxClient: KeetaFXAnchorClient;
	readonly #assetMovementProviderCache = new Map<string, Promise<AssetMovementProvider | null>>();
	readonly #assetNameCache = new Map<MovableAssetSearchCanonical, ISOCurrencyCode | TokenAddress | ExternalChainAsset>();
	readonly #evmChecksumCache: EVMChecksumCache = new Map();
	#graphNodePromise: Promise<GraphNodeLike[]> | null = null;
	#assetMovementProviderIdsByAssetLocation: Promise<Map<string, Set<string>>> | null = null;
	#resolveIndexPromise: Promise<ResolveIndex> | null = null;

	constructor(args: { client: KeetaNet.UserClient; resolver: Resolver; logger?: Logger | undefined; }) {
		this.resolver = args.resolver;
		this.client = args.client;
		this.logger = args.logger;
		this.assetMovementClient = new KeetaAssetMovementAnchorClient(this.client, {
			resolver: this.resolver,
			...(this.logger ? { logger: this.logger } : {})
		});
		this.fxClient = new KeetaFXAnchorClient(this.client, {
			resolver: this.resolver,
			...(this.logger ? { logger: this.logger } : {})
		});
	}

	readonly #assetLocationKeyCache = new WeakMap<object, string>();
	#assetLocationKey = (side: { asset: AnchorChainingAsset; location: AssetLocationLike }) => {
		const cached = this.#assetLocationKeyCache.get(side);
		if (cached !== undefined) {
			return(cached);
		}
		const key = `${convertAssetSearchInputToCanonical(side.asset, this.#evmChecksumCache)}@${convertAssetLocationToString(side.location)}`;
		this.#assetLocationKeyCache.set(side, key);
		return(key);
	};

	getAssetMovementProviderById(providerID: string): Promise<AssetMovementProvider | null> {
		let providerPromise = this.#assetMovementProviderCache.get(providerID);
		if (providerPromise === undefined) {
			providerPromise = this.assetMovementClient.getProviderByID(providerID).catch((error: unknown) => {
				// Don't cache failures -- evict so a later call can retry.
				this.#assetMovementProviderCache.delete(providerID);
				throw(error);
			});
			this.#assetMovementProviderCache.set(providerID, providerPromise);
		}

		return(providerPromise);
	}

	async #getAssetMovementProviderIdsByAssetLocation(): Promise<Map<string, Set<string>>> {
		if (this.#assetMovementProviderIdsByAssetLocation === null) {
			this.#assetMovementProviderIdsByAssetLocation = (async () => {
				const map = new Map<string, Set<string>>();
				for (const node of await this.computeGraphNodes()) {
					if (node.type !== 'assetMovement') {
						continue;
					}
					for (const side of [ node.from, node.to ] as const) {
						const key = this.#assetLocationKey(side);
						let providerIDs = map.get(key);
						if (!providerIDs) {
							providerIDs = new Set<string>();
							map.set(key, providerIDs);
						}
						providerIDs.add(node.providerID);
					}
				}
				return(map);
			})();
		}

		return(await this.#assetMovementProviderIdsByAssetLocation);
	}

	async getAssetMovementProvidersForAsset(asset: AnchorChainingAsset, location: AssetLocationLike): Promise<null | { [providerID: string]: { provider: AssetMovementProvider; }}> {
		const providerIDs = (await this.#getAssetMovementProviderIdsByAssetLocation()).get(this.#assetLocationKey({ asset, location }));
		if (!providerIDs || providerIDs.size === 0) {
			return(null);
		}

		let retval: null | { [providerID: string]: { provider: AssetMovementProvider; }} = null;

		const resolved = await Promise.all([ ...providerIDs ].map(async (providerID) => {
			const provider = await this.getAssetMovementProviderById(providerID);
			return({ providerID, provider });
		}));

		for (const { providerID, provider } of resolved) {
			if (!provider) {
				this.logger?.debug('AnchorGraph::getAssetMovementProvidersForAsset', `No provider found for providerID ${providerID}, although provider was previously known to exist in the graph nodes`);
				continue;
			}

			if (!retval) {
				retval = {};
			}
			retval[providerID] = { provider };
		}

		return(retval);
	}

	async #computeFXNodes() {
		const fxServices = await this.resolver.lookup('fx', {});

		if (!fxServices) {
			return([]);
		}

		const networkLocation = `chain:keeta:${this.client.network}` satisfies AssetLocationLike;

		const providerLookupResult = await Promise.all(Object.entries(fxServices).map(async ([ providerID, service ]) => {
			try {
				const fromEntries = await service.from('array');

				if (!fromEntries) {
					return(null);
				}

				const operations = await service.operations('object');
				if (!operations.createExchange) {
					this.logger?.debug('AnchorGraph::computeFXNodes', `FX service ${providerID} does not support createExchange operation, skipping`);
					return(null);
				}

				const pathNodes = await Promise.all(fromEntries.map(async function(fromEntry) {
					const pathNodesResult: GraphNodeLike[] = [];

					const parsedEntry = await fromEntry('object');

					const [ fromCodes, toCodes ] = await Promise.all([
						parsedEntry.currencyCodes('array'),
						parsedEntry.to('array')
					]);

					for (const from of fromCodes) {
						const fromResolved = await from('string');
						if (!fromResolved) {
							continue;
						}

						const fromAccount = KeetaNet.lib.Account.fromPublicKeyString(fromResolved).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

						for (const to of toCodes) {
							const toResolved = await to('string');
							if (!toResolved) {
								continue;
							}

							const toAccount = KeetaNet.lib.Account.fromPublicKeyString(toResolved).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

							if (fromAccount.comparePublicKey(toAccount)) {
								continue;
							}

							pathNodesResult.push({
								type: 'fx',
								providerID: providerID,
								from: { asset: fromAccount, location: networkLocation, rail: 'KEETA_SEND' },
								to: { asset: toAccount, location: networkLocation, rail: 'KEETA_SEND' }
							});
						}
					}

					return(pathNodesResult);
				}));

				return(pathNodes.flat());
			} catch (error) {
				this.logger?.warn('AnchorGraph::computeFXNodes', `Failed to parse FX service metadata for provider ${providerID} -- ignoring:`, error);
				return(null);
			}
		}));

		return(providerLookupResult.flat().filter((node): node is GraphNodeLike => !!node));
	}

	async #resolveAssetName(name: MovableAssetSearchCanonical): Promise<ISOCurrencyCode | TokenAddress | ExternalChainAsset> {
		if (KeetaNet.lib.Account.isInstance(name) && name.isToken()) {
			return(name);
		}

		if (typeof name === 'string') {
			try {
				return(KeetaNet.lib.Account.fromPublicKeyString(name).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
			} catch {
				/* ignore error and continue with other resolution methods */
			}
		}

		let found = this.#assetNameCache.get(name);
		if (found) {
			return(found);
		}

		if (isExternalChainAsset(name)) {
			found = name;
		} else if (Currency.isCurrencyCode(name)) {
			found = name;
		} else if (Currency.isISOCurrencyNumber(name)) {
			found = new Currency(name).code;
		} else {
			const lookupRet = await this.resolver.lookupToken(name);
			if (lookupRet) {
				found = KeetaNet.lib.Account.toAccount(lookupRet.token);
			}
		}

		if (!found) {
			throw(new Error(`Unable to resolve asset name: ${name}`));
		}

		this.#assetNameCache.set(name, found);

		return(found);
	}

	async #computeAssetRails(assetInput: ToValuizable<RailOrRailWithExtendedDetails>): Promise<RailWithSupportedOperations> {
		try {
			const railResolved = await assetInput('string');

			if (!isRail(railResolved)) {
				throw(new Error(`Invalid rail format: ${railResolved}`));
			}

			return({ rail: railResolved });
		} catch {
			/* ignore error */
		}

		const extendedDetailsResolved = await assetInput('object');

		if (!extendedDetailsResolved || typeof extendedDetailsResolved !== 'object' || Array.isArray(extendedDetailsResolved)) {
			throw(new Error(`Invalid asset format, expected string or object with extended details`));
		}

		if (!('rail' in extendedDetailsResolved)) {
			throw(new Error(`Invalid asset format, missing 'rail' field in extended details`));
		}

		const railResolved = await extendedDetailsResolved.rail?.('string');

		if (!isRail(railResolved)) {
			throw(new Error(`Invalid rail format in extended details: ${railResolved}`));
		}

		let supportedOperations: RailSupportedOperations | undefined;
		if ('supportedOperations' in extendedDetailsResolved && extendedDetailsResolved.supportedOperations) {
			const opsResolved = await extendedDetailsResolved.supportedOperations('object');
			if (opsResolved && typeof opsResolved === 'object' && !Array.isArray(opsResolved)) {
				const parsed: RailSupportedOperations = {};
				if ('createPersistentForwarding' in opsResolved && opsResolved.createPersistentForwarding) {
					const val = await opsResolved.createPersistentForwarding('boolean');
					if (typeof val === 'boolean') {
						parsed.createPersistentForwarding = val;
					}
				}
				if ('initiateTransfer' in opsResolved && opsResolved.initiateTransfer) {
					const val = await opsResolved.initiateTransfer('boolean');
					if (typeof val === 'boolean') {
						parsed.initiateTransfer = val;
					}
				}
				if (Object.keys(parsed).length > 0) {
					supportedOperations = parsed;
				}
			}
		}

		const result: RailWithSupportedOperations = { rail: railResolved };
		if (supportedOperations) {
			result.supportedOperations = supportedOperations;
		}

		return(result);
	}

	async #computeAssetMovementPairSide(pairSideInput: ToValuizable<AssetWithRails>): Promise<{ rails: AssetMovementResolvedRails; location: AssetLocationLike; id: AnchorChainingAsset; }> {
		const pairSideResolved = await pairSideInput('object');

		let location: AssetLocationLike;
		if (pairSideResolved.location) {
			const locationRaw = await pairSideResolved.location('string');
			if (!isAssetLocationLike(locationRaw)) {
				throw(new Error(`Invalid location format: ${locationRaw}`));
			}

			location = locationRaw;
		} else {
			location = `chain:keeta:${this.client.network}`;
		}

		const railsResolved = await pairSideResolved.rails('object');

		const rails: AssetMovementResolvedRails = {
			common: await Promise.all((await railsResolved.common?.('array'))?.map(async (commonInput) => {
				return(await this.#computeAssetRails(commonInput));
			}) ?? []),
			inbound: await Promise.all((await railsResolved.inbound?.('array'))?.map(async (commonInput) => {
				return(await this.#computeAssetRails(commonInput));
			}) ?? []),
			outbound: await Promise.all((await railsResolved.outbound?.('array'))?.map(async (commonInput) => {
				return(await this.#computeAssetRails(commonInput));
			}) ?? [])
		};

		const id = await pairSideResolved.id('string');
		if (!isMovableAssetSearchCanonical(id)) {
			throw(new Error(`Invalid asset id format: ${id}`));
		}

		return({
			rails: rails,
			location: location,
			id: await this.#resolveAssetName(id)
		});
	}

	async #computeAssetMovementNodes() {
		const assetMovementServices = await this.resolver.lookup('assetMovement', {});

		if (!assetMovementServices) {
			return([]);
		}

		const providerResults = await Promise.all(Object.entries(assetMovementServices).map(async ([ providerID, service ]) => {
			try {
				const supportedOperationsMetadata = await service.operations('object');

				const supportedAssetsEntries = await service.supportedAssets('array');

				if (!supportedAssetsEntries) {
					this.logger?.debug('AnchorGraph::computeAssetMovementNodes', `No supported assets found for provider ${providerID}`);
					return(null);
				}

				const pathNodesResult = await Promise.all(supportedAssetsEntries.map(async (assetEntry): Promise<GraphNodeLike[]> => {
					const parsedEntry = await assetEntry('object');

					const pathsResolved = await parsedEntry.paths('array');
					const pathPromises = await Promise.allSettled(pathsResolved.map(async (pathResolvedInput): Promise<GraphNodeLike[]> => {
						const pathResolved = await pathResolvedInput('object');

						const pairResolved = await pathResolved.pair('array');

						const [ fromResolved, toResolved ] = await Promise.all([
							this.#computeAssetMovementPairSide(pairResolved[0]),
							this.#computeAssetMovementPairSide(pairResolved[1])
						]);

						function getProviderSupportedOperationsForRail(railSpecific?: RailSupportedOperations): RailSupportedOperations {
							const retval: RailSupportedOperations = {
								createPersistentForwarding: supportedOperationsMetadata.createPersistentForwarding !== undefined,
								initiateTransfer: supportedOperationsMetadata.initiateTransfer !== undefined
							};

							if (railSpecific) {
								retval.createPersistentForwarding = railSpecific.createPersistentForwarding ?? false;
								retval.initiateTransfer = railSpecific.initiateTransfer ?? false;
							}

							return(retval);
						}

						const makeFromTo = (input: {
							asset: { id: AnchorChainingAsset; location: AssetLocationLike; };
							rail: { rail: Rail; supportedOperations?: RailSupportedOperations | undefined; }
						}) => {
							const retval: Extract<GraphNodeLike, { type: 'assetMovement' }>['from' | 'to'] = {
								asset: input.asset.id,
								location: input.asset.location,
								rail: input.rail.rail
							};

							if (input.rail.supportedOperations !== undefined) {
								retval.supportedOperations = getProviderSupportedOperationsForRail(input.rail.supportedOperations);
							}

							return(retval);
						};

						const pathNodes: GraphNodeLike[] = [];
						for (const [ src, dest ] of [
							[ fromResolved, toResolved ],
							[ toResolved, fromResolved ]
						] as const) {
							for (const inboundRail of [ ...(src.rails.common ?? []), ...(src.rails.inbound ?? []) ]) {
								/*
								 * Drop edges whose source rail explicitly cannot
								 * initiate a transfer and also cannot create a
								 * persistent forwarding address.
								 */
								const inboundSupportedOperations = getProviderSupportedOperationsForRail(inboundRail.supportedOperations);
								if (inboundSupportedOperations.initiateTransfer === false && inboundSupportedOperations.createPersistentForwarding === false) {
									this.logger?.debug('AnchorGraph::computeAssetMovementNodes', `Skipping ${providerID} edge from ${convertAssetLocationToString(src.location)} via rail ${inboundRail.rail}: neither initiateTransfer nor createPersistentForwarding supported`);
									continue;
								}

								for (const outboundRail of [ ...(dest.rails.common ?? []), ...(dest.rails.outbound ?? []) ]) {
									pathNodes.push({
										type: 'assetMovement',
										providerID: providerID,
										from: makeFromTo({ asset: src, rail: inboundRail }),
										to: makeFromTo({ asset: dest, rail: outboundRail })
									});
								}
							}

						}

						return(pathNodes);
					}));

					const allPaths = [];

					for (const resolved of pathPromises) {
						if (resolved.status === 'rejected') {
							this.logger?.debug('AnchorGraph::computeAssetMovementNodes', `error fetching nodes for provider ${providerID}:`, resolved.reason);
						} else {
							allPaths.push(...resolved.value);
						}
					}

					return(allPaths);
				}));

				return(pathNodesResult.flat());
			} catch (error) {
				this.logger?.warn('AnchorGraph::computeAssetMovementNodes', `Failed to parse asset movement service metadata for provider ${providerID} -- ignoring:`, error);
				return(null);
			}
		}));

		return(providerResults.flat().filter((node): node is GraphNodeLike => !!node));
	}

	async computeGraphNodes(): Promise<GraphNodeLike[]> {
		if (this.#graphNodePromise === null) {
			this.#graphNodePromise = (async () => {
				const receivedNodes = await Promise.all([
					this.#computeFXNodes(),
					this.#computeAssetMovementNodes()
				]);

				return(receivedNodes.flat());
			})();
		}

		return(await this.#graphNodePromise);
	}

	async findPaths(input: AnchorChainingPathInput, options?: AnchorChainingFindPathsOptions): Promise<GraphNodeLike[][]> {
		const forwardingOpts = normalizeForwardingOnlyOptions(options?.forwardingOnly);
		const maxPathLength = forwardingOpts
			? Math.min(
				options?.maxPathLength ?? Infinity,
				forwardingOpts.maxLegs ?? DEFAULT_FORWARDING_MAX_LEGS
			)
			: (options?.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH);
		if (maxPathLength < 1) {
			throw(new Error(`maxPathLength must be at least 1, got ${maxPathLength}`));
		}
		const maxPaths = options?.maxPaths ?? DEFAULT_MAX_PATHS;
		if (maxPaths < 1) {
			throw(new Error(`maxPaths must be at least 1, got ${maxPaths}`));
		}

		const allNodes = await this.computeGraphNodes();
		const graph = forwardingOpts
			? allNodes.filter((node) => isForwardingEligibleNode(node, forwardingOpts.method))
			: allNodes;

		const nodesWithNext: { node: GraphNodeLike, next: number[] }[] = graph.map(function(node) {
			return({ node, next: [] });
		});

		const sideKey = (side: GraphNodeLike['from' | 'to']): string =>
			`${side.rail}:${this.#assetLocationKey(side)}`;

		const fromKeys = graph.map(node => sideKey(node.from));
		const toKeys = graph.map(node => sideKey(node.to));

		const nodesByFromKey = new Map<string, number[]>();
		for (let j = 0; j < fromKeys.length; j++) {
			const key = fromKeys[j];
			if (key === undefined) {
				throw(new Error(`Invalid node index during adjacency construction: ${j}`));
			}
			let bucket = nodesByFromKey.get(key);
			if (!bucket) {
				bucket = [];
				nodesByFromKey.set(key, bucket);
			}
			bucket.push(j);
		}

		for (let i = 0; i < nodesWithNext.length; i++) {
			const ni = nodesWithNext[i];
			const toKey = toKeys[i];
			if (!ni || toKey === undefined) {
				throw(new Error(`Invalid node index during adjacency construction: ${i}`));
			}
			const successors = nodesByFromKey.get(toKey);
			if (!successors) {
				continue;
			}
			for (const j of successors) {
				const nj = nodesWithNext[j];
				if (!nj) {
					throw(new Error(`Invalid node index during adjacency construction: ${j}`));
				}
				// We can ignore chaining one fx anchor to itself
				if (ni.node.type === 'fx' && nj.node.type === 'fx' && ni.node.providerID === nj.node.providerID) {
					continue;
				}
				ni.next.push(j);
			}
		}

		const paths: GraphNodeLike[][] = [];

		const sourceKey = `${input.source.rail}:${this.#assetLocationKey(input.source)}`;
		const destinationKey = `${input.destination.rail}:${this.#assetLocationKey(input.destination)}`;

		// Node indices whose `from` side matches the requested source -- the
		// possible starting legs.
		const sourceIndices: number[] = [];
		for (let index = 0; index < fromKeys.length; index++) {
			if (fromKeys[index] === sourceKey) {
				sourceIndices.push(index);
			}
		}

		let truncated = false;

		// Depth-limited DFS that records a path only when its length equals the
		// current depthLimit, so each distinct path is collected exactly once as
		// we deepen.
		const dfs = (
			currentIndex: number,
			depthLimit: number,
			visitedAssets: Set<string>,
			path: GraphNodeLike[]
		): void => {
			if (paths.length >= maxPaths) {
				truncated = true;
				return;
			}

			const cur = nodesWithNext[currentIndex];
			const assetLocationStr = fromKeys[currentIndex];

			if (!cur || assetLocationStr === undefined) {
				throw(new Error(`Invalid node index: ${currentIndex}`));
			}

			if (visitedAssets.has(assetLocationStr)) {
				return;
			}

			visitedAssets.add(assetLocationStr);

			const newPath = [ ...path, cur.node ];

			if (newPath.length === depthLimit && toKeys[currentIndex] === destinationKey) {
				paths.push(newPath);
			}

			if (newPath.length < depthLimit) {
				for (const nextIndex of cur.next) {
					dfs(nextIndex, depthLimit, visitedAssets, newPath);
					if (paths.length >= maxPaths) {
						break;
					}
				}
			}

			visitedAssets.delete(assetLocationStr);
		};

		for (let depthLimit = 1; depthLimit <= maxPathLength && paths.length < maxPaths; depthLimit++) {
			for (const index of sourceIndices) {
				dfs(index, depthLimit, new Set<string>(), []);
				if (paths.length >= maxPaths) {
					break;
				}
			}
		}

		if (truncated) {
			this.logger?.debug('AnchorGraph::findPaths', `Path search hit the maxPaths cap of ${maxPaths}; returning the ${maxPaths} shortest paths (up to maxPathLength ${maxPathLength}).`);
		}

		return(paths);
	}

	async #getResolveIndex(): Promise<ResolveIndex> {
		if (this.#resolveIndexPromise === null) {
			this.#resolveIndexPromise = (async () => {
				const nodes = await this.computeGraphNodes();

				const fromAssetKeys = nodes.map(node => this.#assetLocationKey(node.from));
				const toAssetKeys = nodes.map(node => this.#assetLocationKey(node.to));
				const fromKeys = nodes.map((node, i) => `${node.from.rail}:${fromAssetKeys[i]}`);
				const toKeys = nodes.map((node, i) => `${node.to.rail}:${toAssetKeys[i]}`);

				const nodesByFromKey = new Map<string, number[]>();
				const nodesByToKey = new Map<string, number[]>();
				const nodesByFromAssetKey = new Map<string, number[]>();
				const nodesByToAssetKey = new Map<string, number[]>();
				const railInfo: ResolveIndex['railInfo'] = new Map();

				const addToBucket = (map: Map<string, number[]>, key: string | undefined, index: number) => {
					if (key === undefined) {
						throw(new Error(`Invalid node index during resolve-index construction: ${index}`));
					}
					let bucket = map.get(key);
					if (!bucket) {
						bucket = [];
						map.set(key, bucket);
					}
					bucket.push(index);
				};

				const addRail = (assetKey: string | undefined, side: GraphNodeLike['from' | 'to'], railSide: 'inbound' | 'outbound', index: number) => {
					if (assetKey === undefined) {
						throw(new Error(`Invalid node index during resolve-index construction: ${index}`));
					}
					let info = railInfo.get(assetKey);
					if (!info) {
						info = { asset: side.asset, location: side.location, inbound: new Set(), outbound: new Set() };
						railInfo.set(assetKey, info);
					}
					info[railSide].add(side.rail);
				};

				for (let i = 0; i < nodes.length; i++) {
					const node = nodes[i];
					if (!node) {
						throw(new Error(`Invalid node index during resolve-index construction: ${i}`));
					}
					addToBucket(nodesByFromKey, fromKeys[i], i);
					addToBucket(nodesByToKey, toKeys[i], i);
					addToBucket(nodesByFromAssetKey, fromAssetKeys[i], i);
					addToBucket(nodesByToAssetKey, toAssetKeys[i], i);
					// Match buildResultMap's node/side ordering (to side before from
					// side) so the representative asset/location for a key is stable.
					addRail(toAssetKeys[i], node.to, 'inbound', i);
					addRail(fromAssetKeys[i], node.from, 'outbound', i);
				}

				return({ nodes, fromAssetKeys, toAssetKeys, fromKeys, toKeys, nodesByFromKey, nodesByToKey, nodesByFromAssetKey, nodesByToAssetKey, railInfo });
			})();
		}

		return(await this.#resolveIndexPromise);
	}

	async resolveAssets(filter: AnchorChainingResolveAssetsFilter = {}): Promise<AnchorChainingResolveAssetsResult> {
		const { from: fromFilterInput, to: toFilterInput, maxStepCount, onlyAllowFXLike } = filter;
		const forwardingOpts = normalizeForwardingOnlyOptions(filter.forwardingOnly);
		const forwardingMethod = forwardingOpts?.method;
		const traversalStepLimit = forwardingOpts
			? (maxStepCount ?? forwardingOpts.maxLegs ?? DEFAULT_FORWARDING_MAX_LEGS)
			: maxStepCount;

		const keetaNetworkLocation = `chain:keeta:${this.client.network}` satisfies AssetLocationLike;

		// When onlyAllowFXLike, default omitted locations to the Keeta network location
		const fromFilter = (onlyAllowFXLike && fromFilterInput !== undefined && fromFilterInput.location === undefined)
			? { ...fromFilterInput, location: keetaNetworkLocation }
			: fromFilterInput;
		const toFilter = (onlyAllowFXLike && toFilterInput !== undefined && toFilterInput.location === undefined)
			? { ...toFilterInput, location: keetaNetworkLocation }
			: toFilterInput;

		// Graph-invariant structures (keys, adjacency buckets, per-asset rail
		// aggregation) are built once and reused across every call, so a fan-out
		// of many filtered resolveAssets/listAssets calls doesn't rebuild them n
		// times.
		const { nodes, fromAssetKeys, toAssetKeys, fromKeys, toKeys, nodesByFromKey, nodesByToKey, nodesByFromAssetKey, nodesByToAssetKey, railInfo } = await this.#getResolveIndex();

		const nodeAllowed = (node: GraphNodeLike): boolean => {
			if (onlyAllowFXLike && !isFXLikeNode(node)) {
				return(false);
			}
			if (forwardingMethod !== undefined && !isForwardingEligibleNode(node, forwardingMethod)) {
				return(false);
			}
			return(true);
		};

		const sideMatchesFilter = (
			side: GraphNodeLike['from' | 'to'],
			f: AnchorChainingListAssetsSideFilter
		): boolean => {
			if (f.location !== undefined && convertAssetLocationToString(side.location) !== convertAssetLocationToString(f.location)) {
				return(false);
			}
			if (f.asset !== undefined && !isAnchorChainingAssetEqual(side.asset, f.asset)) {
				return(false);
			}
			if (f.rail !== undefined && side.rail !== f.rail) {
				return(false);
			}
			return(true);
		};

		// The start nodes for a traversal are those whose relevant side matches the
		// filter. When the filter pins both asset and location (the common case) we
		// look them up by key in O(matches); otherwise we fall back to scanning all
		// nodes. The key path avoids running isAnchorChainingAssetEqual -- and thus
		// keccak -- per node, which on a large graph dominates fan-out patterns.
		const assetBucketsForSide = { from: nodesByFromAssetKey, to: nodesByToAssetKey } as const;
		const computeStartIndices = (f: AnchorChainingListAssetsSideFilter, side: 'from' | 'to'): number[] => {
			if (f.asset !== undefined && f.location !== undefined) {
				const key = this.#assetLocationKey({ asset: f.asset, location: f.location });
				const candidates = assetBucketsForSide[side].get(key) ?? [];
				if (f.rail === undefined) {
					return(candidates);
				}
				return(candidates.filter(i => nodes[i]?.[side].rail === f.rail));
			}

			const out: number[] = [];
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				if (node && sideMatchesFilter(node[side], f)) {
					out.push(i);
				}
			}
			return(out);
		};

		// Separate reachable sets and distance maps for backward (from) and forward (to) traversals.
		const fromReachable = new Set<string>();
		const fromDistances = new Map<string, number>();
		const toReachable = new Set<string>();
		const toDistances = new Map<string, number>();

		const makeMarkFn = (reachable: Set<string>, distances: Map<string, number>) =>
			(key: string, depth?: number) => {
				reachable.add(key);
				if (depth !== undefined) {
					const existing = distances.get(key);
					if (existing === undefined || depth < existing) {
						distances.set(key, depth);
					}
				}
			};

		const markFromReachable = makeMarkFn(fromReachable, fromDistances);
		const markToReachable = makeMarkFn(toReachable, toDistances);

		const bfs = (
			startIndices: number[],
			direction: 'forward' | 'backward',
			markFn: (key: string, depth: number) => void
		) => {
			const markKeys = direction === 'forward' ? toAssetKeys : fromAssetKeys;
			const stepKeys = direction === 'forward' ? toKeys : fromKeys;
			const neighborBuckets = direction === 'forward' ? nodesByFromKey : nodesByToKey;

			const nodeVisited = new Set<number>();
			const queue: { nodeIdx: number; depth: number }[] = [];
			for (const i of startIndices) {
				if (!nodeVisited.has(i)) {
					nodeVisited.add(i);
					queue.push({ nodeIdx: i, depth: 1 });
				}
			}

			let head = 0;
			while (head < queue.length) {
				const queueItem = queue[head];
				head++;
				if (!queueItem) {
					throw(new Error(`Unexpected empty queue during BFS processing`));
				}
				const { nodeIdx, depth } = queueItem;
				const node = nodes[nodeIdx];
				const markKey = markKeys[nodeIdx];
				const stepKey = stepKeys[nodeIdx];
				if (!node || markKey === undefined || stepKey === undefined) {
					throw(new Error(`Invalid node index during BFS processing: ${nodeIdx}`));
				}
				if (!nodeAllowed(node)) {
					continue;
				}
				markFn(markKey, depth);
				if (traversalStepLimit !== undefined && depth >= traversalStepLimit) {
					continue;
				}
				const neighbors = neighborBuckets.get(stepKey);
				if (!neighbors) {
					continue;
				}
				for (const neighborIdx of neighbors) {
					if (nodeVisited.has(neighborIdx)) {
						continue;
					}
					const neighbor = nodes[neighborIdx];
					if (!neighbor) {
						throw(new Error(`Invalid node index during BFS processing: ${neighborIdx}`));
					}
					if (node.type === 'fx' && neighbor.type === 'fx' && node.providerID === neighbor.providerID) {
						continue;
					}
					nodeVisited.add(neighborIdx);
					queue.push({ nodeIdx: neighborIdx, depth: depth + 1 });
				}
			}
		};

		if (fromFilter) {
			bfs(computeStartIndices(fromFilter, 'from'), 'forward', markToReachable);
		}
		if (toFilter) {
			bfs(computeStartIndices(toFilter, 'to'), 'backward', markFromReachable);
		}
		if (!fromFilter && !toFilter) {
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				const fromKey = fromAssetKeys[i];
				const toKey = toAssetKeys[i];
				if (!node || fromKey === undefined || toKey === undefined) {
					throw(new Error(`Invalid node index during reachability marking: ${i}`));
				}
				if (nodeAllowed(node)) {
					markFromReachable(fromKey);
					markFromReachable(toKey);
					markToReachable(fromKey);
					markToReachable(toKey);
				}
			}
		}

		// Build result maps by collecting inbound/outbound rails for every reachable
		// (asset, location) pair. The common path reads the precomputed per-asset
		// rail aggregation (railInfo) and so is O(reachable). onlyAllowFXLike and
		// forwardingOnly need to exclude disallowed nodes' rails -- which railInfo
		// doesn't distinguish -- so they fall back to the O(nodes) scan.
		const buildResultMapFast = (
			reachable: Set<string>,
			distances: Map<string, number>
		): Map<string, AnchorChainingAssetInfo> => {
			const resultMap = new Map<string, AnchorChainingAssetInfo>();
			for (const key of reachable) {
				const info = railInfo.get(key);
				if (!info) {
					continue;
				}
				const distanceValue = distances.get(key);
				resultMap.set(key, {
					asset: info.asset,
					location: info.location,
					rails: { inbound: [ ...info.inbound ], outbound: [ ...info.outbound ] },
					distance: distanceValue !== undefined ? { pathLength: distanceValue } : null
				});
			}
			return(resultMap);
		};

		const buildResultMapFiltered = (
			reachable: Set<string>,
			distances: Map<string, number>
		): Map<string, AnchorChainingAssetInfo> => {
			const resultMap = new Map<string, AnchorChainingAssetInfo>();
			const getOrCreate = (key: string, side: { asset: AnchorChainingAsset; location: AssetLocationLike }): AnchorChainingAssetInfo => {
				let resultObj = resultMap.get(key);
				if (!resultObj) {
					const distanceValue = distances.get(key);

					resultObj = {
						asset: side.asset,
						location: side.location,
						rails: { inbound: [], outbound: [] },
						distance: distanceValue !== undefined ? { pathLength: distanceValue } : null
					};

					resultMap.set(key, resultObj);
				}
				return(resultObj);
			};
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				const toKey = toAssetKeys[i];
				const fromKey = fromAssetKeys[i];
				if (!node || toKey === undefined || fromKey === undefined) {
					throw(new Error(`Invalid node index during result-map construction: ${i}`));
				}
				if (!nodeAllowed(node)) {
					continue;
				}
				if (reachable.has(toKey)) {
					const entry = getOrCreate(toKey, node.to);
					if (!entry.rails.inbound.includes(node.to.rail)) {
						entry.rails.inbound.push(node.to.rail);
					}
				}
				if (reachable.has(fromKey)) {
					const entry = getOrCreate(fromKey, node.from);
					if (!entry.rails.outbound.includes(node.from.rail)) {
						entry.rails.outbound.push(node.from.rail);
					}
				}
			}
			return(resultMap);
		};

		const buildResultMap = (onlyAllowFXLike || forwardingMethod !== undefined) ? buildResultMapFiltered : buildResultMapFast;

		const fromResultMap = buildResultMap(fromReachable, fromDistances);
		const toResultMap = buildResultMap(toReachable, toDistances);

		// When onlyAllowFXLike, exclude the filter asset from the result set so that
		// "what can USDC be swapped to?" doesn't include USDC itself via a round-trip.
		if (onlyAllowFXLike) {
			if (fromFilter?.asset !== undefined) {
				toResultMap.delete(this.#assetLocationKey({ asset: fromFilter.asset, location: fromFilter.location ?? keetaNetworkLocation }));
			}
			if (toFilter?.asset !== undefined) {
				fromResultMap.delete(this.#assetLocationKey({ asset: toFilter.asset, location: toFilter.location ?? keetaNetworkLocation }));
			}
		}

		const filterMap = (
			map: Map<string, AnchorChainingAssetInfo>,
			f: AnchorChainingListAssetsSideFilter,
			railSide: 'inbound' | 'outbound'
		): AnchorChainingAssetInfo[] =>
			Array.from(map.values()).filter(info => {
				if (f.location !== undefined && convertAssetLocationToString(info.location) !== convertAssetLocationToString(f.location)) {
					return(false);
				}
				if (f.asset !== undefined && !isAnchorChainingAssetEqual(info.asset, f.asset)) {
					return(false);
				}
				if (f.rail !== undefined && !info.rails[railSide].includes(f.rail)) {
					return(false);
				}
				return(true);
			});

		const fromAssets = (fromFilter !== undefined && toFilter !== undefined)
			? filterMap(fromResultMap, fromFilter, 'outbound')
			: Array.from(fromResultMap.values());
		const toAssets = (fromFilter !== undefined && toFilter !== undefined)
			? filterMap(toResultMap, toFilter, 'inbound')
			: Array.from(toResultMap.values());

		return({ from: fromAssets, to: toAssets });
	}

	async listAssets(filter: AnchorChainingListAssetsFilter = {}): Promise<AnchorChainingAssetInfo[]> {
		const result = await this.resolveAssets(filter);

		if (filter.from) {
			return(result.to);
		} else if (filter.to) {
			return(result.from);
		} else {
			return(result.to);
		}
	}

	async getExternalAssetMetadata(
		asset: AnchorChainingAssetInfo['asset'],
		location: AnchorChainingAssetInfo['location'],
		providerID?: string
	):  Promise<AnchorTokenLocationMetadata | undefined> {
		if (!isExternalChainAsset(asset)) {
			return(undefined);
		}

		const providers = await this.getAssetMovementProvidersForAsset(asset, location);
		if (!providers) {
			return(undefined);
		}

		if (providerID) {
			const found = providers[providerID];
			if (!found) {
				return(undefined);
			}
			return(found.provider.getAssetMetadataForLocation(location, asset) ?? undefined);
		}

		for (const { provider } of Object.values(providers)) {
			const metadata = provider.getAssetMetadataForLocation(location, asset);
			if (metadata) {
				return(metadata);
			}
		}

		return(undefined);
	}

	async #attachMetadata(
		assetInfo: AnchorChainingAssetInfo,
		options?: AnchorChainingWithMetadataOptions
	): Promise<AnchorChainingAssetInfoWithMetadata> {
		const metadata = await this.getExternalAssetMetadata(assetInfo.asset, assetInfo.location, options?.providerID);
		if (!metadata) {
			return(assetInfo);
		}
		return({ ...assetInfo, metadata });
	}

	async resolveAssetsWithMetadata(
		filter: AnchorChainingResolveAssetsFilter = {},
		options?: AnchorChainingWithMetadataOptions
	): Promise<AnchorChainingResolveAssetsWithMetadataResult> {
		const result = await this.resolveAssets(filter);

		const [from, to] = await Promise.all([
			Promise.all(result.from.map((info) => this.#attachMetadata(info, options))),
			Promise.all(result.to.map((info) => this.#attachMetadata(info, options)))
		]);

		return({ from, to });
	}

	async listAssetsWithMetadata(
		filter: AnchorChainingListAssetsFilter = {},
		options?: AnchorChainingWithMetadataOptions
	): Promise<AnchorChainingAssetInfoWithMetadata[]> {
		const result = await this.resolveAssetsWithMetadata(filter, options);

		if (filter.from) {
			return(result.to);
		} else if (filter.to) {
			return(result.from);
		} else {
			return(result.to);
		}
	}

	async buildForwardingAdjacency(): Promise<Map<string, ForwardingAssetRef[]>> {
		return(buildForwardingAdjacency(await this.computeGraphNodes()));
	}
}

export interface ComputePlanOptions {
	overrides?: AnchorChainingAccountOverrides;
	/**
	 * Limit the number of plans to calculate, defaults to 3
	 */
	limit?: number;
	/**
	 * When true, plan computation uses persistent forwarding for the final leg
	 * instead of initiateTransfer, even when the source rail supports both.
	 */
	forwardingOnly?: boolean;
}

export interface GetPlansOptions extends Omit<ComputePlanOptions, 'forwardingOnly'> {
	includeAllOutput?: boolean;
	forwardingOnly?: boolean | ForwardingOnlyOptions;
}

function toComputePlanOptions(options?: GetPlansOptions, forwardingOpts?: ForwardingOnlyOptions): ComputePlanOptions | undefined {
	const overrides = options?.overrides;
	const forwardingOnly = forwardingOpts !== undefined;

	if (overrides === undefined && !forwardingOnly) {
		return(undefined);
	}

	return({
		...(overrides !== undefined ? { overrides } : {}),
		...(forwardingOnly ? { forwardingOnly: true } : {})
	});
}

/**
 * Whether a discovered path is eligible for forwarding-only plan resolution:
 * crypto chain hops only, no Keeta-origin legs, no FX, within maxLegs.
 */
export function isForwardingPath(path: AnchorChainingPath, options?: ForwardingOnlyOptions): boolean {
	const maxLegs = options?.maxLegs ?? DEFAULT_FORWARDING_MAX_LEGS;
	const method = options?.method ?? 'explicit';
	const legs = path.path;

	if (legs.length < 1 || legs.length > maxLegs) {
		return(false);
	}

	return(legs.every((step) => {
		if (step.type !== 'assetMovement') {
			return(false);
		}

		if (!isCryptoChainLocation(step.from.location) || !isCryptoChainLocation(step.to.location)) {
			return(false);
		}

		if (isChainLocation(toAssetLocation(step.from.location), 'keeta')) {
			return(false);
		}

		return(supportsPersistentForwarding(step.from.supportedOperations, method));
	}));
}

function computeFeeTotalFromBreakdown(valueIn: bigint, fees: { lineItems: readonly (ResolvedFeeLineItem | UnresolvedFeeLineItem)[]; total?: string }): bigint {
	let feeFromLineItems = 0n;

	for (const lineItem of fees.lineItems) {
		if ('value' in lineItem && lineItem.value !== undefined && lineItem.value !== '') {
			feeFromLineItems += BigInt(lineItem.value);
		} else if (lineItem.purpose === 'VALUE_VARIABLE' && lineItem.basisPoints !== undefined) {
			feeFromLineItems += valueIn * BigInt(lineItem.basisPoints) / 10000n;
		}
	}

	let feeTotal = feeFromLineItems;
	if (fees.total !== undefined && fees.total !== '') {
		feeTotal = BigInt(fees.total);
	}

	return(feeTotal);
}

function estimateValueOutFromPersistentForwardingFees(valueIn: bigint, fees?: PersistentAddressAssetFeeBreakdown): bigint {
	if (!fees) {
		return(valueIn);
	}

	const valueOut = valueIn - computeFeeTotalFromBreakdown(valueIn, fees);
	return(valueOut < 1n ? 1n : valueOut);
}

/** @internal Exported for unit tests. */
export function estimateForwardingValueOut(valueIn: bigint, fees?: PersistentAddressAssetFeeBreakdown): bigint {
	return(estimateValueOutFromPersistentForwardingFees(valueIn, fees));
}

export type AnchorChainingFeeLineItemSource =
	| 'persistentAddress'
	| 'simulatedTransfer'
	| 'transferInstruction'
	| 'fxQuote'
	| 'fxEstimate';

export type AnchorChainingFeeLineItemMetadata = {
	stepIndex: number;
	step: Exclude<ChainStepResolution, { type: 'keetaSend' }>;
	source: AnchorChainingFeeLineItemSource;
};

export type AnchorChainingFeeLineItem = {
	purpose: AssetFeeLineItemType;
	asset: MovableAssetSearchCanonical;
	value?: string;
	basisPoints?: number;
	details?: ClientRenderableContent;
	metadata: AnchorChainingFeeLineItemMetadata;
};

/** Combined fee breakdown for a computed chaining plan. Does not include a total. */
export type AnchorChainingPlanFeeBreakdown = {
	lineItems: AnchorChainingFeeLineItem[];
};

/** List combined fees for a computed chaining plan. Keeta-send steps are omitted (treated as zero). */
export function listChainingPlanFees(plan: { plan: AnchorChainingPathComputedPlan }): AnchorChainingPlanFeeBreakdown {
	const lineItems: AnchorChainingFeeLineItem[] = [];

	const defaultFeeAsset = (step: Exclude<ChainStepResolution, { type: 'keetaSend' }>): MovableAssetSearchCanonical => {
		if (step.type === 'fx') {
			const token = step.result.isQuote ? step.result.quote.cost.token : step.result.estimate.expectedCost.token;
			return(token.publicKeyString.get());
		}

		if (KeetaNet.lib.Account.isInstance(step.step.from.asset)) {
			return(step.step.from.asset.publicKeyString.get());
		}

		return(step.step.from.asset);
	};

	for (let stepIndex = 0; stepIndex < plan.plan.steps.length; stepIndex++) {
		const step = plan.plan.steps[stepIndex];
		if (!step || step.type === 'keetaSend') {
			continue;
		}

		const appendBreakdown = (
			breakdown: { lineItems: readonly (ResolvedFeeLineItem | UnresolvedFeeLineItem)[]; total?: string },
			source: AnchorChainingFeeLineItemSource
		) => {
			const stepDefaultAsset = defaultFeeAsset(step);
			const metadata = { stepIndex, step, source };
			const startLength = lineItems.length;

			for (const item of breakdown.lineItems) {
				const asset = item.asset ?? stepDefaultAsset;
				const base = {
					purpose: item.purpose,
					asset,
					metadata,
					...(item.details !== undefined ? { details: item.details } : {})
				};

				if ('value' in item && item.value !== undefined && item.value !== '') {
					lineItems.push({
						...base,
						value: item.value,
						...(item.purpose === 'VALUE_VARIABLE' && 'basisPoints' in item && item.basisPoints !== undefined ? { basisPoints: item.basisPoints } : {})
					});
					continue;
				}

				if (item.purpose === 'VALUE_VARIABLE' && 'basisPoints' in item && item.basisPoints !== undefined) {
					lineItems.push({
						...base,
						basisPoints: item.basisPoints,
						value: (step.valueIn * BigInt(item.basisPoints) / 10000n).toString()
					});
				}
			}

			if (breakdown.total !== undefined && breakdown.total !== '') {
				const authoritativeTotal = computeFeeTotalFromBreakdown(step.valueIn, breakdown);
				let lineItemSum = 0n;

				for (let i = startLength; i < lineItems.length; i++) {
					const emitted = lineItems[i];
					if (emitted?.value !== undefined && emitted.value !== '') {
						lineItemSum += BigInt(emitted.value);
					}
				}

				if (authoritativeTotal > lineItemSum) {
					lineItems.push({
						purpose: 'OTHER',
						asset: stepDefaultAsset,
						value: (authoritativeTotal - lineItemSum).toString(),
						metadata
					});
				} else if (authoritativeTotal < lineItemSum) {
					lineItems.splice(startLength);
					lineItems.push({
						purpose: 'OTHER',
						asset: stepDefaultAsset,
						value: authoritativeTotal.toString(),
						metadata
					});
				}
			}
		};

		const appendAssetFee = (
			assetFee: string | AssetFeeBreakdown | PersistentAddressAssetFeeBreakdown,
			source: AnchorChainingFeeLineItemSource
		) => {
			if (typeof assetFee === 'string') {
				lineItems.push({
					purpose: 'OTHER',
					asset: defaultFeeAsset(step),
					value: assetFee,
					metadata: { stepIndex, step, source }
				});
				return;
			}

			appendBreakdown(assetFee, source);
		};

		if (step.type === 'fx') {
			if (step.result.isQuote) {
				lineItems.push({
					purpose: 'PROVIDER',
					asset: step.result.quote.cost.token.publicKeyString.get(),
					value: step.result.quote.cost.amount.toString(),
					metadata: { stepIndex, step, source: 'fxQuote' }
				});
			} else {
				lineItems.push({
					purpose: 'PROVIDER',
					asset: step.result.estimate.expectedCost.token.publicKeyString.get(),
					value: step.result.estimate.expectedCost.max.toString(),
					metadata: { stepIndex, step, source: 'fxEstimate' }
				});
			}

			continue;
		}

		if (step.type === 'assetMovement') {
			appendAssetFee(step.usingInstruction.assetFee, 'transferInstruction');
			continue;
		}

		if (step.simulatedTransfer) {
			const simulatedInstruction = step.simulatedTransfer.instructions.find((instr) => instr.type === step.step.from.rail);
			if (simulatedInstruction && 'assetFee' in simulatedInstruction) {
				appendAssetFee(simulatedInstruction.assetFee, 'simulatedTransfer');
				continue;
			}
		}

		if (step.persistentAddress.fees) {
			appendBreakdown(step.persistentAddress.fees, 'persistentAddress');
			continue;
		}

		if (step.valueIn > step.valueOut) {
			lineItems.push({
				purpose: 'OTHER',
				asset: defaultFeeAsset(step),
				value: (step.valueIn - step.valueOut).toString(),
				metadata: { stepIndex, step, source: 'persistentAddress' }
			});
		}
	}

	return({ lineItems });
}

/**
 * Whether a resolved plan is anchor-to-anchor with no user intermediary steps.
 * The user may still fund the initial deposit address once.
 */
export function isForwardingPlan(plan: { plan: AnchorChainingPathComputedPlan }): boolean {
	const steps = plan.plan.steps;

	if (steps.length === 0) {
		return(false);
	}

	return(steps.every((step) => step.type === 'forwarded'));
}

/** Deposit address for the first forwarding leg of a forwarding-only plan. */
export function getForwardingDepositAddress(plan: { plan: AnchorChainingPathComputedPlan }): string | null {
	const firstStep = plan.plan.steps[0];

	if (!firstStep || firstStep.type !== 'forwarded') {
		return(null);
	}

	const address = firstStep.persistentAddress.address;
	return(typeof address === 'string' ? address : null);
}

export class AnchorChainingPath {
	readonly request: AnchorChainingPathInput;
	readonly path: AnchorChainingStepLike[];
	readonly parent: AnchorChaining;

	constructor(input: {
		request: AnchorChainingPathInput;
		path: AnchorChainingStepLike[];
		parent: AnchorChaining;
	}) {
		this.request = input.request;
		this.path = input.path;
		this.parent = input.parent;
	}

	get logger(): Logger | undefined {
		return(this.parent['logger']);
	}

	protected async getAccountLike(action: GetAccountForActionPayload, override?: AccountLike): Promise<InstanceType<typeof KeetaNetLib.Account>> {
		let found: InstanceType<typeof KeetaNetLib.Account> | undefined = undefined;

		if (this.parent['client'].account.isAccount()) {
			found = this.parent['client'].account;
		} else if (this.parent['client'].signer !== null) {
			found = this.parent['client'].signer;
		}

		if (override) {
			if (typeof override === 'function') {
				found = await override(action);
			} else {
				found = override;
			}
		}

		if (!found) {
			throw(new Error(`Could not get account for ${action.type} action ${action.providerMethod}`));
		}

		return(found);
	}

	protected async getAccountsForAction(action: GetAccountForActionPayload, overrides?: AnchorChainingAccountOverrides): Promise<{ account: InstanceType<typeof KeetaNetLib.Account>; signer: InstanceType<typeof KeetaNetLib.Account> }> {
		const [signer, account] = await Promise.all([
			this.getAccountLike(action, overrides?.signer),
			this.getAccountLike(action, overrides?.account)
		]);

		return({ signer, account });
	}

	async getProviderLegalDisclaimers(): Promise<PlanDisclaimers | null> {
		const legalDisclaimerPromises: { key: string; promise: () => Promise<ProviderDisclaimers | null> }[] = [];

		for (const step of this.path) {
			if (step.type === 'keetaSend') {
				continue
			}

			const key = `${step.type}:${step.providerID}`;
			if (legalDisclaimerPromises.find(entry => entry.key === key)) {
				continue
			}

			const promise = async () => {
				try {
					let disclaimers: ProviderDisclaimers['disclaimers'] | null | undefined = null;
					if (step.type === 'assetMovement') {
						const provider = await this.parent.graph.getAssetMovementProviderById(step.providerID);
						disclaimers = provider?.getLegalDisclaimers();
					} else {
						disclaimers = await this.parent.graph.fxClient.getLegalDisclaimersById(step.providerID);
					}

					if (!disclaimers) {
						return(null);
					}

					return({ providerID: step.providerID, disclaimers });
				} catch (error) {
					this.logger?.debug(`AnchorChainingPath::getProviderLegalDisclaimers`, `Error getting provider disclaimers for providerId: ${step.providerID}`, error);
					throw(error)
				}
			}

			legalDisclaimerPromises.push({ key, promise });
		}

		try {
			const disclaimersOrNull = await Promise.all(legalDisclaimerPromises.map((entry) => entry.promise()));
			const disclaimers = disclaimersOrNull.filter((entry) => entry !== null);
			return(disclaimers);
		} catch (error) {
			this.logger?.debug(`AnchorChainingPath::getProviderLegalDisclaimers`, 'Error getting legal disclaimers for path', error);
			return(null);
		}
	}
}

export class AnchorChainingPlan extends AnchorChainingPath {
	#_plan: AnchorChainingPathComputedPlan | null = null;

	#state: AnchorChainingPathState = { status: 'idle' };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	#listeners = new Map<string, Set<((...args: any[]) => void)>>();
	#options: ComputePlanOptions | undefined = undefined;

	private constructor(path: AnchorChainingPath, options?: ComputePlanOptions) {
		super({ ...path });
		this.#options = options;
	}

	get plan(): AnchorChainingPathComputedPlan {
		if (!this.#_plan) {
			throw(new Error(`Steps have not been computed yet`));
		}

		return(this.#_plan);
	}

	listFees(): AnchorChainingPlanFeeBreakdown {
		return(listChainingPlanFees(this));
	}

	async #computePlan() {
		if (this.#_plan) {
			throw(new Error(`Steps have already been computed`));
		}

		const sharedClientOptions = {
			resolver: this.parent['resolver'],
			...(this.parent['logger'] ? { logger: this.parent['logger'] } : {})
		} as const;

		const fxClient = new KeetaFXAnchorClient(this.parent['client'], sharedClientOptions);

		const assetMovementClient = new KeetaAssetMovementAnchorClient(this.parent['client'], sharedClientOptions);

		let affinityAndAmount: { affinity: 'to' | 'from'; amount: bigint } | undefined = undefined;

		if (this.request.source.value !== undefined && this.request.destination.value !== undefined) {
			throw(new Error('Must have source.value or destination.value but not both'));
		} else if (this.request.source.value !== undefined) {
			affinityAndAmount = {
				affinity: 'from',
				amount: this.request.source.value
			}
		} else if (this.request.destination.value !== undefined) {
			affinityAndAmount = {
				affinity: 'to',
				amount: this.request.destination.value
			}
		} else {
			throw(new Error('Must have source.value or destination.value'));
		}

		const { affinity } = affinityAndAmount

		const findInstruction = <R extends AssetTransferInstructions['type']>(allInstructions: AssetTransferInstructions[], type: R): Extract<AssetTransferInstructions, { type: R }> => {
			const found = allInstructions.find((instr): instr is Extract<AssetTransferInstructions, { type: R }> => {
				return(instr.type === type);
			});

			if (!found) {
				throw(new Error(`Expected to find instruction of type ${type} in next step's instructions`));
			}

			return(found);
		};

		/**
		 * Resolve persistent forwarding addresses for path steps whose source rail
		 * cannot accept an initiated transfer.
		 */
		type ForwardedStepInfo = { provider: AssetMovementProvider; persistentAddress: KeetaPersistentForwardingAddressDetails };
		const forwardedSteps = new Map<number, ForwardedStepInfo>();
		const forwardingOnly = this.#options?.forwardingOnly === true;

		const resolvePersistentForwardingForStep = async (scanIndex: number, destinationAddress: string): Promise<void> => {
			const scanStep = this.path[scanIndex];
			if (!scanStep || scanStep.type !== 'assetMovement') {
				throw(new Error(`Expected asset movement step at index ${scanIndex} for persistent forwarding`));
			}

			const forwardedAssetPair = { from: scanStep.from.asset, to: scanStep.to.asset };
			const forwardedProviders = await assetMovementClient.getProvidersForTransfer(
				{ asset: forwardedAssetPair, from: scanStep.from.location, to: scanStep.to.location },
				{ providerIDs: [ scanStep.providerID ] }
			);
			if (!forwardedProviders?.[0] || forwardedProviders.length === 0) {
				throw(new Error(`Could not get asset movement provider ${scanStep.providerID} for persistent-forwarding step at index ${scanIndex}`));
			}

			const forwardedProvider = forwardedProviders[0];
			if (!await forwardedProvider.isOperationSupported('createPersistentForwarding')) {
				throw(new Error(`Asset movement provider ${scanStep.providerID} does not support createPersistentForwarding, but the source rail ${scanStep.from.rail} at ${convertAssetLocationToString(scanStep.from.location)} requires it (initiateTransfer is unsupported)`));
			}
			if (!forwardingOnly && !await forwardedProvider.isOperationSupported('simulateTransfer')) {
				throw(new Error(`Asset movement provider ${scanStep.providerID} does not support simulateTransfer, which is required to compute valueOut for a persistent-forwarding step at ${convertAssetLocationToString(scanStep.from.location)}`));
			}

			const { signer: forwardedSigner } = await this.getAccountsForAction({
				type: 'assetMovement',
				providerMethod: 'initiateTransfer',
				provider: forwardedProvider
			}, this.#options?.overrides);

			let persistentAddress: KeetaPersistentForwardingAddressDetails | undefined;
			if (await forwardedProvider.isOperationSupported('listPersistentForwarding')) {
				try {
					const existing = await forwardedProvider.listForwardingAddresses({
						account: forwardedSigner,
						search: [{
							sourceLocation: scanStep.from.location,
							destinationLocation: scanStep.to.location,
							asset: forwardedAssetPair,
							destinationAddress
						}]
					});

					const sourceLocationString = convertAssetLocationToString(scanStep.from.location);
					const destLocationString = convertAssetLocationToString(scanStep.to.location);
					const match = existing.addresses.find(addr => {
						if (addr.destinationAddress !== destinationAddress) {
							return(false);
						}
						if (!addr.sourceLocation || convertAssetLocationToString(addr.sourceLocation) !== sourceLocationString) {
							return(false);
						}
						if (!addr.destinationLocation || convertAssetLocationToString(addr.destinationLocation) !== destLocationString) {
							return(false);
						}
						if (addr.asset && !doesAssetOrPairMatch(addr.asset, forwardedAssetPair)) {
							return(false);
						}

						return(true);
					});
					if (match) {
						persistentAddress = match;
					}
				} catch (error) {
					this.logger?.debug('AnchorChainingPlan::computePlan', `listForwardingAddresses lookup failed for step ${scanIndex}, will create a new address`, error);
				}
			}

			if (!persistentAddress) {
				persistentAddress = await forwardedProvider.createPersistentForwardingAddress({
					account: forwardedSigner,
					sourceLocation: scanStep.from.location,
					destinationLocation: scanStep.to.location,
					destinationAddress,
					asset: forwardedAssetPair
				});
			}

			if (typeof persistentAddress.address !== 'string') {
				throw(new Error(`Persistent forwarding address for step ${scanIndex} is not a resolved string (got ${typeof persistentAddress.address})`));
			}

			forwardedSteps.set(scanIndex, { provider: forwardedProvider, persistentAddress });
		};

		if (forwardingOnly) {
			for (let scanIndex = this.path.length - 1; scanIndex >= 0; scanIndex--) {
				const scanStep = this.path[scanIndex];
				if (!scanStep || scanStep.type !== 'assetMovement') {
					continue;
				}

				// Accept explicit createPersistentForwarding:true or omitted supportedOperations
				// (implied). Reject partial ops that omit the flag - those imply false.
				const pfrEligible = supportsPersistentForwarding(scanStep.from.supportedOperations, 'implied');
				const sourceIsKeeta = isChainLocation(toAssetLocation(scanStep.from.location), 'keeta');

				if (sourceIsKeeta || !pfrEligible) {
					throw(new Error(`Forwarding-only plan requires persistent forwarding support on every leg, but step ${scanIndex} at ${convertAssetLocationToString(scanStep.from.location)} does not qualify`));
				}

				let destinationAddress: string;
				if (scanIndex === this.path.length - 1) {
					const finalRecipient = this.request.destination.recipient;
					if (typeof finalRecipient !== 'string') {
						throw(new Error(`Forwarding-only plan requires the destination recipient to be a resolved address string`));
					}
					destinationAddress = finalRecipient;
				} else {
					const nextForwarded = forwardedSteps.get(scanIndex + 1);
					if (!nextForwarded) {
						throw(new Error(`Forwarding-only plan expected persistent forwarding to be resolved for next step ${scanIndex + 1}`));
					}
					const nextAddress = nextForwarded.persistentAddress.address;
					if (typeof nextAddress !== 'string') {
						throw(new Error(`Forwarding-only plan requires the next step persistent forwarding address to be a resolved string at index ${scanIndex + 1}`));
					}
					destinationAddress = nextAddress;
				}

				await resolvePersistentForwardingForStep(scanIndex, destinationAddress);
			}
		}

		for (let scanIndex = 0; scanIndex < this.path.length; scanIndex++) {
			if (forwardingOnly) {
				continue;
			}

			const scanStep = this.path[scanIndex];
			if (!scanStep || scanStep.type !== 'assetMovement') {
				continue;
			}

			/**
			 * PFR is selected in two cases:
			 *   (a) the source rail explicitly cannot accept a managed transfer.
			 *   (b) the prior step is also an asset-movement step (AMP -> AMP
			 *       transition) and the source rail supports PFR.
			 *
			 * Persistent forwarding only applies to non-Keeta (external chain)
			 * source rails: the model is that the prior step deposits into a chain
			 * address the bridge observes and auto-forwards. A Keeta-source leg
			 * (KEETA_SEND) is always a user-initiated send -- the prior step routes
			 * its output back to the user, who then sends again -- so it is never
			 * PFR, even when the provider advertises createPersistentForwarding at
			 * the provider level (which its bare KEETA_SEND rails would otherwise
			 * inherit). Treating an on-Keeta swap as PFR skips the required second
			 * send.
			 */
			const priorStep = scanIndex > 0 ? this.path[scanIndex - 1] : null;
			const isAmpToAmpTransition = priorStep?.type === 'assetMovement';
			const pfrSupported = scanStep.from.supportedOperations?.createPersistentForwarding === true;
			const initiateForbidden = scanStep.from.supportedOperations?.initiateTransfer === false;
			const sourceIsKeeta = isChainLocation(toAssetLocation(scanStep.from.location), 'keeta');

			const shouldUsePFR = !sourceIsKeeta && (initiateForbidden || (isAmpToAmpTransition && pfrSupported));
			if (!shouldUsePFR) {
				continue;
			}
			if (!pfrSupported) {
				throw(new Error(`Asset movement provider ${scanStep.providerID} source rail ${scanStep.from.rail} at ${convertAssetLocationToString(scanStep.from.location)} declares initiateTransfer:false but does not support createPersistentForwarding`));
			}

			if (scanIndex !== this.path.length - 1) {
				throw(new Error(`Persistent-forwarding (PersistentForwardingRelay-only) asset movement steps are currently only supported as the last step in a chain (step ${scanIndex} of ${this.path.length})`));
			}

			const destinationAddress = this.request.destination.recipient;
			if (typeof destinationAddress !== 'string') {
				throw(new Error(`Persistent-forwarding step at index ${scanIndex} requires the chain's destination recipient to be a resolved address string`));
			}

			await resolvePersistentForwardingForStep(scanIndex, destinationAddress);
		}

		const stepPromises: Promise<ChainStepResolution>[] = [];
		const resolvingSteps = new Set<number>();
		const precomputedValueOuts = new Map<number, bigint>();
		const resolveStep = async (index: number): Promise<ChainStepResolution> => {
			const step = this.path[index];

			if (!step) {
				throw(new Error(`Step ${index} is not defined`));
			}

			/*
			 * Detect cycles
			 */
			if (resolvingSteps.has(index)) {
				throw(new Error(`Cyclic dependency detected in resolveStep: step ${index} is already being resolved`));
			}

			let promise: Promise<ChainStepResolution> | undefined = stepPromises[index];

			if (!promise) {
				resolvingSteps.add(index);

				promise = (async (): Promise<ChainStepResolution> => {
					if (step.type === 'fx') {
						let amount;

						if (affinity === 'from') {
							if (index === 0) {
								amount = affinityAndAmount.amount;
							} else {
								const previous = await resolveStep(index - 1);
								amount = previous.valueOut;
							}
						} else if (affinity === 'to') {
							if (index === (this.path.length - 1)) {
								// XXX:TODO Move this to destination
								amount = affinityAndAmount.amount;
							} else {
								const next = await resolveStep(index + 1);
								amount = next.valueIn;
							}
						} else {
							assertNever(affinity);
						}

						const fxAccountOptions = await this.getAccountsForAction({
							type: 'fx',
							providerMethod: 'getAccountForAction'
						}, this.#options?.overrides);

						const quotesOrEstimates = await fxClient.getQuotesOrEstimates(
							{ from: step.from.asset, to: step.to.asset, amount, affinity },
							fxAccountOptions,
							{ providerIDs: [ step.providerID ] }
						);

						if (!quotesOrEstimates?.[0] || quotesOrEstimates.length === 0) {
							throw(new Error(`Could not get FX quote/estimate for provider ${step.providerID}`));
						}

						const result = quotesOrEstimates[0];

						if (!result.isQuote && result.estimate.canPerformExchange === false) {
							throw(new Error(`FX estimate from provider ${step.providerID} indicates exchange cannot be performed`));
						}

						const convertedAmount = result.isQuote ? result.quote.convertedAmount : result.estimate.convertedAmount;

						let valueIn;
						let valueOut;

						if (affinity === 'to') {
							valueOut = amount;
							valueIn = convertedAmount;
						} else if (affinity === 'from') {
							valueOut = convertedAmount;
							valueIn = amount;
						} else {
							assertNever(affinity);
						}

						return({ type: 'fx', step, valueIn, valueOut, result });
					} else if (step.type === 'assetMovement') {
						if (affinity === 'to') {
							throw(new Error(`Chaining with affinity 'to' is not currently supported for asset movement steps, as it requires looking up transfer quotes/estimates which is not currently implemented`));
						}

						let depositValue: bigint;
						if (index === 0) {
							depositValue = affinityAndAmount.amount;
						} else {
							const precomputedPrev = precomputedValueOuts.get(index - 1);
							if (precomputedPrev !== undefined) {
								depositValue = precomputedPrev;
							} else {
								const previous = await resolveStep(index - 1);
								depositValue = previous.valueOut;
							}
						}

						const assetPair = { from: step.from.asset, to: step.to.asset };

						/*
						 * Forwarded step: prior step deposits into a pre-resolved persistent address.
						 */
						const forwardedInfo = forwardedSteps.get(index);
						if (forwardedInfo) {
							const { provider: forwardedProvider, persistentAddress } = forwardedInfo;

							let estimatedValueOut = depositValue;
							let simulatedTransfer: Awaited<ReturnType<typeof forwardedProvider.simulateTransfer>> | undefined;
							if (forwardingOnly) {
								estimatedValueOut = estimateValueOutFromPersistentForwardingFees(depositValue, persistentAddress.fees);
							} else if (await forwardedProvider.isOperationSupported('simulateTransfer')) {
								try {
									const { signer: forwardedSigner } = await this.getAccountsForAction({
										type: 'assetMovement',
										providerMethod: 'initiateTransfer',
										provider: forwardedProvider
									}, this.#options?.overrides);
									simulatedTransfer = await forwardedProvider.simulateTransfer({
										account: forwardedSigner,
										asset: assetPair,
										from: { location: step.from.location },
										to: { location: step.to.location },
										value: depositValue
									});

									const simulatedInstruction = simulatedTransfer.instructions.find((instr): instr is Extract<SimulatedAssetTransferInstructions, { type: typeof step.from.rail }> => instr.type === step.from.rail);
									let simulatedTotalReceive: string | undefined;
									if (simulatedInstruction) {
										simulatedTotalReceive = simulatedInstruction.totalReceiveAmount;
										if (simulatedTotalReceive === undefined && 'value' in simulatedInstruction) {
											simulatedTotalReceive = simulatedInstruction.value;
										}
									}
									if (simulatedTotalReceive !== undefined) {
										estimatedValueOut = BigInt(simulatedTotalReceive);
									}
								} catch (error) {
									this.logger?.debug('AnchorChainingPlan::resolveStep', `simulateTransfer for forwarded step ${index} valueOut estimation failed; falling back to depositValue`, error);
								}
							}

							return({
								type: 'forwarded',
								step,
								valueIn: depositValue,
								valueOut: estimatedValueOut,
								persistentAddress,
								provider: forwardedProvider,
								...(simulatedTransfer !== undefined ? { simulatedTransfer } : {})
							});
						}

						if (this.#options?.forwardingOnly) {
							throw(new Error(`Forwarding-only plan requires persistent forwarding for step at index ${index}, but none was resolved`));
						}

						const providers = await assetMovementClient.getProvidersForTransfer(
							{ asset: assetPair, from: step.from.location, to: step.to.location },
							{ providerIDs: [ step.providerID ] }
						);

						if (!providers?.[0] || providers.length === 0) {
							throw(new Error(`Could not get asset movement provider ${step.providerID}`));
						}
						const provider = providers[0];

						const { signer } = await this.getAccountsForAction({
							type: 'assetMovement',
							providerMethod: 'initiateTransfer',
							provider
						}, this.#options?.overrides);

						let resolvedRecipient: RecipientResolved | GenericAccount;
						let sendingToType: SendingToType;

						if (index === this.path.length - 1) {
							resolvedRecipient = this.request.destination.recipient;
							sendingToType = 'FINAL_DESTINATION';
						} else {
							sendingToType = 'NEXT_STEP';

							const nextPathStep = this.path[index + 1];

							if (!nextPathStep) {
								throw(new Error(`Expected next step at index ${index + 1} for asset movement step at index ${index}`));
							}

							/*
							 * Next step is forwarded: recipient is its persistent address,
							 * no need to resolve the next step's instructions.
							 */
							const nextForwardedInfo = forwardedSteps.get(index + 1);
							if (nextForwardedInfo) {
								const pfiAddress = nextForwardedInfo.persistentAddress.address;
								if (typeof pfiAddress !== 'string') {
									throw(new Error(`Persistent forwarding address for next step ${index + 1} is not a resolved string`));
								}

								resolvedRecipient = pfiAddress;
							} else if (nextPathStep.from.location === `chain:keeta:${this.parent['client'].network}`) {
								const { account } = await this.getAccountsForAction({
									type: 'assetMovement',
									providerMethod: 'initiateTransfer'
								}, this.#options?.overrides);

								// Store funds in-transit in the account instead of forwarding directly to provider.
								resolvedRecipient = account;
							} else {
								/**
								 * If the provider does not support simulateTransfer,
								 * we cannot chain to this step.
								 */
								if (!await provider.isOperationSupported('simulateTransfer')) {
									throw(new Error(`Asset movement provider ${step.providerID} does not support simulateTransfer, which is required for chaining at non-keeta intermediate location ${convertAssetLocationToString(nextPathStep.from.location)}`));
								}

								const simulated = await provider.simulateTransfer({
									account: signer,
									asset: assetPair,
									from: { location: step.from.location },
									to: { location: step.to.location },
									value: depositValue
								});

								const simulatedInstruction = simulated.instructions.find((instr): instr is Extract<SimulatedAssetTransferInstructions, { type: typeof step.from.rail }> => instr.type === step.from.rail);
								if (!simulatedInstruction) {
									throw(new Error(`Simulated transfer for step ${index} did not return an instruction matching rail ${step.from.rail}`));
								}

								let simulatedTotalReceive: string | undefined = simulatedInstruction.totalReceiveAmount;
								if (simulatedTotalReceive === undefined && 'value' in simulatedInstruction) {
									simulatedTotalReceive = simulatedInstruction.value;
								}
								if (simulatedTotalReceive === undefined) {
									throw(new Error(`totalReceiveAmount must be defined for simulated transfer when chaining`));
								}

								precomputedValueOuts.set(index, BigInt(simulatedTotalReceive));

								const nextStep = await resolveStep(index + 1);

								if (nextStep.type === 'assetMovement' || nextStep.type === 'keetaSend') {
									if (nextStep.usingInstruction.type !== step.to.rail) {
										throw(new Error(`Next step's usingInstruction type ${nextStep.usingInstruction.type} does not match expected ${step.to.rail} for recipient resolution`));
									}

									const foundInstruction = nextStep.usingInstruction;

									const isFiatPushRailFoundInstruction = (input: AssetTransferInstructions | SimulatedAssetTransferInstructions): input is Extract<AssetTransferInstructions, { type: FiatPushRails; }> => {
										return(isFiatRail(input.type));
									}

									if (foundInstruction.type === 'KEETA_SEND') {
										throw(new Error(`Cannot currently chain from asset movement to KEETA_SEND step, as this implies multiple keeta locations in the path which is not currently supported`));
									} else if (isFiatPushRailFoundInstruction(foundInstruction)) {
										if (foundInstruction.depositMessage) {
											throw(new Error(`Deposit message outbound is not currently supported for chaining`));
										}
										resolvedRecipient = foundInstruction.account;
									} else if (foundInstruction.type === 'EVM_SEND' || foundInstruction.type === 'SOLANA_SEND') {
										resolvedRecipient = foundInstruction.sendToAddress;
									} else {
										throw(new Error(`Unsupported rail for chaining: ${step.to.rail}`));
									}
								} else if (nextStep.type === 'fx') {
									throw(new Error(`Cannot currently chain from asset movement to fx step, as fx step does not have recipient information`));
								} else if (nextStep.type === 'forwarded') {
									throw(new Error(`Internal invariant violation: forwarded step at index ${index + 1} reached simulate-cycle-break path; expected nextForwardedInfo branch to have handled it`));
								} else {
									assertNever(nextStep);
								}
							}
						}

						const recipientString = KeetaNet.lib.Account.isInstance(resolvedRecipient)
							? resolvedRecipient.publicKeyString.get()
							: resolvedRecipient;

						const transfer = await provider.initiateTransfer({
							account: signer,
							asset: assetPair,
							from: { location: step.from.location },
							to: {
								location: step.to.location,
								recipient: recipientString
							},
							value: depositValue
						});

						const usingInstruction = findInstruction(transfer.instructions, step.from.rail);

						let totalReceiveAmount: string | undefined = usingInstruction.totalReceiveAmount;
						if (totalReceiveAmount === undefined && 'value' in usingInstruction) {
							totalReceiveAmount = usingInstruction.value;
						}
						if (totalReceiveAmount === undefined) {
							throw(new Error(`totalReceiveAmount must be defined for chaining`));
						}

						const actualValueOut = BigInt(totalReceiveAmount);

						// If we simulated to break a cycle, the next step's initiateTransfer was
						// keyed off the simulated valueOut; a mismatch here means the next step
						// is now misaligned, so fail at plan-time instead of letting execute() catch it.
						const simulatedValueOut = precomputedValueOuts.get(index);
						if (simulatedValueOut !== undefined && simulatedValueOut !== actualValueOut) {
							throw(new Error(`Simulated valueOut ${simulatedValueOut} for step ${index} does not match actual ${actualValueOut} from initiateTransfer`));
						}

						return({
							type: 'assetMovement',
							step: step,
							valueIn: depositValue,
							usingInstruction: usingInstruction,
							transfer: transfer,
							sendingTo: sendingToType,
							valueOut: actualValueOut,
							provider: provider
						})
					} else if (step.type === 'keetaSend') {
						if (this.path.length !== 1) {
							throw(new Error(`Direct same-location/same-asset send steps must be the only step in the path`));
						}

						if (!KeetaNet.lib.Account.isInstance(step.from.asset) || !KeetaNet.lib.Account.isInstance(step.to.asset)) {
							throw(new Error(`Expected assets to be token accounts for KEETA_SEND rail`));
						}

						if (!step.from.asset.comparePublicKey(step.to.asset)) {
							throw(new Error(`For KEETA_SEND step, from and to asset must be the same account`));
						}

						let keetaRecipientDestination = null;
						if (KeetaNet.lib.Account.isInstance(this.request.destination.recipient)) {
							keetaRecipientDestination = this.request.destination.recipient;
						} else if (typeof this.request.destination.recipient === 'string') {
							try {
								keetaRecipientDestination = KeetaNet.lib.Account.fromPublicKeyString(this.request.destination.recipient);
							} catch {
								/* ignore errors */
							}
						}
						if (!keetaRecipientDestination) {
							throw(new Error(`Expected destination recipient to be a public key string for KEETA_SEND step`));
						}

						return({
							type: 'keetaSend',
							step: null,
							valueIn: affinityAndAmount.amount,
							valueOut: affinityAndAmount.amount,
							usingInstruction: {
								type: 'KEETA_SEND',
								tokenAddress: step.to.asset.publicKeyString.get(),
								sendToAddress: keetaRecipientDestination.publicKeyString.get(),
								totalReceiveAmount: affinityAndAmount.amount.toString(),
								location: `chain:keeta:${this.parent['client'].network}`,
								value: String(affinityAndAmount.amount),
								assetFee: '0'
							}
						})
					} else {
						assertNever(step);
					}
				})();

				promise.then(() => resolvingSteps.delete(index), () => resolvingSteps.delete(index));
				stepPromises[index] = promise;
			}

			return(await promise);
		}

		const steps = [];
		for (let index = 0; index < this.path.length; index++) {
			steps.push(await resolveStep(index));
		}

		// Direct same-location/same-asset send: no provider steps needed.
		if (steps.length === 0) {
			return({
				steps: [],
				totalValueIn: affinityAndAmount.amount,
				totalValueOut: affinityAndAmount.amount
			});
		}

		const firstStep = steps[0];
		const lastStep = steps[steps.length - 1];

		if (!firstStep || !lastStep) {
			throw(new Error(`Steps array is empty`));
		}

		if (affinity === 'from') {
			if (firstStep.valueIn !== this.request.source.value) {
				throw(new Error(`Computed valueIn for first step ${firstStep.valueIn} does not match request source value ${this.request.source.value}`));
			}
		} else if (affinity === 'to') {
			if (lastStep.valueOut !== this.request.destination.value) {
				throw(new Error(`Computed valueOut for last step ${lastStep.valueOut} does not match requested destination value ${this.request.destination.value}`));
			}
		}

		if (lastStep.valueOut <= 0n) {
			throw(new Error(`Computed valueOut for last step must be greater than 0, got ${lastStep.valueOut}`));
		}

		return({
			steps,
			totalValueIn: firstStep.valueIn,
			totalValueOut: lastStep.valueOut
		});
	}

	static async create(path: AnchorChainingPath, options?: ComputePlanOptions): Promise<AnchorChainingPlan> {
		const instance = new this(path, options);
		instance.#_plan = await instance.#computePlan();
		return(instance);
	}

	get state(): AnchorChainingPathState {
		return(this.#state);
	}

	on<E extends keyof AnchorChainingPathEventMap>(event: E, listener: (...args: AnchorChainingPathEventMap[E]) => void): void {
		let listenerSet = this.#listeners.get(event);
		if (!listenerSet) {
			listenerSet = new Set();
			this.#listeners.set(event, listenerSet);
		}
		listenerSet.add(listener);
	}

	off<E extends keyof AnchorChainingPathEventMap>(event: E, listener: (...args: AnchorChainingPathEventMap[E]) => void): void {
		this.#listeners.get(event)?.delete(listener);
	}

	#setState(state: AnchorChainingPathState): void {
		this.#state = state;
		this.#emit('stateChange', state);
	}

	get logger(): Logger | undefined {
		return(this.parent['logger']);
	}

	#emit<E extends keyof AnchorChainingPathEventMap>(event: E, ...args: AnchorChainingPathEventMap[E]): { sendCount: number; } {
		let sendCount = 0;

		for (const listener of (this.#listeners.get(event) ?? [])) {
			try {
				listener(...args);
				sendCount++;
			} catch (err) {
				this.logger?.debug(`AnchorChainingPath::emit`, `Error in listener for event '${event}'`, err);
			}
		}

		return({ sendCount });
	}

	async #awaitStepCompletion<
		Type extends StepNeededActionEventPayload['type'],
		Ret extends Parameters<Extract<StepNeededActionEventPayload, { action: { type: Type }}>['markCompleted']>
	>(step: Pick<Extract<StepNeededActionEventPayload, { type: Type }>, 'action' | 'type'>): Promise<Ret> {
		let didComplete = false;

		function assertDidNotComplete() {
			if (didComplete) {
				throw(new Error(`Step was already marked as completed or failed`));
			}

			didComplete = true;
		}

		let resolveFn: undefined | StepNeededActionEventPayload['markCompleted'];
		let rejectFn: undefined | StepNeededActionEventPayload['markFailed'];

		const promise = new Promise<Ret>(function(resolve, reject) {
			resolveFn = (...args: Ret) => {
				assertDidNotComplete();
				resolve(args);
			};

			rejectFn = (error) => {
				assertDidNotComplete();

				let usingErr = error;
				if (!usingErr) {
					usingErr = new Error(`Step marked as failed without error`);
				}

				// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
				reject(usingErr);
			}
		});

		if (!resolveFn || !rejectFn) {
			throw(new Error(`Failed to create step completion promise`));
		}

		// Typescript Cannot infer the correct payload type for the stepNeedsAction event, so we have to assert it here. We ensure type safety by constraining the step parameter to the correct action type, which guarantees that the payload will match the expected structure for that action type.
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const { sendCount } = this.#emit('stepNeedsAction', {
			...step,
			markCompleted: resolveFn,
			markFailed: rejectFn
		} as Extract<StepNeededActionEventPayload, { action: { type: Type }}>);

		if (sendCount === 0) {
			throw(new Error(`No listeners for stepNeedsAction event, but a step (actionType=${step.type}) is awaiting completion`));
		}

		return(await promise);
	}

	async #authorizedSend(options: Pick<AnchorChainingPathExecuteOptions, 'requireSendAuth'> | undefined, sendToAddress: string | GenericAccount, value: bigint, token: TokenAddress | string, external?: string): Promise<string | undefined> {
		if (options?.requireSendAuth) {
			await this.#awaitStepCompletion({
				type: 'keetaSendAuthRequired',
				action: {
					sendToAddress: KeetaNet.lib.Account.toAccount(sendToAddress),
					value,
					token: KeetaNet.lib.Account.toAccount(token).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
					...(external !== undefined ? { external } : {})
				}
			});
		}

		const { account } = await this.getAccountsForAction({ type: 'assetMovement', providerMethod: 'initiateTransfer' }, this.#options?.overrides);
		const published = await this.parent['client'].send(sendToAddress, value, token, external, { account });
		let publishedBlocks;
		if ('blocks' in published) {
			publishedBlocks = published.blocks;
		} else {
			publishedBlocks = published.voteStaple.blocks;
		}

		const sendBlock = publishedBlocks[0];
		if (sendBlock === undefined) {
			return(undefined);
		}

		return(sendBlock.hash.toString());
	}

	/**
	 * Construct the unsigned external envelope for a user-funded KEETA_SEND.
	 */
	static async #buildKeetaSendExternal(provider: AssetMovementProvider, transactionID: string, inputs: readonly AnchorExternalInput[]): Promise<string | undefined> {
		const anchorKey = provider.serviceInfo.account;
		if (anchorKey === undefined) {
			return(undefined);
		}

		const anchor = KeetaNet.lib.Account.fromPublicKeyString(anchorKey);
		const builder = new AnchorExternalBuilder().setAnchor(anchor, { transactionId: transactionID });

		for (const input of inputs) {
			builder.addInput(input.blockHash, input.operationIndex);
		}

		const external = await builder.build();
		return(external);
	}

	async #pollTransferStatus(
		transfer: AssetMovementTransfer,
		context: { stepIndex: number; planStep: ChainStepResolution },
		options?: { intervalMs?: number; timeoutMs?: number; abortSignal?: AbortSignal; }
	): Promise<Awaited<ReturnType<AssetMovementTransfer['getTransferStatus']>>> {
		const intervalMs = options?.intervalMs ?? 2000;
		const timeoutMs  = options?.timeoutMs  ?? 300_000;
		const deadline = Date.now() + timeoutMs;

		while (true) {
			if (options?.abortSignal?.aborted) {
				throw(new Error(`Aborted while waiting for transfer ${transfer.transferID} to complete`));
			}

			const status = await transfer.getTransferStatus();
			this.#emit('transactionObserved', {
				stepIndex: context.stepIndex,
				planStep: context.planStep,
				transaction: status.transaction,
				source: 'getTransferStatus'
			});

			if (status.transaction.status === 'COMPLETE') {
				return(status);
			}
			if (Date.now() >= deadline) {
				throw(new Error(`Timed out waiting for transfer ${transfer.transferID} to complete`));
			}
			await KeetaNet.lib.Utils.Helper.asleep(intervalMs);
		}
	}

	/**
	 * Wait for the forwarded transfer the bridge creates after observing the
	 * prior step's withdraw deposit in the persistent-forwarding address.
	 */
	async #pollForwardedTransaction(
		step: ChainStepResolutionForwarded,
		sourceTransaction: { location: AssetLocationLike; transaction: { id: string }},
		context: { stepIndex: number; planStep: ChainStepResolution },
		options?: { intervalMs?: number; timeoutMs?: number; abortSignal?: AbortSignal; }
	): Promise<KeetaAssetMovementTransaction> {
		const intervalMs = options?.intervalMs ?? 2000;
		const timeoutMs  = options?.timeoutMs  ?? 300_000;
		const deadline = Date.now() + timeoutMs;

		const { provider, persistentAddress } = step;
		const pfiAddress = persistentAddress.address;
		if (typeof pfiAddress !== 'string') {
			throw(new Error(`Persistent forwarding address must be a resolved string`));
		}

		const { account } = await this.getAccountsForAction({
			type: 'assetMovement',
			providerMethod: 'initiateTransfer',
			provider
		}, this.#options?.overrides);

		while (true) {
			if (options?.abortSignal?.aborted) {
				throw(new Error(`Aborted while waiting for forwarded transaction at ${pfiAddress} correlated to source tx ${sourceTransaction.transaction.id}`));
			}

			let transactions: KeetaAssetMovementTransaction[] = [];
			try {
				const response = await provider.listTransactions({
					account,
					persistentAddresses: [{
						location: step.step.from.location,
						persistentAddress: pfiAddress
					}],
					transactions: [ sourceTransaction ]
				});

				transactions = response.transactions;
			} catch (error) {
				this.logger?.debug('AnchorChainingPlan::pollForwardedTransaction', `listTransactions failed for PersistentForwardingRelay address ${pfiAddress}`, error);
			}

			for (const transaction of transactions) {
				this.#emit('transactionObserved', {
					stepIndex: context.stepIndex,
					planStep: context.planStep,
					transaction,
					source: 'listTransactions'
				});
			}

			const candidate = transactions.find(tx => tx.status === 'COMPLETE');
			if (candidate) {
				return(candidate);
			}

			if (Date.now() >= deadline) {
				throw(new Error(`Timed out waiting for persistent-forwarding transaction at ${pfiAddress} correlated to source tx ${sourceTransaction.transaction.id}`));
			}

			await KeetaNet.lib.Utils.Helper.asleep(intervalMs);
		}
	}

	async #pollExchangeStatus(
		exchange: FXExchange,
		options?: { intervalMs?: number; timeoutMs?: number; abortSignal?: AbortSignal; }
	): Promise<Extract<Awaited<ReturnType<FXExchange['getExchangeStatus']>>, { status: 'completed' }>> {
		const intervalMs = options?.intervalMs ?? 2000;
		const timeoutMs  = options?.timeoutMs  ?? 300_000;
		const deadline = Date.now() + timeoutMs;

		while (true) {
			if (options?.abortSignal?.aborted) {
				throw(new Error(`Aborted while waiting for FX exchange ${exchange.exchange.exchangeID} to complete`));
			}

			const status = await exchange.getExchangeStatus();
			if (status.status === 'completed') {
				return(status);
			}
			if (status.status === 'failed') {
				throw(new Error(`FX exchange ${exchange.exchange.exchangeID} failed`));
			}
			if (Date.now() >= deadline) {
				throw(new Error(`Timed out waiting for FX exchange ${exchange.exchange.exchangeID} to complete`));
			}

			await KeetaNet.lib.Utils.Helper.asleep(intervalMs);
		}
	}

	async execute(options?: { requireSendAuth?: boolean; abortSignal?: AbortSignal; }): Promise<AnchorChainingPathExecuteResult> {
		if (this.#options?.forwardingOnly) {
			throw(new Error('Forwarding-only plans cannot be executed. Use getPlans({ forwardingOnly: true }), which returns AnchorChainingForwardingOnlyPlan, and fund the deposit address externally.'));
		}

		if (this.#state.status !== 'idle') {
			throw(new Error(`Cannot execute: path is already in state "${this.#state.status}"`));
		}

		const executedSteps: ExecutedStep[] = [];
		this.#setState({ status: 'executing', completedSteps: [], currentStepIndex: 0 });

		/*
		 * Actual output value from each completed step, used for equality checking.
		 */
		let prevActualValueOut: bigint | null = null;

		/**
		 * Source-tx anchor for the next forwarded step's poll. Populated only
		 * when the prior step is an asset-movement transfer that produced a
		 * withdraw transaction on its destination chain; reset for any step
		 * type that cannot deposit into a persistent-forwarding address.
		 */
		let prevWithdrawTx: { location: AssetLocationLike; transaction: { id: string }} | null = null;

		/*
		 * On-chain operations this execution has published so far. Deferred
		 * initiations forward these as the external envelope's inputs so the
		 * anchor's signed envelope references the prior steps' operations.
		 */
		const publishedInputs: AnchorExternalInput[] = [];
		let index = 0;
		try {
			for (index = 0; index < this.plan.steps.length; index++) {
				if (options?.abortSignal?.aborted) {
					throw(new Error(`Execution aborted`));
				}

				const onStepCompleted = (step: ExecutedStep) => {
					executedSteps.push(step);
					this.#emit('stepExecuted', step, index);
				}

				this.#setState({ status: 'executing', completedSteps: [...executedSteps], currentStepIndex: index });

				const step = this.plan.steps[index];

				if (!step) {
					throw(new Error(`Step ${index} is not defined`));
				}

				const pollContext = { stepIndex: index, planStep: step };

				// Verify the actual output from the previous step matches the expected
				// input for this step. A mismatch indicates a provider delivered a
				// different amount than was negotiated in computeSteps.
				if (index > 0 && prevActualValueOut !== null) {
					if (prevActualValueOut !== step.valueIn) {
						if (prevActualValueOut < step.valueIn) {
							throw(new Error(`Execution failed at step ${index} due to value mismatch: expected at least ${step.valueIn} but previous step produced ${prevActualValueOut}`));
						} else {
							this.logger?.debug(`AnchorChainingPlan::execute`, `Value mismatch at step ${index} is non-critical since previous step produced more (${prevActualValueOut}) than expected (${step.valueIn}), proceeding with execution`);
						}
					}
				}

				if (step.type === 'fx') {
					const exchange = await step.result.createExchange(undefined, { inputs: [...publishedInputs] });
					const exchangeStatus = await this.#pollExchangeStatus(exchange);

					publishedInputs.push({ blockHash: exchangeStatus.blockhash });

					prevActualValueOut = step.valueOut;
					prevWithdrawTx = null;
					onStepCompleted({ type: 'fx', plan: step, exchange });
				} else if (step.type === 'forwarded') {
					if (!prevWithdrawTx) {
						throw(new Error(`Forwarded step at index ${index} requires the prior step to produce a withdraw transaction on its destination chain`));
					}

					const observed = await this.#pollForwardedTransaction(step, prevWithdrawTx, pollContext, {
						...(options?.abortSignal ? { abortSignal: options.abortSignal } : {})
					});
					prevActualValueOut = BigInt(observed.to.value);
					prevWithdrawTx = null;
					onStepCompleted({ type: 'forwarded', plan: step, observedTransaction: observed });
				} else if (step.type === 'assetMovement' || step.type === 'keetaSend') {
					if (step.usingInstruction.type === 'KEETA_SEND') {
						/*
						 * Prefer the anchor-provided external. When absent,
						 * construct the unsigned correlation envelope locally,
						 * referencing the prior steps' on-chain operations.
						 */
						let external = step.usingInstruction.external;
						if (external === undefined && step.type === 'assetMovement') {
							external = await AnchorChainingPlan.#buildKeetaSendExternal(step.provider, step.transfer.transferID, publishedInputs);
						}

						const sentBlockHash = await this.#authorizedSend(
							options,
							step.usingInstruction.sendToAddress,
							BigInt(step.usingInstruction.value),
							KeetaNet.lib.Account.fromPublicKeyString(step.usingInstruction.tokenAddress).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
							external
						);
						if (sentBlockHash !== undefined) {
							publishedInputs.push({ blockHash: sentBlockHash, operationIndex: 0 });
						}
					} else if (index === 0) {
						if (step.type !== 'assetMovement') {
							throw(new Error(`Unexpected asset movement step at index ${index} for user-initiated transfer`));
						}

						await this.#awaitStepCompletion({
							type: 'assetMovementUserExecutionRequired',
							action: {
								assetMovementTransfer: step.transfer
							}
						});
					} else if (step.usingInstruction.type === 'EVM_SEND') {
						/* For EVM Sends for now we assume the last step sent to this address */
						this.logger?.debug(`AnchorChainingPlan::execute`, `Executing EVM_SEND instruction for step ${index} by sending to address ${step.usingInstruction.sendToAddress} with value ${step.usingInstruction.value} and token ${step.usingInstruction.tokenAddress}`);
					} else {
						throw(new Error(`Unsupported instruction type ${step.usingInstruction.type} for user-initiated transfer at step ${index}`));
					}

					if (step.type === 'assetMovement') {
						const status = await this.#pollTransferStatus(step.transfer, pollContext, {
							...(options?.abortSignal ? { abortSignal: options.abortSignal } : {})
						});
						prevActualValueOut = BigInt(status.transaction.to.value);
						const withdraw = status.transaction.to.transactions.withdraw;
						if (withdraw) {
							prevWithdrawTx = {
								location: step.step.to.location,
								transaction: { id: withdraw.id }
							};
						} else {
							prevWithdrawTx = null;
						}
						onStepCompleted({ type: 'assetMovement', plan: step });
					} else if (step.type === 'keetaSend') {
						/*
						 * Direct Keeta send: optimistically treat as completed since
						 * there is no provider transfer to poll. Cannot feed a forwarded
						 * step because it does not produce a bridge withdraw.
						 */
						prevActualValueOut = step.valueIn;
						prevWithdrawTx = null;
						onStepCompleted({ type: 'keetaSend', plan: step });
					} else {
						assertNever(step);
					}

				} else {
					assertNever(step);
				}
			}

			// Direct same-location/same-asset send: the loop ran zero iterations,
			// so just publish the on-chain transfer directly.
			if (this.path.length === 0) {
				const sendValue = this.request.source.value ?? this.request.destination.value;
				if (!sendValue) {
					throw(new Error(`Direct send requires a value for source or destination`));
				}

				if (!KeetaNet.lib.Account.isInstance(this.request.source.asset)) {
					throw(new Error(`Direct send requires a Keeta token address as the source asset`));
				}
				const recipient = this.request.destination.recipient;
				if (typeof recipient !== 'string') {
					throw(new Error(`Direct Keeta send requires a crypto address as the recipient`));
				}
				await this.#authorizedSend(options, recipient, sendValue, this.request.source.asset);
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.#setState({ status: 'failed', error, completedSteps: [...executedSteps], failedAtStepIndex: index });
			this.#emit('failed', error, [...executedSteps], index);
			throw(error);
		}

		const result: AnchorChainingPathExecuteResult = { steps: executedSteps };
		this.#setState({ status: 'completed', result });
		this.#emit('completed', result);
		return(result);
	}
}

/**
 * Forwarding-only chaining plan for persistent-forwarding routes. Resolves deposit
 * addresses and fee estimates but cannot be executed: the user funds the
 * external deposit address directly.
 */
export class AnchorChainingForwardingOnlyPlan extends AnchorChainingPath {
	readonly #plan: AnchorChainingPathComputedPlan;

	private constructor(path: AnchorChainingPath, plan: AnchorChainingPathComputedPlan) {
		super({ request: path.request, path: path.path, parent: path.parent });
		this.#plan = plan;
	}

	get plan(): AnchorChainingPathComputedPlan {
		return(this.#plan);
	}

	getDepositAddress(): string | null {
		return(getForwardingDepositAddress(this));
	}

	listFees(): AnchorChainingPlanFeeBreakdown {
		return(listChainingPlanFees(this));
	}

	static async create(path: AnchorChainingPath, options?: ComputePlanOptions): Promise<AnchorChainingForwardingOnlyPlan> {
		const computed = await AnchorChainingPlan.create(path, { ...options, forwardingOnly: true });
		if (!isForwardingPlan(computed)) {
			throw(new Error('Computed plan does not qualify as a forwarding-only route'));
		}

		return(new AnchorChainingForwardingOnlyPlan(path, computed.plan));
	}
}

type AnchorChainingFullPlanResult = (({ success: true; plan: AnchorChainingPlan; } | { success: false; error: unknown; }) & { path: AnchorChainingPath; });
type AnchorChainingFullForwardingOnlyPlanResult = (({ success: true; plan: AnchorChainingForwardingOnlyPlan; } | { success: false; error: unknown; }) & { path: AnchorChainingPath; });

export class AnchorChaining {
	private client: KeetaNet.UserClient;
	private resolver: Resolver;
	readonly graph: AnchorGraph;
	private logger?: Logger;

	constructor(config: AnchorChainingConfig) {
		this.client = config.client;
		if (config.resolver) {
			this.resolver = config.resolver;
		} else {
			this.resolver = getDefaultResolver(config.client);
		}
		this.graph = new AnchorGraph({ resolver: this.resolver, client: this.client, logger: config.logger });
		if (config.logger !== undefined) {
			this.logger = config.logger;
		}
	}

	async getPaths(input: AnchorChainingPathInput, options?: GetPathsOptions): Promise<AnchorChainingPath[] | null> {
		const forwardingOpts = normalizeForwardingOnlyOptions(options?.forwardingOnly);
		if (forwardingOpts && (forwardingOpts.maxLegs ?? DEFAULT_FORWARDING_MAX_LEGS) < 1) {
			return(null);
		}

		// Direct send: same Keeta location, same asset, same rail no providers needed.
		const sourceLocation = toAssetLocation(input.source.location);
		const destinationLocation = toAssetLocation(input.destination.location);

		let foundPaths: AnchorChainingStepLike[][] | null = null;

		if (
			input.source.rail === 'KEETA_SEND' &&
			input.destination.rail === 'KEETA_SEND' &&
			convertAssetLocationToString(sourceLocation) === convertAssetLocationToString(destinationLocation) &&
			isChainLocation(sourceLocation, 'keeta') &&
			isChainLocation(destinationLocation, 'keeta') &&
			isAnchorChainingAssetEqual(input.source.asset, input.destination.asset)
		) {
			// Direct Keeta sends are never forwarding routes.
			if (forwardingOpts) {
				return(null);
			}

			const fromTo = {
				asset: input.source.asset,
				location: sourceLocation,
				rail: 'KEETA_SEND'
			} as const;

			foundPaths = [
				[{ type: 'keetaSend', from: fromTo, to: fromTo }]
			];
		} else {
			foundPaths = await this.graph.findPaths(input, options);
		}

		// Filter out paths with non-chain steps in intermediate positions
		foundPaths = foundPaths?.filter(path => {
			for (let i = 0; i < path.length - 1; i++) {
				const item = path[i];
				if (!item) {
					continue;
				}

				const toLocation = toAssetLocation(item.to.location);
				if (toLocation.type !== 'chain' && i < path.length - 1) {
					return(false);
				}
			}

			return(true);
		});

		if (foundPaths.length === 0) {
			return(null);
		}

		const retval: AnchorChainingPath[] = [];

		for (const path of foundPaths) {
			retval.push(new AnchorChainingPath({ request: input, path, parent: this }));
		}

		if (forwardingOpts) {
			const forwardingPaths = retval.filter((path) => isForwardingPath(path, forwardingOpts));
			return(forwardingPaths.length === 0 ? null : forwardingPaths);
		}

		return(retval);
	}

	async getPlans(input: AnchorChainingPathInput, options: GetPlansOptions & { includeAllOutput: true; forwardingOnly: true | ForwardingOnlyOptions }): Promise<AnchorChainingFullForwardingOnlyPlanResult[] | null>;
	async getPlans(input: AnchorChainingPathInput, options: GetPlansOptions & { includeAllOutput: true; forwardingOnly?: false; }): Promise<AnchorChainingFullPlanResult[] | null>;
	async getPlans(input: AnchorChainingPathInput, options: GetPlansOptions & { includeAllOutput?: false; forwardingOnly: true | ForwardingOnlyOptions }): Promise<AnchorChainingForwardingOnlyPlan[] | null>;
	async getPlans(input: AnchorChainingPathInput, options?: GetPlansOptions): Promise<AnchorChainingPlan[] | null>;
	async getPlans(input: AnchorChainingPathInput, options?: GetPlansOptions): Promise<(AnchorChainingPlan | AnchorChainingForwardingOnlyPlan | AnchorChainingFullPlanResult | AnchorChainingFullForwardingOnlyPlanResult)[] | null> {
		const forwardingOpts = normalizeForwardingOnlyOptions(options?.forwardingOnly);
		const paths = await this.getPaths(input, options?.forwardingOnly ? { forwardingOnly: options.forwardingOnly } : undefined);

		if (!paths) {
			return(null);
		}

		const limit = options?.limit ?? 3;

		const sortedPaths = paths.sort((a, b) => a.path.length - b.path.length);

		let successCount = 0;
		let lowestStepsSuccessCount = Infinity;
		let lastAttemptedPathIdx = -1;

		const maxAttemptLoops = 3;
		let currentAttemptLoop = 0;

		const allOutput: PromiseSettledResult<AnchorChainingPlan | AnchorChainingForwardingOnlyPlan>[] = [];

		while (successCount < limit && lastAttemptedPathIdx < sortedPaths.length - 1 && currentAttemptLoop < maxAttemptLoops) {
			currentAttemptLoop++;

			const pathsToTry = sortedPaths.slice(lastAttemptedPathIdx + 1, lastAttemptedPathIdx + 1 + (limit - successCount));

			if (pathsToTry.length === 0 || !pathsToTry[0]) {
				break;
			}

			if (pathsToTry[0].path.length > lowestStepsSuccessCount) {
				break;
			}

			const currentTry = await Promise.allSettled(pathsToTry.map(async function(path) {
				const computeOptions = toComputePlanOptions(options, forwardingOpts);
				if (forwardingOpts) {
					return(await AnchorChainingForwardingOnlyPlan.create(path, computeOptions));
				}

				return(await AnchorChainingPlan.create(path, computeOptions));
			}));

			allOutput.push(...currentTry);

			for (let i = 0; i < currentTry.length; i++) {
				const result = currentTry[i];
				const path = pathsToTry[i];

				if (!result || !path) {
					continue;
				}

				if (result.status === 'fulfilled') {
					const qualifies = !forwardingOpts || isForwardingPlan(result.value);
					if (qualifies) {
						successCount++;
						if (path && path.path.length < lowestStepsSuccessCount) {
							lowestStepsSuccessCount = path.path.length;
						}
					}
				}
			}

			lastAttemptedPathIdx += pathsToTry.length;
		}

		const ret: (AnchorChainingPlan | AnchorChainingForwardingOnlyPlan | AnchorChainingFullPlanResult | AnchorChainingFullForwardingOnlyPlanResult)[] = [];

		for (let i = 0; i < allOutput.length; i++) {
			const path = sortedPaths[i];
			const plan = allOutput[i];

			if (!path || !plan) {
				continue;
			}

			if (options?.includeAllOutput) {
				if (plan.status === 'rejected') {
					ret.push({ success: false, error: plan.reason, path });
				} else if (forwardingOpts && !isForwardingPlan(plan.value)) {
					ret.push({ success: false, error: new Error('Plan does not qualify as a forwarding-only route'), path });
				} else if (plan.value instanceof AnchorChainingForwardingOnlyPlan) {
					ret.push({ success: true, plan: plan.value, path });
				} else if (plan.value instanceof AnchorChainingPlan) {
					ret.push({ success: true, plan: plan.value, path });
				}
			} else {
				if (plan.status === 'rejected') {
					this.logger?.debug(`AnchorChaining::getPlans`, `Error computing plan for a path:`, plan.reason);
				} else if (forwardingOpts && !isForwardingPlan(plan.value)) {
					this.logger?.debug(`AnchorChaining::getPlans`, `Skipping plan that does not qualify as forwarding-only`);
				} else {
					ret.push(plan.value);
				}
			}
		}

		if (forwardingOpts && !options?.includeAllOutput && ret.length === 0) {
			return(null);
		}

		return(ret);
	}
}
