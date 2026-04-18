import { test, expect, describe } from 'vitest';
import { createNodeAndClient } from './utils/tests/node.js';
import { KeetaNet } from '../client/index.js';
import { KeetaNetAssetMovementAnchorHTTPServer, type KeetaAnchorAssetMovementServerConfig } from '../services/asset-movement/server.js';
import { convertAssetLocationToString, toAssetLocation, toAssetPair, type AssetLocationLike, type KeetaAssetMovementTransaction } from '../services/asset-movement/common.js';
import { KeetaNetFXAnchorHTTPServer, type KeetaAnchorFXServerConfig, type GetConversionRateAndFeeContext, type KeetaFXInternalPriceQuote } from '../services/fx/server.js';
import type { ConversionInputCanonicalJSON } from '../services/fx/common.js';
import { Resolver } from './index.js';
import type { ServiceMetadataExternalizable } from './resolver.js';
import { AnchorChaining, AnchorChainingPlan } from './chaining.js';
import type { AnchorChainingPathState, ExecutedStep, AnchorChainingAsset, AnchorChainingAssetInfo } from './chaining.js';
import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { KeetaAnchorUserError } from './error.js';
import { BlockListener } from './block-listener.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

const toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

type InitiateTransferFn = NonNullable<KeetaAnchorAssetMovementServerConfig['assetMovement']['initiateTransfer']>;
type RateFn = (request: ConversionInputCanonicalJSON, context: GetConversionRateAndFeeContext) => Promise<KeetaFXInternalPriceQuote>;

class TestBankServer extends KeetaNetAssetMovementAnchorHTTPServer {
	private readonly _initiateRef: { fn: InitiateTransferFn };
	#defaultInitiateRef: { fn: InitiateTransferFn; };
	private readonly _statusMap: Map<string, KeetaAssetMovementTransaction>;
	private readonly _getStatusRef: { interceptor: (() => void) | null };

	constructor(config: Omit<KeetaAnchorAssetMovementServerConfig, 'assetMovement'> & {
		assetMovement: Omit<KeetaAnchorAssetMovementServerConfig['assetMovement'], 'initiateTransfer' | 'getTransferStatus'>;
		client: KeetaNet.UserClient;
	}) {
		const { client: userClient, ...serverConfig } = config;

		const bankAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

		const statusMap = new Map<string, KeetaAssetMovementTransaction>();
		const blockListener = new BlockListener({ client: userClient.client });
		const getStatusRef: { interceptor: (() => void) | null } = { interceptor: null };

		const initiateRef: { fn: InitiateTransferFn } = {
			fn: async (request) => {
				const value = BigInt(request.value);
				const fee = 10n;
				const receive = value - fee;
				const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;

				const parsedFrom = toAssetLocation(request.from.location);
				if (parsedFrom.type === 'chain' && parsedFrom.chain.type === 'keeta') {
					const assetPair = toAssetPair(request.asset);

					statusMap.set(txId, {
						id: txId,
						status: 'PENDING',
						asset: request.asset,
						from: { location: request.from.location, value: value.toString(), transactions: { deposit: null, persistentForwarding: null, finalization: null }},
						to:   { location: request.to.location,   value: receive.toString(), transactions: { withdraw: null }},
						fee: null,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});

					let listenerHandle: { remove: () => void } | null = null;
					listenerHandle = blockListener.on('block', {
						callback: async ({ block }) => {
							for (const op of block.operations) {
								if (op.type === KeetaNet.lib.Block.OperationType.SEND && op.external === txId) {
									if (op.amount !== value) {
										throw(new KeetaAnchorUserError(`Invalid transfer amount: expected ${value}, got ${op.amount}`));
									}
									const existing = statusMap.get(txId);
									if (existing && existing.status !== 'COMPLETED') {
										statusMap.set(txId, { ...existing, status: 'COMPLETED', updatedAt: new Date().toISOString() });
									}
									listenerHandle?.remove();
									return({ requiresWork: false });
								}
							}
							return({ requiresWork: false });
						}
					});

					const tokenAddress = assetPair.from;
					if (typeof tokenAddress !== 'string') {
						throw(new Error('invalid keeta send asset'));
					}

					return({
						id: txId,
						instructionChoices: [{
							type: 'KEETA_SEND' as const,
							location: request.from.location,
							sendToAddress: bankAccount.publicKeyString.get(),
							external: txId,
							value: value.toString(),
							tokenAddress: KeetaNet.lib.Account.fromPublicKeyString(tokenAddress)
								.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
								.publicKeyString.get(),
							assetFee: fee.toString(),
							totalReceiveAmount: receive.toString()
						}]
					});
				} else {
					statusMap.set(txId, {
						id: txId,
						status: 'COMPLETED',
						asset: request.asset,
						from: { location: request.from.location, value: value.toString(), transactions: { deposit: null, persistentForwarding: null, finalization: null }},
						to:   { location: request.to.location,   value: receive.toString(), transactions: { withdraw: null }},
						fee: null,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
					return({
						id: txId,
						instructionChoices: [{
							type: 'ACH',
							account: {
								type: 'bank-account',
								accountType: 'us',
								accountNumber: `test-acct-${txId}`,
								routingNumber: '021000021',
								accountTypeDetail: 'checking',
								accountOwner: { type: 'business', businessName: 'TestBank' }
							} as const,
							value: value.toString(),
							assetFee: fee.toString(),
							totalReceiveAmount: receive.toString()
						}]
					});
				}
			}
		};

		super({
			...serverConfig,
			assetMovement: {
				...serverConfig.assetMovement,
				initiateTransfer: async (request) => {
					// Status management is handled inside initiateRef.fn per direction.
					return(await initiateRef.fn(request));
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				getTransferStatus: async (id: string): Promise<any> => {
					// Allow tests to arm a one-shot failure for the next status poll.
					const interceptor = getStatusRef.interceptor;
					if (interceptor) {
						getStatusRef.interceptor = null;
						interceptor();
					}
					// Scan recent blocks to detect any KEETA_SEND that completes a pending transfer.
					await blockListener.scan();
					const tx = statusMap.get(id);
					if (!tx) {throw(new Error(`Unknown transfer ID: ${id}`));}
					return({ transaction: tx });
				}
			}
		});

		// Store references to the shared objects so instance methods can mutate them.
		this._initiateRef = initiateRef;
		this.#defaultInitiateRef = { ...initiateRef };
		this._statusMap   = statusMap;
		this._getStatusRef = getStatusRef;
	}

	setInitiateTransfer(fn: InitiateTransferFn | null): this {
		if (!fn) {
			fn = this.#defaultInitiateRef.fn;
		}

		this._initiateRef.fn = fn;

		return(this);
	}

	setFee(fee: bigint): this {
		return(this.setInitiateTransfer(async (request) => {
			const value = BigInt(request.value);
			const receive = value - fee;
			const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			this._statusMap.set(txId, {
				id: txId,
				status: 'COMPLETED',
				asset: request.asset,
				from: { location: request.from.location, value: value.toString(), transactions: { deposit: null, persistentForwarding: null, finalization: null }},
				to:   { location: request.to.location,   value: receive.toString(), transactions: { withdraw: null }},
				fee: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			});

			if (typeof request.to.recipient !== 'string') {
				throw(new Error('invalid keeta send recipient'));
			}

			const assetPair = toAssetPair(request.asset);

			const tokenAddress = assetPair.from;

			if (typeof tokenAddress !== 'string') {
				throw(new Error('invalid keeta send asset'));
			}

			return({
				id: txId,
				instructionChoices: [{
					type: 'KEETA_SEND' as const,
					location: request.from.location,
					sendToAddress: KeetaNet.lib.Account.fromPublicKeyString(request.to.recipient).publicKeyString.get(),
					value: value.toString(),
					tokenAddress: KeetaNet.lib.Account.fromPublicKeyString(tokenAddress)
						.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
						.publicKeyString.get(),
					assetFee: fee.toString(),
					totalReceiveAmount: receive.toString()
				}]
			});
		}));
	}

	/** Arm the server so the next initiateTransfer call throws (then restores). */
	failNextInitiate(message = 'Transfer initiation failed'): this {
		const saved = this._initiateRef.fn;
		this._initiateRef.fn = async () => {
			this._initiateRef.fn = saved;
			throw(new KeetaAnchorUserError(message));
		};
		return(this);
	}

	/** Arm the server so the next getTransferStatus call throws (then restores). */
	failNextTransferStatus(message = 'Transfer status check failed'): this {
		this._getStatusRef.interceptor = () => { throw(new KeetaAnchorUserError(message)); };
		return(this);
	}

	/** Manually update the status of an in-flight transfer. */
	setTransferStatus(id: string, update: Partial<Pick<KeetaAssetMovementTransaction, 'status'>>): this {
		const existing = this._statusMap.get(id);
		if (!existing) {throw(new Error(`Unknown transfer ID: ${id}`));}
		this._statusMap.set(id, { ...existing, ...update, updatedAt: new Date().toISOString() });
		return(this);
	}
}

type TestFXServerConfig = Omit<KeetaAnchorFXServerConfig, 'fx'> & {
	fx: Pick<KeetaAnchorFXServerConfig['fx'], 'from'>;
	giveTokens: (to: GenericAccount, amount: bigint, token: TokenAddress) => Promise<void>;
	/** Must be a UserClient so we can read LP balances and mint tokens on demand. */
	client: KeetaNet.UserClient;
};

class TestFXServer extends KeetaNetFXAnchorHTTPServer {
	private readonly _rateRef: { fn: RateFn };
	private readonly _giveTokens: (to: GenericAccount, amount: bigint, token: TokenAddress) => Promise<void>;
	private readonly _keetaClient: KeetaNet.UserClient;
	private readonly _lp: InstanceType<typeof KeetaNet.lib.Account>;

	constructor(config: TestFXServerConfig) {
		// Resolve the LP from the accounts set
		const lp = config.accounts?.values().next().value;
		if (!lp) {
			throw(new Error('TestFXServer requires at least one account in the accounts set'));
		}

		const giveTokens = config.giveTokens;
		const keetaClient = config.client;

		// Shared rate ref captured by the super() closure
		const rateRef: { fn: RateFn } = {
			fn: async (request) => {
				const rate = request.affinity === 'to' ? 1 / 0.88 : 0.88;
				const convertedAmount = BigInt(Math.round(Number(request.amount) * rate));
				const balance = await keetaClient.client.getBalance(lp, request.to);
				if (balance < convertedAmount * 2n) {
					const token = KeetaNet.lib.Account.fromPublicKeyString(request.to).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
					await giveTokens(lp, convertedAmount * 2n, token);
				}
				return({
					account: lp,
					convertedAmount,
					cost: { amount: 0n, token: KeetaNet.lib.Account.fromPublicKeyString(request.from).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN) }
				});
			}
		};

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { giveTokens: _gt, client: _userClient, quoteSigner: _qs, ...baseConfig } = config;

		// Pass the raw client config (not a UserClient) so the server uses the else-branch in
		// its processor: it picks up config.signer (= LP) to build an LP-scoped UserClient itself.
		const rawClient = {
			client: keetaClient.client,
			network: keetaClient.network,
			networkAlias: keetaClient.config.networkAlias
		};

		super({
			...baseConfig,
			quoteSigner: null,
			quoteConfiguration: { requiresQuote: false, validateQuoteBeforeExchange: false, issueQuotes: false },
			client: rawClient,
			fx: {
				...config.fx,
				getConversionRateAndFee: (request, context) => rateRef.fn(request, context)
			} satisfies KeetaAnchorFXServerConfig['fx']
		});

		this._rateRef      = rateRef;
		this._giveTokens   = giveTokens;
		this._keetaClient  = keetaClient;
		this._lp           = lp;
	}

	/** Set a fixed exchange rate (forward direction; reverse is 1/rate). */
	setRate(rate: number): this {
		const lp          = this._lp;
		const giveTokens  = this._giveTokens;
		const keetaClient = this._keetaClient;
		this._rateRef.fn = async (request, context) => {
			const effectiveRate   = request.affinity === 'to' ? 1 / rate : rate;
			const convertedAmount = BigInt(Math.round(Number(request.amount) * effectiveRate));
			const balance = await keetaClient.client.getBalance(lp, request.to);
			if (context.purpose === 'exchange' || context.purpose === 'quote') {
				if (balance < convertedAmount * 2n) {
					const token = KeetaNet.lib.Account.fromPublicKeyString(request.to).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
					await giveTokens(lp, convertedAmount * 2n, token);
				}
			}
			return({
				account: lp,
				convertedAmount,
				cost: { amount: 0n, token: KeetaNet.lib.Account.fromPublicKeyString(request.from).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN) }
			});
		};
		return(this);
	}

	/** Replace the full conversion handler. */
	setGetConversionRateAndFee(fn: RateFn): this {
		this._rateRef.fn = fn;
		return(this);
	}

	/**
	 * Arm so the next estimate-phase call throws during createExchange.
	 * computeSteps() calls getEstimate BEFORE arming so it succeeds.
	 * execute() -> createExchange() hits getUnsignedQuoteData(purpose='estimate')
	 * BEFORE queuing, so the failure propagates immediately to the client.
	 */
	failNextExchange(message = 'FX exchange failed'): this {
		const saved = this._rateRef.fn;
		this._rateRef.fn = async (request, context) => {
			if (context.purpose === 'estimate') {
				this._rateRef.fn = saved;
				throw(new KeetaAnchorUserError(message));
			}
			return(await saved(request, context));
		};
		return(this);
	}
}

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
						token: KeetaNet.lib.Account.fromPublicKeyString(request.from).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
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

	const paths = await anchorChaining.getPaths({
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

	expect(path.path.length).toEqual(3);

	expect(toJSONSerializable([
		{
			providerID: 'BankAnchor',
			type: 'assetMovement',
			from: { asset: 'USD', location: 'bank-account:us', rail: 'ACH' },
			to: { asset: tokens.USDC, location: keetaLocation, rail: 'KEETA_SEND' }
		},
		{
			from: { asset: tokens.USDC, location: keetaLocation, rail: 'KEETA_SEND' },
			providerID: 'FXOne',
			type: 'fx',
			to: { asset: tokens.EURC, location: keetaLocation, rail: 'KEETA_SEND' }
		},
		{
			providerID: 'BankAnchor',
			type: 'assetMovement',
			from: { asset: tokens.EURC, location: keetaLocation, rail: 'KEETA_SEND' },
			to: { asset: 'EUR', location: 'bank-account:iban-swift', rail: 'SEPA_PUSH' }
		}
	])).toEqual(toJSONSerializable(path.path));
});

async function createChainingTestHarness() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client, fees } = await createNodeAndClient(account);

	const makeToken = async () => {
		const { account } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		await client.setInfo(
			{ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS']) },
			{ account }
		);
		return(account.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
	};

	const giveTokens = async (to: GenericAccount, amount: bigint, token: TokenAddress) => {
		await client.modTokenSupplyAndBalance(amount, token, { account: to });
	};

	const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;
	const tokens = { USDC: await makeToken(), EURC: await makeToken() };

	const fxLPOne  = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const fxLPTwo  = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const bankServerUS = new TestBankServer({
		...(DEBUG ? { logger } : {}),
		client,
		assetMovement: {
			supportedAssets: [{
				asset: [ tokens.USDC.publicKeyString.get(), 'USD' ],
				paths: [{ pair: [
					{ location: 'bank-account:us', id: 'USD', rails: { common: [ 'ACH' ] }},
					{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
				] }]
			}]
		}
	});

	const bankServerEU = new TestBankServer({
		...(DEBUG ? { logger } : {}),
		client,
		assetMovement: {
			supportedAssets: [{
				asset: [ tokens.EURC.publicKeyString.get(), 'EUR' ],
				paths: [{ pair: [
					{ location: 'bank-account:iban-swift', id: 'EUR', rails: { common: [ 'SEPA_PUSH' ] }},
					{ location: keetaLocation, id: tokens.EURC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
				] }]
			}]
		}
	});

	// fxServerOne: 0.88 rate (primary)
	const fxServerOne = new TestFXServer({
		...(DEBUG ? { logger } : {}),
		quoteSigner: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		accounts: new KeetaNet.lib.Account.Set([ fxLPOne ]),
		signer: fxLPOne,
		client,
		giveTokens,
		fx: {
			from: [{ currencyCodes: [ tokens.USDC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ], to: [ tokens.USDC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ] }]
		}
	});

	// fxServerTwo: 0.85 rate (alternative, slightly worse)
	const fxServerTwo = new TestFXServer({
		...(DEBUG ? { logger } : {}),
		quoteSigner: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		accounts: new KeetaNet.lib.Account.Set([ fxLPTwo ]),
		signer: fxLPTwo,
		client,
		giveTokens,
		fx: {
			from: [{ currencyCodes: [ tokens.USDC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ], to: [ tokens.USDC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ] }]
		}
	}).setRate(0.85);

	await bankServerUS.start();
	await bankServerEU.start();
	await fxServerOne.start();
	await fxServerTwo.start();

	// Make FX LPs fee-free so they don't need KTA to execute exchanges
	fees.addFeeFreeAccount(fxLPOne);
	fees.addFeeFreeAccount(fxLPTwo);

	await client.setInfo({
		description: 'Chaining Test',
		name: 'TEST',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: { '$USDC': tokens.USDC.publicKeyString.get(), '$EURC': tokens.EURC.publicKeyString.get() },
			services: {
				fx: {
					FXOne: await fxServerOne.serviceMetadata(),
					FXTwo: await fxServerTwo.serviceMetadata()
				},
				assetMovement: {
					BankUS: await bankServerUS.serviceMetadata(),
					BankEU: await bankServerEU.serviceMetadata()
				}
			}
		} satisfies ServiceMetadataExternalizable)
	});

	const anchorChaining = new AnchorChaining({
		client,
		resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
	});

	const getPathVia = async (fxProviderID: 'FXOne' | 'FXTwo', affinity: 'to' | 'from' = 'from') => {
		const paths = await anchorChaining.getPaths({
			source: { asset: tokens.USDC, location: keetaLocation, rail: 'KEETA_SEND', ...(affinity === 'from' ? { value: 100n } : {}) },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: client.account.publicKeyString.get(), rail: 'SEPA_PUSH', ...(affinity === 'to' ? { value: 100n } : {}) }
		});
		const path = paths?.find(p => p.path.some(n => n.type === 'fx' && n.providerID === fxProviderID));
		if (!path) {
			throw(new Error(`No path found using ${fxProviderID}`));
		}
		return(path);
	};

	const getPlanVia = async (fxProviderID: 'FXOne' | 'FXTwo') => {
		const plans = await anchorChaining.getPlans({
			source: { asset: tokens.USDC, location: keetaLocation, value: 100n, rail: 'KEETA_SEND' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: client.account.publicKeyString.get(), rail: 'SEPA_PUSH' }
		});

		const path = plans?.find(p => p.plan.steps.some(n => n.type === 'fx' && n.step.providerID === fxProviderID));

		if (!path) {
			throw(new Error(`No path found using ${fxProviderID}`));
		}

		return(path);
	};

	return({
		client,
		fees,
		tokens,
		keetaLocation,
		bankServerUS,
		bankServerEU,
		fxServerOne,
		fxServerTwo,
		anchorChaining,
		giveTokens,
		getPlanVia,
		getPathVia,
		[Symbol.asyncDispose]: async function() {
			await bankServerUS[Symbol.asyncDispose]?.();
			await bankServerEU[Symbol.asyncDispose]?.();
			await fxServerOne[Symbol.asyncDispose]?.();
			await fxServerTwo[Symbol.asyncDispose]?.();
		}
	});
}

describe('AnchorChainingPath computeSteps', function() {
	test.each([
		{ providerID: 'FXOne' as const, expectedFxOut: 88n, totalOut: 78n },
		{ providerID: 'FXTwo' as const, expectedFxOut: 85n, totalOut: 75n }
	])('FX rate comparison: $providerID', async function({ providerID, expectedFxOut, totalOut }) {
		await using h = await createChainingTestHarness();
		const path = await h.getPlanVia(providerID);

		expect(path.plan.steps.length).toEqual(2);
		expect(path.plan.totalValueIn).toEqual(100n);
		expect(path.plan.totalValueOut).toEqual(totalOut);

		const fxStep = path.plan.steps.find(s => s.type === 'fx');
		if (fxStep?.type === 'fx') {expect(fxStep.valueOut).toEqual(expectedFxOut);}

		for (let i = 0; i < path.plan.steps.length - 1; i++) {
			const valueOut = path.plan.steps[i]?.valueOut;
			const valueIn = path.plan.steps[i + 1]?.valueIn;
			if (!valueIn || !valueOut) {
				throw(new Error(`Missing valueIn or valueOut for step ${i}`));
			}
			expect(valueOut).toEqual(valueIn);
		}
	});

	test('affinity:to is unsupported for paths with AM steps', async function() {
		await using h = await createChainingTestHarness();
		const path = await h.getPathVia('FXOne', 'to');
		await expect(AnchorChainingPlan.create(path)).rejects.toThrow('not currently supported for asset movement steps');
	});

	test('BankEU initiateTransfer failure propagates from computeSteps', async function() {
		await using h = await createChainingTestHarness();
		h.bankServerEU.failNextInitiate('Bank EU initiate failed');
		const path = await h.getPathVia('FXOne');
		await expect(AnchorChainingPlan.create(path)).rejects.toThrow('Bank EU initiate failed');
	});

	test('AM->FX chaining is unsupported', async function() {
		await using h = await createChainingTestHarness();
		const paths = await h.anchorChaining.getPaths({
			source: { asset: 'USD', location: 'bank-account:us', value: 100n, rail: 'ACH' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: h.client.account.publicKeyString.get(), rail: 'SEPA_PUSH' }
		});
		const threeStepPath = paths?.find(p => p.path.length === 3);
		if (!threeStepPath) {throw(new Error('No 3-step path found'));}
		await expect(AnchorChainingPlan.create(threeStepPath)).rejects.toThrow('Cannot currently chain from asset movement to fx step');
	});
});

describe('AnchorChainingPath computeSteps for fx with "to" affinity', function() {
	test('destination.value on FX-only path computes correct values', async function() {
		await using h = await createChainingTestHarness();

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: 100n }
		});

		const plan = plans?.find(p => p.path.length === 1 && p.path[0]?.type === 'fx' && p.path[0]?.providerID === 'FXOne');
		if (!plan) { throw(new Error('No single-step FX path found')); }

		const result = plan.plan

		expect(result.steps.length).toEqual(1);
		expect(result.totalValueOut).toEqual(100n);
		expect(result.totalValueIn).toEqual(114n);
	});

	test.each([
		{ providerID: 'FXOne' as const, expectedValueIn: 114n },
		{ providerID: 'FXTwo' as const, expectedValueIn: 118n }
	])('destination.value FX-only path via $providerID', async function({ providerID, expectedValueIn }) {
		await using h = await createChainingTestHarness();

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: 100n }
		});

		const plan = plans?.find(p => p.path.some(n => n.type === 'fx' && n.providerID === providerID));
		if (!plan) { throw(new Error(`No FX path found for ${providerID}`)); }

		const result = plan.plan

		expect(result.totalValueOut).toEqual(100n);
		expect(result.totalValueIn).toEqual(expectedValueIn);
	});

	test('destination.value FX-only path with different amount chains backward correctly', async function() {
		await using h = await createChainingTestHarness();

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: 50n }
		});

		const plan = plans?.find(p => p.path.length === 1 && p.path[0]?.providerID === 'FXOne');
		if (!plan) { throw(new Error('No FX path found')); }

		const result = plan.plan

		expect(result.totalValueIn).toEqual(57n);
		expect(result.totalValueOut).toEqual(50n);

		for (let i = 0; i < result.steps.length - 1; i++) {
			expect(result.steps[i]?.valueOut).toEqual(result.steps[i + 1]?.valueIn);
		}
	});
})

describe('AnchorChainingPath execute with destination.value (to affinity)', function() {
	test('FX-only path: executes successfully with correct amounts', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: 100n }
		});

		const path = plans?.find(p => p.path.length === 1 && p.path[0]?.providerID === 'FXOne');
		if (!path) { throw(new Error('No FX path found')); }

		const computed = path.plan
		expect(computed.totalValueIn).toEqual(114n);
		expect(computed.totalValueOut).toEqual(100n);

		const result = await path.execute();

		expect(result.steps.length).toEqual(1);
		expect(result.steps[0]?.type).toEqual('fx');
		if (result.steps[0]?.type === 'fx') {
			const exchangeStatus = await result.steps[0].exchange.getExchangeStatus();
			expect(exchangeStatus.status).toEqual('completed');
		}
		expect(path.state.status).toEqual('completed');
	});

	test.each([
		{ providerID: 'FXOne' as const, expectedValueIn: 114n },
		{ providerID: 'FXTwo' as const, expectedValueIn: 118n }
	])('FX-only path via $providerID: state transitions and events', async function({ providerID, expectedValueIn }) {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: 100n }
		});

		const path = plans?.find(p => p.path.some(n => n.type === 'fx' && n.providerID === providerID));
		if (!path) { throw(new Error(`No FX path found for ${providerID}`)); }

		const stateHistory: AnchorChainingPathState['status'][] = [];
		path.on('stateChange', (state: AnchorChainingPathState) => stateHistory.push(state.status));

		const emittedSteps: { step: ExecutedStep; index: number }[] = [];
		path.on('stepExecuted', (step: ExecutedStep, index: number) => emittedSteps.push({ step, index }));

		let completedResult: Awaited<ReturnType<typeof path.execute>> | null = null;
		path.on('completed', (result: Awaited<ReturnType<typeof path.execute>>) => { completedResult = result; });

		const computed = path.plan
		expect(computed.totalValueIn).toEqual(expectedValueIn);
		expect(computed.totalValueOut).toEqual(100n);

		const result = await path.execute();

		expect(result.steps.length).toEqual(1);
		expect(path.state.status).toEqual('completed');
		expect(stateHistory[0]).toEqual('executing');
		expect(stateHistory[stateHistory.length - 1]).toEqual('completed');
		expect(emittedSteps.length).toEqual(1);
		expect(emittedSteps[0]?.step).toBe(result.steps[0]);
		expect(completedResult).toBe(result);
	});

	test('FX-only path: exchange failure emits failed event', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: 100n }
		});

		const plan = plans?.find(p => p.path.length === 1 && p.path[0]?.providerID === 'FXOne');
		if (!plan) { throw(new Error('No FX path found')); }

		const computed = plan.plan
		expect(computed.totalValueIn).toEqual(114n);
		expect(computed.totalValueOut).toEqual(100n);

		h.fxServerOne.failNextExchange('FX to-affinity exchange failed');

		const failedEvents: { error: Error; completedSteps: ExecutedStep[]; index: number }[] = [];
		plan.on('failed', (error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number) => {
			failedEvents.push({ error, completedSteps, index: failedAtStepIndex });
		});

		await expect(plan.execute()).rejects.toThrow('FX to-affinity exchange failed');
		expect(plan.state.status).toEqual('failed');
		if (plan.state.status === 'failed') {
			expect(plan.state.failedAtStepIndex).toEqual(0);
			expect(plan.state.completedSteps.length).toEqual(0);
		}
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) { throw(new Error('Expected failed event')); }
		expect(failedEvent.index).toEqual(0);
		expect(failedEvent.completedSteps.length).toEqual(0);
	});

	test('FX-only path: re-executing after completion throws', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: 100n }
		});

		const plan = plans?.find(p => p.path.length === 1 && p.path[0]?.providerID === 'FXOne');
		if (!plan) { throw(new Error('No FX path found')); }

		await plan.execute();

		await expect(plan.execute()).rejects.toThrow('Cannot execute');
	});

	test('providing both source.value and destination.value throws', async function() {
		await using h = await createChainingTestHarness();
		const path = await h.getPathVia('FXOne');

		path.request.source.value = 100n;
		path.request.destination.value = 100n;

		await expect(AnchorChainingPlan.create(path)).rejects.toThrow('Must have source.value or destination.value but not both');
	});

	test('providing neither source.value nor destination.value throws', async function() {
		await using h = await createChainingTestHarness();
		const path = await h.getPathVia('FXOne');

		delete path.request.source.value;
		delete path.request.destination.value;

		await expect(AnchorChainingPlan.create(path)).rejects.toThrow('Must have source.value or destination.value');
	});
});

describe('AnchorChainingPath execute', function() {
	test('success: step structure, events, state transitions, and guard rails', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const path = await h.getPlanVia('FXOne');
		expect(path.state.status).toEqual('idle');

		const stateHistory: AnchorChainingPathState['status'][] = [];
		path.on('stateChange', (state: AnchorChainingPathState) => stateHistory.push(state.status));

		const emittedSteps: { step: ExecutedStep; index: number }[] = [];
		path.on('stepExecuted', (step: ExecutedStep, index: number) => emittedSteps.push({ step, index }));

		let completedResult: Awaited<ReturnType<typeof path.execute>> | null = null;
		path.on('completed', (result: Awaited<ReturnType<typeof path.execute>>) => { completedResult = result; });

		// Register then immediately remove a listener to verify off() is effective
		let removedListenerCallCount = 0;
		const removedListener = () => { removedListenerCallCount++; };
		path.on('stepExecuted', removedListener);
		path.off('stepExecuted', removedListener);

		const result = await path.execute();

		// Step structure and server-side verification
		expect(result.steps.length).toEqual(2);
		const [step0, step1] = result.steps;
		expect(step0?.type).toEqual('fx');
		if (step0?.type === 'fx') {
			expect(step0.exchange.exchange.exchangeID).toBeTruthy();
			const exchangeStatus = await step0.exchange.getExchangeStatus();
			expect(exchangeStatus.status).toEqual('completed');
			if (exchangeStatus.status === 'completed') {
				expect(exchangeStatus.blockhash).toBeTruthy();
			}
		}
		// 88 EURC from FX - 10 fee = 78 EUR output
		expect(step1?.type).toEqual('assetMovement');
		if (step1?.type === 'assetMovement') {
			expect(step1.plan.transfer.transferId).toBeTruthy();
			expect(step1.plan.usingInstruction.type).toEqual('KEETA_SEND');
			const transferStatus = await step1.plan.transfer.getTransferStatus();
			expect(transferStatus.transaction.status).toEqual('COMPLETED');
			expect(transferStatus.transaction.to.value).toEqual('78');
		}

		// State transitions: idle -> executing -> completed
		expect(path.state.status).toEqual('completed');
		expect(stateHistory[0]).toEqual('executing');
		expect(stateHistory[stateHistory.length - 1]).toEqual('completed');
		if (path.state.status === 'completed') {
			expect(path.state.result).toBe(result);
		}

		// stepExecuted fired once per step, each with the correct step reference
		expect(emittedSteps.length).toEqual(result.steps.length);
		emittedSteps.forEach(({ step, index }) => expect(step).toBe(result.steps[index]));

		// completed event carries the result object
		expect(completedResult).toBe(result);

		// Removed listener was never called
		expect(removedListenerCallCount).toEqual(0);

		// Re-executing a completed path throws
		await expect(path.execute()).rejects.toThrow('Cannot execute');
	});

	test('FX step failure: failed event, state, and double-execute guard', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const path = await h.getPlanVia('FXOne');

		h.fxServerOne.failNextExchange('FX step 0 failed');

		const failedEvents: { error: Error; completedSteps: ExecutedStep[]; index: number }[] = [];
		path.on('failed', (error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number) => {
			failedEvents.push({ error, completedSteps, index: failedAtStepIndex });
		});

		await expect(path.execute()).rejects.toThrow('FX step 0 failed');
		expect(path.state.status).toEqual('failed');
		if (path.state.status === 'failed') {
			expect(path.state.failedAtStepIndex).toEqual(0);
			expect(path.state.completedSteps.length).toEqual(0);
		}
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) {throw(new Error('Expected failed event'));}
		expect(failedEvent.index).toEqual(0);
		expect(failedEvent.completedSteps.length).toEqual(0);

		// Re-executing a failed path throws
		await expect(path.execute()).rejects.toThrow('Cannot execute');
	});

	test('AM step failure: failed event carries the completed FX step', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const path = await h.getPlanVia('FXOne');

		// Arm failure after computeSteps so initiation succeeds but status polling throws.
		h.bankServerEU.failNextTransferStatus('AM step 1 poll failed');

		const emittedSteps: ExecutedStep[] = [];
		path.on('stepExecuted', (step: ExecutedStep) => emittedSteps.push(step));

		const failedEvents: { error: Error; completedSteps: ExecutedStep[]; index: number }[] = [];
		path.on('failed', (error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number) => {
			failedEvents.push({ error, completedSteps, index: failedAtStepIndex });
		});

		await expect(path.execute()).rejects.toThrow('AM step 1 poll failed');
		expect(path.state.status).toEqual('failed');
		if (path.state.status === 'failed') {
			expect(path.state.failedAtStepIndex).toEqual(1);
			expect(path.state.completedSteps.length).toEqual(1);
			expect(path.state.completedSteps[0]?.type).toEqual('fx');
		}
		// stepExecuted fired for FX step only
		expect(emittedSteps.length).toEqual(1);
		expect(emittedSteps[0]?.type).toEqual('fx');
		// failed event carries the same completed steps
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) {throw(new Error('Expected failed event'));}
		expect(failedEvent.index).toEqual(1);
		expect(failedEvent.completedSteps.length).toEqual(1);
		expect(failedEvent.completedSteps[0]?.type).toEqual('fx');
	});
});

describe('AnchorChainingPath direct send', function() {
	test('same Keeta location and asset: zero-step path sends on-chain directly', async function() {
		await using h = await createChainingTestHarness();
		const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		await h.giveTokens(h.client.account, 500n, h.tokens.USDC);

		const paths = await h.anchorChaining.getPlans({
			source:      { asset: h.tokens.USDC, location: h.keetaLocation, value: 200n, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.USDC, location: h.keetaLocation, recipient: recipient.publicKeyString.get(), rail: 'KEETA_SEND' }
		});

		if (!paths?.[0]) {
			throw(new Error('Expected to find a path'));
		}
		expect(paths.length).toEqual(1);
		const path = paths[0];

		expect(path.path.length).toEqual(1);

		expect(path.plan.steps.length).toEqual(1);
		expect(path.plan.totalValueIn).toEqual(200n);
		expect(path.plan.totalValueOut).toEqual(200n);

		expect(path.state.status).toEqual('idle');
		const result = await path.execute();
		expect(result.steps.length).toEqual(1);
		expect(path.state.status).toEqual('completed');

		const balance = await h.client.client.getBalance(recipient, h.tokens.USDC);
		expect(balance).toEqual(200n);
	});
});

describe('AnchorChainingPath ACH fiat path', function() {
	async function getBankUSPath(h: Awaited<ReturnType<typeof createChainingTestHarness>>) {
		const paths = await h.anchorChaining.getPlans({
			source: { asset: 'USD', location: 'bank-account:us', value: 100n, rail: 'ACH' },
			destination: { asset: h.tokens.USDC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND' }
		});
		const p = paths?.find(p => p.path.length === 1 && p.path[0]?.providerID === 'BankUS');
		if (!p) {throw(new Error('No single-step BankUS path found'));}
		return(p);
	}

	test('no stepNeedsAction listener causes execute to throw', async function() {
		await using h = await createChainingTestHarness();
		const path = await getBankUSPath(h);

		expect(path.plan.steps[0]?.type).toEqual('assetMovement');
		if (path.plan.steps[0]?.type === 'assetMovement') {
			expect(path.plan.steps[0].usingInstruction.type).toEqual('ACH');
		}

		await expect(path.execute()).rejects.toThrow('No listeners for stepNeedsAction');
	});

	test('markCompleted signals completion; server records transfer as COMPLETED', async function() {
		await using h = await createChainingTestHarness();
		const path = await getBankUSPath(h);

		path.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				payload.markCompleted({ sent: true });
			} else {
				payload.markCompleted()
			}
		});
		const result = await path.execute();

		expect(result.steps.length).toEqual(1);
		expect(result.steps[0]?.type).toEqual('assetMovement');
		if (result.steps[0]?.type === 'assetMovement') {
			// value = 100 - 10 fee = 90
			const transferStatus = await result.steps[0].plan.transfer.getTransferStatus();
			expect(transferStatus.transaction.status).toEqual('COMPLETED');
			expect(transferStatus.transaction.to.value).toEqual('90');
		}
	});

	test('transfer status polling failure emits failed event at step 0', async function() {
		await using h = await createChainingTestHarness();
		const path = await getBankUSPath(h);

		h.bankServerUS.failNextTransferStatus('ACH poll failed');

		const failedEvents: { error: Error; completedSteps: ExecutedStep[]; index: number }[] = [];
		path.on('failed', (error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number) => {
			failedEvents.push({ error, completedSteps, index: failedAtStepIndex });
		});

		path.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				payload.markCompleted({ sent: true });
			} else {
				payload.markCompleted()
			}
		});
		await expect(path.execute()).rejects.toThrow('ACH poll failed');

		expect(path.state.status).toEqual('failed');
		if (path.state.status === 'failed') {
			expect(path.state.failedAtStepIndex).toEqual(0);
			expect(path.state.completedSteps.length).toEqual(0);
		}
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) {throw(new Error('Expected failed event'));}
		expect(failedEvent.index).toEqual(0);
		expect(failedEvent.completedSteps.length).toEqual(0);
	});
});

describe('AnchorChainingPath keetaSendAuthRequired', function() {
	// Uses the FX+AM path (USDC -> EURC via FXOne, then EURC -> EUR bank via BankEU).
	// The AM step has a KEETA_SEND instruction, so execute() calls client.send() internally.
	// With requireSendAuth: true, a keetaSendAuthRequired event fires before that send.

	test('no stepNeedsAction listener throws when requireSendAuth is set', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const path = await h.getPlanVia('FXOne');
		await expect(path.execute({ requireSendAuth: true })).rejects.toThrow('No listeners for stepNeedsAction');
	});

	test('markCompleted({ sent: true }): event fires with correct payload and execute succeeds', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const path = await h.getPlanVia('FXOne');

		const capturedActions: { sendToAddress: GenericAccount; value: bigint; token: TokenAddress; external?: string }[] = [];

		path.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				capturedActions.push(payload.action);
				payload.markCompleted({ sent: true });
			} else {
				payload.markCompleted();
			}
		});

		const result = await path.execute({ requireSendAuth: true });

		expect(result.steps).toHaveLength(2);
		expect(capturedActions).toHaveLength(1);
		const action = capturedActions[0];
		if (!action) { throw(new Error('Expected keetaSendAuthRequired action')); }

		// sendToAddress is the bank server's Keeta account
		expect(KeetaNet.lib.Account.isInstance(action.sendToAddress)).toBe(true);
		// value is the post-FX EURC amount: 100 * 0.88 = 88
		expect(action.value).toBe(88n);
		// token is the EURC token
		expect(action.token.publicKeyString.get()).toBe(h.tokens.EURC.publicKeyString.get());
		// external is the bank transfer ID used to match the on-chain send
		expect(typeof action.external).toBe('string');
	});

	test('markCompleted({ sent: false }): execute still proceeds (sent value is advisory)', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const path = await h.getPlanVia('FXOne');

		path.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				payload.markCompleted({ sent: false });
			} else {
				payload.markCompleted();
			}
		});

		const result = await path.execute({ requireSendAuth: true });
		expect(result.steps).toHaveLength(2);
	});

	test('markFailed: execute rejects with the provided error', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const path = await h.getPlanVia('FXOne');

		path.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				payload.markFailed(new Error('send rejected by user'));
			} else {
				payload.markCompleted();
			}
		});

		const failedEvents: { error: Error; completedSteps: ExecutedStep[]; index: number }[] = [];
		path.on('failed', (error: Error, completedSteps: ExecutedStep[], failedAtStepIndex: number) => {
			failedEvents.push({ error, completedSteps, index: failedAtStepIndex });
		});

		await expect(path.execute({ requireSendAuth: true })).rejects.toThrow('send rejected by user');
		expect(path.state.status).toBe('failed');
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) { throw(new Error('Expected failed event')); }
		// FX step (index 0) completed; rejection happened at AM step (index 1)
		expect(failedEvent.index).toBe(1);
		expect(failedEvent.completedSteps[0]?.type).toBe('fx');
	});

	test('direct send: keetaSendAuthRequired fires with correct sendToAddress and value', async function() {
		await using h = await createChainingTestHarness();
		const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		await h.giveTokens(h.client.account, 500n, h.tokens.USDC);

		const paths = await h.anchorChaining.getPlans({
			source:      { asset: h.tokens.USDC, location: h.keetaLocation, value: 200n, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.USDC, location: h.keetaLocation, recipient: recipient.publicKeyString.get(), rail: 'KEETA_SEND' }
		});
		if (!paths?.[0]) { throw(new Error('Expected direct-send path')); }
		const path = paths[0];
		expect(path.plan.steps).toHaveLength(1);

		const capturedActions: { sendToAddress: GenericAccount; value: bigint; token: TokenAddress; external?: string }[] = [];

		path.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				capturedActions.push(payload.action);
				payload.markCompleted({ sent: true });
			} else {
				payload.markCompleted();
			}
		});

		const result = await path.execute({ requireSendAuth: true });
		expect(result.steps).toHaveLength(1);

		expect(capturedActions).toHaveLength(1);
		const action = capturedActions[0];
		if (!action) { throw(new Error('Expected keetaSendAuthRequired action')); }

		expect(action.sendToAddress.publicKeyString.get()).toBe(recipient.publicKeyString.get());
		expect(action.value).toBe(200n);
		expect(action.token.publicKeyString.get()).toBe(h.tokens.USDC.publicKeyString.get());
		expect(action.external).toBeUndefined();

		const balance = await h.client.client.getBalance(recipient, h.tokens.USDC);
		expect(balance).toBe(200n);
	});
});

describe('AnchorChaining listAssets', function() {
	function assetKey(asset: AnchorChainingAsset): string {
		if (KeetaNet.lib.Account.isInstance(asset)) {
			return(asset.publicKeyString.get());
		}
		return(String(asset));
	}

	function resultKey(item: AnchorChainingAssetInfo): string {
		return(`${assetKey(item.asset)}@${convertAssetLocationToString(item.location)}`);
	}

	test('onlyAllowFXLike excludes the source token and bank-account destinations', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation },
			onlyAllowFXLike: true
		});

		// EURC@keeta reachable; USDC itself excluded even though reachable via round-trip;
		// bank-account destinations excluded because they are not FX-like nodes
		expect(assets).toHaveLength(1);
		const [eurc] = assets;
		if (!eurc) {
			throw(new Error('Expected to find EURC asset for onlyAllowFXLike filter'));
		}
		expect(assetKey(eurc.asset)).toBe(h.tokens.EURC.publicKeyString.get());
		expect(eurc.location).toBe(h.keetaLocation);
		expect(eurc.rails.inbound).toEqual(['KEETA_SEND']);
		expect(eurc.rails.outbound).toEqual(['KEETA_SEND']);
	});

	test('from filter with maxStepCount=1 returns only direct 1-hop destinations', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation },
			maxStepCount: 1
		});

		expect(assets).toHaveLength(2);
		const keys = assets.map(resultKey);
		expect(keys).toContain(`${h.tokens.EURC.publicKeyString.get()}@${h.keetaLocation}`);
		expect(keys).toContain(`USD@bank-account:us`);
		expect(keys).not.toContain(`EUR@bank-account:iban-swift`);
	});

	test('from filter without maxStepCount finds all reachable assets in the graph', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation }
		});

		expect(assets).toHaveLength(4);
		const keys = assets.map(resultKey);
		expect(keys).toContain(`${h.tokens.EURC.publicKeyString.get()}@${h.keetaLocation}`);
		expect(keys).toContain(`EUR@bank-account:iban-swift`);
		expect(keys).toContain(`USD@bank-account:us`);
	});

	test('to filter with maxStepCount=1 returns only direct 1-hop sources for US bank', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets({
			to: { location: 'bank-account:us' },
			maxStepCount: 1
		});

		// Only USDC@keeta can reach bank-account:us in a single hop (BankUS USDC->USD)
		expect(assets).toHaveLength(1);
		const [usdc] = assets;
		if (!usdc) {
			throw(new Error('Expected to find USDC asset for bank-account:us'));
		}
		expect(assetKey(usdc.asset)).toBe(h.tokens.USDC.publicKeyString.get());
		expect(usdc.location).toBe(h.keetaLocation);
		expect(usdc.rails.outbound).toContain('KEETA_SEND');
	});

	test('no filter returns all 4 distinct asset-location pairs in the graph', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets();

		expect(assets).toHaveLength(4);
		const keys = assets.map(resultKey);
		expect(keys).toContain(`${h.tokens.USDC.publicKeyString.get()}@${h.keetaLocation}`);
		expect(keys).toContain(`${h.tokens.EURC.publicKeyString.get()}@${h.keetaLocation}`);
		expect(keys).toContain(`USD@bank-account:us`);
		expect(keys).toContain(`EUR@bank-account:iban-swift`);
	});
});
