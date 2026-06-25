import { test, expect, describe } from 'vitest';

import type { AnchorChainingAsset, AnchorChainingAssetInfo, AnchorChainingResolveAssetsFilter, Disclaimer } from './index.js';
import { KeetaNet } from '../../client/index.js';
import { convertAssetLocationToString } from '../../services/asset-movement/common.js';
import {
	createChainingTestHarness,
	createMetadataHarness,
	createPersistentForwardingHarness,
	PFR_SUPPORTED_OPS
} from './fixtures.js';

/** Stable string key for an asset (token public key or ISO/external code). */
function assetKey(asset: AnchorChainingAsset): string {
	if (KeetaNet.lib.Account.isInstance(asset)) {
		return(asset.publicKeyString.get());
	}

	return(String(asset));
}

/** Stable `asset@location` key for an asset-info result. */
function resultKey(item: AnchorChainingAssetInfo): string {
	return(`${assetKey(item.asset)}@${convertAssetLocationToString(item.location)}`);
}

describe('graph.listAssets', function() {
	test('onlyAllowFXLike excludes the source token and bank-account destinations', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation },
			onlyAllowFXLike: true
		});
		expect(assets).toHaveLength(1);

		const eurc = assets[0];
		if (!eurc) {
			throw(new Error('Expected to find the EURC asset'));
		}

		expect(assetKey(eurc.asset)).toEqual(h.tokens.EURC.publicKeyString.get());
		expect(eurc.location).toEqual(h.keetaLocation);
		expect(eurc.rails.inbound).toEqual([ 'KEETA_SEND' ]);
		expect(eurc.rails.outbound).toEqual([ 'KEETA_SEND' ]);
	});

	test('a from filter with maxStepCount=1 returns only direct 1-hop destinations', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation },
			maxStepCount: 1
		});
		expect(assets).toHaveLength(2);

		const keys = assets.map(resultKey);
		expect(keys).toContain(`${h.tokens.EURC.publicKeyString.get()}@${convertAssetLocationToString(h.keetaLocation)}`);
		expect(keys).toContain('USD@bank-account:us');
		expect(keys).not.toContain('EUR@bank-account:iban-swift');
	});

	test('a from filter without maxStepCount finds all reachable assets', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation }
		});
		expect(assets).toHaveLength(4);

		const keys = assets.map(resultKey);
		expect(keys).toContain(`${h.tokens.EURC.publicKeyString.get()}@${convertAssetLocationToString(h.keetaLocation)}`);
		expect(keys).toContain('EUR@bank-account:iban-swift');
		expect(keys).toContain('USD@bank-account:us');
	});

	test('a to filter with maxStepCount=1 returns only direct 1-hop sources', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets({
			to: { location: 'bank-account:us' },
			maxStepCount: 1
		});
		expect(assets).toHaveLength(1);

		const usdc = assets[0];
		if (!usdc) {
			throw(new Error('Expected to find the USDC asset'));
		}

		expect(assetKey(usdc.asset)).toEqual(h.tokens.USDC.publicKeyString.get());
		expect(usdc.location).toEqual(h.keetaLocation);
		expect(usdc.rails.outbound).toContain('KEETA_SEND');
	});

	test('no filter returns all four distinct asset-location pairs', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets();
		expect(assets).toHaveLength(4);

		const keys = assets.map(resultKey);
		expect(keys).toContain(`${h.tokens.USDC.publicKeyString.get()}@${convertAssetLocationToString(h.keetaLocation)}`);
		expect(keys).toContain(`${h.tokens.EURC.publicKeyString.get()}@${convertAssetLocationToString(h.keetaLocation)}`);
		expect(keys).toContain('USD@bank-account:us');
		expect(keys).toContain('EUR@bank-account:iban-swift');
	});

	test('a from filter populates distance.pathLength with the shortest hop count', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation }
		});

		const distanceByKey = new Map(assets.map(a => [ resultKey(a), a.distance?.pathLength ]));
		expect(distanceByKey.get(`${h.tokens.EURC.publicKeyString.get()}@${convertAssetLocationToString(h.keetaLocation)}`)).toEqual(1);
		expect(distanceByKey.get('USD@bank-account:us')).toEqual(1);
		expect(distanceByKey.get('EUR@bank-account:iban-swift')).toEqual(2);
	});

	test('a to filter populates distance.pathLength', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets({
			to: { location: 'bank-account:us' },
			maxStepCount: 1
		});
		expect(assets).toHaveLength(1);
		expect(assets[0]?.distance).toEqual({ pathLength: 1 });
	});

	test('no filter returns a null distance for every asset', async function() {
		await using h = await createChainingTestHarness();

		const assets = await h.anchorChaining.graph.listAssets();
		for (const asset of assets) {
			expect(asset.distance).toBeNull();
		}
	});
});

describe('graph.resolveAssets', function() {
	type ExpectedAsset = { key: string; distance: number | null };
	type ResolveCase = {
		name: string;
		args: AnchorChainingResolveAssetsFilter | AnchorChainingResolveAssetsFilter[];
		expected: { from: ExpectedAsset[]; to: ExpectedAsset[] };
	};

	test('resolves directional reachability and distances under a range of filters', async function() {
		await using h = await createChainingTestHarness();

		const usdcKey = `${h.tokens.USDC.publicKeyString.get()}@${convertAssetLocationToString(h.keetaLocation)}`;
		const eurcKey = `${h.tokens.EURC.publicKeyString.get()}@${convertAssetLocationToString(h.keetaLocation)}`;
		const usdKey = 'USD@bank-account:us';
		const eurKey = 'EUR@bank-account:iban-swift';

		const cases: ResolveCase[] = [
			{
				name: 'from only',
				args: { from: { asset: h.tokens.USDC, location: h.keetaLocation }},
				expected: {
					from: [],
					to: [
						{ key: eurcKey, distance: 1 },
						{ key: usdKey, distance: 1 },
						{ key: eurKey, distance: 2 },
						{ key: usdcKey, distance: 2 }
					]
				}
			},
			{
				name: 'to only with maxStepCount: 1',
				args: { to: { location: 'bank-account:us' }, maxStepCount: 1 },
				expected: { from: [ { key: usdcKey, distance: 1 } ], to: [] }
			},
			{
				name: 'no filter',
				args: {},
				expected: {
					from: [
						{ key: usdcKey, distance: null },
						{ key: eurcKey, distance: null },
						{ key: usdKey, distance: null },
						{ key: eurKey, distance: null }
					],
					to: [
						{ key: usdcKey, distance: null },
						{ key: eurcKey, distance: null },
						{ key: usdKey, distance: null },
						{ key: eurKey, distance: null }
					]
				}
			},
			{
				name: 'from+to: keeta -> bank-account:us',
				args: [
					{ from: { location: h.keetaLocation }, to: { location: 'bank-account:us' }},
					{ from: { location: h.keetaLocation, rail: 'KEETA_SEND' }, to: { location: 'bank-account:us' }},
					{ from: { location: h.keetaLocation }, to: { location: 'bank-account:us', rail: 'ACH' }},
					{ from: { location: h.keetaLocation, rail: 'KEETA_SEND' }, to: { location: 'bank-account:us', rail: 'ACH' }}
				],
				expected: {
					from: [
						{ key: usdcKey, distance: 1 },
						{ key: eurcKey, distance: 2 }
					],
					to: [ { key: usdKey, distance: 1 } ]
				}
			},
			{
				name: 'from+to: invalid rail yields nothing',
				args: [
					{ from: { location: h.keetaLocation }, to: { location: 'bank-account:us', rail: 'BITCOIN_SEND' }},
					{ from: { location: h.keetaLocation, rail: 'ACH' }, to: { location: 'bank-account:us' }}
				],
				expected: { from: [], to: [] }
			},
			{
				name: 'from+to: to.rail SEPA_PUSH filters to the EU corridor',
				args: { from: { location: h.keetaLocation }, to: { location: 'bank-account:iban-swift', rail: 'SEPA_PUSH' }},
				expected: {
					from: [
						{ key: eurcKey, distance: 1 },
						{ key: usdcKey, distance: 2 }
					],
					to: [ { key: eurKey, distance: 1 } ]
				}
			},
			{
				name: 'from+to: from.rail ACH limits sources to ACH-outbound assets',
				args: { from: { rail: 'ACH' }, to: { location: h.keetaLocation }},
				expected: {
					from: [ { key: usdKey, distance: 1 } ],
					to: [
						{ key: usdcKey, distance: 1 },
						{ key: eurcKey, distance: 2 }
					]
				}
			}
		];

		const toActual = (side: AnchorChainingAssetInfo[]): ExpectedAsset[] =>
			side.map(a => ({ key: resultKey(a), distance: a.distance?.pathLength ?? null }));

		for (const { name, args, expected } of cases) {
			const argsArray = Array.isArray(args) ? args : [ args ];
			for (const argValue of argsArray) {
				const result = await h.anchorChaining.graph.resolveAssets(argValue);
				expect(toActual(result.from), `${name}: from`).toEqual(expect.arrayContaining(expected.from));
				expect(result.from, `${name}: from length`).toHaveLength(expected.from.length);
				expect(toActual(result.to), `${name}: to`).toEqual(expect.arrayContaining(expected.to));
				expect(result.to, `${name}: to length`).toHaveLength(expected.to.length);
			}
		}
	});
});

describe('graph metadata', function() {
	test('listAssetsWithMetadata attaches metadata for external-chain assets', async function() {
		await using h = await createMetadataHarness();
		const assets = await h.anchorChaining.graph.listAssetsWithMetadata();

		const evmAsset = assets.find(a => !KeetaNet.lib.Account.isInstance(a.asset) && String(a.asset) === h.usdcEvmId && a.location === h.evmChainLocation);
		expect(evmAsset?.metadata).toMatchObject({ ticker: '$USDC', decimalPlaces: 6 });
	});

	test('listAssetsWithMetadata leaves Keeta-native tokens without metadata', async function() {
		await using h = await createMetadataHarness();
		const assets = await h.anchorChaining.graph.listAssetsWithMetadata();

		const keetaAsset = assets.find(a => KeetaNet.lib.Account.isInstance(a.asset) && a.asset.publicKeyString.get() === h.tokens.USDC.publicKeyString.get());
		expect(keetaAsset).toBeDefined();
		expect(keetaAsset?.metadata).toBeUndefined();
	});

	test('resolveAssetsWithMetadata attaches metadata on the resolved side only', async function() {
		await using h = await createMetadataHarness();
		const result = await h.anchorChaining.graph.resolveAssetsWithMetadata({
			from: { location: h.keetaLocation },
			to: { location: h.evmChainLocation }
		});

		const evmAsset = result.to.find(a => !KeetaNet.lib.Account.isInstance(a.asset) && String(a.asset) === h.usdcEvmId);
		expect(evmAsset?.metadata).toMatchObject({ ticker: '$USDC', decimalPlaces: 6 });

		const keetaAsset = result.from.find(a => KeetaNet.lib.Account.isInstance(a.asset) && a.asset.publicKeyString.get() === h.tokens.USDC.publicKeyString.get());
		expect(keetaAsset).toBeDefined();
		expect(keetaAsset?.metadata).toBeUndefined();
	});

	test('resolveAssetsWithMetadata returns the requested provider metadata', async function() {
		await using h = await createMetadataHarness();

		const bridgeOne = await h.anchorChaining.graph.resolveAssetsWithMetadata(
			{ to: { location: h.evmChainLocation }, from: { location: h.keetaLocation }},
			{ providerID: 'BridgeOne' }
		);

		const bridgeOneEvm = bridgeOne.to.find(a => !KeetaNet.lib.Account.isInstance(a.asset) && String(a.asset) === h.usdcEvmId && a.location === h.evmChainLocation);
		expect(bridgeOneEvm?.metadata).toEqual(h.bridgeOneMetadata);

		const bridgeTwo = await h.anchorChaining.graph.resolveAssetsWithMetadata(
			{ to: { location: h.evmChainLocation }, from: { location: h.keetaLocation }},
			{ providerID: 'BridgeTwo' }
		);

		const bridgeTwoEvm = bridgeTwo.to.find(a => !KeetaNet.lib.Account.isInstance(a.asset) && String(a.asset) === h.usdcEvmId);
		expect(bridgeTwoEvm?.metadata).toEqual(h.bridgeTwoMetadata);
	});

	test('listAssetsWithMetadata returns undefined metadata for an unknown provider', async function() {
		await using h = await createMetadataHarness();
		const assets = await h.anchorChaining.graph.listAssetsWithMetadata(
			{ to: { location: h.evmChainLocation }},
			{ providerID: 'NonExistentBridge' }
		);

		const evmAsset = assets.find(a => !KeetaNet.lib.Account.isInstance(a.asset) && String(a.asset) === h.usdcEvmId);
		expect(evmAsset).toBeDefined();
		expect(evmAsset?.metadata).toBeUndefined();
	});

	test('getAssetMovementProvidersForAsset returns every provider for an external asset', async function() {
		await using h = await createMetadataHarness();

		const providers = await h.anchorChaining.graph.getAssetMovementProvidersForAsset(h.usdcEvmId, h.evmChainLocation);
		expect(Object.keys(providers ?? {}).sort()).toEqual([ 'BridgeOne', 'BridgeTwo' ]);
		for (const entry of Object.values(providers ?? {})) {
			expect(entry.provider).toBeDefined();
		}
	});

	test('getAssetMovementProvidersForAsset finds providers for Keeta-side assets', async function() {
		await using h = await createMetadataHarness();

		const providers = await h.anchorChaining.graph.getAssetMovementProvidersForAsset(h.tokens.USDC, h.keetaLocation);
		expect(Object.keys(providers ?? {}).sort()).toEqual([ 'BridgeOne', 'BridgeTwo' ]);
	});

	test('getAssetMovementProvidersForAsset returns null for an unknown pair', async function() {
		await using h = await createMetadataHarness();

		const providers = await h.anchorChaining.graph.getAssetMovementProvidersForAsset('evm:0x000000000000000000000000000000000000dEaD', h.evmChainLocation);
		expect(providers).toBeNull();
	});

	test('graph nodes carry rail supportedOperations metadata', async function() {
		await using h = await createPersistentForwardingHarness();
		const nodes = await h.anchorChaining.graph.computeGraphNodes();

		const evmSourceNode = nodes.find(n => n.type === 'assetMovement' && n.from.location === h.evmChainLocation && n.from.rail === 'EVM_SEND');
		expect(evmSourceNode).toBeDefined();
		expect(evmSourceNode?.from.supportedOperations).toEqual(PFR_SUPPORTED_OPS);
	});
});

describe('getPlans', function() {
	test('includeAllOutput preserves failures alongside successes and the default drops them', async function() {
		await using h = await createChainingTestHarness();

		const input = {
			source: { asset: h.tokens.USDC, location: h.keetaLocation, value: 100n, rail: 'KEETA_SEND' as const },
			destination: { asset: 'EUR' as const, location: 'bank-account:iban-swift' as const, recipient: h.client.account.publicKeyString.get(), rail: 'SEPA_PUSH' as const }
		};

		const allOk = await h.anchorChaining.getPlans(input, { includeAllOutput: true });
		expect(allOk).toHaveLength(2);
		for (const result of allOk ?? []) {
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.plan).toBeDefined();
				expect(result.path).toBeDefined();
			}
		}

		h.fxServerOne.setGetConversionRateAndFee(async () => {
			throw(new Error('FXOne rate unavailable'));
		});

		const mixed = await h.anchorChaining.getPlans(input, { includeAllOutput: true });
		expect(mixed).toHaveLength(2);

		const failed = mixed?.find(r => !r.success);
		const succeeded = mixed?.find(r => r.success);
		if (!failed || failed.success) {
			throw(new Error('Expected a failed result'));
		}
		expect(failed.error).toBeTruthy();
		expect(failed.path).toBeDefined();

		if (!succeeded || !succeeded.success) {
			throw(new Error('Expected a successful result'));
		}

		expect(succeeded.plan.preview.steps.some(s => s.type === 'fx' && s.providerID === 'FXTwo')).toBe(true);

		const defaultResults = await h.anchorChaining.getPlans(input);
		expect(defaultResults).toHaveLength(1);
		expect(defaultResults?.[0]?.preview.steps.some(s => s.type === 'fx' && s.providerID === 'FXTwo')).toBe(true);
	});
});

describe('path disclaimers', function() {
	test('a path returns each provider leg legal disclaimers in order', async function() {
		await using h = await createChainingTestHarness();

		const expectDisclaimers = async (paths: Awaited<ReturnType<typeof h.anchorChaining.getPaths>>, legCount: number): Promise<void> => {
			if (!paths || paths.length === 0) {
				throw(new Error('Expected at least one valid path'));
			}

			for (const path of paths) {
				const expected = path.path.slice(0, legCount).map((step) => {
					if (!step.providerID) {
						throw(new Error('Expected step to have a provider ID'));
					}
					const map: { [key: string]: Disclaimer[] } = step.type === 'assetMovement' ? h.bankProviderDisclaimers : h.fxProviderDisclaimers;
					return({ providerID: step.providerID, disclaimers: map[step.providerID] });
				});

				const disclaimers = await path.getProviderLegalDisclaimers();
				expect(disclaimers?.length).toEqual(expected.length);
				expect(disclaimers).toEqual(expected);
			}
		};

		const recipient = h.client.account.publicKeyString.get();

		const euBankPaths = await h.anchorChaining.getPaths({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND', value: 100n },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient, rail: 'SEPA_PUSH' }
		});
		await expectDisclaimers(euBankPaths, euBankPaths?.[0]?.path.length ?? 0);

		const usBankPaths = await h.anchorChaining.getPaths({
			source: { asset: h.tokens.EURC, location: h.keetaLocation, rail: 'KEETA_SEND', value: 100n },
			destination: { asset: 'USD', location: 'bank-account:us', recipient, rail: 'ACH' }
		});
		await expectDisclaimers(usBankPaths, usBankPaths?.[0]?.path.length ?? 0);
	});
});
