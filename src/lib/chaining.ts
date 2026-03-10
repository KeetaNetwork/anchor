import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { KeetaNet } from "../client/index.js";
import type { AssetLocationLike, AssetWithRails, ExternalChainAsset, MovableAssetSearchCanonical, Rail, RailOrRailWithExtendedDetails, RecipientResolved } from "../services/asset-movement/common.js";
import { convertAssetLocationToString, convertAssetSearchInputToCanonical, isExternalChainAsset } from "../services/asset-movement/common.js";
import type { Resolver } from "./index.js";
import { getDefaultResolver } from '../config.js';
import type { ISOCurrencyCode } from '@keetanetwork/currency-info';
import { Currency } from '@keetanetwork/currency-info';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { isAssetLocationLike } from '../services/asset-movement/lib/location.generated.js';
import type { ToValuizable } from './resolver.js';
import { isMovableAssetSearchCanonical, isRail } from '../services/asset-movement/common.generated.js';


interface AnchorChainingAssetAndLocation {
	asset: AnchorChainingAsset;
	location: AssetLocationLike;
	rail: Rail;
}

interface AnchorChainingSource extends AnchorChainingAssetAndLocation {
	value: bigint;
}

interface AnchorChainingDestination extends AnchorChainingAssetAndLocation {
	recipient: RecipientResolved;
}

interface AnchorChainingPathInput {
	source: AnchorChainingSource;
	destination: AnchorChainingDestination;
}

export interface AnchorChainingConfig {
	client: KeetaNet.UserClient;
	resolver?: Resolver;
	signer?: InstanceType<typeof KeetaNetLib.Account>;
	account?: InstanceType<typeof KeetaNetLib.Account>;
}

interface GraphNodeLike {
	provider: {
		type: 'fx' | 'assetMovement';
		id: string;
	}

	from: AnchorChainingAssetAndLocation;
	to: AnchorChainingAssetAndLocation;
}


type AnchorChainingAsset = TokenAddress | ISOCurrencyCode | ExternalChainAsset;

interface AssetMovementResolvedRails {
	common: Rail[];
	inbound: Rail[];
	outbound: Rail[];
}

class AnchorGraph {
	client: KeetaNet.UserClient;
	resolver: Resolver;

	constructor(args: { client: KeetaNet.UserClient, resolver: Resolver }) {
		this.resolver = args.resolver;
		this.client = args.client;
	}

	async #computeFXNodes() {
		const fxServices = await this.resolver.lookup('fx', {});

		if (!fxServices) {
			return([]);
		}

		const networkLocation = `chain:keeta:${this.client.network}` satisfies AssetLocationLike;

		const providerLookupResult = await Promise.all(Object.entries(fxServices).map(async ([ providerId, service ]) => {
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
							provider: { type: 'fx', id: providerId },
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
		if (isExternalChainAsset(name)) {
			return(name);
		}
		if (Currency.isCurrencyCode(name)) {
			return(name);
		} else if (Currency.isISOCurrencyNumber(name)) {
			return(new Currency(name).code);
		}

		const found = await this.resolver.lookupToken(name);

		if (found) {
			return(KeetaNet.lib.Account.toAccount(found.token));
		}

		throw(new Error(`Unable to resolve asset name: ${name}`));
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

		const providerResults = await Promise.all(Object.entries(assetMovementServices).map(async ([ providerId, service ]) => {
			const supportedAssetsEntries = await service.supportedAssets('array');

			if (!supportedAssetsEntries) {
				return(null);
			}

			const pathNodesResult = await Promise.all(supportedAssetsEntries.map(async (assetEntry): Promise<GraphNodeLike[]> => {
				const parsedEntry = await assetEntry('object');

				const pathsResolved = await parsedEntry.paths('array');
				const allPaths = await Promise.all(pathsResolved.map(async (pathResolvedInput): Promise<GraphNodeLike[]> => {
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
									provider: { type: 'assetMovement', id: providerId },
									from: { asset: src.id, location: src.location, rail: inboundRail },
									to: { asset: dest.id, location: dest.location, rail: outboundRail }
								});
							}
						}

					}

					return(pathNodes);
				}));

				return(allPaths.flat());
			}));

			return(pathNodesResult.flat());
		}));

		return(providerResults.flat().filter((node): node is GraphNodeLike => !!node));
	}

	async #computeGraphNodes() {
		const receivedNodes = await Promise.all([
			this.#computeFXNodes(),
			this.#computeAssetMovementNodes()
		]);

		return(receivedNodes.flat());
	}

	async findPaths(input: AnchorChainingPathInput): Promise<GraphNodeLike[][]> {
		const graph = await this.#computeGraphNodes();

		function compareAsset(assetA: AnchorChainingAsset, assetB: AnchorChainingAsset): boolean {
			if (typeof assetA === 'string' && typeof assetB === 'string') {
				return(assetA === assetB);
			} else if (KeetaNet.lib.Account.isInstance(assetA) && KeetaNet.lib.Account.isInstance(assetB)) {
				return(assetA.publicKeyString.get() === assetB.publicKeyString.get());
			} else {
				return(false);
			}
		}

		function nodeSideSupports(input: GraphNodeLike['from' | 'to'], required: AnchorChainingAssetAndLocation): boolean {
			if (input.rail !== required.rail) {
				return(false);
			}

			if (input.location !== required.location) {
				return(false);
			}

			if (!(compareAsset(input.asset, required.asset))) {
				return(false);
			}

			return(true);
		}

		const nodesWithNext: { node: GraphNodeLike, next: number[] }[] = graph.map(function(node, index) {
			return({ node, next: [] });
		});

		for (const node of nodesWithNext) {
			for (let secondNodeIdx = 0; secondNodeIdx < nodesWithNext.length; secondNodeIdx++) {
				const nodeJ = nodesWithNext[secondNodeIdx];
				if (!nodeJ) {
					continue;
				}

				// We can ignore chaining one fx anchor to itself
				if (node.node.provider.type === 'fx') {
					if (node.node.provider.type === nodeJ.node.provider.type && node.node.provider.id === nodeJ.node.provider.id) {
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
}

class AnchorChainingPath {
	readonly request: AnchorChainingPathInput;
	readonly path: GraphNodeLike[];
	readonly parent: AnchorChaining;

	constructor(input: {
		request: AnchorChainingPathInput;
		path: GraphNodeLike[];
		parent: AnchorChaining;
	}) {
		if (input.path.length < 1) {
			throw(new Error(`Path must have at least one node`));
		}

		this.request = input.request;
		this.path = input.path;
		this.parent = input.parent;
	}

	private _debugGetPathReadable() {
		return(this.path.map(function(node) {
			const fromAssetLocation = `${convertAssetSearchInputToCanonical(node.from.asset)}@${convertAssetLocationToString(node.from.location)}`;
			const toAssetLocation = `${convertAssetSearchInputToCanonical(node.to.asset)}@${convertAssetLocationToString(node.to.location)}`;
			return(`${node.provider.type}:${node.provider.id} (${fromAssetLocation} -> ${toAssetLocation} via ${node.to.rail})`);
		}));
	}

	get isMultiStep(): boolean {
		return(this.path.length > 1);
	}

	async execute(): Promise<void> {
		throw(new Error(`Not implemented yet`));
	}
}

export class AnchorChaining {
	private client: KeetaNet.UserClient;
	private resolver: Resolver;
	private signer: InstanceType<typeof KeetaNetLib.Account> | undefined;
	private account: InstanceType<typeof KeetaNetLib.Account> | undefined;
	private graph: AnchorGraph;

	constructor(config: AnchorChainingConfig) {
		this.client = config.client;
		if (config.resolver) {
			this.resolver = config.resolver;
		} else {
			this.resolver = getDefaultResolver(config.client);
		}
		this.signer = config.signer ?? config.account ?? config.client.signer ?? config.client.account;
		this.account = config.account ?? config.client.account;
		this.graph = new AnchorGraph({ resolver: this.resolver, client: this.client });
	}

	async computeChainingPath(input: AnchorChainingPathInput): Promise<AnchorChainingPath[] | null> {
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
}

