import type {
	AnchorChainingAsset,
	AnchorChainingAssetAndLocation,
	AnchorChainingAssetInfo,
	AnchorChainingAssetInfoWithMetadata,
	AnchorChainingListAssetsFilter,
	AnchorChainingListAssetsSideFilter,
	AnchorChainingPathInput,
	AnchorChainingResolveAssetsFilter,
	AnchorChainingResolveAssetsResult,
	AnchorChainingResolveAssetsWithMetadataResult,
	AnchorChainingWithMetadataOptions,
	AssetMovementProvider,
	AssetMovementResolvedRails,
	GraphNodeLike,
	RailSupportedOperations,
	RailWithSupportedOperations
} from './types.js';
import type {
	AnchorTokenLocationMetadata,
	AssetLocationLike,
	AssetWithRails,
	MovableAssetSearchCanonical,
	RailOrRailWithExtendedDetails
} from '../../services/asset-movement/common.js';
import type { Resolver } from '../index.js';
import type { ISOCurrencyCode } from '@keetanetwork/currency-info';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { ToValuizable } from '../resolver.js';
import type { KeetaAssetMovementAnchorProvider } from '../../services/asset-movement/client.js';
import type { ExternalChainAsset } from '../asset.js';
import type { Logger } from '../log/index.js';
import { Currency } from '@keetanetwork/currency-info';
import { convertAssetLocationToString, convertAssetSearchInputToCanonical } from '../../services/asset-movement/common.js';
import { isAssetLocationLike } from '../../services/asset-movement/lib/location.generated.js';
import { isMovableAssetSearchCanonical, isRail } from '../../services/asset-movement/common.generated.js';
import { isExternalChainAsset } from '../asset.js';
import { isAnchorChainingAssetEqual, isFXLikeNode, nodeSideSupports } from './types.js';
import KeetaFXAnchorClient from '../../services/fx/client.js';
import KeetaAssetMovementAnchorClient from '../../services/asset-movement/client.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';

/**
 * Pure topology over FX and asset-movement anchors. Resolves provider service
 * metadata into a directed graph of {@link GraphNodeLike} edges and exposes
 * path-finding and asset-discovery queries over it. Carries no execution
 * concern: it neither initiates transfers nor sends value.
 */
export class AnchorGraph {
	client: KeetaNet.UserClient;
	resolver: Resolver;
	logger?: Logger | undefined;

	readonly assetMovementClient: KeetaAssetMovementAnchorClient;
	readonly fxClient: KeetaFXAnchorClient;
	readonly #assetMovementProviderCache = new Map<string, AssetMovementProvider | null>();
	readonly #assetNameCache = new Map<MovableAssetSearchCanonical, ISOCurrencyCode | TokenAddress | ExternalChainAsset>();
	#graphNodePromise: Promise<GraphNodeLike[]> | null = null;

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

	#assetLocationKey = (side: { asset: AnchorChainingAsset; location: AssetLocationLike }) => {
		return(`${convertAssetSearchInputToCanonical(side.asset)}@${convertAssetLocationToString(side.location)}`);
	};

	async getAssetMovementProviderById(providerID: string): Promise<AssetMovementProvider | null> {
		let provider: KeetaAssetMovementAnchorProvider | undefined | null = this.#assetMovementProviderCache.get(providerID);
		if (provider === undefined) {
			provider = await this.assetMovementClient.getProviderByID(providerID);
		}

		this.#assetMovementProviderCache.set(providerID, provider);

		return(provider);
	}

	async getAssetMovementProvidersForAsset(asset: AnchorChainingAsset, location: AssetLocationLike): Promise<null | { [providerID: string]: { provider: AssetMovementProvider; }}> {
		let retval: null | { [providerID: string]: { provider: AssetMovementProvider; }} = null;
		for (const node of await this.computeGraphNodes()) {
			if (node.type !== 'assetMovement') {
				continue;
			}

			for (const side of [ node.from, node.to ] as const) {
				if (!isAnchorChainingAssetEqual(side.asset, asset) || convertAssetLocationToString(side.location) !== convertAssetLocationToString(location)) {
					continue;
				}

				if (!retval) {
					retval = {};
				}

				if (!retval[node.providerID]) {
					const provider = await this.getAssetMovementProviderById(node.providerID);
					if (!provider) {
						this.logger?.debug('AnchorGraph::getAssetMovementProvidersForAsset', `No provider found for providerID ${node.providerID}, although provider was previously known to exist in the graph nodes`);
						continue;
					}

					retval[node.providerID] = { provider };
				}
			}
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
									from: {
										asset: src.id,
										location: src.location,
										rail: inboundRail.rail,
										supportedOperations: getProviderSupportedOperationsForRail(inboundRail.supportedOperations)
									},
									to: {
										asset: dest.id,
										location: dest.location,
										rail: outboundRail.rail,
										supportedOperations: getProviderSupportedOperationsForRail(outboundRail.supportedOperations)
									}
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

		function getAssetLocationString(input: GraphNodeLike['to'], includeRail = false) {
			let railStr = '';
			if (includeRail) {
				railStr = `#${input.rail}`;
			}

			return(`${convertAssetSearchInputToCanonical(input.asset)}@${convertAssetLocationToString(input.location)}${railStr}`)
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

			const assetLocationStr = getAssetLocationString(cur.node.from, true);
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

	async resolveAssets(filter: AnchorChainingResolveAssetsFilter = {}): Promise<AnchorChainingResolveAssetsResult> {
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

		// Separate reachable sets and distance maps for backward (from) and forward (to) traversals.
		const fromReachable = new Set<string>();
		const fromDistances = new Map<string, number>();
		const toReachable = new Set<string>();
		const toDistances = new Map<string, number>();

		const makeMarkFn = (reachable: Set<string>, distances: Map<string, number>) =>
			(side: GraphNodeLike['from' | 'to'], depth?: number) => {
				const key = this.#assetLocationKey(side);
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
			startCondition: (item: (typeof nodesWithAdj)[number]) => boolean,
			adjacency: 'next' | 'prev',
			markSide: 'from' | 'to',
			markFn: (side: GraphNodeLike['from' | 'to'], depth: number) => void
		) => {
			const nodeVisited = new Set<number>();
			const queue: { nodeIdx: number; depth: number }[] = [];
			for (let i = 0; i < nodesWithAdj.length; i++) {
				const item = nodesWithAdj[i];
				if (!item) {
					throw(new Error(`Invalid node index during BFS initialization: ${i}`));
				}
				if (startCondition(item) && !nodeVisited.has(i)) {
					nodeVisited.add(i);
					queue.push({ nodeIdx: i, depth: 1 });
				}
			}

			while (queue.length > 0) {
				const queueItem = queue.shift();
				if (!queueItem) {
					throw(new Error(`Unexpected empty queue during BFS processing`));
				}

				const { nodeIdx, depth } = queueItem;
				const item = nodesWithAdj[nodeIdx];
				if (!item) {
					throw(new Error(`Invalid node index during BFS processing: ${nodeIdx}`));
				}
				if (onlyAllowFXLike && !isFXLikeNode(item.node)) {
					continue;
				}

				markFn(item.node[markSide], depth);

				if (maxStepCount === undefined || depth < maxStepCount) {
					for (const neighborIdx of item[adjacency]) {
						if (!nodeVisited.has(neighborIdx)) {
							nodeVisited.add(neighborIdx);
							queue.push({ nodeIdx: neighborIdx, depth: depth + 1 });
						}
					}
				}
			}
		};

		if (fromFilter) {
			bfs(item => sideMatchesFilter(item.node.from, fromFilter), 'next', 'to', markToReachable);
		}
		if (toFilter) {
			bfs(item => sideMatchesFilter(item.node.to, toFilter), 'prev', 'from', markFromReachable);
		}
		if (!fromFilter && !toFilter) {
			for (const { node } of nodesWithAdj) {
				if (!onlyAllowFXLike || isFXLikeNode(node)) {
					markFromReachable(node.from);
					markFromReachable(node.to);
					markToReachable(node.from);
					markToReachable(node.to);
				}
			}
		}

		// Second pass: build result maps by collecting inbound/outbound rails for every reachable
		// (asset, location) pair from ALL graph nodes, not just those on the traversal path.
		const buildResultMap = (
			reachable: Set<string>,
			distances: Map<string, number>
		): Map<string, AnchorChainingAssetInfo> => {
			const resultMap = new Map<string, AnchorChainingAssetInfo>();
			const getOrCreate = (side: { asset: AnchorChainingAsset; location: AssetLocationLike }): AnchorChainingAssetInfo => {
				const key = this.#assetLocationKey(side);
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
			for (const { node } of nodesWithAdj) {
				if (onlyAllowFXLike && !isFXLikeNode(node)) {
					continue;
				}
				if (reachable.has(this.#assetLocationKey(node.to))) {
					const entry = getOrCreate(node.to);
					if (!entry.rails.inbound.includes(node.to.rail)) {
						entry.rails.inbound.push(node.to.rail);
					}
				}
				if (reachable.has(this.#assetLocationKey(node.from))) {
					const entry = getOrCreate(node.from);
					if (!entry.rails.outbound.includes(node.from.rail)) {
						entry.rails.outbound.push(node.from.rail);
					}
				}
			}

			return(resultMap);
		};

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

			const result = found.provider.getAssetMetadataForLocation(location, asset);
			return(result ?? undefined);
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
}
