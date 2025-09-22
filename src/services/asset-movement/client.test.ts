import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from './server.js';
import type { KeetaAssetMovementAnchorCreatePersistentForwardingRequest, KeetaAssetMovementAnchorCreatePersistentForwardingResponse, KeetaAssetMovementAnchorGetTransferStatusResponse, KeetaAssetMovementAnchorInitiateTransferRequest, KeetaAssetMovementAnchorInitiateTransferResponse, KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse, KeetaAssetMovementAnchorlistTransactionsRequest, KeetaAssetMovementTransaction } from './common.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;
const toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';

test('Asset Movement Anchor Client Test', async function() {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	// const liquidityProvider = KeetaNet.lib.Account.fromSeed(seed, 1);
	// const quoteSigner = KeetaNet.lib.Account.fromSeed(seed, 2);
	const { userClient: client } = await createNodeAndClient(account);

	const currentDateString = (new Date()).toISOString();

	const baseToken = client.baseToken;

	const { account: testCurrencyUSDC } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: testCurrencyEUR } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!testCurrencyUSDC.isToken() || !testCurrencyEUR.isToken()) {
		throw(new Error('USDC is not a token'));
	}
	const initialAccountUSDCBalance = 500000n;
	await client.modTokenSupplyAndBalance(initialAccountUSDCBalance, testCurrencyUSDC);

	const initialAccountBalances = await client.allBalances();
	expect(toJSONSerializable(initialAccountBalances)).toEqual(toJSONSerializable([{ token: testCurrencyUSDC, balance: initialAccountUSDCBalance }]));

	const testTransaction: KeetaAssetMovementTransaction = {
		id: '123',
		status: 'COMPLETED',
		asset: baseToken.publicKeyString.get(),

		from: {
			location: 'chain:evm:100',
			value: '100',
			transactions: {
				persistentForwarding: null,
				deposit: null,
				finalization: null
			}
		},

		to: {
			location: 'chain:keeta:100',
			value: '100',
			transactions: {
				withdraw: null
			}
		},
		fee: null,
		createdAt: currentDateString,
		updatedAt: currentDateString
	};

	await using server = new KeetaNetAssetMovementAnchorHTTPServer({
		...(logger ? { logger: logger } : {}),
		client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
		assetMovement: {
			/**
			 * Supported assets and their configurations
			 */
			supportedAssets: [
				{
					asset: baseToken.publicKeyString.get(),
					paths: [
						{
							pair: [
								{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
								{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] }}
							]
						}
					]
				},
				{
					asset: testCurrencyUSDC.publicKeyString.get(),
					paths: [
						{
							pair: [
								{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }},
								{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { inbound: [ 'KEETA_SEND' ] }}
							]
						}
					]
				}
			],

			/**
			 * Method to create a persistent forwarding address
			 */
			createPersistentForwarding: async function(request: KeetaAssetMovementAnchorCreatePersistentForwardingRequest): Promise<Omit<Extract<KeetaAssetMovementAnchorCreatePersistentForwardingResponse, { ok: true }>, 'ok'>> {
				return({
					address: request.destinationAddress
				})
			},

			/**
			 * Method to initiate a transfer
			 */
			initiateTransfer: async function(request: KeetaAssetMovementAnchorInitiateTransferRequest): Promise<Omit<Extract<KeetaAssetMovementAnchorInitiateTransferResponse, { ok: true }>, 'ok'>> {
				return({
					id: '123',
					instructionChoices: [{
						type: 'KEETA_SEND',
						location: request.from.location,

						sendToAddress: request.to.recipient,
						value: request.value.toString(),
						tokenAddress: baseToken.publicKeyString.get(),

						external: `123:${request.to.recipient}`,  // encodeAssetMovementForward
						assetFee: '10'
					}]
				})
			},

			/**
			 * Method to get the status of a transfer
			 */
			getTransferStatus: async function(_ignored_id: string): Promise<Omit<Extract<KeetaAssetMovementAnchorGetTransferStatusResponse, { ok: true }>, 'ok'>> {
				return({
					transaction: testTransaction
				})
			},

			/**
			 * Method to list transactions
			 */
			listTransactions: async function(_ignored_request: KeetaAssetMovementAnchorlistTransactionsRequest): Promise<Omit<Extract<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse, { ok: true }>, 'ok'>> {
				return({
					transactions: [testTransaction],
					total: '1'
				})
			}
		}
	});

	/*
	 * Start the FX Anchor Server and get the URL
	 */
	await server.start();
	const serverURL = server.url;

	const results = await client.setInfo({
		description: 'Asset Movement Anchor Test Root',
		name: 'TEST',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			services: {
				assetMovement: {
					Bad: {
						operations: {
							getEstimate: 'https://example.com/getEstimate.json',
							getQuote: 'https://example.com/getQuote.json',
							createExchange: 'https://example.com/createExchange.json',
							getExchangeStatus: 'https://example.com/createVerification.json'
						},
						supportedAssets: [
							{
								asset: baseToken.publicKeyString.get(),
								paths: [
									{
										pair: [
											{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
										]
									}
								]
							},
							{
								asset: testCurrencyUSDC.publicKeyString.get(),
								paths: [
									{
										pair: [
										]
									}
								]
							}
						]
					},
					Test: {
						operations: {
							initiateTransfer: `${serverURL}/api/initiateTransfer`,
							getTransferStatus: `${serverURL}/api/getTransferStatus/{id}`,
							createPersistentForwarding: `${serverURL}/api/createPersistentForwarding`,
							listTransactions: `${serverURL}/api/listTransactions`
						},
						supportedAssets: [
							{
								asset: baseToken.publicKeyString.get(),
								paths: [
									{
										pair: [
											{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
											{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] }}
										]
									}
								]
							},
							{
								asset: testCurrencyUSDC.publicKeyString.get(),
								paths: [
									{
										pair: [
											{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }},
											{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { inbound: [ 'KEETA_SEND' ] }}
										]
									}
								]
							}
						]
					},
					Test2: {
						operations: {
							getTransferStatus: `${serverURL}/api/getTransferStatus/{id}`,
							createPersistentForwarding: `${serverURL}/api/createPersistentForwarding`
						},
						supportedAssets: [
							{
								asset: testCurrencyUSDC.publicKeyString.get(),
								paths: [
									{
										pair: [
											{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }},
											{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
										]
									}
								]
							}
						]
					}
				}
			}
		})
	});
	logger?.log('Set info results:', results);

	await expect(async function() {
		const noSignerUserClient = new  KeetaNet.UserClient({
			client: client.client,
			network: client.network,
			networkAlias: client.config.networkAlias,
			account: KeetaNet.lib.Account.fromPublicKeyString(account.publicKeyString.get()),
			signer: null,
			usePublishAid: false
		});
		// Should fail with no signer error
		new KeetaNetAnchor.AssetMovement.Client(noSignerUserClient, {
			root: account,
			...(logger ? { logger: logger } : {})
		});
	}).rejects.toThrow();

	const assetTransferClient = new KeetaNetAnchor.AssetMovement.Client(client, {
		root: account,
		signer: account,
		account: account,
		...(logger ? { logger: logger } : {})
	});

	const baseTokenProviderList = await assetTransferClient.getProvidersForTransfer({ asset: baseToken });
	if (baseTokenProviderList === null) {
		throw(new Error('Did not find any matching asset movement providers'));
	}
	expect(baseTokenProviderList.length).toBe(1);
	const baseTokenProvider = baseTokenProviderList[0];
	if (baseTokenProvider === undefined) {
		throw(new Error('Base token provider is undefined'));
	}

	const usdcTokenProviderList = await assetTransferClient.getProvidersForTransfer({ asset: testCurrencyUSDC });
	if (usdcTokenProviderList === null) {
		throw(new Error('Did not find any matching asset movement providers'));
	}
	expect(usdcTokenProviderList.length).toBe(2);
	const usdcTokenProvider = usdcTokenProviderList[1];
	if (usdcTokenProvider === undefined) {
		throw(new Error('USDC token provider is undefined'));
	}
	expect(Object.keys(usdcTokenProvider.serviceInfo.operations).length).toBe(2);

	const conversionTests = [
		{
			test: async function() { return((await assetTransferClient.resolver.listTransferableAssets()).sort()) },
			result: [testCurrencyUSDC.publicKeyString.get(), baseToken.publicKeyString.get()].sort()
		},
		{
			// @ts-expect-error
			test: async function() { return((await assetTransferClient.getProvidersForTransfer({}))?.length) },
			result: false
		},
		{
			test: async function() { return((await assetTransferClient.getProvidersForTransfer({ asset: testCurrencyEUR }))) },
			result: null
		},
		{
			test: async function() { return((await assetTransferClient.getProvidersForTransfer({ asset: baseToken, from: 'chain:keeta:123', to: 'chain:evm:100' }))?.length) },
			result: 1
		},
		{
			test: async function() { return((await assetTransferClient.getProvidersForTransfer({ asset: testCurrencyUSDC, from: 'chain:keeta:123', to: 'chain:evm:100' }))?.length) },
			result: 1
		},
		{
			test: async function() { return((await assetTransferClient.getProvidersForTransfer({ asset: testCurrencyUSDC, from: 'chain:evm:100', to: 'chain:keeta:123' }))?.length) },
			result: 2
		},
		{
			test: async function() { return((await assetTransferClient.getProvidersForTransfer({ asset: testCurrencyUSDC }))?.length) },
			result: 2
		},
		{
			test: async function() { return(await baseTokenProvider.createPersistentForwardingAddress({ asset: baseToken, destinationLocation: 'chain:keeta:100', destinationAddress: account.publicKeyString.get(), sourceLocation: 'chain:evm:100' })) },
			result: {
				ok: true,
				address: account.publicKeyString.get()
			}
		},
		{
			test: async function() {
				const transfer = await baseTokenProvider.initiateTransfer({ asset: baseToken, from: { location: 'chain:keeta:100' }, to: { location: 'chain:evm:100', recipient: account.publicKeyString.get() }, value: '100' });
				const transferStatus = await transfer.getTransferStatus();
				return({
					id: transfer.transferId,
					instructions: transfer.instructions,
					status: transferStatus
				})
			},
			result: {
				id: '123',
				instructions: [{
					type: 'KEETA_SEND',
					location: 'chain:keeta:100',

					sendToAddress: account.publicKeyString.get(),
					value: '100',
					tokenAddress: baseToken.publicKeyString.get(),

					external: `123:${account.publicKeyString.get()}`,  // encodeAssetMovementForward
					assetFee: '10'
				}],
				status: {
					ok: true,
					transaction: testTransaction
				}
			}
		},
		{
			test: async function() { return((await baseTokenProvider.getTransferStatus({ id: crypto.randomUUID() }))) },
			result: {
				ok: true,
				transaction: testTransaction
			}
		},
		{
			test: async function() { return((await baseTokenProvider.listTransactions({ persistentAddresses: [{ location: 'chain:evm:100', persistentAddress: account.publicKeyString.get() }] }))) },
			result: {
				ok: true,
				transactions: [testTransaction],
				total: '1'
			}
		},
		{
			// InitiateTransfer endpoint is missing from USDCProvider
			test: async function() { return((await usdcTokenProvider.initiateTransfer({ asset: baseToken, from: { location: 'chain:keeta:100' }, to: { location: 'chain:evm:100', recipient: account.publicKeyString.get() }, value: '100' }))) },
			result: false
		}
	];

	for (const test of conversionTests) {
		if (test.result === false) {
			await expect(test.test()).rejects.toThrow();
		} else {
			const result = await test.test();
			expect(result).toEqual(test.result);
		}
	}
});
