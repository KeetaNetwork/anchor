
import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaFXAnchorEstimateResponse, KeetaFXAnchorQuoteResponse } from './common.js';
import crypto from '../../lib/utils/crypto.js';

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
        estimate: {
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

	const getQuoteResponse: KeetaFXAnchorQuoteResponse = {
		ok: true,
		quote: {
			amount: '88.2',
			affinity: 'to',
			signed: {
				nonce: crypto.randomUUID(),
				timestamp: (new Date()).toISOString(),
				signature: ''
			}
		},
		cost: {
			amount: '5',
			token: baseToken.publicKeyString.get()
		}
	};
	const getQuoteResponseJSON = JSON.stringify(getQuoteResponse);

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
							getEstimate: `data:application/json,${encodeURIComponent(getEstimateResponseJSON)}`,
							getQuote: `data:application/json,${encodeURIComponent(getQuoteResponseJSON)}`,
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

    const estimates = await fxClient.getEstimates({ from: 'USD', to: 'EUR', amount: 100, affinity: 'from'});
    if (estimates === null) {
        throw(new Error('Estimates is NULL'));
    }
	const estimate = estimates[0];
	if (estimate === undefined) {
		throw(new Error('Estimate is undefined'));
	}
    expect(estimate).toEqual({ provider: estimate.provider, ...getEstimateResponse });
	
	const fxProvider = estimate.provider;

    const quote = await fxProvider.getQuote();
    if (quote === null) {
        throw(new Error('Quote is NULL'));
    }
    expect(quote).toEqual(getQuoteResponse);
});
