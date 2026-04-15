import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { KeetaNet } from "../client/index.js";
import type { AssetLocationLike, AssetTransferInstructions, AssetWithRails, FiatRails, MovableAssetSearchCanonical, Rail, RailOrRailWithExtendedDetails, RecipientResolved } from "../services/asset-movement/common.js";
import { convertAssetLocationToString, convertAssetSearchInputToCanonical } from "../services/asset-movement/common.js";
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
import type { ExternalChainAsset } from './asset.js';
import { isExternalChainAsset } from './asset.js';
import type { Logger } from './log/index.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';

type FXQuoteOrEstimate = NonNullable<Awaited<ReturnType<KeetaFXAnchorClient['getQuotesOrEstimates']>>>[number];
type AssetMovementProvider = NonNullable<Awaited<ReturnType<KeetaAssetMovementAnchorClient['getProvidersForTransfer']>>>[number];
type AssetMovementTransfer = Awaited<ReturnType<AssetMovementProvider['initiateTransfer']>>;
type FXExchange = Awaited<ReturnType<FXQuoteOrEstimate['createExchange']>>;

interface ChainStepResolutionBase<Type extends 'fx' | 'assetMovement'> {
	type: Type;
	valueIn: bigint;
	valueOut: bigint;
	step: Extract<GraphNodeLike, { type: Type }>;
}

export interface ChainStepResolutionFX extends ChainStepResolutionBase<'fx'> {
	type: 'fx';
	result: FXQuoteOrEstimate;
};

type SendingToType = 'SELF' | 'NEXT_STEP' | 'FINAL_DESTINATION';;

export interface ChainStepResolutionAssetMovement extends ChainStepResolutionBase<'assetMovement'> {
	usingInstruction: AssetTransferInstructions;
	sendingTo: SendingToType;
	transfer: AssetMovementTransfer;
};

export type ChainStepResolution = ChainStepResolutionFX | ChainStepResolutionAssetMovement;

export type AnchorChainingPathComputedPlan = {
	steps: ChainStepResolution[];
	totalValueIn: bigint;
	totalValueOut: bigint;
};

export type ExecutedStepFX = {
	type: 'fx';
	plan: ChainStepResolutionFX;
	exchange: FXExchange;
};

export type ExecutedStepAssetMovement = {
	type: 'assetMovement';
	plan: ChainStepResolutionAssetMovement;
};

export type ExecutedStep = ExecutedStepFX | ExecutedStepAssetMovement;

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

export type AnchorChainingPathEventMap = {
	stateChange: [state: AnchorChainingPathState];
	stepExecuted: [step: ExecutedStep, index: number];
	completed: [result: AnchorChainingPathExecuteResult];
	failed: [error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number];
	stepNeedsAction: [StepNeededActionEventPayload];
};

interface AnchorChainingAssetAndLocation<AssetType extends AnchorChainingAsset = AnchorChainingAsset> {
	asset: AssetType;
	location: AssetLocationLike;
	rail: Rail;
}

interface AnchorChainingLocationWithValue extends AnchorChainingAssetAndLocation {
	value: bigint;
}

interface AnchorChainingDestination extends AnchorChainingAssetAndLocation {
	recipient: RecipientResolved;
}

interface AnchorChainingPathInput {
	source: AnchorChainingLocationWithValue;
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

export type AnchorChainingAsset = TokenAddress | ISOCurrencyCode | ExternalChainAsset;

function isAnchorChainingAssetEqual(a: AnchorChainingAsset, b: AnchorChainingAsset): boolean {
	if (typeof a === 'string' && typeof b === 'string') {
		return(a === b);
	} else if (KeetaNet.lib.Account.isInstance(a) && KeetaNet.lib.Account.isInstance(b)) {
		return(a.publicKeyString.get() === b.publicKeyString.get());
	} else {
		return(false);
	}
}

function nodeSideSupports(side: AnchorChainingAssetAndLocation, required: AnchorChainingAssetAndLocation): boolean {
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
function isFXLikeNode(node: GraphNodeLike): boolean {
	if (node.type === 'fx') {
		return(true);
	}
	const fromStr = convertAssetLocationToString(node.from.location);
	const toStr = convertAssetLocationToString(node.to.location);
	return(fromStr === toStr && fromStr.startsWith('chain:keeta:'));
}

interface AssetMovementResolvedRails {
	common: Rail[];
	inbound: Rail[];
	outbound: Rail[];
}

type AnchorChainingListAssetsSideFilter = {
	location?: AssetLocationLike;
	asset?: AnchorChainingAsset;
	rail?: Rail;
};

type AnchorChainingListAssetsShared = {
	maxStepCount?: number;
	onlyAllowFXLike?: boolean;
};

export type AnchorChainingListAssetsFilter =
	| ({ from: AnchorChainingListAssetsSideFilter; to?: never } & AnchorChainingListAssetsShared)
	| ({ to: AnchorChainingListAssetsSideFilter; from?: never } & AnchorChainingListAssetsShared)
	| ({ from?: never; to?: never } & AnchorChainingListAssetsShared);

export interface AnchorChainingAssetInfo {
	asset: AnchorChainingAsset;
	location: AssetLocationLike;
	rails: {
		inbound: Rail[];
		outbound: Rail[];
	};
}

type GetAccountForActionPayload = {
	type: 'assetMovement';
	providerMethod: 'initiateTransfer';
	provider: AssetMovementProvider;
}

interface AnchorChainingAccountOverrides {
	account?: Account | undefined | ((providerMethodPayload: GetAccountForActionPayload) => Promise<Account> | Account);
}

export class AnchorGraph {
	client: KeetaNet.UserClient;
	resolver: Resolver;
	logger?: Logger | undefined;
	#assetNameCache = new Map<MovableAssetSearchCanonical, ISOCurrencyCode | TokenAddress | ExternalChainAsset>();

	constructor(args: { client: KeetaNet.UserClient; resolver: Resolver; logger?: Logger | undefined; }) {
		this.resolver = args.resolver;
		this.client = args.client;
		this.logger = args.logger;
	}

	async #computeFXNodes() {
		const fxServices = await this.resolver.lookup('fx', {});

		if (!fxServices) {
			return([]);
		}

		const networkLocation = `chain:keeta:${this.client.network}` satisfies AssetLocationLike;

		const providerLookupResult = await Promise.all(Object.entries(fxServices).map(async ([ providerID, service ]) => {
			const fromEntries = await service.from('array');

			if (!fromEntries) {
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
		}));

		return(providerLookupResult.flat().filter((node): node is GraphNodeLike => !!node));
	}

	async #resolveAssetName(name: MovableAssetSearchCanonical): Promise<ISOCurrencyCode | TokenAddress | ExternalChainAsset> {
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

	async #computeAssetRails(assetInput: ToValuizable<RailOrRailWithExtendedDetails>): Promise<{ rail: Rail }> {
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

		return({ rail: railResolved });
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
				return((await this.#computeAssetRails(commonInput)).rail);
			}) ?? []),
			inbound: await Promise.all((await railsResolved.inbound?.('array'))?.map(async (commonInput) => {
				return((await this.#computeAssetRails(commonInput)).rail);
			}) ?? []),
			outbound: await Promise.all((await railsResolved.outbound?.('array'))?.map(async (commonInput) => {
				return((await this.#computeAssetRails(commonInput)).rail);
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

					const pathNodes: GraphNodeLike[] = [];
					for (const [ src, dest ] of [
						[ fromResolved, toResolved ],
						[ toResolved, fromResolved ]
					] as const) {
						for (const inboundRail of [ ...(src.rails.common ?? []), ...(src.rails.inbound ?? []) ]) {
							for (const outboundRail of [ ...(dest.rails.common ?? []), ...(dest.rails.outbound ?? []) ]) {
								pathNodes.push({
									type: 'assetMovement',
									providerID: providerID,
									from: { asset: src.id, location: src.location, rail: inboundRail },
									to: { asset: dest.id, location: dest.location, rail: outboundRail }
								});
							}
						}

					}

					return(pathNodes);
				}));

				const allPaths = [];

				for (const resolved of pathPromises) {
					if (resolved.status === 'rejected') {
						this.logger?.debug('AnchorGraph::computeAssetMovementNodes', `error fetching nodes for ... TODO`, resolved.reason);
					} else {
						allPaths.push(...resolved.value);
					}
				}

				return(allPaths);
			}));

			return(pathNodesResult.flat());
		}));

		return(providerResults.flat().filter((node): node is GraphNodeLike => !!node));
	}

	async computeGraphNodes(): Promise<GraphNodeLike[]> {
		const receivedNodes = await Promise.all([
			this.#computeFXNodes(),
			this.#computeAssetMovementNodes()
		]);

		return(receivedNodes.flat());
	}

	async findPaths(input: AnchorChainingPathInput): Promise<GraphNodeLike[][]> {
		const graph = await this.computeGraphNodes();

		const nodesWithNext: { node: GraphNodeLike, next: number[] }[] = graph.map(function(node) {
			return({ node, next: [] });
		});

		for (const node of nodesWithNext) {
			for (let secondNodeIdx = 0; secondNodeIdx < nodesWithNext.length; secondNodeIdx++) {
				const nodeJ = nodesWithNext[secondNodeIdx];
				if (!nodeJ) {
					continue;
				}

				// We can ignore chaining one fx anchor to itself
				if (node.node.type === 'fx') {
					if (node.node.type === nodeJ.node.type && node.node.providerID === nodeJ.node.providerID) {
						continue;
					}
				}

				if (nodeSideSupports(node.node.to, nodeJ.node.from)) {
					node.next.push(secondNodeIdx);
				}
			}
		}

		const paths: GraphNodeLike[][] = [];

		function getAssetLocationString(input: GraphNodeLike['to']) {
			return(`${convertAssetSearchInputToCanonical(input.asset)}@${convertAssetLocationToString(input.location)}`)
		}

		function dfs(
			currentIndex: number,
			target: AnchorChainingAssetAndLocation,
			visitedAssets = new Set<string>(),
			path: GraphNodeLike[] = []
		) {
			const cur = nodesWithNext[currentIndex];

			if (!cur) {
				throw(new Error(`Invalid node index: ${currentIndex}`));
			}

			const assetLocationStr = getAssetLocationString(cur.node.from);
			if (visitedAssets.has(assetLocationStr)) {
				return;
			}

			visitedAssets.add(assetLocationStr);

			const newPath = [ ...path, cur.node ];

			if (nodeSideSupports(cur.node.to, target)) {
				paths.push(newPath);
			}

			for (const nextIndex of nodesWithNext[currentIndex]?.next ?? []) {
				dfs(nextIndex, target, visitedAssets, newPath);
			}

			visitedAssets.delete(assetLocationStr);
		}

		for (let index = 0; index < nodesWithNext.length; index++) {
			const node = nodesWithNext[index];

			if (!node) {
				continue;
			}

			if (nodeSideSupports(node.node.from, input.source)) {
				dfs(index, input.destination);
			}
		}

		return(paths);
	}

	async listAssets(filter: AnchorChainingListAssetsFilter = {}): Promise<AnchorChainingAssetInfo[]> {
		const { from: fromFilterInput, to: toFilterInput, maxStepCount, onlyAllowFXLike } = filter;

		const keetaNetworkLocation = `chain:keeta:${this.client.network}` satisfies AssetLocationLike;

		// When onlyAllowFXLike, default omitted locations to the Keeta network location
		const fromFilter = (onlyAllowFXLike && fromFilterInput !== undefined && fromFilterInput.location === undefined)
			? { ...fromFilterInput, location: keetaNetworkLocation }
			: fromFilterInput;
		const toFilter = (onlyAllowFXLike && toFilterInput !== undefined && toFilterInput.location === undefined)
			? { ...toFilterInput, location: keetaNetworkLocation }
			: toFilterInput;

		const nodes = await this.computeGraphNodes();

		// Build forward (next) and backward (prev) adjacency in a single pass.
		const nodesWithAdj: { node: GraphNodeLike; next: number[]; prev: number[] }[] = nodes.map(node => ({ node, next: [], prev: [] }));
		for (let i = 0; i < nodesWithAdj.length; i++) {
			for (let j = 0; j < nodesWithAdj.length; j++) {
				const ni = nodesWithAdj[i];
				const nj = nodesWithAdj[j];
				if (!ni || !nj) {
					throw(new Error(`Invalid node index during adjacency construction: ${i} or ${j}`));
				}
				if (ni.node.type === 'fx' && nj.node.type === 'fx' && ni.node.providerID === nj.node.providerID) {
					continue;
				}
				if (nodeSideSupports(ni.node.to, nj.node.from)) {
					ni.next.push(j);
					nj.prev.push(i);
				}
			}
		}

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

		const reachable = new Set<string>();
		const assetLocationKey = (side: { asset: AnchorChainingAsset; location: AssetLocationLike }) => {
			return(`${convertAssetSearchInputToCanonical(side.asset)}@${convertAssetLocationToString(side.location)}`);
		}

		const markReachable = (side: GraphNodeLike['from' | 'to']) => reachable.add(assetLocationKey(side));

		// Unified traversal: 'next'+'to' = forward, 'prev'+'from' = backward.
		const visit = (visited: Set<number>, adjacency: 'next' | 'prev', markSide: 'from' | 'to', nodeIdx: number, depth: number) => {
			if (visited.has(nodeIdx)) {
				return;
			}
			const item = nodesWithAdj[nodeIdx];
			if (!item) {
				throw(new Error(`Invalid node index during traversal: ${nodeIdx}`));
			}
			if (onlyAllowFXLike && !isFXLikeNode(item.node)) {
				return;
			}
			visited.add(nodeIdx);
			markReachable(item.node[markSide]);
			if (maxStepCount === undefined || depth < maxStepCount) {
				for (const neighborIdx of item[adjacency]) {
					visit(visited, adjacency, markSide, neighborIdx, depth + 1);
				}
			}
		};

		const visited = new Set<number>();
		for (let i = 0; i < nodesWithAdj.length; i++) {
			const item = nodesWithAdj[i];
			if (!item) {
				throw(new Error(`Invalid node index: ${i}`));
			}

			if (fromFilter || toFilter) {
				if (fromFilter) {
					if (sideMatchesFilter(item.node.from, fromFilter)) {
						visit(visited, 'next', 'to', i, 1);
					}
				} else if (toFilter) {
					if (sideMatchesFilter(item.node.to, toFilter)) {
						visit(visited, 'prev', 'from', i, 1);
					}
				} else {
					throw(new Error(`Invalid filter state: at least one of fromFilter or toFilter must be defined`));
				}
			} else {
				if (!onlyAllowFXLike || isFXLikeNode(item.node)) {
					markReachable(item.node.from);
					markReachable(item.node.to);
				}
			}
		}

		// Second pass: collect inbound/outbound rails for every reachable (asset, location) pair
		// from ALL graph nodes, not just those on the traversal path.
		const resultMap = new Map<string, AnchorChainingAssetInfo>();
		const getOrCreate = (side: { asset: AnchorChainingAsset; location: AssetLocationLike }): AnchorChainingAssetInfo => {
			const key = assetLocationKey(side);
			let resultObj = resultMap.get(key);
			if (!resultObj) {
				resultObj = { asset: side.asset, location: side.location, rails: { inbound: [], outbound: [] }};
				resultMap.set(key, resultObj);
			}
			return(resultObj);
		};

		for (const { node } of nodesWithAdj) {
			if (onlyAllowFXLike && !isFXLikeNode(node)) {
				continue;
			}
			const toKey = assetLocationKey(node.to);
			const fromKey = assetLocationKey(node.from);
			if (reachable.has(toKey)) {
				const entry = getOrCreate(node.to);
				if (!entry.rails.inbound.includes(node.to.rail)) {
					entry.rails.inbound.push(node.to.rail);
				}
			}
			if (reachable.has(fromKey)) {
				const entry = getOrCreate(node.from);
				if (!entry.rails.outbound.includes(node.from.rail)) {
					entry.rails.outbound.push(node.from.rail);
				}
			}
		}

		// When onlyAllowFXLike, exclude the filter asset from the result set so that
		// "what can USDC be swapped to?" doesn't include USDC itself via a round-trip.
		if (onlyAllowFXLike) {
			if (fromFilter?.asset !== undefined) {
				resultMap.delete(assetLocationKey({ asset: fromFilter.asset, location: fromFilter.location ?? keetaNetworkLocation }));
			}
			if (toFilter?.asset !== undefined) {
				resultMap.delete(assetLocationKey({ asset: toFilter.asset, location: toFilter.location ?? keetaNetworkLocation }));
			}
		}

		return(Array.from(resultMap.values()));
	}
}

interface ComputePlanOptions {
	affinity?: 'from' | 'to';
	receiveAmount?: bigint;

	overrides?: AnchorChainingAccountOverrides;
}

export class AnchorChainingPath {
	readonly request: AnchorChainingPathInput;
	readonly path: GraphNodeLike[];
	readonly parent: AnchorChaining;

	constructor(input: {
		request: AnchorChainingPathInput;
		path: GraphNodeLike[];
		parent: AnchorChaining;
	}) {
		this.request = input.request;
		this.path = input.path;
		this.parent = input.parent;
	}

	protected async getAccountForAction(action: GetAccountForActionPayload, overrides?: AnchorChainingAccountOverrides): Promise<Account | undefined> {
		let found;

		if (this.parent['client'].account.isAccount()) {
			found = this.parent['client'].account;
		} else if (this.parent['client'].signer !== null) {
			found = this.parent['client'].signer;
		}

		if (overrides?.account) {
			if (typeof overrides.account === 'function') {
				found = await overrides.account(action);
			} else {
				found = overrides.account;
			}
		}

		return(found);
	}
}

export class AnchorChainingPlan extends AnchorChainingPath {
	#_plan: AnchorChainingPathComputedPlan | null = null;

	#state: AnchorChainingPathState = { status: 'idle' };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	#listeners = new Map<string, Set<((...args: any[]) => void)>>();

	private constructor(path: AnchorChainingPath) {
		super({ ...path });
	}

	get plan(): AnchorChainingPathComputedPlan {
		if (!this.#_plan) {
			throw(new Error(`Steps have not been computed yet`));
		}

		return(this.#_plan);
	}

	async #computePlan(options?: ComputePlanOptions) {
		if (this.#_plan) {
			throw(new Error(`Steps have already been computed`));
		}

		const sharedClientOptions = {
			resolver: this.parent['resolver'],
			...(this.parent['logger'] ? { logger: this.parent['logger'] } : {})
		} as const;

		const fxClient = new KeetaFXAnchorClient(this.parent['client'], sharedClientOptions);

		const assetMovementClient = new KeetaAssetMovementAnchorClient(this.parent['client'], sharedClientOptions);

		const affinity = options?.affinity ?? 'from';

		const findInstruction = <R extends AssetTransferInstructions['type']>(allInstructions: AssetTransferInstructions[], type: R): Extract<AssetTransferInstructions, { type: R }> => {
			const found = allInstructions.find((instr): instr is Extract<AssetTransferInstructions, { type: R }> => {
				return(instr.type === type);
			});

			if (!found) {
				throw(new Error(`Expected to find instruction of type ${type} in next step's instructions`));
			}

			return(found);
		};

		const stepPromises: Promise<ChainStepResolution>[] = [];
		const resolveStep = async (index: number): Promise<ChainStepResolution> => {
			const step = this.path[index];

			if (!step) {
				throw(new Error(`Step ${index} is not defined`));
			}

			let promise: Promise<ChainStepResolution> | undefined = stepPromises[index];

			if (!promise) {
				promise = (async (): Promise<ChainStepResolution> => {
					if (step.type === 'fx') {
						let amount;

						if (affinity === 'from') {
							if (index === 0) {
								amount = this.request.source.value;
							} else {
								const previous = await resolveStep(index - 1);
								amount = previous.valueOut;
							}
						} else if (affinity === 'to') {
							if (index === (this.path.length - 1)) {
								// XXX:TODO Move this to destination
								amount = this.request.source.value;
							} else {
								const next = await resolveStep(index + 1);
								amount = next.valueIn;
							}
						} else {
							assertNever(affinity);
						}

						const quotesOrEstimates = await fxClient.getQuotesOrEstimates(
							{ from: step.from.asset, to: step.to.asset, amount, affinity },
							undefined,
							{ providerIDs: [ step.providerID ] }
						);

						if (!quotesOrEstimates?.[0] || quotesOrEstimates.length === 0) {
							throw(new Error(`Could not get FX quote/estimate for provider ${step.providerID}`));
						}

						const result = quotesOrEstimates[0];

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
						let recipient;
						let sendingToType: SendingToType;
						if (index === this.path.length - 1) {
							recipient = this.request.destination.recipient;
							sendingToType = 'FINAL_DESTINATION';
						} else {
							const nextPathStep = this.path[index + 1];
							if (nextPathStep?.type === 'fx') {
								throw(new Error(`Cannot currently chain from asset movement to fx step, as fx step does not have recipient information`));
							}

							const nextStep = await resolveStep(index + 1);

							if (nextStep.type === 'assetMovement') {
								if (nextStep.usingInstruction.type !== step.to.rail) {
									throw(new Error(`Next step's usingInstruction type ${nextStep.usingInstruction.type} does not match expected ${step.to.rail} for recipient resolution`));
								}

								const foundInstruction = nextStep.usingInstruction;

								const isFiatRailFoundInstruction = (input: AssetTransferInstructions): input is Extract<AssetTransferInstructions, { type: FiatRails; }> => {
									return(isFiatRail(input.type));
								}

								if (foundInstruction.type === 'KEETA_SEND') {
									if (!KeetaNet.lib.Account.isInstance(step.to.asset)) {
										throw(new Error(`Expected asset to be a token account for KEETA_SEND rail`));
									}

									if (!step.to.asset.comparePublicKey(foundInstruction.tokenAddress)) {
										throw(new Error(`Recipient token account ${foundInstruction.tokenAddress.toString()} does not match expected ${step.to.asset.publicKeyString.get()}`));
									}

									if (foundInstruction.external) {
										throw(new Error(`Expected KEETA_SEND instruction to not have external value`));
									}

									// XXX:TODO assert value here matches

									sendingToType = 'NEXT_STEP';
									recipient = KeetaNet.lib.Account.fromPublicKeyString(foundInstruction.sendToAddress);
								} else if (isFiatRailFoundInstruction(foundInstruction)) {
									if (foundInstruction.depositMessage) {
										throw(new Error(`Deposit message outbound is not currently supported for chaining`));
									}
									sendingToType = 'NEXT_STEP';
									recipient = foundInstruction.account;
								} else {
									throw(new Error(`Unsupported rail for chaining: ${step.to.rail}`));
								}
							} else if (nextStep.type === 'fx') {
								throw(new Error(`Cannot currently chain from asset movement to fx step, as fx step does not have recipient information`));
							} else {
								assertNever(nextStep);
							}
						}

						if (!recipient) {
							throw(new Error(`Recipient must be defined for asset movement step at index ${index}`));
						}

						const assetPair = { from: step.from.asset, to: step.to.asset };

						const providers = await assetMovementClient.getProvidersForTransfer(
							{ asset: assetPair, from: step.from.location, to: step.to.location },
							{ providerIDs: [ step.providerID ] }
						);

						if (!providers?.[0] || providers.length === 0) {
							throw(new Error(`Could not get asset movement provider ${step.providerID}`));
						}

						let depositValue;

						if (affinity === 'to') {
							throw(new Error(`Chaining with affinity 'to' is not currently supported for asset movement steps, as it requires looking up transfer quotes/estimates which is not currently implemented`));
						} else {
							if (index === 0) {
								depositValue = this.request.source.value;
							} else {
								const previous = await resolveStep(index - 1);
								depositValue = previous.valueOut;
							}
						}

						const transfer = await providers[0].initiateTransfer({
							account: await this.getAccountForAction({
								type: 'assetMovement',
								providerMethod: 'initiateTransfer',
								provider: providers[0]
							}, options?.overrides),
							asset: assetPair,
							from: { location: step.from.location },
							to: {
								location: step.to.location,
								recipient: (() => {
									if (KeetaNet.lib.Account.isInstance(recipient)) {
										return(recipient.publicKeyString.get());
									} else {
										return(recipient);
									}
								})()
							},
							value: depositValue
						});

						const usingInstruction = findInstruction(transfer.instructions, step.from.rail);

						if (!usingInstruction.totalReceiveAmount) {
							throw(new Error(`totalReceiveAmount must be defined for chaining`));
						}

						return({
							type: 'assetMovement',
							step,
							valueIn: depositValue,
							usingInstruction: usingInstruction,
							transfer: transfer,
							sendingTo: sendingToType,
							valueOut: BigInt(usingInstruction.totalReceiveAmount)
						})
					} else {
						assertNever(step);
					}
				})();

				stepPromises[index] = promise;
			}

			return(await promise);
		}

		const steps: ChainStepResolution[] = await Promise.all(this.path.map(async function(_, index) {
			return(await resolveStep(index));
		}));

		// Direct same-location/same-asset send: no provider steps needed.
		if (steps.length === 0) {
			return({
				steps: [],
				totalValueIn: this.request.source.value,
				totalValueOut: this.request.source.value
			});
		}

		const firstStep = steps[0];
		const lastStep = steps[steps.length - 1];

		if (!firstStep || !lastStep) {
			throw(new Error(`Steps array is empty`));
		}

		if (firstStep.valueIn !== this.request.source.value) {
			throw(new Error(`Computed valueIn for first step ${firstStep.valueIn} does not match request source value ${this.request.source.value}`));
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
		const instance = new this(path);
		instance.#_plan = await instance.#computePlan(options);
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
				reject(error);
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

	async #authorizedSend(options: Pick<AnchorChainingPathExecuteOptions, 'requireSendAuth'> | undefined, sendToAddress: string | GenericAccount, value: bigint, token: TokenAddress | string, external?: string): Promise<void> {
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

		await this.parent['client'].send(sendToAddress, value, token, external);
	}

	async #pollTransferStatus(
		transfer: AssetMovementTransfer,
		options?: { intervalMs?: number; timeoutMs?: number }
	): Promise<Awaited<ReturnType<AssetMovementTransfer['getTransferStatus']>>> {
		const intervalMs = options?.intervalMs ?? 2000;
		const timeoutMs  = options?.timeoutMs  ?? 300_000;
		const deadline = Date.now() + timeoutMs;

		while (true) {
			const status = await transfer.getTransferStatus();
			if (status.transaction.status === 'COMPLETED') {
				return(status);
			}
			if (Date.now() >= deadline) {
				throw(new Error(`Timed out waiting for transfer ${transfer.transferId} to complete`));
			}
			await KeetaNet.lib.Utils.Helper.asleep(intervalMs);
		}
	}

	async #pollExchangeStatus(
		exchange: FXExchange,
		options?: { intervalMs?: number; timeoutMs?: number }
	): Promise<Awaited<ReturnType<FXExchange['getExchangeStatus']>>> {
		const intervalMs = options?.intervalMs ?? 2000;
		const timeoutMs  = options?.timeoutMs  ?? 300_000;
		const deadline = Date.now() + timeoutMs;

		while (true) {
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

	async execute(options?: { requireSendAuth?: boolean }): Promise<AnchorChainingPathExecuteResult> {
		if (this.#state.status !== 'idle') {
			throw(new Error(`Cannot execute: path is already in state "${this.#state.status}"`));
		}

		const executedSteps: ExecutedStep[] = [];
		this.#setState({ status: 'executing', completedSteps: [], currentStepIndex: 0 });

		// Actual output value from each completed step, used for equality checking.
		let prevActualValueOut: bigint | null = null;

		let index = 0;
		try {
			let prev = null;
			for (index = 0; index < this.plan.steps.length; index++) {
				const onStepCompleted = (step: ExecutedStep) => {
					executedSteps.push(step);
					this.#emit('stepExecuted', step, index);
				}

				this.#setState({ status: 'executing', completedSteps: [...executedSteps], currentStepIndex: index });

				const step = this.plan.steps[index];

				if (!step) {
					throw(new Error(`Step ${index} is not defined`));
				}

				// Verify the actual output from the previous step matches the expected
				// input for this step. A mismatch indicates a provider delivered a
				// different amount than was negotiated in computeSteps.
				if (index > 0 && prevActualValueOut !== null) {
					if (prevActualValueOut !== step.valueIn) {
						throw(new Error(
							`Value mismatch at step ${index}: ` +
							`expected ${step.valueIn} but previous step produced ${prevActualValueOut}`
						));
					}
				}

				if (step.type === 'fx') {
					const exchange = await step.result.createExchange();
					await this.#pollExchangeStatus(exchange);
					prevActualValueOut = step.valueOut;
					onStepCompleted({ type: 'fx', plan: step, exchange });
				} else if (step.type === 'assetMovement') {
					let userInitiatedTransferRequired;
					if (prev && prev.type === 'assetMovement') {
						if (prev.sendingTo === 'NEXT_STEP') {
							userInitiatedTransferRequired = false;
						} else if (prev.sendingTo === 'FINAL_DESTINATION') {
							throw(new Error(`Invalid path: step ${index - 1} is sending to final destination, but is followed by another step`));
						} else if (prev.sendingTo === 'SELF') {
							userInitiatedTransferRequired = true;
						} else {
							assertNever(prev.sendingTo);
						}
					} else {
						userInitiatedTransferRequired = true;
					}

					if (userInitiatedTransferRequired) {
						if (step.usingInstruction.type === 'KEETA_SEND') {
							await this.#authorizedSend(
								options,
								step.usingInstruction.sendToAddress,
								BigInt(step.usingInstruction.value),
								KeetaNet.lib.Account.fromPublicKeyString(step.usingInstruction.tokenAddress).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
								step.usingInstruction.external
							);
						} else if (index === 0) {
							await this.#awaitStepCompletion({
								type: 'assetMovementUserExecutionRequired',
								action: {
									assetMovementTransfer: step.transfer
								}
							});
						} else {
							throw(new Error(`Unsupported instruction type ${step.usingInstruction.type} for user-initiated transfer at step ${index}`));
						}
					}

					const status = await this.#pollTransferStatus(step.transfer);
					prevActualValueOut = BigInt(status.transaction.to.value);

					onStepCompleted({ type: 'assetMovement', plan: step });
				} else {
					assertNever(step);
				}

				prev = step;
			}

			// Direct same-location/same-asset send: the loop ran zero iterations,
			// so just publish the on-chain transfer directly.
			if (this.path.length === 0) {
				if (!KeetaNet.lib.Account.isInstance(this.request.source.asset)) {
					throw(new Error(`Direct send requires a Keeta token address as the source asset`));
				}
				const recipient = this.request.destination.recipient;
				if (typeof recipient !== 'string') {
					throw(new Error(`Direct Keeta send requires a crypto address as the recipient`));
				}
				await this.#authorizedSend(options, recipient, this.request.source.value, this.request.source.asset);
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

export class AnchorChaining {
	private client: KeetaNet.UserClient;
	private resolver: Resolver;
	private signer: InstanceType<typeof KeetaNetLib.Account> | undefined;
	private account: InstanceType<typeof KeetaNetLib.Account> | undefined;
	readonly graph: AnchorGraph;
	private logger?: Logger;

	constructor(config: AnchorChainingConfig) {
		this.client = config.client;
		if (config.resolver) {
			this.resolver = config.resolver;
		} else {
			this.resolver = getDefaultResolver(config.client);
		}
		this.signer = config.signer ?? config.account ?? config.client.signer ?? config.client.account;
		this.account = config.account ?? config.client.account;
		this.graph = new AnchorGraph({ resolver: this.resolver, client: this.client, logger: config.logger });
		if (config.logger !== undefined) {
			this.logger = config.logger;
		}
	}

	async getPaths(input: AnchorChainingPathInput): Promise<AnchorChainingPath[] | null> {
		// Direct send: same Keeta location, same asset, same rail no providers needed.
		if (
			input.source.rail === 'KEETA_SEND' &&
			input.destination.rail === 'KEETA_SEND' &&
			convertAssetLocationToString(input.source.location) === convertAssetLocationToString(input.destination.location) &&
			convertAssetLocationToString(input.source.location).startsWith('chain:keeta:') &&
			isAnchorChainingAssetEqual(input.source.asset, input.destination.asset)
		) {
			return([new AnchorChainingPath({ request: input, path: [], parent: this })]);
		}

		const foundPaths = await this.graph.findPaths(input);

		if (foundPaths.length === 0) {
			return(null);
		}

		const retval: AnchorChainingPath[] = [];

		for (const path of foundPaths) {
			retval.push(new AnchorChainingPath({ request: input, path, parent: this }));
		}

		return(retval);
	}

	async getPlans(input: AnchorChainingPathInput, options?: ComputePlanOptions): Promise<AnchorChainingPlan[] | null> {
		const paths = await this.getPaths(input);

		if (!paths) {
			return(null);
		}

		const result = await Promise.allSettled(paths.map(async function(path) {
			return(await AnchorChainingPlan.create(path, options));
		}));

		const ret = [];


		for (const plan of result) {
			if (plan.status === 'fulfilled') {
				ret.push(plan.value);
			} else {
				this.logger?.debug(`AnchorChaining::getPlans`, `Error computing plan for a path:`, plan.reason);
			}
		}

		return(ret);
	}
}
