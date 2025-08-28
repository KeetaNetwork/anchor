
import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaFXAnchorEstimateResponse } from './common.js';

const DEBUG = false;

const testCurrencyUSD = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
const testCurrencyEUR = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
const testCurrencyBTC = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

test('KYC Anchor Client Test', async function() {
    const logger = DEBUG ? console : undefined;
	const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);

	const { userClient: client } = await createNodeAndClient(account);
    const baseToken = client.baseToken;

    const getEstimateResponse: KeetaFXAnchorEstimateResponse = {
        ok: true,
        provider: 'Test',
        estimate: {
            rate: 0.88,
            amount: '88',
            affinity: 'to'
        },
        expectedCost: {
            min: '1',
            max: '5',
            token: baseToken.publicKeyString.get()
        }
    }
    const getEstimateResponseJSON = JSON.stringify(getEstimateResponse);
    const getEstimateResponseEncoded = encodeURIComponent(getEstimateResponseJSON);

	const results = await client.setInfo({
		description: 'FX Anchor Test Root',
		name: 'TEST',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {
				USD: testCurrencyUSD.publicKeyString.get(),
				EUR: testCurrencyEUR.publicKeyString.get(),
				'$BTC': testCurrencyBTC.publicKeyString.get()
			},
			services: {
				fx: {
					Bad: {
						from: [{
                            currencyCodes: ['FOO'],
                            to: ['BAR']
                        }],
						operations: {
							getEstimate: 'https://example.com/getEstimate.json',
							getQuote: 'https://example.com/getQuote.json',
                            createExchange: 'https://example.com/createExchange.json',
                            getExchangeStatus: 'https://example.com/createVerification.json'
						}
					},
					Test: {
						from: [{
                            currencyCodes: [testCurrencyUSD.publicKeyString.get()],
                            to: [testCurrencyEUR.publicKeyString.get()]
                        }],
						operations: {
							getEstimate: `data:application/json,${getEstimateResponseEncoded}`,
							getQuote: 'https://example.com/getQuote.json',
                            createExchange: 'https://example.com/createExchange.json',
                            getExchangeStatus: 'https://example.com/createVerification.json'
						}
					}
				}
			}
		})
	});
	logger?.log('Set info results:', results);

	const fxClient = new KeetaNetAnchor.FX.Client(client, {
		root: account,
		...(logger ? { logger: logger } : {})
	});

    const estimate = await fxClient.getEstimate({ from: 'USD', to: 'EUR', amount: 100, affinity: 'from'});
    if (estimate === null) {
        throw(new Error('Estimate is NULL'));
    }
    expect(estimate[0]).toEqual(getEstimateResponse);
});
