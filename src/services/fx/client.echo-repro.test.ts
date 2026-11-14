import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaNetFXAnchorHTTPServer } from './server.js';
import type { KeetaAnchorFXServerConfig } from './server.js';
import { KeetaAnchorQueueStorageDriverMemory } from '../../lib/queue/index.js';
import type { Routes } from '../../lib/http-server/index.js';

/*
 * Reproduction for the "echoed request" report: the client must build the
 * swap block from the conversion it asked for, not from the `request` the
 * anchor echoes back in its quote.
 */
const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';

type Tamper = 'none' | 'amount' | 'from';

async function runScenario(tamper: Tamper, extraRequest: { preferredCostAsset?: boolean } = {}) {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	const quoteSigner = KeetaNet.lib.Account.fromSeed(seed, 2);
	const liquidityProvider = KeetaNet.lib.Account.fromSeed(seed, 3);

	await using nodeAndClient = await createNodeAndClient(account);
	const client = nodeAndClient.userClient;
	const baseToken = client.baseToken;

	const { account: usd } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: eur } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!usd.isToken() || !eur.isToken()) {
		throw(new Error('not tokens'));
	}

	const captured: { block?: InstanceType<typeof KeetaNet.lib.Block>; createExchangeError?: unknown } = {};

	await using server = new (class extends KeetaNetFXAnchorHTTPServer {
		protected async initRoutes(config: KeetaAnchorFXServerConfig): Promise<Routes> {
			const routes = await super.initRoutes(config);
			const honestGetQuote = routes['POST /api/getQuote'];
			const honestCreateExchange = routes['POST /api/createExchange'];
			if (typeof honestGetQuote !== 'function' || typeof honestCreateExchange !== 'function') {
				throw(new Error('routes missing'));
			}

			routes['POST /api/getQuote'] = async function(params, postData, ...rest) {
				const honest = await honestGetQuote(params, postData, ...rest);
				const body = JSON.parse(String(honest.output));
				if (tamper === 'amount') {
					body.quote.request.amount = '0x' + (BigInt(body.quote.request.amount) * 1000n).toString(16);
				} else if (tamper === 'from') {
					body.quote.request.from = baseToken.publicKeyString.get();
					body.quote.request.amount = '0x' + (50000n).toString(16);
				}
				return({ ...honest, output: JSON.stringify(body) });
			};

			routes['POST /api/createExchange'] = async function(params, postData, ...rest) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				const req = (postData as { request: { block: string } }).request;
				captured.block = new KeetaNet.lib.Block(req.block);
				if (tamper !== 'none') {
					return({ output: JSON.stringify({ ok: true, exchangeID: 'x', status: 'pending' }) });
				}
				try {
					return(await honestCreateExchange(params, postData, ...rest));
				} catch (error) {
					captured.createExchangeError = error;
					throw(error);
				}
			};
			return(routes);
		}
	})({
		account: liquidityProvider,
		quoteSigner: quoteSigner,
		client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
		storage: { queue: new KeetaAnchorQueueStorageDriverMemory({ id: 'queue' }), autoRun: false },
		fx: {
			from: [{ currencyCodes: [usd.publicKeyString.get()], to: [eur.publicKeyString.get()] }],
			acceptedCostAssets: [baseToken.publicKeyString.get()],
			getConversionRateAndFee: async function(request) {
				return({
					account: liquidityProvider,
					convertedAmount: BigInt(request.amount) * 92n / 100n,
					cost: { amount: 0n, token: baseToken }
				});
			}
		}
	});
	await server.start();

	await client.setInfo({
		description: 'echo repro',
		name: 'TEST',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: { USD: usd.publicKeyString.get(), EUR: eur.publicKeyString.get() },
			services: { fx: { Test: await server.serviceMetadata() } }
		})
	});

	const fxClient = new KeetaNetAnchor.FX.Client(client, { root: account });
	const quotes = await fxClient.getQuotes({
		from: 'USD',
		to: 'EUR',
		amount: 1000n,
		affinity: 'from',
		...(extraRequest.preferredCostAsset === true ? { preferredCostAsset: baseToken.publicKeyString.get() } : {})
	});

	let exchangeError: unknown = null;
	const quote = quotes?.[0];
	if (quote !== undefined) {
		try {
			await quote.createExchange();
		} catch (error) {
			exchangeError = error;
		}
	}

	const sends = (captured.block?.operations ?? []).flatMap(function(op) {
		if (op.type !== KeetaNet.lib.Block.OperationType.SEND) {
			return([]);
		}
		return([{ token: op.token.publicKeyString.get(), amount: op.amount }]);
	});

	return({ quotes, sends, exchangeError, usd: usd.publicKeyString.get(), base: baseToken.publicKeyString.get(), quoteRequest: quote?.request });
}

test('client signs only the conversion it asked for when the anchor inflates request.amount', async function() {
	const r = await runScenario('amount');
	// The only provider answered for a different conversion, so it is refused and nothing is signed
	expect(r.quotes).toBeNull();
	expect(r.sends).toEqual([]);
}, 60_000);

test('client signs only the conversion it asked for when the anchor swaps request.from', async function() {
	const r = await runScenario('from');
	expect(r.quotes).toBeNull();
	expect(r.sends).toEqual([]);
}, 60_000);

test('honest quote with preferredCostAsset round-trips through createExchange', async function() {
	const r = await runScenario('none', { preferredCostAsset: true });
	expect(r.exchangeError).toBeNull();
	expect(r.quoteRequest?.preferredCostAsset).toBe(r.base);
	expect(r.sends).toEqual([{ token: r.usd, amount: 1000n }]);
}, 60_000);
