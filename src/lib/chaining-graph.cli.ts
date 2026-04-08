import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import type { GenericAccount, TokenPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';
import { createAssert } from 'typia';
import { assertNever } from './utils/never.js';
import { KeetaNet } from '../client/index.js';
import { getDefaultResolverConfig } from '../config.js';
import { Resolver } from './index.js';
import type { AnchorChainingAsset, GraphNodeLike } from './chaining.js';
import { AnchorChaining } from './chaining.js';
import { convertAssetSearchInputToCanonical } from './asset.js';
import type { AssetLocationLike } from '../services/asset-movement/common.js';
import { convertAssetLocationToString } from '../services/asset-movement/common.js';

const assertNetwork = createAssert<Networks>();

interface GraphCLIArgs {
	network: Networks;
	skipDefaultResolver: boolean;
	roots: GenericAccount[];

	showFX: boolean;
}

function getConfig(args: string[]): GraphCLIArgs {
	const retval: GraphCLIArgs = {
		network: 'test',
		roots: [],
		skipDefaultResolver: false,
		showFX: false
	};

	let flag: keyof GraphCLIArgs | null = null;
	for (const arg of args) {
		if (flag) {
			if (flag === 'network') {
				retval.network = assertNetwork(arg);
			} else if (flag === 'roots') {
				const acct = KeetaNet.lib.Account.fromPublicKeyString(arg);
				retval.roots.push(acct);
			} else {
				assertNever(flag);
			}

			flag = null;
		} else if (arg.startsWith('-')) {
			if (arg === '--network' || arg === '-n') {
				flag = 'network';
			} else if (arg === '--root' || arg === '-r') {
				flag = 'roots';
			} else if (arg === '--skip-default-resolver') {
				retval.skipDefaultResolver = true;
			} else if (arg === '--show-fx' || arg === '-x') {
				retval.showFX = true;
			} else {
				throw(new Error(`Unknown flag: ${arg}`));
			}
		} else {
			throw(new Error(`Unexpected argument: ${arg}`));
		}

	}

	return(retval);
}

async function makeGraphViz(input: {
	graph: AnchorChaining['graph'];
	config: Pick<GraphCLIArgs, 'showFX'>;
}) {
	const nodes = await input.graph['computeGraphNodes']();

	// Assign stable sequential IDs to each unique (asset, location) pair
	const dotNodeId = new Map<string, string>();
	let nextNodeId = 0;

	function assetLocationKey(asset: AnchorChainingAsset, location: AssetLocationLike): string {
		return(`${convertAssetSearchInputToCanonical(asset)}@${convertAssetLocationToString(location)}`);
	}

	function getDotId(asset: AnchorChainingAsset, location: AssetLocationLike): string {
		const key = assetLocationKey(asset, location);

		let found = dotNodeId.get(key);
		if (!found) {
			found = `n${nextNodeId++}`;
			dotNodeId.set(key, found);
		}

		return(found);
	}

	for (const node of nodes) {
		getDotId(node.from.asset, node.from.location);
		getDotId(node.to.asset, node.to.location);
	}

	const currencyMapByToken = await (async () => {
		const map = new Map<TokenPublicKeyString, string>();
		const listedTokens = await input.graph.resolver.listTokens();
		for (const asset of listedTokens) {
			map.set(asset.token, asset.currency);
		}
		return(map);
	})();

	const publicKeyOrDefaultLabel = (input: string) => {
		if (input.startsWith('keeta_')) {
			try {
				const pub = KeetaNet.lib.Account.toPublicKeyString(input);

				return(`${pub.slice(0, 10)}...${pub.slice(-4)}`)
			} catch {
				/* ignore */
			}
		}

		return(input);
	}

	const assetLabel = (asset: AnchorChainingAsset): string => {
		if (KeetaNet.lib.Account.isInstance(asset) || (typeof asset === 'string' && asset.startsWith('keeta_'))) {
			const tokenPub = KeetaNet.lib.Account.toAccount(asset)
				.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
				.publicKeyString.get();

			const cached = currencyMapByToken.get(tokenPub);
			if (cached) {
				return(cached);
			}

			return(publicKeyOrDefaultLabel(tokenPub));
		}

		const s = String(convertAssetSearchInputToCanonical(asset));
		return(s.length <= 10 ? s : `\u2026${s.slice(-8)}`);
	}

	function esc(s: string): string {
		return(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
	}

	// Group (asset, location) entries by location string for clustering
	const locationGroups = new Map<string, { asset: AnchorChainingAsset; location: AssetLocationLike }[]>();
	for (const node of nodes) {
		for (const side of [ node.from, node.to ]) {
			const locStr = convertAssetLocationToString(side.location);
			if (!locationGroups.has(locStr)) {
				locationGroups.set(locStr, []);
			}
			const group = locationGroups.get(locStr);
			if (!group) {
				throw(new Error(`Unexpected missing location group for location string: ${locStr}`));
			}
			const key = assetLocationKey(side.asset, side.location);
			if (!group.some(g => assetLocationKey(g.asset, g.location) === key)) {
				group.push({ asset: side.asset, location: side.location });
			}
		}
	}

	const lines: string[] = [
		'digraph AnchorGraph {',
		'  rankdir=LR',
		'  node [shape=box, style=filled, fontname="Helvetica"]',
		'  edge [fontsize=9, fontname="Helvetica"]',
		''
	];

	// One cluster per location color-coded by location type
	let clusterIdx = 0;
	for (const [ locStr, entries ] of locationGroups) {
		const isKeeta   = locStr.startsWith('chain:keeta:');
		const isExtChain = !isKeeta && locStr.startsWith('chain:');
		// Keeta = blue tint, fiat/bank = green tint, other external chains = red tint
		const clusterFill = isKeeta ? '#e8f4ff' : isExtChain ? '#fff0f0' : '#f0fff0';
		const nodeFill    = isKeeta ? '#fffacd' : isExtChain ? '#ffe4e1' : '#e0ffe0';

		lines.push(`  subgraph cluster_${clusterIdx++} {`);
		lines.push(`    label="${esc(locStr)}"`);
		lines.push(`    style=filled`);
		lines.push(`    color="#aaaaaa"`);
		lines.push(`    fillcolor="${clusterFill}"`);
		for (const { asset, location } of entries) {
			const id = getDotId(asset, location);
			const label = assetLabel(asset);
			const tooltip = esc(assetLocationKey(asset, location));
			lines.push(`    ${id} [label="${esc(label)}", fillcolor="${nodeFill}", tooltip="${tooltip}"]`);
		}
		lines.push('  }');
		lines.push('');
	}

	function isFXLike(node: GraphNodeLike): boolean {
		if (node.type === 'fx') {
			return(true);
		} else if (node.type === 'assetMovement') {
			if (node.from.rail === 'KEETA_SEND' && node.to.rail === 'KEETA_SEND') {
				if (convertAssetLocationToString(node.from.location) === convertAssetLocationToString(node.to.location)) {
					return(true);
				}
			}

			return(false);
		} else {
			assertNever(node);
		}
	}

	const emittedFXLikeKeys = new Set<string>();
	const emittedMoveKeys   = new Set<string>();

	for (const node of nodes) {
		const fromKey = assetLocationKey(node.from.asset, node.from.location);
		const toKey   = assetLocationKey(node.to.asset,   node.to.location);
		const from    = getDotId(node.from.asset, node.from.location);
		const to      = getDotId(node.to.asset,   node.to.location);

		if (isFXLike(node)) {
			if (!input.config.showFX) {
				continue;
			}

			const [lo, hi] = fromKey < toKey ? [fromKey, toKey] : [toKey, fromKey];
			const canonKey = `${lo}|${hi}|${node.providerID}`;
			if (emittedFXLikeKeys.has(canonKey)) {
				continue;
			}
			emittedFXLikeKeys.add(canonKey);

			const hasReverse = nodes.some(n =>
				isFXLike(n) &&
                n.providerID === node.providerID &&
                assetLocationKey(n.from.asset, n.from.location) === toKey &&
                assetLocationKey(n.to.asset,   n.to.location)   === fromKey
			);

			const edgeLabel = esc(`FX [PRV=${publicKeyOrDefaultLabel(node.providerID)}]`);
			const dirAttr   = hasReverse ? ', dir=both' : '';
			lines.push(`  ${from} -> FX_${esc(publicKeyOrDefaultLabel(node.providerID))} -> ${to} [label="${edgeLabel}", color=darkorange, fontcolor=darkorange, style=dashed${dirAttr}, constraint=false]`);
		} else {
			const railLabel = node.to.rail;

			const edgeLabel = esc(`${railLabel} [PRV=${publicKeyOrDefaultLabel(node.providerID)}]`);
			const moveKey = `${from}|${to}|${edgeLabel}`;
			if (emittedMoveKeys.has(moveKey)) {
				continue;
			}
			emittedMoveKeys.add(moveKey);
			lines.push(`  ${from} -> ${to} [label="${edgeLabel}", color=steelblue, fontcolor=steelblue]`);
		}
	}

	lines.push('}');
	return(lines.join('\n'));
}

(async () => {
	const config = getConfig(process.argv.slice(2));

	const fakeAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const userClient = KeetaNet.UserClient.fromNetwork(config.network, fakeAccount);

	const usingRoots = config.roots;
	const defaultConfig = getDefaultResolverConfig(userClient);
	if (!config.skipDefaultResolver) {
		usingRoots.push(...([defaultConfig.root].flat()));
	}

	const resolver = new Resolver({
		...defaultConfig,
		root: usingRoots
	});

	const chaining = new AnchorChaining({
		client: userClient,
		resolver: resolver
	});

	const computed = await makeGraphViz({
		graph: chaining['graph'],
		config
	});

	console.log(computed);

	process.exit(0);
})().catch(function(err: unknown) {
	console.error(err);
	process.exit(1);
});
