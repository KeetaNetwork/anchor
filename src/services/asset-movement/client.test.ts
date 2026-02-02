import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import type { ServiceMetadataExternalizable } from '../../lib/resolver.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { type KeetaAnchorAssetMovementServerConfig, KeetaNetAssetMovementAnchorHTTPServer } from './server.js';
import { Errors, type RailWithExtendedDetails, type KeetaAssetMovementAnchorCreatePersistentForwardingRequest, type KeetaAssetMovementAnchorCreatePersistentForwardingResponse, type KeetaAssetMovementAnchorGetTransferStatusResponse, type KeetaAssetMovementAnchorInitiateTransferClientRequest, type KeetaAssetMovementAnchorInitiateTransferRequest, type KeetaAssetMovementAnchorInitiateTransferResponse, type KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse, type KeetaAssetMovementAnchorlistTransactionsRequest, type KeetaAssetMovementTransaction, type ProviderSearchInput, toAssetPair, AssetOrPair, Rail } from './common.js';
import { Certificate, CertificateBuilder, SharableCertificateAttributes } from '../../lib/certificates.js';
import type { Routes } from '../../lib/http-server/index.js';
import { KeetaAnchorUserValidationError } from '../../lib/error.js';

const toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

const DEBUG = false;
const logger = DEBUG ? console : undefined;

const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';

test('Asset Movement Anchor Client Test', async function() {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	const { userClient: client } = await createNodeAndClient(account);

	const currentDateString = (new Date()).toISOString();

	const baseToken = client.baseToken;

	const { account: testCurrencyUSDC } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: testCurrencyEURC } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!testCurrencyUSDC.isToken() || !testCurrencyEURC.isToken()) {
		throw(new Error('USDC is not a token'));
	}
	const initialAccountUSDCBalance = 500000n;
	await client.modTokenSupplyAndBalance(initialAccountUSDCBalance, testCurrencyUSDC);

	const initialAccountBalanceUSDC = await client.balance(testCurrencyUSDC);
	expect(initialAccountBalanceUSDC).toEqual(initialAccountUSDCBalance);

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

	const extendedKeetaSendDetails: RailWithExtendedDetails = {
		rail: 'KEETA_SEND',
		estimatedTransferTimeMs: [ 1000, 2000 ],
		transferValueRange: {
			value: [ '100', '10000' ],
			asset: 'USD'
		},
		feeEstimate: {
			fixedFee: {
				value: '2',
				asset: 'USD'
			},
			variableFeeBps: 50
		},
		supportedOperations: {
			createPersistentForwarding: false,
			initiateTransfer: false
		}
	};

	function shouldOperationFailExtendedKeetaSend(inputAsset: AssetOrPair): boolean {
		const assetPair = toAssetPair(inputAsset);
		if (typeof assetPair.from !== 'string' || !(testCurrencyUSDC.comparePublicKey(assetPair.from)) || assetPair.to !== 'USD') {
			return(false);
		}

		return(true);
	}

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
								{ location: 'chain:keeta:123', id: baseToken.publicKeyString.get(), rails: { common: [ { rail: 'KEETA_SEND' } ] }},
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
								{ location: 'chain:keeta:123', id: testCurrencyUSDC.publicKeyString.get(), rails: { inbound: [ 'KEETA_SEND' ] }}
							]
						}
					]
				},
				{
					asset: [ testCurrencyUSDC.publicKeyString.get(), 'USD' ],
					paths: [
						{
							pair: [
								{ location: 'bank-account:us', id: 'USD', rails: { common: [ 'EVM_SEND' ] }},
								{
									location: 'chain:keeta:123',
									id: testCurrencyUSDC.publicKeyString.get(),
									rails: { inbound: [ extendedKeetaSendDetails ] }
								}
							]
						}
					]
				}
			],

			/**
			 * Method to create a persistent forwarding address
			 */
			createPersistentForwarding: async function(request: KeetaAssetMovementAnchorCreatePersistentForwardingRequest): Promise<Omit<Extract<KeetaAssetMovementAnchorCreatePersistentForwardingResponse, { ok: true }>, 'ok'>> {
				if (!('destinationAddress' in request)) {
					throw(new Error('Missing depositAddress in request'));
				}


				if (shouldOperationFailExtendedKeetaSend(request.asset)) {
					throw(new Errors.OperationNotSupported({
						operationName: 'createPersistentForwarding',
						forAsset: request.asset,
						forRail: extendedKeetaSendDetails.rail
					}));
				}

				return({
					address: request.destinationAddress
				})
			},

			/**
			 * Method to initiate a transfer
			 */
			initiateTransfer: async function(request: KeetaAssetMovementAnchorInitiateTransferRequest): Promise<Omit<Extract<KeetaAssetMovementAnchorInitiateTransferResponse, { ok: true }>, 'ok'>> {
				if (typeof request.to.recipient !== 'string') {
					throw(new Error('Recipient is not a string'));
				}

				if (shouldOperationFailExtendedKeetaSend(request.asset)) {
					throw(new Errors.OperationNotSupported({
						operationName: 'initiateTransfer',
						forAsset: 'USD',
						forRail: extendedKeetaSendDetails.rail
					}));
				}

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
							// @ts-expect-error
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
									// @ts-expect-error
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
										// @ts-expect-error
										pair: [ ]
									}
								]
							}
						]
					},
					// For some reason the type checker fails to recognize that this is the correct type here.
					// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-assignment
					Test: await server.serviceMetadata() as any,
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
											{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] }},
											{ location: 'chain:keeta:123', id: testCurrencyUSDC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
										]
									}
								]
							}
						]
					}
				}
			}
		} satisfies ServiceMetadataExternalizable)
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

	const getProviderTests: [ ProviderSearchInput, string[] ][] = [
		[ { asset: testCurrencyEURC }, [] ],
		[ { asset: baseToken, from: 'chain:keeta:123', to: 'chain:evm:100' }, [ 'Test' ] ],
		[ { asset: baseToken, from: 'chain:evm:100', to: 'chain:keeta:123' }, [ 'Test' ] ],
		[ { asset: baseToken }, [ 'Test' ] ],
		[ { asset: testCurrencyUSDC, from: 'chain:evm:100', to: 'chain:keeta:123' }, [ 'Test', 'Test2' ] ],
		[ { asset: testCurrencyUSDC, from: 'chain:evm:100', to: 'chain:keeta:123', rail: 'EVM_SEND' }, [ 'Test', 'Test2' ] ],
		[ { asset: testCurrencyUSDC, from: 'chain:evm:100', to: 'chain:keeta:123', rail: [ 'EVM_CALL' ] }, [ 'Test2' ] ],
		[ { asset: testCurrencyUSDC, from: 'chain:evm:100', to: 'chain:keeta:123', rail: [ 'EVM_CALL', 'EVM_SEND' ] }, [ 'Test', 'Test2' ] ],
		[ { asset: testCurrencyUSDC, from: 'chain:keeta:123', to: 'chain:evm:100', rail: [ 'EVM_CALL', 'EVM_SEND' ] }, [] ],
		[ { asset: testCurrencyUSDC, from: 'chain:keeta:123', to: 'chain:evm:100' }, [ 'Test', 'Test2' ] ],
		[ { asset: testCurrencyUSDC, from: 'chain:keeta:123', to: 'chain:evm:100', rail: 'KEETA_SEND' }, [ 'Test', 'Test2' ] ],
		[ { asset: testCurrencyUSDC }, [ 'Test', 'Test2' ] ],
		[ { asset: { from: testCurrencyUSDC, to: 'USD' }}, [ 'Test' ] ]
	];

	for (const [ input, expectedProviderIDs ] of getProviderTests) {
		const providers = await assetTransferClient.getProvidersForTransfer(input);
		const providerIDs = providers?.map((p) => p.providerID) ?? [];
		expect(providerIDs.sort()).toEqual(expectedProviderIDs.sort());
	}


	const baseTokenProviderList = await assetTransferClient.getProvidersForTransfer({ asset: baseToken });
	const baseTokenProvider = baseTokenProviderList?.[0];
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
			test: async function() { return((await assetTransferClient.getProviderByID('bad')) === null) },
			result: true
		},
		{
			test: async function() { return((await assetTransferClient.getProviderByID('Test')) !== null) },
			result: true
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

	{
		/**
		 * Test that extended rail details gets encoded/decoded correctly
		 */
		const testProvider = await assetTransferClient.getProviderByID('Test');

		const supportedAssetWithDetails = testProvider?.serviceInfo.supportedAssets.find(function(asset) {
			return(asset.asset[0] === testCurrencyUSDC.publicKeyString.get() && asset.asset[1] === 'USD');
		})

		if (!supportedAssetWithDetails) {
			throw(new Error('Supported asset with details not found'));
		}

		expect(supportedAssetWithDetails.paths[0]?.pair[1].rails.inbound?.[0]).toEqual(extendedKeetaSendDetails);

		for (const [ method, expectedArguments ] of [
			[
				() => testProvider?.createPersistentForwardingAddress({
					asset: { from: testCurrencyUSDC, to: 'USD' },
					destinationLocation: 'chain:keeta:123',
					destinationAddress: 'test-address',
					sourceLocation: 'bank-account:us'
				}),
				{
					operationName: 'createPersistentForwarding',
					forAsset: { from: testCurrencyUSDC, to: 'USD' },
					forRail: 'KEETA_SEND'
				}
			],
			[
				() => testProvider?.initiateTransfer({
					asset: { from: testCurrencyUSDC, to: 'USD' },
					from: { location: 'bank-account:us' },
					to: { location: 'chain:keeta:123', recipient: 'test-recipient' },
					value: '1000'
				}),
				{
					operationName: 'initiateTransfer',
					forAsset: 'USD',
					forRail: 'KEETA_SEND'
				}
			]
		] as const) {
			let error = null;
			try {
				await method();
			} catch (e) {
				error = e;
			}

			if (!(error instanceof Errors.OperationNotSupported)) {
				throw(new Error('Expected OperationNotSupported error'));
			}

			expect(toJSONSerializable({
				operationName: error.operationName,
				forAsset: error.forAsset,
				forRail: error.forRail
			})).toEqual(toJSONSerializable(({
				operationName: expectedArguments.operationName,
				forAsset: expectedArguments.forAsset,
				forRail: expectedArguments.forRail
			})));
		}
	}
});

test('Asset Movement Anchor Authenticated Client Test', async function() {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
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

	const initialAccountBalanceUSDC = await client.balance(testCurrencyUSDC);
	expect(initialAccountBalanceUSDC).toEqual(initialAccountUSDCBalance);

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

	const kycCertificateIssuer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const kycSharePrincipal = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);


	const userKYCNeeded = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const userAdditionalKYCNeeded = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const promisePolling: { [key: string]: number } = {};

	await using server = new (class extends KeetaNetAssetMovementAnchorHTTPServer {
		protected async initRoutes(config: KeetaAnchorAssetMovementServerConfig): Promise<Routes> {
			const routes = await super.initRoutes(config);
			routes['GET /_promises/:promiseID'] = async (params) => {
				const pid = params.get('promiseID');
				if (!pid) {
					throw(new Error('Missing promise ID'));
				}

				if (pid.includes('error')) {
					throw(new KeetaAnchorUserValidationError({
						fields: [{
							path: 'firstName',
							message: 'Invalid first name provided'
						}]
					}));
				}

				if (!promisePolling[pid]) {
					promisePolling[pid] = 0;
				}
				const newCount = promisePolling[pid]++;

				if (newCount < 2) {
					return({
						ok: true,
						statusCode: 202,
						output: 'pending',
						headers: {
							'Retry-After': '0.1'
						}
					})
				}

				return({
					ok: true,
					output: 'ok'
				});
			}
			return(routes);
		}
	})({
		...(logger ? { logger: logger } : {}),
		client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
		assetMovement: {
			authenticationRequired: true,

			/**
			 * Supported assets and their configurations
			 */
			supportedAssets: [
				{
					asset: testCurrencyUSDC.publicKeyString.get(),
					paths: [
						{
							pair: [
								{ location: `chain:keeta:${client.network}`, id: testCurrencyUSDC.publicKeyString.get(), rails: { inbound: [ 'ACH' ] }},
								{ location: 'bank-account:us', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { inbound: [ 'KEETA_SEND' ] }}
							]
						}
					]
				}
			],

			/**
			 * Method to create a persistent forwarding address
			 */
			createPersistentForwarding: async function(request: KeetaAssetMovementAnchorCreatePersistentForwardingRequest): Promise<Omit<Extract<KeetaAssetMovementAnchorCreatePersistentForwardingResponse, { ok: true }>, 'ok'>> {
				if (!('destinationAddress' in request)) {
					throw(new Error('Missing depositAddress in request'));
				}

				return({
					address: request.destinationAddress
				})
			},

			/**
			 * Method to initiate a transfer
			 */
			initiateTransfer: async function(request: KeetaAssetMovementAnchorInitiateTransferRequest): Promise<Omit<Extract<KeetaAssetMovementAnchorInitiateTransferResponse, { ok: true }>, 'ok'>> {
				if (typeof request.to.recipient !== 'string') {
					throw(new Error('Recipient is not a string'));
				}

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
			getTransferStatus: async function(_ignored_id: string, account): Promise<Omit<Extract<KeetaAssetMovementAnchorGetTransferStatusResponse, { ok: true }>, 'ok'>> {
				if (!account) {
					throw(new Error('Missing account authentication'));
				}

				if (userKYCNeeded.comparePublicKey(account)) {
					throw(new Errors.KYCShareNeeded({
						shareWithPrincipals: [ kycSharePrincipal ],
						neededAttributes: [ 'firstName' ],
						acceptedIssuers: [ [ { name: 'iss', value: 'testSubjectDN' } ] ],
						tosFlow: {
							type: 'url-flow',
							url: 'https://example.com/tos'
						}
					}));
				}

				if (userAdditionalKYCNeeded.comparePublicKey(account)) {
					throw(new Errors.AdditionalKYCNeeded({
						toCompleteFlow: {
							type: 'url-flow',
							url: 'https://example.com/tos'
						}
					}, 'User requires additional KYC to proceed with asset movement'));
				}

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
			},

			shareKYC: async function(request) {
				const attributes = new SharableCertificateAttributes(request.attributes, { principals: [ kycSharePrincipal ] });

				const firstName = await attributes.getAttribute('firstName');

				if (firstName?.includes('promise')) {
					return({
						isPending: true,
						promiseURL: `/_promises/${firstName}`
					});
				} else if (firstName === 'Alice') {
					return({});
				} else  {
					throw(new Error(`Invalid first name, got ${firstName}`));
				}
			}
		}
	});


	/*
	 * Start the Asset Movement Anchor Server and get the URL
	 */
	await server.start();

	const results = await client.setInfo({
		description: 'Asset Movement Anchor Test Root',
		name: 'TEST',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				assetMovement: { Test: await server.serviceMetadata() }
			}
		} satisfies ServiceMetadataExternalizable)
	});
	logger?.log('Set info results:', results);

	const assetMovementClient = new KeetaNetAnchor.AssetMovement.Client(client, {
		root: account,
		signer: account,
		account: account,
		...(logger ? { logger: logger } : {})
	});

	const listedProviders = await assetMovementClient.getProvidersForTransfer({
		from: { type: 'chain', chain: { type: 'keeta', networkId: client.network }},
		to: { type: 'bank-account', account: { type: 'us' }},
		asset: testCurrencyUSDC
	});

	const usdcProvider = listedProviders?.[0];
	if (listedProviders?.length !== 1 || !usdcProvider) {
		throw(new Error('Did not find any matching asset movement providers'));
	}

	await expect(usdcProvider.getTransferStatus({ id: '555' })).rejects.toThrow(); // Invalid ID format
	expect(await usdcProvider.getTransferStatus({ id: '555', account })).toEqual({
		ok: true,
		transaction: testTransaction
	});

	const initiateTransferRequest: KeetaAssetMovementAnchorInitiateTransferClientRequest = {
		asset: testCurrencyUSDC,
		from: { location: `chain:keeta:${client.network}` },
		to: { location: 'bank-account:us', recipient: 'account-123' },
		value: '100'
	};
	await expect(usdcProvider.initiateTransfer(initiateTransferRequest)).rejects.toThrow(); // Invalid ID format
	expect((await usdcProvider.initiateTransfer({ ...initiateTransferRequest, account })).transferId).toEqual('123');

	async function makeCertificate(name: string) {
		const certificateBuilder = new CertificateBuilder({
			subject: account,
			subjectDN: [{ name: 'commonName', value: 'KYC Verified User' }],
			issuer: kycCertificateIssuer,
			serial: 3,
			validFrom: new Date(Date.now() - 30_000),
			validTo: new Date(Date.now() + 120_000)
		});
		certificateBuilder.setAttribute('firstName', true, name);
		const certificate = await certificateBuilder.build();
		const certificateWithPrivate = new Certificate(certificate.toDER(), { subjectKey: account });
		const sharable = await SharableCertificateAttributes.fromCertificate(certificateWithPrivate);
		await sharable.grantAccess(kycSharePrincipal);

		return({ name: name, sharable, certificate });
	}

	const invalidNameCert = await makeCertificate('Invalid Name');

	await expect(async function() {
		await usdcProvider.shareKYCAttributes({
			account: account,
			attributes: invalidNameCert.sharable
		});
	}).rejects.toThrow();

	{
		const hasPromiseCert = await makeCertificate('testpromise');
		await usdcProvider.shareKYCAttributes({
			account: account,
			attributes: hasPromiseCert.sharable
		});

		expect(promisePolling['testpromise']).toEqual(3);
	}

	{
		const abortSignal = AbortSignal.abort();

		const hasPromiseCert = await makeCertificate('testpromiseabort');
		await usdcProvider.shareKYCAttributes({
			account: account,
			attributes: hasPromiseCert.sharable
		}, {
			abortSignal: abortSignal
		});

		expect(promisePolling['testpromiseabort'] ?? 0).toEqual(0);
	}


	{
		const hasPromiseCert = await makeCertificate('promiseerror');

		let caughtError;
		try {
			await usdcProvider.shareKYCAttributes({
				account: account,
				attributes: hasPromiseCert.sharable
			});
			throw(new Error('Expected error was not thrown'));
		} catch (error) {
			caughtError = error;
		}

		if (!(caughtError instanceof KeetaAnchorUserValidationError)) {
			throw(new Error('Expected KeetaAnchorUserValidationError'));
		}

		expect(caughtError.fields[0]?.path).toEqual('firstName');
	}

	const validNameCert = await makeCertificate('Alice');
	await usdcProvider.shareKYCAttributes({
		account: account,
		attributes: validNameCert.sharable
	});

	{
		let kycNeededError;
		try {
			await usdcProvider.getTransferStatus({ id: '555', account: userKYCNeeded });
		} catch (error) {
			kycNeededError = error;
		}

		if (!(kycNeededError instanceof Errors.KYCShareNeeded)) {
			throw(new Error('Expected KYCShareNeeded error'));
		}

		expect(kycNeededError.neededAttributes).toEqual([ 'firstName' ]);
		expect(kycNeededError.acceptedIssuers.length).toEqual(1);
		expect(kycNeededError.acceptedIssuers).toEqual([[{ name: 'iss', value: 'testSubjectDN' }]]);
		expect(kycNeededError.shareWithPrincipals.length).toEqual(1);
		expect(kycNeededError.shareWithPrincipals[0]?.comparePublicKey(kycSharePrincipal)).toEqual(true);
		expect(kycNeededError.tosFlow).toEqual({
			type: 'url-flow',
			url: 'https://example.com/tos'
		});
	}

	{
		let additionalNeededError;
		try {
			await usdcProvider.getTransferStatus({ id: '555', account: userAdditionalKYCNeeded });
		} catch (error) {
			additionalNeededError = error;
		}

		if (!(additionalNeededError instanceof Errors.AdditionalKYCNeeded)) {
			throw(new Error('Expected AdditionalKYCNeeded error'));
		}

		expect(additionalNeededError.toCompleteFlow).toEqual({
			type: 'url-flow',
			url: 'https://example.com/tos'
		});
	}
});
