import { test } from 'vitest';
import { createNodeAndClient } from './utils/tests/node.js';
import { KeetaNet } from '../client/index.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from '../services/asset-movement/server.js';
import type { AssetLocationLike } from '../services/asset-movement/common.js';
import { KeetaNetFXAnchorHTTPServer } from '../services/fx/server.js';
import { Resolver } from './index.js';
import type { ServiceMetadataExternalizable } from './resolver.js';
import { AnchorChaining } from './chaining.js';


const DEBUG = false;
const logger = DEBUG ? console : undefined;

test('Asset Movement Anchor Client Test', async function({ expect }) {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client } = await createNodeAndClient(account);

	const makeTokenAssert = async () => {
		const { account } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		return(account.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
	}

	const evmChainLocation = 'chain:evm:500' satisfies AssetLocationLike;
	const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;

	const tokens = {
		USDC: await makeTokenAssert(),
		EURC: await makeTokenAssert(),
		USDT: await makeTokenAssert(),
		BTC: await makeTokenAssert()
	}

	await using baseAnchorAssetMovementServer = new KeetaNetAssetMovementAnchorHTTPServer({
		...(logger ? { logger: logger } : {}),
		assetMovement: {
			/**
             * Supported assets and their configurations
             */
			supportedAssets: [
				{
					asset: tokens.USDC.publicKeyString.get(),
					paths: [
						{
							pair: [
								{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { common: [ { rail: 'KEETA_SEND' } ] }},
								{ location: evmChainLocation, id: 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] }}
							]
						}
					]
				},
				{
					asset: '$USDC',
					paths: [
						{
							pair: [
								{ location: evmChainLocation, id: 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }},
								{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { inbound: [ 'KEETA_SEND' ] }}
							]
						}
					]
				}
			],

			async getTransferStatus() {
				return({
					transaction: {
						id: 'tx123',
						status: 'pending',
						asset: tokens.USDC.publicKeyString.get(),
						from: {
							location: evmChainLocation,
							value: '500',
							transactions: {
								deposit: null,
								persistentForwarding: null,
								finalization: null
							}
						},
						to: {
							location: keetaLocation,
							value: '500',
							transactions: {
								withdraw: null
							}
						},
						fee: null,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				})
			}
		}
	});

	await using bankAnchorServer = new KeetaNetAssetMovementAnchorHTTPServer({
		logger: logger,
		assetMovement: {
			supportedAssets: [
				{
					asset: [ tokens.USDC.publicKeyString.get(), 'USD' ],
					paths: [
						{
							pair: [
								{ location: 'bank-account:us', id: 'USD', rails: { common: [ 'ACH', 'WIRE' ] }},
								{ location: keetaLocation,  id: tokens.USDC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
							]
						}
					]
				},
				{
					asset: [ tokens.EURC.publicKeyString.get(), 'EUR' ],
					paths: [
						{
							pair: [
								{ location: 'bank-account:iban-swift', id: 'EUR', rails: { common: [ 'SEPA_PUSH' ] }},
								{ location: keetaLocation,  id: tokens.EURC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
							]
						}
					]
				}
			],

			async getTransferStatus() {
				return({
					transaction: {
						id: 'tx123',
						status: 'pending',
						asset: tokens.USDC.publicKeyString.get(),
						from: {
							location: evmChainLocation,
							value: '500',
							transactions: {
								deposit: null,
								persistentForwarding: null,
								finalization: null
							}
						},
						to: {
							location: keetaLocation,
							value: '500',
							transactions: {
								withdraw: null
							}
						},
						fee: null,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				})
			}
		}
	});

	const fxServerQuoteSigner = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const fxServerLiquidityProvider = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using fxServer = new KeetaNetFXAnchorHTTPServer({
		logger: logger,
		quoteSigner: fxServerQuoteSigner,
		accounts: new KeetaNet.lib.Account.Set([ fxServerLiquidityProvider ]),
		signer: fxServerLiquidityProvider,
		client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
		fx: {
			from: [
				{
					currencyCodes: [ tokens.USDC.publicKeyString.get(), tokens.USDT.publicKeyString.get(), tokens.BTC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ],
					to: [ tokens.USDC.publicKeyString.get(), tokens.USDT.publicKeyString.get(), tokens.BTC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ]
				}
			],
			getConversionRateAndFee: async function(request) {
				let rate = 0.88;
				if (request.affinity === 'to') {
					rate = 1 / rate;
				}
				return({
					account: fxServerLiquidityProvider,
					convertedAmount: BigInt(request.amount) * BigInt(Math.round(rate * 1000)) / 1000n,
					cost: {
						amount: 0n,
						token: KeetaNet.lib.Account.toAccount(request.from)
					}
				});
			}
		}
	});

	await fxServer.start();
	await baseAnchorAssetMovementServer.start();
	await bankAnchorServer.start();

	await client.setInfo({
		description: 'FX Anchor Test Root',
		name: 'TEST',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: Object.fromEntries(Object.entries(tokens).map(function([ symbol, token ]) {
				return([ `$${symbol}`,  token.publicKeyString.get() ]);
			})),
			services: {
				fx: {
					FXOne: await fxServer.serviceMetadata()
				},
				assetMovement: {
					BaseAnchor: await baseAnchorAssetMovementServer.serviceMetadata(),
					BankAnchor: await bankAnchorServer.serviceMetadata()
				}
			}
		} satisfies ServiceMetadataExternalizable)
	});

	const anchorChaining = new AnchorChaining({
		client: client,
		resolver: new Resolver({
			root: client.account,
			client: client,
			trustedCAs: []
		})
	});

	const paths = await anchorChaining.computeChainingPath({
		source: {
			asset: 'USD',
			location: 'bank-account:us',
			value: 100n,
			rail: 'ACH'
		},
		destination: {
			asset: 'EUR',
			location: 'bank-account:iban-swift',
			recipient: client.account.publicKeyString.get(),
			rail: 'SEPA_PUSH'
		}
	});

	const path = paths?.[0];
	if (!paths || !path) {
		throw(new Error(`No paths found`));
	}

	expect(paths.length).toEqual(1);

	expect(path.isMultiStep).toEqual(true);
	expect(path.path.length).toEqual(3);

	expect(KeetaNet.lib.Utils.Conversion.toJSONSerializable(path.path)).toEqual(KeetaNet.lib.Utils.Conversion.toJSONSerializable([
		{
			from: { asset: 'USD', location: 'bank-account:us', rail: 'ACH' },
			provider: { id: "BankAnchor", type: "assetMovement" },
			to: { asset: tokens.USDC, location: keetaLocation, rail: 'KEETA_SEND' }
		},
		{
			from: { asset: tokens.USDC, location: keetaLocation, rail: 'KEETA_SEND' },
			provider: { "id": "FXOne", "type": "fx" },
			to: { asset: tokens.EURC, location: keetaLocation, rail: 'KEETA_SEND' }
		},
		{
			from: { asset: tokens.EURC, location: keetaLocation, rail: 'KEETA_SEND' },
			provider: { id: "BankAnchor", type: "assetMovement" },
			to: { asset: 'EUR', location: 'bank-account:iban-swift', rail: 'SEPA_PUSH' }
		}
	]));
});
