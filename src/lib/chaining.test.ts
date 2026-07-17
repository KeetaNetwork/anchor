import { test, expect, describe } from 'vitest';
import { createNodeAndClient } from './utils/tests/node.js';
import { KeetaNet } from '../client/index.js';
import { KeetaNetAssetMovementAnchorHTTPServer, type KeetaAnchorAssetMovementServerConfig } from '../services/asset-movement/server.js';
import { type AnchorTokenLocationMetadata, convertAssetLocationToString, convertAssetSearchInputToCanonical, isAssetPairLike, toAssetLocation, toAssetPair, type AssetLocationLike, type AssetOrPair, type KeetaAssetMovementTransaction, type KeetaPersistentForwardingAddressDetails } from '../services/asset-movement/common.js';
import { KeetaNetFXAnchorHTTPServer, type KeetaAnchorFXServerConfig, type GetConversionRateAndFeeContext, type KeetaFXInternalPriceQuote } from '../services/fx/server.js';
import type { ConversionInputCanonicalJSON } from '../services/fx/common.js';
import { Resolver } from './index.js';
import type { ServiceMetadataExternalizable } from './resolver.js';
import { AnchorChaining, AnchorChainingForwardingOnlyPlan, AnchorChainingPlan, buildForwardingAdjacency, estimateForwardingValueOut, getForwardingDepositAddress, hasForwardingRoute, isForwardingPath, isForwardingPlan, listChainingPlanFees, supportsPersistentForwarding } from './chaining.js';
import type { AnchorChainingPathState, ExecutedStep, AnchorChainingAsset, AnchorChainingAssetInfo, AnchorChainingResolveAssetsFilter, Disclaimer, AnchorChainingPathInput, AnchorChainingPath, GetPlansOptions } from './chaining.js';
import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { KeetaAnchorUserError } from './error.js';
import { AnchorExternal } from './anchor-external.js';
import { BlockListener } from './block-listener.js';
import type { AnchorMetadataLegalField } from './metadata.types.js';
import type { KeetaAssetMovementAnchorProvider } from '../services/asset-movement/client.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

const toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

type InitiateTransferFn = NonNullable<KeetaAnchorAssetMovementServerConfig['assetMovement']['initiateTransfer']>;
type RateFn = (request: ConversionInputCanonicalJSON, context: GetConversionRateAndFeeContext) => Promise<KeetaFXInternalPriceQuote>;

const EMPTY_FROM_TRANSACTIONS = { deposit: null, persistentForwarding: null, finalization: null } as const;
const EMPTY_TO_TRANSACTIONS = { withdraw: null } as const;

/**
 * `true` when a SEND's external field references the given transfer, either
 * as the raw transfer id (anchor-provided external) or as an entry in a
 * decodable plaintext envelope (client-constructed external).
 */
async function externalReferencesTransfer(external: unknown, txId: string): Promise<boolean> {
	if (external === txId) {
		return(true);
	}
	if (typeof external !== 'string' || external === '') {
		return(false);
	}

	let decoded;
	try {
		decoded = await AnchorExternal.fromPlainExternal(external);
	} catch {
		return(false);
	}

	return(Object.values(decoded.envelope.anchors).some(function(entry) {
		return('transactionId' in entry && entry.transactionId === txId);
	}));
}

/**
 * Initiate-transfer wrapper simulating an anchor under the construction
 * model: KEETA_SEND instructions carry no external, so the client must
 * build the correlation envelope itself.
 */
async function stripKeetaSendExternal(request: Parameters<InitiateTransferFn>[0], next: InitiateTransferFn): ReturnType<InitiateTransferFn> {
	const response = await next(request);
	return({
		...response,
		instructionChoices: response.instructionChoices.map(function(choice) {
			if (choice.type === 'KEETA_SEND') {
				const rest = { ...choice };
				delete rest.external;
				return(rest);
			}

			return(choice);
		})
	});
}

/**
 * Build a `KeetaAssetMovementTransaction` record for in-memory test bridges.
 * `fromValue`/`toValue` are kept separate so bridges that charge a fee can
 * model the asymmetry (e.g. `fromValue = value`, `toValue = value - fee`).
 */
function buildTxRecord(args: {
	id: string;
	status: KeetaAssetMovementTransaction['status'];
	asset: KeetaAssetMovementTransaction['asset'];
	fromLocation: KeetaAssetMovementTransaction['from']['location'];
	toLocation: KeetaAssetMovementTransaction['to']['location'];
	fromValue: string;
	toValue: string;
	additionalTransferDetails?: KeetaAssetMovementTransaction['additionalTransferDetails'];
}): KeetaAssetMovementTransaction {
	const now = new Date().toISOString();
	return({
		id: args.id,
		status: args.status,
		asset: args.asset,
		from: { location: args.fromLocation, value: args.fromValue, transactions: { ...EMPTY_FROM_TRANSACTIONS }},
		to:   { location: args.toLocation,   value: args.toValue,   transactions: { ...EMPTY_TO_TRANSACTIONS }},
		fee: null,
		createdAt: now,
		updatedAt: now,
		...(args.additionalTransferDetails !== undefined ? { additionalTransferDetails: args.additionalTransferDetails } : {})
	});
}

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

					statusMap.set(txId, buildTxRecord({
						id: txId,
						status: 'PENDING',
						asset: request.asset,
						fromLocation: request.from.location,
						toLocation: request.to.location,
						fromValue: value.toString(),
						toValue: receive.toString()
					}));

					let listenerHandle: { remove: () => void } | null = null;
					listenerHandle = blockListener.on('block', {
						callback: async ({ block }) => {
							for (const op of block.operations) {
								if (op.type === KeetaNet.lib.Block.OperationType.SEND && await externalReferencesTransfer(op.external, txId)) {
									if (op.amount !== value) {
										throw(new KeetaAnchorUserError(`Invalid transfer amount: expected ${value}, got ${op.amount}`));
									}
									const existing = statusMap.get(txId);
									if (existing && existing.status !== 'COMPLETE') {
										statusMap.set(txId, { ...existing, status: 'COMPLETE', updatedAt: new Date().toISOString() });
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
					statusMap.set(txId, buildTxRecord({
						id: txId,
						status: 'COMPLETE',
						asset: request.asset,
						fromLocation: request.from.location,
						toLocation: request.to.location,
						fromValue: value.toString(),
						toValue: receive.toString()
					}));
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

	wrapInitiateTransfer(wrapper: (request: Parameters<InitiateTransferFn>[0], next: InitiateTransferFn) => ReturnType<InitiateTransferFn>): this {
		const saved = this._initiateRef.fn;
		this._initiateRef.fn = async (request) => {
			return(await wrapper(request, saved));
		};
		return(this);
	}

	setFee(fee: bigint): this {
		return(this.setInitiateTransfer(async (request) => {
			const value = BigInt(request.value);
			const receive = value - fee;
			const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			this._statusMap.set(txId, buildTxRecord({
				id: txId,
				status: 'COMPLETE',
				asset: request.asset,
				fromLocation: request.from.location,
				toLocation: request.to.location,
				fromValue: value.toString(),
				toValue: receive.toString()
			}));

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
	fx: Pick<KeetaAnchorFXServerConfig['fx'], 'from' | 'legal'>;
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

type PersistentForwardingBridgeAddressMeta = {
	sourceLocation: AssetLocationLike;
	destinationLocation: AssetLocationLike;
	destinationAddress: string;
	asset: KeetaAssetMovementTransaction['asset'];
	fees?: KeetaPersistentForwardingAddressDetails['fees'];
};

type TestPersistentForwardingBridgeServerConfig = Omit<KeetaAnchorAssetMovementServerConfig, 'assetMovement'> & {
	assetMovement: Omit<
		KeetaAnchorAssetMovementServerConfig['assetMovement'],
		'initiateTransfer' | 'getTransferStatus' | 'simulateTransfer' | 'createPersistentForwarding' | 'listPersistentForwarding' | 'listTransactions'
	>;
	client: KeetaNet.UserClient;
};

/**
 * Test bridge for the persistent-forwarding flow used by anchor chaining.
 */
class TestPersistentForwardingBridgeServer extends KeetaNetAssetMovementAnchorHTTPServer {
	readonly bridgeAccount: GenericAccount;
	readonly addresses: Map<string, PersistentForwardingBridgeAddressMeta>;
	readonly transactionsByAddress: Map<string, KeetaAssetMovementTransaction[]>;
	readonly transferStatuses: Map<string, KeetaAssetMovementTransaction>;

	constructor(config: TestPersistentForwardingBridgeServerConfig) {
		const { client: userClient, ...serverConfig } = config;

		const bridgeAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const blockListener = new BlockListener({ client: userClient.client });

		const addresses = new Map<string, PersistentForwardingBridgeAddressMeta>();
		const transactionsByAddress = new Map<string, KeetaAssetMovementTransaction[]>();
		const transferStatuses = new Map<string, KeetaAssetMovementTransaction>();

		super({
			...serverConfig,
			assetMovement: {
				...serverConfig.assetMovement,
				async initiateTransfer(request) {
					const parsedFrom = toAssetLocation(request.from.location);
					const isKeetaSource = parsedFrom.type === 'chain' && parsedFrom.chain.type === 'keeta';
					if (!isKeetaSource) {
						throw(new KeetaAnchorUserError(`initiateTransfer not supported from ${convertAssetLocationToString(request.from.location)}; use createPersistentForwarding instead`));
					}

					const value = BigInt(request.value);
					const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
					const recipientAddress = typeof request.to.recipient === 'string' ? request.to.recipient : '';

					transferStatuses.set(txId, buildTxRecord({
						id: txId,
						status: 'PENDING',
						asset: request.asset,
						fromLocation: request.from.location,
						toLocation: request.to.location,
						fromValue: value.toString(),
						toValue: value.toString()
					}));

					let handle: { remove: () => void } | null = null;
					handle = blockListener.on('block', {
						callback: async ({ block }) => {
							for (const op of block.operations) {
								if (op.type === KeetaNet.lib.Block.OperationType.SEND && op.external === txId) {
									if (op.amount !== value) {
										throw(new KeetaAnchorUserError(`Invalid transfer amount: expected ${value}, got ${op.amount}`));
									}

									const withdrawTxId = `withdraw-${txId}`;
									const existing = transferStatuses.get(txId);
									if (existing && existing.status !== 'COMPLETE') {
										transferStatuses.set(txId, {
											...existing,
											status: 'COMPLETE',
											updatedAt: new Date().toISOString(),
											additionalTransferDetails: { type: 'markdown', content: 'Bridge withdraw complete' },
											to: {
												...existing.to,
												transactions: { withdraw: { id: withdrawTxId, nonce: '0' }}
											}
										});
									}

									/*
									 * Mimics the bridge's EVM withdrawal landing at the
									 * persistent forwarding address and auto-forwarding to the
									 * chain destination.
									 */
									const meta = addresses.get(recipientAddress);
									if (meta) {
										const list = transactionsByAddress.get(recipientAddress) ?? [];
										const forwarded = buildTxRecord({
											id: `persistentForwarding-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
											status: 'COMPLETE',
											asset: meta.asset,
											fromLocation: convertAssetLocationToString(meta.sourceLocation),
											toLocation: convertAssetLocationToString(meta.destinationLocation),
											fromValue: value.toString(),
											toValue: value.toString(),
											additionalTransferDetails: { type: 'markdown', content: 'Forwarded leg complete' }
										});
										forwarded.from.transactions = {
											...forwarded.from.transactions,
											persistentForwarding: { id: withdrawTxId, nonce: '0' }
										};
										list.push(forwarded);
										transactionsByAddress.set(recipientAddress, list);
									}

									handle?.remove();
									return({ requiresWork: false });
								}
							}
							return({ requiresWork: false });
						}
					});

					const tokenAddress = toAssetPair(request.asset).from;
					if (typeof tokenAddress !== 'string') {
						throw(new Error('invalid keeta send asset'));
					}

					return({
						id: txId,
						instructionChoices: [{
							type: 'KEETA_SEND' as const,
							location: request.from.location,
							sendToAddress: bridgeAccount.publicKeyString.get(),
							external: txId,
							value: value.toString(),
							tokenAddress: KeetaNet.lib.Account.fromPublicKeyString(tokenAddress)
								.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
								.publicKeyString.get(),
							assetFee: '0',
							totalReceiveAmount: value.toString()
						}]
					});
				},

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				async getTransferStatus(id: string): Promise<any> {
					await blockListener.scan();
					const tx = transferStatuses.get(id);
					if (!tx) {
						throw(new Error(`Unknown transfer ID: ${id}`));
					}

					return({ transaction: tx });
				},

				async simulateTransfer(request) {
					const value = BigInt(request.value);
					const tokenAddress = toAssetPair(request.asset).from;
					if (typeof tokenAddress !== 'string') {
						throw(new Error('invalid asset for simulate'));
					}

					const parsedFrom = toAssetLocation(request.from.location);
					const isKeetaSource = parsedFrom.type === 'chain' && parsedFrom.chain.type === 'keeta';
					if (isKeetaSource) {
						return({
							instructionChoices: [{
								type: 'KEETA_SEND' as const,
								location: request.from.location,
								value: value.toString(),
								tokenAddress: KeetaNet.lib.Account.fromPublicKeyString(tokenAddress)
									.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
									.publicKeyString.get(),
								assetFee: '0',
								totalReceiveAmount: value.toString()
							}]
						});
					}

					/*
					 * EVM-side simulation for the persistent-forwarding leg.
					 */
					if (!tokenAddress.startsWith('evm:0x')) {
						throw(new Error(`invalid evm asset format for simulate: ${tokenAddress}`));
					}

					/* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
					const evmTokenHex = tokenAddress.slice('evm:'.length) as `0x${string}`;
					const fee = 25n;
					return({
						instructionChoices: [{
							type: 'EVM_SEND' as const,
							location: request.from.location,
							value: value.toString(),
							tokenAddress: evmTokenHex,
							assetFee: fee.toString(),
							totalReceiveAmount: (value - fee).toString()
						}]
					});
				},

				async createPersistentForwarding(request) {
					if (!('destinationLocation' in request) || !('destinationAddress' in request)) {
						throw(new KeetaAnchorUserError('createPersistentForwarding via template is not supported in this test bridge'));
					}
					if (typeof request.destinationAddress !== 'string') {
						throw(new KeetaAnchorUserError('Test bridge only supports string destinationAddress for persistent forwarding'));
					}

					const address = `persistentForwarding-${Math.random().toString(36).slice(2)}`;
					const meta: PersistentForwardingBridgeAddressMeta = {
						sourceLocation: request.sourceLocation,
						destinationLocation: request.destinationLocation,
						destinationAddress: request.destinationAddress,
						asset: request.asset
					};

					addresses.set(address, meta);

					return({
						address,
						asset: meta.asset,
						sourceLocation: meta.sourceLocation,
						destinationLocation: meta.destinationLocation,
						destinationAddress: meta.destinationAddress
					});
				},

				async listPersistentForwarding(request) {
					const all: KeetaPersistentForwardingAddressDetails[] = [];
					for (const [address, meta] of addresses) {
						all.push({
							address,
							asset: meta.asset,
							sourceLocation: meta.sourceLocation,
							destinationLocation: meta.destinationLocation,
							destinationAddress: meta.destinationAddress,
							...(meta.fees !== undefined ? { fees: meta.fees } : {})
						});
					}

					let filtered = all;
					const searches = request.search;
					if (searches && searches.length > 0) {
						filtered = all.filter(addr => searches.some(search => {
							if (search.destinationAddress !== undefined && addr.destinationAddress !== search.destinationAddress) {
								return(false);
							}
							return(true);
						}));
					}

					return({
						addresses: filtered,
						total: filtered.length.toString()
					});
				},

				async listTransactions(request) {
					const transactions: KeetaAssetMovementTransaction[] = [];
					for (const pf of (request.persistentAddresses ?? [])) {
						if (!('persistentAddress' in pf) || !pf.persistentAddress) {
							continue;
						}
						const found = transactionsByAddress.get(pf.persistentAddress) ?? [];
						transactions.push(...found);
					}

					const txFilters = request.transactions;
					let filtered = transactions;
					if (txFilters && txFilters.length > 0) {
						const wantedIds = new Set(txFilters
							.map(f => f.transaction.id)
							.filter((id): id is string => typeof id === 'string'));

						filtered = transactions.filter(tx => {
							const fromIds = [
								tx.from.transactions.persistentForwarding?.id,
								tx.from.transactions.deposit?.id,
								tx.from.transactions.finalization?.id
							];
							const toIds = [ tx.to.transactions.withdraw?.id ];
							for (const id of [ ...fromIds, ...toIds ]) {
								if (id && wantedIds.has(id)) {
									return(true);
								}
							}
							return(false);
						});
					}

					return({
						transactions: filtered,
						total: filtered.length.toString()
					});
				}
			}
		});

		this.bridgeAccount = bridgeAccount;
		this.addresses = addresses;
		this.transactionsByAddress = transactionsByAddress;
		this.transferStatuses = transferStatuses;
	}
}

type ChainAnchorConvert = (args: {
	fromAsset: string;
	toAsset: string;
	fromLocation: AssetLocationLike;
	toLocation: AssetLocationLike;
	value: bigint;
}) => bigint;

type TestChainAnchorServerConfig = Omit<KeetaAnchorAssetMovementServerConfig, 'assetMovement'> & {
	assetMovement: Omit<
		KeetaAnchorAssetMovementServerConfig['assetMovement'],
		'initiateTransfer' | 'simulateTransfer' | 'getTransferStatus' | 'createPersistentForwarding' | 'listPersistentForwarding' | 'listTransactions'
	>;
	client: KeetaNet.UserClient;
	convert: ChainAnchorConvert;
};

function evmAssetToHex(assetId: string): `0x${string}` {
	if (!assetId.startsWith('evm:0x')) {
		throw(new Error(`Expected evm asset id, got ${assetId}`));
	}
	/* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
	return(assetId.slice('evm:'.length) as `0x${string}`);
}

function solanaAssetToMint(assetId: string): string {
	if (!assetId.startsWith('solana:')) {
		throw(new Error(`Expected solana asset id, got ${assetId}`));
	}
	return(assetId.slice('solana:'.length));
}

/**
 * Configurable in-memory asset-movement anchor for the generic chaining cases.
 * Generalizes TestBankServer + TestPersistentForwardingBridgeServer so a single
 * class can model every provider (AM1/AM2/AM3) under any leg-execution mode:
 *  - keeta-source legs => user-funded KEETA_SEND, marked COMPLETE on the matching
 *    on-chain send. When the destination is a non-keeta chain it records a withdraw
 *    tx so a following persistent-forwarding leg can correlate.
 *  - non-keeta-source legs (EVM/Solana) => deposit instruction, recorded COMPLETE
 *    (deposit detection is mocked, matching TestBankServer's non-keeta branch).
 *  - simulateTransfer / createPersistentForwarding / listPersistentForwarding /
 *    listTransactions are implemented so any leg can run managed OR persistent-forwarding.
 *  - `convert` models per-leg rate + fee and drives every totalReceiveAmount.
 */
class TestChainAnchorServer extends KeetaNetAssetMovementAnchorHTTPServer {
	readonly anchorAccount: GenericAccount;
	readonly addresses: Map<string, PersistentForwardingBridgeAddressMeta>;

	constructor(config: TestChainAnchorServerConfig) {

		const { client: userClient, convert, ...serverConfig } = config;

		const anchorAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const blockListener = new BlockListener({ client: userClient.client });

		const statusMap = new Map<string, KeetaAssetMovementTransaction>();
		const addresses = new Map<string, PersistentForwardingBridgeAddressMeta>();
		const forwardValues = new Map<string, bigint>();

		const assetPairStrings = (asset: KeetaAssetMovementTransaction['asset']): { from: string; to: string } => {
			const pair = toAssetPair(asset);
			if (typeof pair.from !== 'string' || typeof pair.to !== 'string') {
				throw(new Error('TestChainAnchorServer: expected string asset ids'));
			}
			return({ from: pair.from, to: pair.to });
		};

		super({
			...serverConfig,
			assetMovement: {
				...serverConfig.assetMovement,
				async initiateTransfer(request) {
					const value = BigInt(request.value);
					const { from: fromAsset, to: toAsset } = assetPairStrings(request.asset);
					const receive = convert({ fromAsset, toAsset, fromLocation: request.from.location, toLocation: request.to.location, value });
					const fee = value - receive;
					const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;

					const parsedFrom = toAssetLocation(request.from.location);
					const isKeetaSource = parsedFrom.type === 'chain' && parsedFrom.chain.type === 'keeta';
					const parsedTo = toAssetLocation(request.to.location);
					const destIsKeeta = parsedTo.type === 'chain' && parsedTo.chain.type === 'keeta';
					const fromStr = convertAssetLocationToString(request.from.location);

					if (isKeetaSource) {
						statusMap.set(txId, buildTxRecord({
							id: txId, status: 'PENDING', asset: request.asset,
							fromLocation: request.from.location, toLocation: request.to.location,
							fromValue: value.toString(), toValue: receive.toString()
						}));

						let handle: { remove: () => void } | null = null;
						handle = blockListener.on('block', {
							callback: async ({ block }) => {
								for (const op of block.operations) {
									if (op.type === KeetaNet.lib.Block.OperationType.SEND && await externalReferencesTransfer(op.external, txId)) {
										if (op.amount !== value) {
											throw(new KeetaAnchorUserError(`Invalid transfer amount: expected ${value}, got ${op.amount}`));
										}
										const existing = statusMap.get(txId);
										if (existing && existing.status !== 'COMPLETE') {
											const withdraw = destIsKeeta ? null : { id: `withdraw-${txId}`, nonce: '0' };
											statusMap.set(txId, {
												...existing,
												status: 'COMPLETE',
												updatedAt: new Date().toISOString(),
												to: { ...existing.to, transactions: { withdraw }}
											});
										}
										handle?.remove();
										return({ requiresWork: false });
									}
								}
								return({ requiresWork: false });
							}
						});

						return({
							id: txId,
							instructionChoices: [{
								type: 'KEETA_SEND' as const,
								location: request.from.location,
								sendToAddress: anchorAccount.publicKeyString.get(),
								external: txId,
								value: value.toString(),
								tokenAddress: KeetaNet.lib.Account.fromPublicKeyString(fromAsset)
									.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
									.publicKeyString.get(),
								assetFee: fee.toString(),
								totalReceiveAmount: receive.toString()
							}]
						});
					}

					// Non-keeta source: record COMPLETE immediately (deposit mocked). When the
					// destination is another non-keeta chain, record a withdraw so a following
					// persistent-forwarding leg can correlate to it.
					const nonKeetaRecord = buildTxRecord({
						id: txId, status: 'COMPLETE', asset: request.asset,
						fromLocation: request.from.location, toLocation: request.to.location,
						fromValue: value.toString(), toValue: receive.toString()
					});
					if (!destIsKeeta) {
						nonKeetaRecord.to = { ...nonKeetaRecord.to, transactions: { withdraw: { id: `withdraw-${txId}`, nonce: '0' }}};
					}
					statusMap.set(txId, nonKeetaRecord);

					if (fromStr.startsWith('chain:evm:')) {
						return({
							id: txId,
							instructionChoices: [{
								type: 'EVM_SEND' as const,
								location: request.from.location,
								sendToAddress: '0x1111111111111111111111111111111111111111',
								value: value.toString(),
								tokenAddress: evmAssetToHex(fromAsset),
								assetFee: fee.toString(),
								totalReceiveAmount: receive.toString()
							}]
						});
					}
					if (fromStr.startsWith('chain:solana:')) {
						return({
							id: txId,
							instructionChoices: [{
								type: 'SOLANA_SEND' as const,
								location: request.from.location,
								sendToAddress: 'So11111111111111111111111111111111111111112',
								value: value.toString(),
								tokenMintAddress: solanaAssetToMint(fromAsset),
								assetFee: fee.toString(),
								totalReceiveAmount: receive.toString()
							}]
						});
					}
					throw(new Error(`TestChainAnchorServer: unsupported source location ${fromStr}`));
				},

				async simulateTransfer(request) {
					const value = BigInt(request.value);
					const { from: fromAsset, to: toAsset } = assetPairStrings(request.asset);
					const receive = convert({ fromAsset, toAsset, fromLocation: request.from.location, toLocation: request.to.location, value });
					const fee = value - receive;
					forwardValues.set(convertAssetLocationToString(request.from.location), value);

					const parsedFrom = toAssetLocation(request.from.location);
					const fromStr = convertAssetLocationToString(request.from.location);

					if (parsedFrom.type === 'chain' && parsedFrom.chain.type === 'keeta') {
						return({
							instructionChoices: [{
								type: 'KEETA_SEND' as const,
								location: request.from.location,
								value: value.toString(),
								tokenAddress: KeetaNet.lib.Account.fromPublicKeyString(fromAsset)
									.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)
									.publicKeyString.get(),
								assetFee: fee.toString(),
								totalReceiveAmount: receive.toString()
							}]
						});
					}
					if (fromStr.startsWith('chain:evm:')) {
						return({
							instructionChoices: [{
								type: 'EVM_SEND' as const,
								location: request.from.location,
								value: value.toString(),
								tokenAddress: evmAssetToHex(fromAsset),
								assetFee: fee.toString(),
								totalReceiveAmount: receive.toString()
							}]
						});
					}
					if (fromStr.startsWith('chain:solana:')) {
						return({
							instructionChoices: [{
								type: 'SOLANA_SEND' as const,
								location: request.from.location,
								value: value.toString(),
								tokenMintAddress: solanaAssetToMint(fromAsset),
								assetFee: fee.toString(),
								totalReceiveAmount: receive.toString()
							}]
						});
					}
					throw(new Error(`TestChainAnchorServer: unsupported simulate source ${fromStr}`));
				},

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				async getTransferStatus(id: string): Promise<any> {
					await blockListener.scan();
					const tx = statusMap.get(id);
					if (!tx) {
						throw(new Error(`Unknown transfer ID: ${id}`));
					}
					return({ transaction: tx });
				},

				async createPersistentForwarding(request) {
					if (!('destinationLocation' in request) || !('destinationAddress' in request)) {
						throw(new KeetaAnchorUserError('createPersistentForwarding via template is not supported in this test anchor'));
					}
					if (typeof request.destinationAddress !== 'string') {
						throw(new KeetaAnchorUserError('Test anchor only supports string destinationAddress for persistent forwarding'));
					}
					const address = `persistentForwarding-${Math.random().toString(36).slice(2)}`;
					const fees = {
						lineItems: [ { purpose: 'RAIL' as const, value: '15' } ],
						total: '15'
					};
					const meta: PersistentForwardingBridgeAddressMeta = {
						sourceLocation: request.sourceLocation,
						destinationLocation: request.destinationLocation,
						destinationAddress: request.destinationAddress,
						asset: request.asset,
						fees
					};
					addresses.set(address, meta);
					return({ address, asset: meta.asset, sourceLocation: meta.sourceLocation, destinationLocation: meta.destinationLocation, destinationAddress: meta.destinationAddress, fees });
				},

				async listPersistentForwarding(request) {
					const all: KeetaPersistentForwardingAddressDetails[] = [];
					for (const [address, meta] of addresses) {
						all.push({
							address,
							asset: meta.asset,
							sourceLocation: meta.sourceLocation,
							destinationLocation: meta.destinationLocation,
							destinationAddress: meta.destinationAddress,
							...(meta.fees !== undefined ? { fees: meta.fees } : {})
						});
					}
					let filtered = all;
					const searches = request.search;
					if (searches && searches.length > 0) {
						filtered = all.filter(addr => searches.some(search => {
							if (search.destinationAddress !== undefined && addr.destinationAddress !== search.destinationAddress) {
								return(false);
							}
							return(true);
						}));
					}
					return({ addresses: filtered, total: filtered.length.toString() });
				},

				async listTransactions(request) {
					const transactions: KeetaAssetMovementTransaction[] = [];
					const sourceTxIds = (request.transactions ?? [])
						.map(f => f.transaction.id)
						.filter((id): id is string => typeof id === 'string');

					for (const pf of (request.persistentAddresses ?? [])) {
						if (!('persistentAddress' in pf) || !pf.persistentAddress) {
							continue;
						}
						const meta = addresses.get(pf.persistentAddress);
						if (!meta) {
							continue;
						}
						const { from: fromAsset, to: toAsset } = assetPairStrings(meta.asset);
						const depositValue = forwardValues.get(convertAssetLocationToString(meta.sourceLocation)) ?? 0n;
						const receive = convert({ fromAsset, toAsset, fromLocation: meta.sourceLocation, toLocation: meta.destinationLocation, value: depositValue });
						const correlateId = sourceTxIds[0] ?? `forward-${Math.random().toString(36).slice(2)}`;

						const forwarded = buildTxRecord({
							id: `persistentForwarding-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
							status: 'COMPLETE', asset: meta.asset,
							fromLocation: convertAssetLocationToString(meta.sourceLocation),
							toLocation: convertAssetLocationToString(meta.destinationLocation),
							fromValue: depositValue.toString(), toValue: receive.toString()
						});
						forwarded.from.transactions = { ...forwarded.from.transactions, persistentForwarding: { id: correlateId, nonce: '0' }};
						transactions.push(forwarded);
					}
					return({ transactions, total: transactions.length.toString() });
				}
			}
		});

		this.anchorAccount = anchorAccount;
		this.addresses = addresses;
	}
}

test('Asset Movement Chaining Test', async function({ expect }) {
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
			async createPersistentForwarding() {
				throw(new Error('getTransferStatus not used in metadata tests'));
			},
			async initiateTransfer() {
				throw(new Error('getTransferStatus not used in metadata tests'));
			},

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
			},
			async createPersistentForwarding() {
				throw(new Error('getTransferStatus not used in metadata tests'));
			},
			async initiateTransfer() {
				throw(new Error('getTransferStatus not used in metadata tests'));
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

	expect(paths).toHaveLength(1);

	expect(path.path).toHaveLength(3);

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

async function createChainingTestHarness(options: { includeSwapAnchor?: boolean } = {}) {
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

	const [usBankProviderID, euBankProviderID] = ['BankUS', 'BankEU'] as const;
	const bankProviderDisclaimers: {
		[bankProviderID in typeof usBankProviderID | typeof euBankProviderID]: Exclude<AnchorMetadataLegalField['disclaimers'], undefined>
	} = {
		[usBankProviderID]: [
			{
				purpose: 'general',
				content: {
					type: 'plaintext',
					content: 'This is a legal disclaimer for the US bank server'
				}
			}
		],
		[euBankProviderID]: [
			{
				purpose: 'general',
				content: {
					type: 'plaintext',
					content: 'This is a legal disclaimer for the EU bank server'
				}
			},
			{
				purpose: 'general',
				content: {
					type: 'markdown',
					content: 'This is another legal disclaimer for the EU bank server'
				}
			}
		]
	};

	/*
	 * Bank entries are signed so providers resolve with a service-entry
	 * account, which client-side external construction files entries under.
	 */
	const bankSignerUS = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const bankSignerEU = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const swapSigner = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const bankServerUS = new TestBankServer({
		...(DEBUG ? { logger } : {}),
		client,
		metadataSigner: bankSignerUS,
		assetMovement: {
			legal: {
				disclaimers: bankProviderDisclaimers['BankUS']
			},
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
		metadataSigner: bankSignerEU,
		assetMovement: {
			legal: {
				disclaimers: bankProviderDisclaimers['BankEU']
			},
			supportedAssets: [{
				asset: [ tokens.EURC.publicKeyString.get(), 'EUR' ],
				paths: [{ pair: [
					{ location: 'bank-account:iban-swift', id: 'EUR', rails: { common: [ 'SEPA_PUSH' ] }},
					{ location: keetaLocation, id: tokens.EURC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
				] }]
			}]
		}
	});

	/*
	 * Keeta-to-Keeta token swap anchor (USDC -> EURC). Both rails are
	 * KEETA_SEND, so chaining it before a bank withdrawal produces two
	 * user-funded sends in one execution.
	 */
	const swapServer = new TestBankServer({
		...(DEBUG ? { logger } : {}),
		client,
		metadataSigner: swapSigner,
		assetMovement: {
			supportedAssets: [{
				asset: [ tokens.USDC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ],
				paths: [{ pair: [
					{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
					{ location: keetaLocation, id: tokens.EURC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
				] }]
			}]
		}
	});

	const [fxOneProviderID, fxTwoProviderID] = ['FXOne', 'FXTwo'] as const;
	const fxProviderDisclaimers: {
		[fxProviderID in typeof fxOneProviderID | typeof fxTwoProviderID]: Exclude<AnchorMetadataLegalField['disclaimers'], undefined>
	} = {
		[fxOneProviderID]: [
			{
				purpose: 'general',
				content: { type: 'plaintext', content: 'This is a legal disclaimer for FX provider One' }
			}
		],
		[fxTwoProviderID]: [
			{
				purpose: 'general',
				content: { type: 'plaintext', content: 'This is a legal disclaimer for FX provider Two' }
			},
			{
				purpose: 'general',
				content: { type: 'markdown', content: 'This is another legal disclaimer for FX provider Two' }
			}
		]
	};
	// fxServerOne: 0.88 rate (primary)
	const fxServerOne = new TestFXServer({
		...(DEBUG ? { logger } : {}),
		quoteSigner: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		accounts: new KeetaNet.lib.Account.Set([ fxLPOne ]),
		signer: fxLPOne,
		client,
		giveTokens,
		fx: {
			legal: { disclaimers: fxProviderDisclaimers[fxOneProviderID] },
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
			legal: { disclaimers: fxProviderDisclaimers[fxTwoProviderID] },
			from: [{ currencyCodes: [ tokens.USDC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ], to: [ tokens.USDC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ] }]
		}
	}).setRate(0.85);

	await bankServerUS.start();
	await bankServerEU.start();
	await swapServer.start();
	await fxServerOne.start();
	await fxServerTwo.start();

	// Make FX LPs fee-free so they don't need KTA to execute exchanges
	fees.addFeeFreeAccount(fxLPOne);
	fees.addFeeFreeAccount(fxLPTwo);

	/*
	 * The swap anchor is opt-in: its keeta-to-keeta pair adds round-trip
	 * paths that would change path counts in unrelated tests.
	 */
	const assetMovementServices: { [providerID: string]: Awaited<ReturnType<typeof swapServer.serviceMetadata>> } = {
		[usBankProviderID]: await bankServerUS.serviceMetadata(),
		[euBankProviderID]: await bankServerEU.serviceMetadata()
	};
	if (options.includeSwapAnchor === true) {
		assetMovementServices['SwapKeeta'] = await swapServer.serviceMetadata();
	}

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
				assetMovement: assetMovementServices
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

	const getPlanVia = async (fxProviderID: 'FXOne' | 'FXTwo', options?: GetPlansOptions) => {
		const plans = await anchorChaining.getPlans({
			source: { asset: tokens.USDC, location: keetaLocation, value: 100n, rail: 'KEETA_SEND' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: client.account.publicKeyString.get(), rail: 'SEPA_PUSH' }
		}, options);

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
		swapServer,
		bankSignerUS,
		bankSignerEU,
		swapSigner,
		fxServerOne,
		fxServerTwo,
		anchorChaining,
		bankProviderDisclaimers,
		euBankProviderID,
		usBankProviderID,
		fxProviderDisclaimers,
		fxOneProviderID,
		fxTwoProviderID,
		giveTokens,
		getPlanVia,
		getPathVia,
		[Symbol.asyncDispose]: async function() {
			await bankServerUS[Symbol.asyncDispose]?.();
			await bankServerEU[Symbol.asyncDispose]?.();
			await swapServer[Symbol.asyncDispose]?.();
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

		expect(path.plan.steps).toHaveLength(2);
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

		expect(result.steps).toHaveLength(1);
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

		expect(result.steps).toHaveLength(1);
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

		expect(result.steps).toHaveLength(1);
		expect(path.state.status).toEqual('completed');
		expect(stateHistory[0]).toEqual('executing');
		expect(stateHistory[stateHistory.length - 1]).toEqual('completed');
		expect(emittedSteps).toHaveLength(1);
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
			expect(plan.state.completedSteps).toHaveLength(0);
		}
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) { throw(new Error('Expected failed event')); }
		expect(failedEvent.index).toEqual(0);
		expect(failedEvent.completedSteps).toHaveLength(0);
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
		expect(result.steps).toHaveLength(2);
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
			expect(step1.plan.transfer.transferID).toBeTruthy();
			expect(step1.plan.usingInstruction.type).toEqual('KEETA_SEND');
			const transferStatus = await step1.plan.transfer.getTransferStatus();
			expect(transferStatus.transaction.status).toEqual('COMPLETE');
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
		expect(emittedSteps).toHaveLength(result.steps.length);
		emittedSteps.forEach(({ step, index }) => expect(step).toBe(result.steps[index]));

		// completed event carries the result object
		expect(completedResult).toBe(result);

		// Removed listener was never called
		expect(removedListenerCallCount).toEqual(0);

		// Re-executing a completed path throws
		await expect(path.execute()).rejects.toThrow('Cannot execute');
	});

	test('success: step structure, events, state transitions, and guard rails for storage accounts', async function() {
		await using h = await createChainingTestHarness();

		const { account: storageAccount } = await h.client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);

		await h.client.setInfo({
			name: '',
			description: 'Storage account with permissions from user account',
			metadata: '',
			defaultPermission: new KeetaNet.lib.Permissions(['STORAGE_CAN_HOLD', 'STORAGE_DEPOSIT'])
		}, { account: storageAccount });

		await h.giveTokens(h.client.account, 2000n, h.tokens.USDC);
		await h.client.send(storageAccount, 1000n, h.tokens.USDC);
		await h.client.send(storageAccount, 10n, h.client.baseToken);

		const userSendTokenBalancePre = await h.client.balance(h.tokens.USDC);
		const storageSendTokenBalancePre = await h.client.balance(h.tokens.USDC, { account: storageAccount });
		const userReceiveTokenBalancePre = await h.client.balance(h.tokens.EURC);

		const path = await h.getPlanVia('FXOne', { overrides: { account: storageAccount }});

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

		// Plan totals from FX rate (0.88 forward)
		expect(path.plan.totalValueIn).toEqual(100n);
		expect(path.plan.totalValueOut).toEqual(78n);

		const result = await path.execute();

		// Step structure and server-side verification
		expect(result.steps).toHaveLength(2);
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

		expect(step1?.type).toEqual('assetMovement');
		if (step1?.type === 'assetMovement') {
			expect(step1.plan.transfer.transferID).toBeTruthy();
			expect(step1.plan.usingInstruction.type).toEqual('KEETA_SEND');
			const transferStatus = await step1.plan.transfer.getTransferStatus();
			expect(transferStatus.transaction.status).toEqual('COMPLETE');
			expect(transferStatus.transaction.to.value).toEqual('78');
		}
		// State transitions: idle -> executing -> completed
		expect(path.state.status).toEqual('completed');
		expect(stateHistory[0]).toEqual('executing');
		expect(stateHistory[stateHistory.length - 1]).toEqual('completed');
		if (path.state.status === 'completed') {
			expect(path.state.result).toBe(result);
		}

		const userSendTokenBalancePost = await h.client.balance(h.tokens.USDC);
		const storageSendTokenBalancePost = await h.client.balance(h.tokens.USDC, { account: storageAccount });
		const userReceiveTokenBalancePost = await h.client.balance(h.tokens.EURC);

		expect(storageSendTokenBalancePre - storageSendTokenBalancePost).toEqual(100n);
		expect(userSendTokenBalancePre).toEqual(userSendTokenBalancePost);
		expect(userReceiveTokenBalancePre).toEqual(userReceiveTokenBalancePost);

		// stepExecuted fired once per step, each with the correct step reference
		expect(emittedSteps).toHaveLength(result.steps.length);
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
			expect(path.state.completedSteps).toHaveLength(0);
		}
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) {throw(new Error('Expected failed event'));}
		expect(failedEvent.index).toEqual(0);
		expect(failedEvent.completedSteps).toHaveLength(0);

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
			expect(path.state.completedSteps).toHaveLength(1);
			expect(path.state.completedSteps[0]?.type).toEqual('fx');
		}
		// stepExecuted fired for FX step only
		expect(emittedSteps).toHaveLength(1);
		expect(emittedSteps[0]?.type).toEqual('fx');
		// failed event carries the same completed steps
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) {throw(new Error('Expected failed event'));}
		expect(failedEvent.index).toEqual(1);
		expect(failedEvent.completedSteps).toHaveLength(1);
		expect(failedEvent.completedSteps[0]?.type).toEqual('fx');
	});

	test('AM -> FX -> AM chain: each keeta-side hop holds tokens at the user address', async function() {
		await using h = await createChainingTestHarness();

		const userAddress = h.client.account.publicKeyString.get();
		const capturedUSRecipients: (string | undefined)[] = [];
		const capturedEURecipients: (string | undefined)[] = [];

		h.bankServerUS.wrapInitiateTransfer(async (request, next) => {
			capturedUSRecipients.push(typeof request.to.recipient === 'string' ? request.to.recipient : undefined);
			return(await next(request));
		});
		h.bankServerEU.wrapInitiateTransfer(async (request, next) => {
			capturedEURecipients.push(typeof request.to.recipient === 'string' ? request.to.recipient : undefined);
			return(await next(request));
		});

		const plans = await h.anchorChaining.getPlans({
			source: { asset: 'USD', location: 'bank-account:us', value: 100n, rail: 'ACH' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: userAddress, rail: 'SEPA_PUSH' }
		});

		const path = plans?.find(p =>
			p.plan.steps.length === 3 && p.plan.steps.some(s => s.type === 'fx' && s.step.providerID === 'FXOne')
		);
		if (!path) { throw(new Error('Expected 3-step path via FXOne')); }

		expect(path.plan.steps).toHaveLength(3);
		expect(path.plan.steps[0]?.type).toBe('assetMovement');
		expect(path.plan.steps[1]?.type).toBe('fx');
		expect(path.plan.steps[2]?.type).toBe('assetMovement');

		expect(await h.client.balance(h.tokens.USDC)).toBe(0n);
		expect(await h.client.balance(h.tokens.EURC)).toBe(0n);

		let afterStep0Balance: { usdc: bigint; eurc: bigint } | null = null;
		let afterStep1Balance: { usdc: bigint; eurc: bigint } | null = null;

		path.on('stepNeedsAction', async (payload) => {
			if (payload.type === 'assetMovementUserExecutionRequired') {
				await h.giveTokens(h.client.account, 90n, h.tokens.USDC);
				afterStep0Balance = {
					usdc: await h.client.balance(h.tokens.USDC),
					eurc: await h.client.balance(h.tokens.EURC)
				};
				payload.markCompleted();
			} else if (payload.type === 'keetaSendAuthRequired') {
				afterStep1Balance = {
					usdc: await h.client.balance(h.tokens.USDC),
					eurc: await h.client.balance(h.tokens.EURC)
				};
				payload.markCompleted({ sent: true });
			}
		});

		const result = await path.execute({ requireSendAuth: true });

		expect(result.steps).toHaveLength(3);
		expect(path.state.status).toBe('completed');

		expect(capturedUSRecipients.length).toBeGreaterThan(0);
		capturedUSRecipients.forEach(r => expect(r).toBe(userAddress));
		expect(afterStep0Balance).toEqual({ usdc: 90n, eurc: 0n });

		expect(afterStep1Balance).toEqual({ usdc: 0n, eurc: 79n });

		expect(await h.client.balance(h.tokens.USDC)).toBe(0n);
		expect(await h.client.balance(h.tokens.EURC)).toBe(0n);
		expect(capturedEURecipients.length).toBeGreaterThan(0);
		capturedEURecipients.forEach(r => expect(r).toBe(userAddress));
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
		expect(paths).toHaveLength(1);
		const path = paths[0];

		expect(path.path).toHaveLength(1);

		expect(path.plan.steps).toHaveLength(1);
		expect(path.plan.totalValueIn).toEqual(200n);
		expect(path.plan.totalValueOut).toEqual(200n);

		expect(path.state.status).toEqual('idle');
		const result = await path.execute();
		expect(result.steps).toHaveLength(1);
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

	test('markCompleted signals completion; server records transfer as COMPLETE', async function() {
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

		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]?.type).toEqual('assetMovement');
		if (result.steps[0]?.type === 'assetMovement') {
			// value = 100 - 10 fee = 90
			const transferStatus = await result.steps[0].plan.transfer.getTransferStatus();
			expect(transferStatus.transaction.status).toEqual('COMPLETE');
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
			expect(path.state.completedSteps).toHaveLength(0);
		}
		expect(failedEvents).toHaveLength(1);
		const failedEvent = failedEvents[0];
		if (!failedEvent) {throw(new Error('Expected failed event'));}
		expect(failedEvent.index).toEqual(0);
		expect(failedEvent.completedSteps).toHaveLength(0);
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

	test('anchor omitting external: client constructs the unsigned correlation envelope', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		// Anchor under the construction model: instructions carry no external.
		h.bankServerEU.wrapInitiateTransfer(stripKeetaSendExternal);

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

		/*
		 * Completion proves the fixture correlated the SEND by decoding the
		 * client-built envelope rather than matching a raw transfer id.
		 */
		const result = await path.execute({ requireSendAuth: true });
		expect(result.steps).toHaveLength(2);

		const step1 = result.steps[1];
		if (step1?.type !== 'assetMovement') {
			throw(new Error('Expected asset movement step'));
		}

		const action = capturedActions[0];
		if (action?.external === undefined) {
			throw(new Error('Expected client-built external on the send action'));
		}

		/*
		 * The prior FX hop forwards its settled swap block, so the client-built
		 * envelope references it as an on-chain input.
		 */
		const step0 = result.steps[0];
		if (step0?.type !== 'fx') {
			throw(new Error('Expected fx step'));
		}

		const fxStatus = await step0.exchange.getExchangeStatus();
		if (fxStatus?.status !== 'completed') {
			throw(new Error('Expected fx exchange to complete'));
		}

		const decoded = await AnchorExternal.fromPlainExternal(action.external);
		expect(decoded.signed).toBeUndefined();
		expect(decoded.envelope.inputs).toEqual([ { blockHash: fxStatus.blockhash } ]);
		expect(decoded.envelope.anchors).toEqual({
			[h.bankSignerEU.publicKeyString.get()]: { transactionId: step1.plan.transfer.transferID }
		});
	});

	test('chained keeta sends: the second envelope references the first send as an input', async function() {
		await using h = await createChainingTestHarness({ includeSwapAnchor: true });
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		/*
		 * The swap anchor settles EURC off-chain in this fixture, so the
		 * user's EURC for the second hop is pre-funded.
		 */
		await h.giveTokens(h.client.account, 1000n, h.tokens.EURC);

		/*
		 * Both anchors omit external, so the client builds both envelopes.
		 */
		h.swapServer.wrapInitiateTransfer(stripKeetaSendExternal);
		h.bankServerEU.wrapInitiateTransfer(stripKeetaSendExternal);

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, value: 100n, rail: 'KEETA_SEND' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: h.client.account.publicKeyString.get(), rail: 'SEPA_PUSH' }
		});
		const path = plans?.find(function(plan) {
			if (plan.path.length !== 2) {
				return(false);
			}

			return(plan.path[0]?.providerID === 'SwapKeeta' && plan.path[1]?.providerID === h.euBankProviderID);
		});
		if (!path) {
			throw(new Error('Expected SwapKeeta -> BankEU path'));
		}

		const capturedExternals: (string | undefined)[] = [];
		path.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				capturedExternals.push(payload.action.external);
				payload.markCompleted({ sent: true });
			} else {
				payload.markCompleted();
			}
		});

		const result = await path.execute({ requireSendAuth: true });
		expect(result.steps).toHaveLength(2);
		expect(capturedExternals).toHaveLength(2);

		const [firstExternal, secondExternal] = capturedExternals;
		if (firstExternal === undefined || secondExternal === undefined) {
			throw(new Error('Expected client-built externals on both sends'));
		}

		// First hop: no prior on-chain operations, so no inputs.
		const firstDecoded = await AnchorExternal.fromPlainExternal(firstExternal);
		expect(firstDecoded.envelope.inputs).toBeUndefined();
		expect(Object.keys(firstDecoded.envelope.anchors)).toEqual([ h.swapSigner.publicKeyString.get() ]);

		// Second hop: filed under BankEU and referencing the first send.
		const secondDecoded = await AnchorExternal.fromPlainExternal(secondExternal);
		expect(Object.keys(secondDecoded.envelope.anchors)).toEqual([ h.bankSignerEU.publicKeyString.get() ]);
		expect(secondDecoded.envelope.inputs).toHaveLength(1);

		const input = secondDecoded.envelope.inputs?.[0];
		if (input === undefined) {
			throw(new Error('Expected an input referencing the first send'));
		}

		expect(input.operationIndex).toBe(0);

		// The referenced block is the first hop's on-chain SEND.
		const referencedBlock = await h.client.block(input.blockHash);
		if (referencedBlock === null) {
			throw(new Error('Referenced input block not found on chain'));
		}

		const referencedExternals = referencedBlock.operations.flatMap(function(op) {
			if (op.type === KeetaNet.lib.Block.OperationType.SEND) {
				return([ op.external ]);
			}

			return([]);
		});

		expect(referencedExternals).toEqual([ firstExternal ]);
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

	test('from filter populates distance.pathLength with shortest hop count', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets({
			from: { asset: h.tokens.USDC, location: h.keetaLocation }
		});

		const distanceByKey = new Map(assets.map(a => [resultKey(a), a.distance?.pathLength]));
		expect(distanceByKey.get(`${h.tokens.EURC.publicKeyString.get()}@${h.keetaLocation}`)).toBe(1);
		expect(distanceByKey.get(`USD@bank-account:us`)).toBe(1);
		expect(distanceByKey.get(`EUR@bank-account:iban-swift`)).toBe(2);
	});

	test('to filter populates distance.pathLength with shortest hop count', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets({
			to: { location: 'bank-account:us' },
			maxStepCount: 1
		});

		expect(assets).toHaveLength(1);
		expect(assets[0]?.distance).toEqual({ pathLength: 1 });
	});

	test('no filter returns distance null for all assets', async function() {
		await using h = await createChainingTestHarness();
		const assets = await h.anchorChaining.graph.listAssets();

		for (const asset of assets) {
			expect(asset.distance).toBeNull();
		}
	});
});

test('AnchorChaining getPlans includeAllOutput', async function() {
	await using h = await createChainingTestHarness();

	const input = {
		source:      { asset: h.tokens.USDC, location: h.keetaLocation, value: 100n, rail: 'KEETA_SEND' as const },
		destination: { asset: 'EUR' as const, location: 'bank-account:iban-swift' as const, recipient: h.client.account.publicKeyString.get(), rail: 'SEPA_PUSH' as const }
	};

	const allOk = await h.anchorChaining.getPlans(input, { includeAllOutput: true });
	expect(allOk).not.toBeNull();
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
	expect(mixed).not.toBeNull();
	expect(mixed).toHaveLength(2);

	const failed    = mixed?.find(r => !r.success);
	const succeeded = mixed?.find(r => r.success);

	expect(failed).toBeDefined();
	if (!failed || failed.success) {
		throw(new Error('Expected a failed result'));
	}
	expect(failed.error).toBeTruthy();
	expect(failed.path).toBeDefined();

	expect(succeeded).toBeDefined();
	if (!succeeded || !succeeded.success) {
		throw(new Error('Expected a successful result'));
	}
	expect(succeeded.plan).toBeDefined();
	expect(succeeded.path).toBeDefined();
	expect(succeeded.plan.plan.steps.some(s => s.type === 'fx' && s.step.providerID === 'FXTwo')).toBe(true);

	const defaultResults = await h.anchorChaining.getPlans(input);
	expect(defaultResults).not.toBeNull();
	expect(defaultResults).toHaveLength(1);
	expect(defaultResults?.[0]?.plan.steps.some(s => s.type === 'fx' && s.step.providerID === 'FXTwo')).toBe(true);
});

test('AnchorChaining resolveAssets', async function() {
	await using h = await createChainingTestHarness();

	const usdcKey = `${h.tokens.USDC.publicKeyString.get()}@${h.keetaLocation}`;
	const eurcKey = `${h.tokens.EURC.publicKeyString.get()}@${h.keetaLocation}`;
	const usdKey = `USD@bank-account:us`;
	const eurKey = `EUR@bank-account:iban-swift`;

	const resultKey = (item: AnchorChainingAssetInfo): string => {
		const assetStr = KeetaNet.lib.Account.isInstance(item.asset)
			? item.asset.publicKeyString.get()
			: String(item.asset);
		return(`${assetStr}@${convertAssetLocationToString(item.location)}`);
	};

	type ExpectedAsset = { key: string; distance: number | null };

	const testCases: {
		name: string;
		args: AnchorChainingResolveAssetsFilter | AnchorChainingResolveAssetsFilter[];
		expected: { from: ExpectedAsset[]; to: ExpectedAsset[] };
	}[] = [
		{
			name: 'from only',
			args: { from: { asset: h.tokens.USDC, location: h.keetaLocation }},
			expected: {
				from: [],
				to: [
					{ key: eurcKey, distance: 1 },
					{ key: usdKey,  distance: 1 },
					{ key: eurKey,  distance: 2 },
					{ key: usdcKey, distance: 2 }
				]
			}
		},
		{
			name: 'to only with maxStepCount: 1',
			args: { to: { location: 'bank-account:us' }, maxStepCount: 1 },
			expected: {
				from: [{ key: usdcKey, distance: 1 }],
				to:   []
			}
		},
		{
			name: 'no filter',
			args: {},
			expected: {
				from: [
					{ key: usdcKey, distance: null },
					{ key: eurcKey, distance: null },
					{ key: usdKey,  distance: null },
					{ key: eurKey,  distance: null }
				],
				to: [
					{ key: usdcKey, distance: null },
					{ key: eurcKey, distance: null },
					{ key: usdKey,  distance: null },
					{ key: eurKey,  distance: null }
				]
			}
		},
		{
			name: 'from+to: keeta -> bank-account:us',
			args: [
				{ from: { location: h.keetaLocation }, to: { location: 'bank-account:us' }},
				{ from: { location: h.keetaLocation, rail: 'KEETA_SEND' }, to: { location: 'bank-account:us' }},
				{ from: { location: h.keetaLocation }, to: { location: 'bank-account:us', rail: 'ACH' }},
				{ from: { location: h.keetaLocation, rail: 'KEETA_SEND' }, to: { location: 'bank-account:us', rail: 'ACH' }},
				{ from: { location: h.keetaLocation, rail: undefined }, to: { location: 'bank-account:us', rail: 'ACH' }},
				{ from: { location: h.keetaLocation, rail: undefined }, to: { location: 'bank-account:us', rail: undefined }}
			],
			expected: {
				from: [
					{ key: usdcKey, distance: 1 },
					{ key: eurcKey, distance: 2 }
				],
				to: [{ key: usdKey, distance: 1 }]
			}
		},
		{
			name: 'from+to: keeta -> bank-account:us with invalid rail',
			args: [
				{ from: { location: h.keetaLocation }, to: { location: 'bank-account:us', rail: 'BITCOIN_SEND' }},
				{ from: { location: h.keetaLocation, rail: 'ACH' }, to: { location: 'bank-account:us' }}
			],
			expected: {
				from: [],
				to: []
			}
		},
		{
			name: 'from+to: to.rail SEPA_PUSH filters to EU corridor',
			args: { from: { location: h.keetaLocation }, to: { location: 'bank-account:iban-swift', rail: 'SEPA_PUSH' }},
			expected: {
				from: [
					{ key: eurcKey, distance: 1 },
					{ key: usdcKey, distance: 2 }
				],
				to: [{ key: eurKey, distance: 1 }]
			}
		},
		{
			name: 'from+to: from.rail ACH limits from assets to those with ACH outbound',
			args: { from: { rail: 'ACH' }, to: { location: h.keetaLocation }},
			expected: {
				from: [{ key: usdKey, distance: 1 }],
				to: [
					{ key: usdcKey, distance: 1 },
					{ key: eurcKey, distance: 2 }
				]
			}
		}
	];

	for (const { name, args, expected } of testCases) {
		let argsArray;
		if (Array.isArray(args)) {
			argsArray = args;
		} else {
			argsArray = [ args ];
		}

		for (const argValue of argsArray) {
			const result = await h.anchorChaining.graph.resolveAssets(argValue);
			const toActual = (side: AnchorChainingAssetInfo[]): ExpectedAsset[] =>
				side.map(a => ({ key: resultKey(a), distance: a.distance?.pathLength ?? null }));

			expect(toActual(result.from), `${name}: from`).toEqual(expect.arrayContaining(expected.from));
			expect(result.from, `${name}: from length`).toHaveLength(expected.from.length);
			expect(toActual(result.to), `${name}: to`).toEqual(expect.arrayContaining(expected.to));
			expect(result.to, `${name}: to length`).toHaveLength(expected.to.length);
		}
	}
});

describe('AnchorChainingAssetInfo metadata', function() {
	async function createMetadataHarness() {
		const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const { userClient: client } = await createNodeAndClient(account);

		const makeToken = async () => {
			const { account } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			return(account.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
		};

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		const evmChainLocation = 'chain:evm:500' as const;
		const keetaLocation = `chain:keeta:${client.network}` as const;
		const tokens = { USDC: await makeToken() };
		const usdcEvmId: AnchorChainingAsset = 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973';

		const bridgeOneMetadata: AnchorTokenLocationMetadata = {
			displayName: 'Circle USDC',
			decimalPlaces: 6,
			ticker: '$USDC',
			logoURI: 'example.com/usdc-logo'
		};

		const bridgeTwoMetadata: AnchorTokenLocationMetadata = {
			displayName: 'USDC (alt)',
			decimalPlaces: 6,
			ticker: '$USDC',
			logoURI: 'example.com/usdc-logo-2'
		};

		const makeBridge = (metadata: typeof bridgeOneMetadata) => new KeetaNetAssetMovementAnchorHTTPServer({
			...(logger ? { logger: logger } : {}),
			assetMovement: {
				supportedAssets: [
					{
						asset: tokens.USDC.publicKeyString.get(),
						paths: [{
							pair: [
								{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
								{ location: evmChainLocation, id: usdcEvmId, rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] }}
							]
						}]
					},
					{
						asset: '$USDC',
						paths: [
							{
								pair: [
									{ location: evmChainLocation, id: usdcEvmId, rails: { common: [ 'EVM_SEND' ] }},
									{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { inbound: [ 'KEETA_SEND' ] }}
								]
							}
						]
					}
				],
				locationMetadata: {
					[evmChainLocation]: {
						assets: {
							[usdcEvmId]: metadata
						}
					}
				},
				async getTransferStatus() {
					throw(new Error('getTransferStatus not used in metadata tests'));
				},
				async createPersistentForwarding() {
					throw(new Error('getTransferStatus not used in metadata tests'));
				},
				async initiateTransfer() {
					throw(new Error('getTransferStatus not used in metadata tests'));
				}
			}
		});

		const bridgeOne = makeBridge(bridgeOneMetadata);
		const bridgeTwo = makeBridge(bridgeTwoMetadata);

		await bridgeOne.start();
		await bridgeTwo.start();

		await client.setInfo({
			description: 'Metadata Test',
			name: 'TEST',
			metadata: Resolver.Metadata.formatMetadata({
				version: 1,
				currencyMap: { '$USDC': tokens.USDC.publicKeyString.get() },
				services: {
					assetMovement: {
						BridgeOne: await bridgeOne.serviceMetadata(),
						BridgeTwo: await bridgeTwo.serviceMetadata()
					}
				}
			} satisfies ServiceMetadataExternalizable)
		});

		const anchorChaining = new AnchorChaining({
			client,
			resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
		});

		return({
			client,
			tokens,
			keetaLocation,
			evmChainLocation,
			usdcEvmId,
			bridgeOneMetadata,
			bridgeTwoMetadata,
			anchorChaining,
			[Symbol.asyncDispose]: async function() {
				await bridgeOne[Symbol.asyncDispose]?.();
				await bridgeTwo[Symbol.asyncDispose]?.();
			}
		});
	}

	test('listAssetsWithMetadata populates metadata for external chain assets', async function() {
		await using h = await createMetadataHarness();
		const assets = await h.anchorChaining.graph.listAssetsWithMetadata();

		const evmAsset = assets.find(a =>
			!KeetaNet.lib.Account.isInstance(a.asset) &&
			String(a.asset) === h.usdcEvmId &&
			a.location === h.evmChainLocation
		);

		expect(evmAsset).toBeDefined();
		expect(evmAsset?.metadata).toBeTruthy();
		expect(evmAsset?.metadata).toMatchObject({
			ticker: '$USDC',
			decimalPlaces: 6
		});
	});

	test('listAssetsWithMetadata returns undefined metadata for Keeta-native tokens', async function() {
		await using h = await createMetadataHarness();
		const assets = await h.anchorChaining.graph.listAssetsWithMetadata();

		const keetaAsset = assets.find(a =>
			KeetaNet.lib.Account.isInstance(a.asset) &&
			a.asset.publicKeyString.get() === h.tokens.USDC.publicKeyString.get()
		);

		expect(keetaAsset).toBeDefined();
		expect(keetaAsset?.metadata).toBeUndefined();
	});

	test('resolveAssetsWithMetadata populates metadata on results', async function() {
		await using h = await createMetadataHarness();
		const result = await h.anchorChaining.graph.resolveAssetsWithMetadata({
			from: { location: h.keetaLocation },
			to: { location: h.evmChainLocation }
		});

		const evmAsset = result.to.find(a =>
			!KeetaNet.lib.Account.isInstance(a.asset) &&
			String(a.asset) === h.usdcEvmId
		);

		expect(evmAsset).toBeDefined();
		expect(evmAsset?.metadata).toBeTruthy();
		expect(evmAsset?.metadata).toMatchObject({
			ticker: '$USDC',
			decimalPlaces: 6
		});

		const keetaAsset = result.from.find(a =>
			KeetaNet.lib.Account.isInstance(a.asset) &&
			a.asset.publicKeyString.get() === h.tokens.USDC.publicKeyString.get()
		);
		expect(keetaAsset).toBeDefined();
		expect(keetaAsset?.metadata).toBeUndefined();
	});

	test('resolveAssetsWithMetadata with providerID returns that providers metadata', async function() {
		await using h = await createMetadataHarness();

		const bridgeOneResult = await h.anchorChaining.graph.resolveAssetsWithMetadata(
			{ to: { location: h.evmChainLocation }, from: { location: h.keetaLocation }},
			{ providerID: 'BridgeOne' }
		);

		const bridgeOneEvmAsset = bridgeOneResult.to.find(a =>
			!KeetaNet.lib.Account.isInstance(a.asset) &&
			String(a.asset) === h.usdcEvmId &&
			a.location === h.evmChainLocation
		);

		expect(bridgeOneEvmAsset).toBeDefined();
		expect(bridgeOneEvmAsset?.metadata).toEqual(h.bridgeOneMetadata);

		const bridgeTwoResult = await h.anchorChaining.graph.resolveAssetsWithMetadata(
			{ to: { location: h.evmChainLocation }, from: { location: h.keetaLocation }},
			{ providerID: 'BridgeTwo' }
		);

		const bridgeTwoEvmAsset = bridgeTwoResult.to.find(a =>
			!KeetaNet.lib.Account.isInstance(a.asset) &&
			String(a.asset) === h.usdcEvmId
		);

		expect(bridgeTwoEvmAsset).toBeDefined();
		expect(bridgeTwoEvmAsset?.metadata).toEqual(h.bridgeTwoMetadata);
	});

	test('listAssetsWithMetadata with unknown providerID returns undefined metadata', async function() {
		await using h = await createMetadataHarness();

		const assets = await h.anchorChaining.graph.listAssetsWithMetadata(
			{ to: { location: h.evmChainLocation }},
			{ providerID: 'NonExistentBridge' }
		);

		const evmAsset = assets.find(a =>
			!KeetaNet.lib.Account.isInstance(a.asset) &&
			String(a.asset) === h.usdcEvmId
		);

		expect(evmAsset).toBeDefined();
		expect(evmAsset?.metadata).toBeUndefined();
	});

	test('getAssetMovementProvidersForAsset returns all providers supporting an asset/location', async function() {
		await using h = await createMetadataHarness();

		const providers = await h.anchorChaining.graph.getAssetMovementProvidersForAsset(
			h.usdcEvmId,
			h.evmChainLocation
		);

		expect(providers).not.toBeNull();
		expect(Object.keys(providers ?? {}).sort()).toEqual(['BridgeOne', 'BridgeTwo']);

		for (const entry of Object.values(providers ?? {})) {
			expect(entry.provider).toBeDefined();
		}
	});

	test('getAssetMovementProvidersForAsset finds providers for Keeta-side assets too', async function() {
		await using h = await createMetadataHarness();

		const providers = await h.anchorChaining.graph.getAssetMovementProvidersForAsset(
			h.tokens.USDC,
			h.keetaLocation
		);

		expect(providers).not.toBeNull();
		expect(Object.keys(providers ?? {}).sort()).toEqual(['BridgeOne', 'BridgeTwo']);
	});

	test('getAssetMovementProvidersForAsset returns null for an unknown asset/location pair', async function() {
		await using h = await createMetadataHarness();

		const providers = await h.anchorChaining.graph.getAssetMovementProvidersForAsset(
			'evm:0x000000000000000000000000000000000000dEaD',
			h.evmChainLocation
		);

		expect(providers).toBeNull();
	});
});

describe('AnchorChainingPlan disclaimers', function() {
	test('anchorChaining paths should return the correct legal disclaimers', async function() {
		await using h = await createChainingTestHarness();

		// EU Bank Paths

		const euBankPaths = await h.anchorChaining.getPaths({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND', value: 100n },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: h.client.account.publicKeyString.get(), rail: 'SEPA_PUSH' }
		});

		if (!euBankPaths || euBankPaths.length === 0) {
			throw(new Error('Expected at least one valid path'));
		}

		for (const euBankPath of euBankPaths) {
			const expectedProviderDisclaimers = euBankPath.path.map((step) => {
				if (!step.providerID) {
					throw(new Error('Expected step to have a provider ID'));
				}

				const expectedDisclaimersMap: { [key: string]: Disclaimer[] } = step.type === 'assetMovement' ? h.bankProviderDisclaimers : h.fxProviderDisclaimers;

				return({
					providerID: step.providerID,
					disclaimers: expectedDisclaimersMap[step.providerID]
				})
			})

			const disclaimers = await euBankPath.getProviderLegalDisclaimers();
			expect(disclaimers).toHaveLength(euBankPath.path.length);
			expect(disclaimers).toEqual(expectedProviderDisclaimers);
		}

		// US Bank Paths

		const usBankPaths = await h.anchorChaining.getPaths({
			source: { asset: h.tokens.EURC, location: h.keetaLocation, rail: 'KEETA_SEND', value: 100n },
			destination: { asset: 'USD', location: 'bank-account:us', recipient: h.client.account.publicKeyString.get(), rail: 'ACH' }
		});

		if (!usBankPaths || usBankPaths.length === 0) {
			throw(new Error('Expected at least one valid path'));
		}

		for (const usBankPath of usBankPaths) {
			const expectedProviderDisclaimers = usBankPath.path.map((step) => {
				if (!step.providerID) {
					throw(new Error('Expected step to have a provider ID'));
				}
				const expectedDisclaimersMap: { [key: string]: Disclaimer[] } = step.type === 'assetMovement' ? h.bankProviderDisclaimers : h.fxProviderDisclaimers;
				return({
					providerID: step.providerID,
					disclaimers: expectedDisclaimersMap[step.providerID]
				})
			})

			const disclaimers = await usBankPath.getProviderLegalDisclaimers();
			expect(disclaimers).toHaveLength(usBankPath.path.length);
			expect(disclaimers).toEqual(expectedProviderDisclaimers);
		}

		// Keeta Paths

		const networkPaths = await h.anchorChaining.getPaths({
			source: { asset: h.tokens.EURC, location: h.keetaLocation, rail: 'KEETA_SEND', value: 100n },
			destination: { asset: h.tokens.USDC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND' }
		});

		if (!networkPaths || networkPaths.length === 0) {
			throw(new Error('Expected at least one valid path'));
		}

		for (const networkPath of networkPaths) {
			const expectedProviderDisclaimers = networkPath.path.slice(0, 2).map((step) => {
				if (!step.providerID) {
					throw(new Error('Expected step to have a provider ID'));
				}
				const expectedDisclaimersMap: { [key: string]: Disclaimer[] } = step.type === 'assetMovement' ? h.bankProviderDisclaimers : h.fxProviderDisclaimers;
				return({
					providerID: step.providerID,
					disclaimers: expectedDisclaimersMap[step.providerID]
				})
			})
			const disclaimers = await networkPath.getProviderLegalDisclaimers();
			expect(disclaimers).toHaveLength(expectedProviderDisclaimers.length);
			expect(disclaimers).toEqual(expectedProviderDisclaimers);
		}
	});
});

describe('Persistent Forwarding chaining', function() {
	const PFR_SUPPORTED_OPS = { initiateTransfer: false, createPersistentForwarding: true } as const;

	function newDestinationAccount() {
		return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
	}

	function firstPath<T>(paths: T[] | null | undefined): T {
		const found = paths?.[0];
		if (!paths || !found) {
			throw(new Error(`No paths found`));
		}

		return(found);
	}

	type PersistentForwardingHarness = Awaited<ReturnType<typeof createPersistentForwardingHarness>>;

	async function getKeetaUsdcToUsdc2Path(h: PersistentForwardingHarness, value: bigint, recipient: GenericAccount) {
		const paths = await h.anchorChaining.getPaths({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, value, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.USDC2, location: h.keetaLocation, recipient: recipient.publicKeyString.get(), rail: 'KEETA_SEND' }
		});
		return(firstPath(paths));
	}

	async function createPersistentForwardingHarness() {
		const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const { userClient: client } = await createNodeAndClient(account);

		const makeToken = async () => {
			const { account: tokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

			await client.setInfo(
				{ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS']) },
				{ account: tokenAccount }
			);

			return(tokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
		};

		const evmChainLocation = 'chain:evm:500' satisfies AssetLocationLike;
		const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;
		const evmUsdcId = 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973';

		const tokens = { USDC: await makeToken(), USDC2: await makeToken() };

		type AssetEntry = KeetaAnchorAssetMovementServerConfig['assetMovement']['supportedAssets'][number];
		const makeAssetEntry = (keetaToken: TokenAddress): AssetEntry => ({
			asset: keetaToken.publicKeyString.get(),
			paths: [{
				pair: [
					{ location: keetaLocation, id: keetaToken.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
					{ location: evmChainLocation, id: evmUsdcId, rails: { common: [{ rail: 'EVM_SEND', supportedOperations: PFR_SUPPORTED_OPS }] }}
				]
			}]
		});

		const bridgeServer = new TestPersistentForwardingBridgeServer({
			...(DEBUG ? { logger } : {}),
			client,
			assetMovement: {
				supportedAssets: [
					makeAssetEntry(tokens.USDC),
					makeAssetEntry(tokens.USDC2)
				]
			}
		});

		await bridgeServer.start();

		await client.setInfo({
			description: 'Persistent Forwarding Chain Test Root',
			name: 'TEST',
			metadata: Resolver.Metadata.formatMetadata({
				version: 1,
				currencyMap: Object.fromEntries(Object.entries(tokens).map(function([ symbol, token ]) {
					return([ `$${symbol}`,  token.publicKeyString.get() ]);
				})),
				services: {
					assetMovement: {
						PersistentForwardingBridge: await bridgeServer.serviceMetadata()
					}
				}
			} satisfies ServiceMetadataExternalizable)
		});

		const anchorChaining = new AnchorChaining({
			client,
			resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
		});

		return({
			client,
			anchorChaining,
			tokens,
			keetaLocation,
			evmChainLocation,
			bridgeServer,
			[Symbol.asyncDispose]: async function() {
				await bridgeServer[Symbol.asyncDispose]?.();
			}
		});
	}

	test('graph nodes carry rail supportedOperations metadata', async function() {
		await using h = await createPersistentForwardingHarness();

		const nodes = await h.anchorChaining.graph.computeGraphNodes();
		const evmSourceNode = nodes.find(n =>
			n.type === 'assetMovement' &&
			n.from.location === h.evmChainLocation &&
			n.from.rail === 'EVM_SEND'
		);
		expect(evmSourceNode).toBeDefined();
		expect(evmSourceNode?.from.supportedOperations).toEqual(PFR_SUPPORTED_OPS);
	});

	test('plan computes a forwarded step when last step source rail forbids initiateTransfer', async function() {
		await using h = await createPersistentForwardingHarness();

		const destinationAccount = newDestinationAccount();
		const path = await getKeetaUsdcToUsdc2Path(h, 1000n, destinationAccount);
		expect(path.path).toHaveLength(2);

		const lastPathStep = path.path[1];
		if (!lastPathStep || lastPathStep.type !== 'assetMovement') {
			throw(new Error(`Expected last path step to be assetMovement`));
		}

		expect(lastPathStep.from.supportedOperations).toEqual(PFR_SUPPORTED_OPS);

		const plan = await AnchorChainingPlan.create(path);
		expect(plan.plan.steps).toHaveLength(2);
		expect(plan.plan.steps[0]?.type).toEqual('assetMovement');
		expect(plan.plan.steps[1]?.type).toEqual('forwarded');

		expect(h.bridgeServer.addresses.size).toEqual(1);

		const onlyAddress = [...h.bridgeServer.addresses.entries()][0];
		if (!onlyAddress) {
			throw(new Error(`Persistent forwarding address was not created during plan computation`));
		}

		const [persistentAddress, addressMeta] = onlyAddress;
		expect(addressMeta.destinationAddress).toEqual(destinationAccount.publicKeyString.get());
		expect(addressMeta.sourceLocation).toEqual(h.evmChainLocation);
		expect(addressMeta.destinationLocation).toEqual(h.keetaLocation);

		/*
		 * Prior step must deposit into the persistent forwarding address.
		 */
		const firstResolved = plan.plan.steps[0];
		if (firstResolved?.type !== 'assetMovement') {
			throw(new Error(`Expected first step to be assetMovement`));
		}

		expect(firstResolved.transfer).toBeDefined();
		expect(firstResolved.sendingTo).toEqual('NEXT_STEP');

		const forwardedResolved = plan.plan.steps[1];
		if (forwardedResolved?.type !== 'forwarded') {
			throw(new Error(`Expected last step to be forwarded`));
		}

		expect(forwardedResolved.persistentAddress.address).toEqual(persistentAddress);
		expect(forwardedResolved.valueIn).toEqual(1000n);
		expect(forwardedResolved.valueOut).toEqual(975n);
		expect(forwardedResolved.simulatedTransfer).toBeDefined();
		expect(forwardedResolved.simulatedTransfer?.isSimulation).toBe(true);

		const fees = plan.listFees();
		const forwardedFees = fees.lineItems.filter((item) => item.metadata.stepIndex === 1);
		expect(forwardedFees).toHaveLength(1);
		expect(forwardedFees[0]?.value).toEqual('25');
		expect(forwardedFees[0]?.metadata.source).toEqual('simulatedTransfer');
		expect(forwardedFees[0]?.asset).toBeDefined();
		expect('total' in fees).toBe(false);
	});

	test('plan reuses an existing persistent forwarding address when present', async function() {
		await using h = await createPersistentForwardingHarness();

		const destinationAccount = newDestinationAccount();

		const initialPath = await getKeetaUsdcToUsdc2Path(h, 500n, destinationAccount);
		await AnchorChainingPlan.create(initialPath);
		expect(h.bridgeServer.addresses.size).toEqual(1);

		const retryPath = await getKeetaUsdcToUsdc2Path(h, 500n, destinationAccount);
		await AnchorChainingPlan.create(retryPath);
		expect(h.bridgeServer.addresses.size).toEqual(1);
	});

	test('plan reuses persistent forwarding address when listed assets use canonical string form', async function() {
		await using h = await createPersistentForwardingHarness();

		const destinationAccount = newDestinationAccount();

		const initialPath = await getKeetaUsdcToUsdc2Path(h, 500n, destinationAccount);
		await AnchorChainingPlan.create(initialPath);
		expect(h.bridgeServer.addresses.size).toEqual(1);

		for (const meta of h.bridgeServer.addresses.values()) {
			if (!isAssetPairLike(meta.asset)) {
				continue;
			}

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			meta.asset = {
				from: convertAssetSearchInputToCanonical(meta.asset.from).toLowerCase(),
				to: convertAssetSearchInputToCanonical(meta.asset.to)
			} as AssetOrPair;
		}

		const retryPath = await getKeetaUsdcToUsdc2Path(h, 500n, destinationAccount);
		await AnchorChainingPlan.create(retryPath);
		expect(h.bridgeServer.addresses.size).toEqual(1);
	});

	test('executes the chain through the persistent forwarding step end-to-end', async function() {
		await using h = await createPersistentForwardingHarness();

		await h.client.modTokenSupplyAndBalance(2000n, h.tokens.USDC);

		const destinationAccount = newDestinationAccount();
		const path = await getKeetaUsdcToUsdc2Path(h, 1000n, destinationAccount);

		const plan = await AnchorChainingPlan.create(path);

		const observedTransactions: {
			stepIndex: number;
			source: 'getTransferStatus' | 'listTransactions';
			additionalTransferDetails?: KeetaAssetMovementTransaction['additionalTransferDetails'];
		}[] = [];
		plan.on('transactionObserved', (payload) => {
			observedTransactions.push({
				stepIndex: payload.stepIndex,
				source: payload.source,
				additionalTransferDetails: payload.transaction.additionalTransferDetails
			});
		});

		const result = await plan.execute();
		expect(result.steps).toHaveLength(2);

		const firstExecuted = result.steps[0];
		if (firstExecuted?.type !== 'assetMovement') {
			throw(new Error(`Expected first executed step to be assetMovement`));
		}

		const forwardedExecuted = result.steps[1];
		if (forwardedExecuted?.type !== 'forwarded') {
			throw(new Error(`Expected last executed step to be forwarded`));
		}

		expect(forwardedExecuted.observedTransaction.status).toEqual('COMPLETE');
		expect(forwardedExecuted.observedTransaction.from.value).toEqual('1000');
		expect(forwardedExecuted.observedTransaction.to.location).toEqual(h.keetaLocation);

		expect(observedTransactions.some((item) => item.stepIndex === 0 && item.source === 'getTransferStatus' && item.additionalTransferDetails?.content === 'Bridge withdraw complete')).toBe(true);
		expect(observedTransactions.some((item) => item.stepIndex === 1 && item.source === 'listTransactions' && item.additionalTransferDetails?.content === 'Forwarded leg complete')).toBe(true);

		expect(plan.state.status).toEqual('completed');
	});
});

describe('Generic Test Cases', function() {
	/*
	 * Stable symbolic asset labels. Keeta tokens are minted per-world (random
	 * keys), so discovered paths are compared by these symbols rather than by
	 * raw ids, which keeps the expected-path declarations world-independent.
	 */
	type Sym =
		| 'USD' | 'EUR' | 'BRL' | 'CAD' | 'USDC' | 'KTA'
		| 'USDC_BASE' | 'KTA_BASE' | 'ETH_BASE'
		| 'USDC_ETH' | 'USDT_ETH' | 'USDC_SOL' | 'USDT_SOL'
		| 'FIAT_USD' | 'FIAT_EUR' | 'FIAT_BRL' | 'FIAT_CAD';

	// Fixed external-chain asset ids (stable across worlds, unlike keeta tokens).
	const EXTERNAL_IDS = {
		USDC_BASE: 'evm:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		KTA_BASE:  'evm:0x4200000000000000000000000000000000000042',
		ETH_BASE:  'evm:0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
		USDC_ETH:  'evm:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
		USDT_ETH:  'evm:0xdAC17F958D2ee523a2206206994597C13D831ec7',
		USDC_SOL:  'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		USDT_SOL:  'solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
	} as const;

	const LOC = {
		base: 'chain:evm:8453',
		eth:  'chain:evm:1',
		sol:  'chain:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
		sepa: 'bank-account:iban-swift',
		wire: 'bank-account:us'
	} as const satisfies { [key: string]: AssetLocationLike };

	const MANAGED_OPS = { initiateTransfer: true, createPersistentForwarding: false } as const;
	const PFR_OPS = { initiateTransfer: false, createPersistentForwarding: true } as const;

	type LegMode = 'managed' | 'pfr';
	type FeeProfile = { name: string; flatFee: bigint; ethRateNum: bigint; ethRateDen: bigint };
	type WorldConfig = { name: string; legMode: LegMode; fee: FeeProfile };

	const FX_RATE = 0.88;

	/* The single conversion used by BOTH the anchors and the expected-output math. */
	function convertLeg(from: Sym, to: Sym, value: bigint, fee: FeeProfile): bigint {
		let out = value;
		if (from === 'USDC_BASE' && to === 'ETH_BASE') {
			out = value * fee.ethRateNum / fee.ethRateDen;
		}
		out = out - fee.flatFee;
		if (out < 1n) {
			out = 1n;
		}
		return(out);
	}

	function fxConvert(value: bigint): bigint {
		return(BigInt(Math.round(Number(value) * FX_RATE)));
	}

	type ExpectedLeg = { provider: string; from: Sym; to: Sym };

	function computeExpectedOutput(legs: ExpectedLeg[], input: bigint, fee: FeeProfile): bigint {
		let value = input;
		for (const leg of legs) {
			if (leg.provider === 'FX1') {
				value = fxConvert(value);
			} else {
				value = convertLeg(leg.from, leg.to, value, fee);
			}
		}
		return(value);
	}

	type AMAssetEntry = KeetaAnchorAssetMovementServerConfig['assetMovement']['supportedAssets'][number];
	type AMSide = AMAssetEntry['paths'][number]['pair'][number];

	async function buildWorld(config: WorldConfig) {
		const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const { userClient: client, fees } = await createNodeAndClient(account);

		const makeToken = async () => {
			const { account: tokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			await client.setInfo(
				{ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS']) },
				{ account: tokenAccount }
			);
			return(tokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
		};

		const giveTokens = async (to: GenericAccount, amount: bigint, token: TokenAddress) => {
			await client.modTokenSupplyAndBalance(amount, token, { account: to });
		};

		const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;

		const tokens = {
			USD: await makeToken(),
			EUR: await makeToken(),
			BRL: await makeToken(),
			CAD: await makeToken(),
			USDC: await makeToken(),
			KTA: await makeToken()
		};

		const tokenSymById = new Map<string, Sym>();
		for (const [ sym, token ] of Object.entries(tokens)) {
			/* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
			tokenSymById.set(token.publicKeyString.get(), sym as Sym);
		}
		const externalSymById = new Map<string, Sym>();
		for (const [ sym, id ] of Object.entries(EXTERNAL_IDS)) {
			/* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
			externalSymById.set(id, sym as Sym);
		}

		const symbolOf = (id: string): Sym => {
			const tokenSym = tokenSymById.get(id);
			if (tokenSym) {
				return(tokenSym);
			}
			const externalSym = externalSymById.get(id);
			if (externalSym) {
				return(externalSym);
			}
			if (id === 'USD' || id === 'EUR' || id === 'BRL' || id === 'CAD') {
				/* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
				return(`FIAT_${id}` as Sym);
			}
			/* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
			return(id as Sym);
		};

		const convert: ChainAnchorConvert = ({ fromAsset, toAsset, value }) => {
			return(convertLeg(symbolOf(fromAsset), symbolOf(toAsset), value, config.fee));
		};

		const baseEvmOps = config.legMode === 'pfr' ? PFR_OPS : MANAGED_OPS;

		const keetaSide = (token: TokenAddress): AMSide => ({
			location: keetaLocation,
			id: token.publicKeyString.get(),
			rails: { common: [{ rail: 'KEETA_SEND', supportedOperations: MANAGED_OPS }] }
		});
		const baseSide = (id: AMSide['id']): AMSide => ({
			location: LOC.base,
			id,
			rails: { common: [{ rail: 'EVM_SEND', supportedOperations: baseEvmOps }] }
		});
		const ethSide = (id: AMSide['id']): AMSide => ({
			location: LOC.eth,
			id,
			rails: { common: [{ rail: 'EVM_SEND', supportedOperations: MANAGED_OPS }] }
		});
		const solSide = (id: AMSide['id']): AMSide => ({
			location: LOC.sol,
			id,
			rails: { common: [{ rail: 'SOLANA_SEND', supportedOperations: MANAGED_OPS }] }
		});
		const fiatSide = (iso: AMSide['id'], location: NonNullable<AMSide['location']>, rail: 'WIRE' | 'SEPA_PUSH'): AMSide => ({
			location,
			id: iso,
			rails: { common: [{ rail, supportedOperations: MANAGED_OPS }] }
		});
		// One-way destination: outbound-only rail => the graph builds no reverse edge.
		const ethBaseTerminal = (id: AMSide['id']): AMSide => ({
			location: LOC.base,
			id,
			rails: { outbound: [ 'EVM_SEND' ] }
		});

		const pairEntry = (a: AMSide, b: AMSide): AMAssetEntry => ({
			asset: [ a.id, b.id ],
			paths: [{ pair: [ a, b ] }]
		});

		const am1Assets: AMAssetEntry[] = [
			pairEntry(keetaSide(tokens.EUR), keetaSide(tokens.USD)),
			pairEntry(keetaSide(tokens.BRL), keetaSide(tokens.USD)),
			pairEntry(keetaSide(tokens.CAD), keetaSide(tokens.USD)),
			pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), keetaSide(tokens.USD)),
			pairEntry(keetaSide(tokens.USD), fiatSide('USD', LOC.wire, 'WIRE')),
			pairEntry(keetaSide(tokens.EUR), fiatSide('EUR', LOC.wire, 'WIRE')),
			pairEntry(keetaSide(tokens.BRL), fiatSide('BRL', LOC.wire, 'WIRE')),
			pairEntry(keetaSide(tokens.CAD), fiatSide('CAD', LOC.wire, 'WIRE')),
			pairEntry(keetaSide(tokens.USD), fiatSide('EUR', LOC.sepa, 'SEPA_PUSH'))
		];
		const am2Assets: AMAssetEntry[] = [
			pairEntry(keetaSide(tokens.USDC), baseSide(EXTERNAL_IDS.USDC_BASE)),
			pairEntry(keetaSide(tokens.KTA), baseSide(EXTERNAL_IDS.KTA_BASE))
		];
		const am3Assets: AMAssetEntry[] = [
			pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), ethSide(EXTERNAL_IDS.USDC_ETH)),
			pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), ethSide(EXTERNAL_IDS.USDT_ETH)),
			pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), solSide(EXTERNAL_IDS.USDC_SOL)),
			pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), solSide(EXTERNAL_IDS.USDT_SOL)),
			pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), ethBaseTerminal(EXTERNAL_IDS.ETH_BASE))
		];

		const am1 = new TestChainAnchorServer({ ...(DEBUG ? { logger } : {}), client, convert, assetMovement: { supportedAssets: am1Assets }});
		const am2 = new TestChainAnchorServer({ ...(DEBUG ? { logger } : {}), client, convert, assetMovement: { supportedAssets: am2Assets }});
		const am3 = new TestChainAnchorServer({ ...(DEBUG ? { logger } : {}), client, convert, assetMovement: { supportedAssets: am3Assets }});

		const fxLP = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const fx1 = new TestFXServer({
			...(DEBUG ? { logger } : {}),
			quoteSigner: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
			accounts: new KeetaNet.lib.Account.Set([ fxLP ]),
			signer: fxLP,
			client,
			giveTokens,
			fx: {
				from: [{
					currencyCodes: [ tokens.USDC.publicKeyString.get(), tokens.KTA.publicKeyString.get() ],
					to: [ tokens.USDC.publicKeyString.get(), tokens.KTA.publicKeyString.get() ]
				}]
			}
		});

		await Promise.all([ am1.start(), am2.start(), am3.start(), fx1.start() ]);
		fees.addFeeFreeAccount(fxLP);
		// The user funds many legs across all cases in one world; waive its network
		// fees so the shared root account's base-token balance can't deplete mid-suite.
		fees.addFeeFreeAccount(client.account);

		await client.setInfo({
			description: 'Generic Chaining Test',
			name: 'TEST',
			metadata: Resolver.Metadata.formatMetadata({
				version: 1,
				currencyMap: Object.fromEntries(Object.entries(tokens).map(([ sym, token ]) => [ `$${sym}`, token.publicKeyString.get() ])),
				services: {
					fx: { FX1: await fx1.serviceMetadata() },
					assetMovement: {
						AM1: await am1.serviceMetadata(),
						AM2: await am2.serviceMetadata(),
						AM3: await am3.serviceMetadata()
					}
				}
			} satisfies ServiceMetadataExternalizable)
		});

		const anchorChaining = new AnchorChaining({
			client,
			resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
		});

		return({
			client, fees, tokens, keetaLocation, anchorChaining, giveTokens, symbolOf,
			recipient: client.account.publicKeyString.get(),
			[Symbol.asyncDispose]: async function() {
				await am1[Symbol.asyncDispose]?.();
				await am2[Symbol.asyncDispose]?.();
				await am3[Symbol.asyncDispose]?.();
				await fx1[Symbol.asyncDispose]?.();
			}
		});
	}

	type World = Awaited<ReturnType<typeof buildWorld>>;

	type ChainTestCase = {
		/** Human-readable case name */
		name: string;
		/** Source value (affinity 'from') */
		inputAmount: bigint;
		/** Build the chaining request from the world's tokens/locations */
		request: (w: World, input: bigint) => AnchorChainingPathInput;
		/** Ordered legs the discovered+selected path must match */
		expectedLegs: ExpectedLeg[];
		/** True when the final leg flips to a 'forwarded' step under legMode:'pfr' */
		pfrEligibleFinalLeg?: boolean;
		/** Restrict to specific leg modes (default: both) */
		legModes?: LegMode[];
	};

	const assetIdOf = (asset: AnchorChainingAsset): string => {
		if (KeetaNet.lib.Account.isInstance(asset)) {
			return(asset.publicKeyString.get());
		} else {
			return(String(asset));
		}
	};

	const pathSignature = (path: AnchorChainingPath, w: World): ExpectedLeg[] => {
		return(path.path.map(function(step) {
			return({
				provider: step.type === 'keetaSend' ? 'KEETA' : step.providerID,
				from: w.symbolOf(assetIdOf(step.from.asset)),
				to: w.symbolOf(assetIdOf(step.to.asset))
			})
		}));
	}

	const legsEqual = (a: ExpectedLeg[], b: ExpectedLeg[]): boolean => {
		if (a.length !== b.length) {
			return(false);
		}

		for (let i = 0; i < a.length; i++) {
			const legA = a[i];
			const legB = b[i];

			if (!legA || !legB) {
				return(false);
			}

			if (!legB || legA.provider !== legB.provider || legA.from !== legB.from || legA.to !== legB.to) {
				return(false);
			}
		}

		return(true);
	}

	const testCases: ChainTestCase[] = [
		{
			name: 'EUR keeta -> USD keeta (AM1, single keeta swap)',
			inputAmount: 1000n,
			request: (w, input) => ({
				source: { asset: w.tokens.EUR, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: w.tokens.USD, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
			}),
			expectedLegs: [{ provider: 'AM1', from: 'EUR', to: 'USD' }]
		},
		{
			name: 'BRL keeta -> EUR keeta (AM1 BRL->USD, AM1 USD->EUR)',
			inputAmount: 1000n,
			request: (w, input) => ({
				source: { asset: w.tokens.BRL, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: w.tokens.EUR, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
			}),
			expectedLegs: [
				{ provider: 'AM1', from: 'BRL', to: 'USD' },
				{ provider: 'AM1', from: 'USD', to: 'EUR' }
			]
		},
		{
			name: 'USDC keeta -> USDC base (AM2, single step)',
			inputAmount: 1000n,
			request: (w, input) => ({
				source: { asset: w.tokens.USDC, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, recipient: w.recipient, rail: 'EVM_SEND' }
			}),
			expectedLegs: [{ provider: 'AM2', from: 'USDC', to: 'USDC_BASE' }]
		},
		{
			name: 'USDC base -> USDC keeta (AM2, single step)',
			inputAmount: 1000n,
			legModes: [ 'managed' ],
			request: (w, input) => ({
				source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: input, rail: 'EVM_SEND' },
				destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
			}),
			expectedLegs: [{ provider: 'AM2', from: 'USDC_BASE', to: 'USDC' }]
		},
		{
			name: 'USDC keeta -> USD keeta (AM2 keeta->base, AM1 base->keeta)',
			inputAmount: 1000n,
			pfrEligibleFinalLeg: true,
			request: (w, input) => ({
				source: { asset: w.tokens.USDC, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: w.tokens.USD, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
			}),
			expectedLegs: [
				{ provider: 'AM2', from: 'USDC', to: 'USDC_BASE' },
				{ provider: 'AM1', from: 'USDC_BASE', to: 'USD' }
			]
		},
		{
			name: 'EUR keeta -> EUR SEPA (AM1 EUR->USD, AM1 USD->EUR/SEPA)',
			inputAmount: 1000n,
			request: (w, input) => ({
				source: { asset: w.tokens.EUR, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: 'EUR', location: LOC.sepa, recipient: w.recipient, rail: 'SEPA_PUSH' }
			}),
			expectedLegs: [
				{ provider: 'AM1', from: 'EUR', to: 'USD' },
				{ provider: 'AM1', from: 'USD', to: 'FIAT_EUR' }
			]
		},
		{
			name: 'KTA keeta -> USDC base (FX1 keeta swap, AM2 keeta->base)',
			inputAmount: 1000n,
			request: (w, input) => ({
				source: { asset: w.tokens.KTA, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, recipient: w.recipient, rail: 'EVM_SEND' }
			}),
			expectedLegs: [
				{ provider: 'FX1', from: 'KTA', to: 'USDC' },
				{ provider: 'AM2', from: 'USDC', to: 'USDC_BASE' }
			]
		},
		{
			name: 'USDC keeta -> USDC ethereum (AM2 keeta->base, AM3 base->eth)',
			inputAmount: 1000n,
			pfrEligibleFinalLeg: true,
			request: (w, input) => ({
				source: { asset: w.tokens.USDC, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: EXTERNAL_IDS.USDC_ETH, location: LOC.eth, recipient: w.recipient, rail: 'EVM_SEND' }
			}),
			expectedLegs: [
				{ provider: 'AM2', from: 'USDC', to: 'USDC_BASE' },
				{ provider: 'AM3', from: 'USDC_BASE', to: 'USDC_ETH' }
			]
		},
		{
			name: 'USDC ethereum -> USDC keeta (AM3 eth->base, AM2 base->keeta)',
			inputAmount: 1000n,
			pfrEligibleFinalLeg: true,
			request: (w, input) => ({
				source: { asset: EXTERNAL_IDS.USDC_ETH, location: LOC.eth, value: input, rail: 'EVM_SEND' },
				destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
			}),
			expectedLegs: [
				{ provider: 'AM3', from: 'USDC_ETH', to: 'USDC_BASE' },
				{ provider: 'AM2', from: 'USDC_BASE', to: 'USDC' }
			]
		},
		{
			name: 'USDC keeta -> ETH base (AM2 keeta->base, AM3 USDC->ETH base, variable rate)',
			inputAmount: 1000n,
			pfrEligibleFinalLeg: true,
			request: (w, input) => ({
				source: { asset: w.tokens.USDC, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: EXTERNAL_IDS.ETH_BASE, location: LOC.base, recipient: w.recipient, rail: 'EVM_SEND' }
			}),
			expectedLegs: [
				{ provider: 'AM2', from: 'USDC', to: 'USDC_BASE' },
				{ provider: 'AM3', from: 'USDC_BASE', to: 'ETH_BASE' }
			]
		},
		{
			name: '3-leg: KTA keeta -> USDC ethereum (FX1 swap, AM2 keeta->base, AM3 base->eth)',
			inputAmount: 1000n,
			pfrEligibleFinalLeg: true,
			request: (w, input) => ({
				source: { asset: w.tokens.KTA, location: w.keetaLocation, value: input, rail: 'KEETA_SEND' },
				destination: { asset: EXTERNAL_IDS.USDC_ETH, location: LOC.eth, recipient: w.recipient, rail: 'EVM_SEND' }
			}),
			expectedLegs: [
				{ provider: 'FX1', from: 'KTA', to: 'USDC' },
				{ provider: 'AM2', from: 'USDC', to: 'USDC_BASE' },
				{ provider: 'AM3', from: 'USDC_BASE', to: 'USDC_ETH' }
			]
		},
		{
			name: '3-leg: USDC ethereum -> KTA keeta (AM3 eth->base, AM2 base->keeta, FX1 swap)',
			inputAmount: 1000n,
			legModes: [ 'managed' ], // middle base->keeta leg cannot be persistent-forwarding mid-chain
			request: (w, input) => ({
				source: { asset: EXTERNAL_IDS.USDC_ETH, location: LOC.eth, value: input, rail: 'EVM_SEND' },
				destination: { asset: w.tokens.KTA, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
			}),
			expectedLegs: [
				{ provider: 'AM3', from: 'USDC_ETH', to: 'USDC_BASE' },
				{ provider: 'AM2', from: 'USDC_BASE', to: 'USDC' },
				{ provider: 'FX1', from: 'USDC', to: 'KTA' }
			]
		},
		{
			name: '3-leg: USDC ethereum -> EUR SEPA (AM3 eth->base, AM1 base->USD keeta, AM1 USD->EUR/SEPA)',
			inputAmount: 1000n,
			legModes: [ 'managed' ], // middle base->keeta leg cannot be persistent-forwarding mid-chain
			request: (w, input) => ({
				source: { asset: EXTERNAL_IDS.USDC_ETH, location: LOC.eth, value: input, rail: 'EVM_SEND' },
				destination: { asset: 'EUR', location: LOC.sepa, recipient: w.recipient, rail: 'SEPA_PUSH' }
			}),
			expectedLegs: [
				{ provider: 'AM3', from: 'USDC_ETH', to: 'USDC_BASE' },
				{ provider: 'AM1', from: 'USDC_BASE', to: 'USD' },
				{ provider: 'AM1', from: 'USD', to: 'FIAT_EUR' }
			]
		}
	];

	const FEE_PROFILES: FeeProfile[] = [
		{ name: 'no-fee', flatFee: 0n, ethRateNum: 1n, ethRateDen: 1n },
		{ name: 'fees',   flatFee: 7n, ethRateNum: 3n, ethRateDen: 2n }
	];

	const worldConfigs: WorldConfig[] = [];
	for (const legMode of [ 'managed', 'pfr' ] as const) {
		for (const fee of FEE_PROFILES) {
			worldConfigs.push({ name: `${legMode}/${fee.name}`, legMode, fee });
		}
	}

	async function runCase(w: World, wc: WorldConfig, tc: ChainTestCase): Promise<void> {
		const request = tc.request(w, tc.inputAmount);

		// 1. Routing: a path matching the expected legs must exist, and it must
		//    be the same regardless of fees/leg-mode (expectedLegs is fixed).
		const paths = await w.anchorChaining.getPaths(request);
		if (!paths) {
			throw(new Error(`No paths found`));
		}
		const selected = paths.find((p) => legsEqual(pathSignature(p, w), tc.expectedLegs));
		if (!selected) {
			throw(new Error(`No path matching expectedLegs. Found: ${JSON.stringify(paths.map((p) => pathSignature(p, w)))}`));
		}

		// 2. Plan: built over the selected path, with the right step types.
		const plan = await AnchorChainingPlan.create(selected);

		const planProviders = plan.plan.steps.map((s) => s.type === 'keetaSend' ? 'KEETA' : s.step.providerID);
		expect(planProviders).toEqual(tc.expectedLegs.map((l) => l.provider));

		const forwardedCount = plan.plan.steps.filter((s) => s.type === 'forwarded').length;
		const expectedForwarded = (tc.pfrEligibleFinalLeg && wc.legMode === 'pfr') ? 1 : 0;
		expect(forwardedCount).toEqual(expectedForwarded);

		for (const token of Object.values(w.tokens)) {
			await w.giveTokens(w.client.account, 1_000_000n, token);
		}

		plan.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				payload.markCompleted({ sent: true });
			} else {
				payload.markCompleted();
			}
		});

		const result = await plan.execute({ requireSendAuth: true });

		// 4. Both legs executed and value threaded correctly (fees applied).
		expect(plan.state.status).toEqual('completed');
		expect(result.steps.length).toEqual(tc.expectedLegs.length);
		expect(plan.plan.totalValueOut).toEqual(computeExpectedOutput(tc.expectedLegs, tc.inputAmount, wc.fee));
		expect(plan.plan.totalValueOut > 0n).toBe(true);
	}

	/*
	 * One test per world config. A fresh world is built inside each test because
	 * the shared test-node harness tears down nodes after every test; every
	 * applicable case then runs against that world via the identical runner above.
	 */
	for (const wc of worldConfigs) {
		test(`chaining flows [${wc.name}]`, async function() {
			await using w = await buildWorld(wc);
			for (const tc of testCases) {
				if (tc.legModes && !tc.legModes.includes(wc.legMode)) {
					continue;
				}
				try {
					await runCase(w, wc, tc);
				} catch (err) {
					throw(new Error(`Case "${tc.name}" [${wc.name}] failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
				}
			}
		}, 300_000);
	}
});

describe('getPlans forwardingOnly', function() {
	test('estimateForwardingValueOut includes fixed, variable, and total fees', function() {
		const fees = {
			lineItems: [
				{ purpose: 'RAIL' as const, value: '5' },
				{ purpose: 'NETWORK' as const, value: '3' },
				{ purpose: 'VALUE_VARIABLE' as const, basisPoints: 100 }
			],
			total: '18'
		};

		expect(estimateForwardingValueOut(1000n, fees)).toEqual(982n);
		expect(estimateForwardingValueOut(1000n, { ...fees, total: '25' })).toEqual(975n);
	});

	const EXTERNAL_IDS = {
		USDC_BASE: 'evm:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		USDC_ETH:  'evm:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
	} as const;

	const LOC = {
		base: 'chain:evm:8453',
		eth:  'chain:evm:1',
		sepa: 'bank-account:iban-swift'
	} as const satisfies { [key: string]: AssetLocationLike };

	test('listChainingPlanFees reconciles fees.total with line items for persistent forwarding', function() {
		const fees = {
			lineItems: [
				{ purpose: 'RAIL' as const, value: '5' },
				{ purpose: 'NETWORK' as const, value: '3' },
				{ purpose: 'VALUE_VARIABLE' as const, basisPoints: 100 }
			],
			total: '25'
		};

		const listed = listChainingPlanFees({
			plan: {
				steps: [{
					type: 'forwarded',
					valueIn: 1000n,
					valueOut: 975n,
					step: {
						type: 'assetMovement',
						providerID: 'AM1',
						from: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, rail: 'EVM_SEND' },
						to: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, rail: 'EVM_SEND' }
					},
					persistentAddress: { address: 'persistentForwarding-test', fees },
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					provider: null as unknown as KeetaAssetMovementAnchorProvider
				}],
				totalValueIn: 1000n,
				totalValueOut: 975n
			}
		});

		const feeSum = listed.lineItems.reduce((sum, item) => sum + BigInt(item.value ?? 0), 0n);
		expect(feeSum).toEqual(25n);
		expect(listed.lineItems.at(-1)?.purpose).toEqual('OTHER');
		expect(listed.lineItems.at(-1)?.value).toEqual('7');
	});

	const MANAGED_OPS = { initiateTransfer: true, createPersistentForwarding: false } as const;
	const PFR_OPS = { initiateTransfer: false, createPersistentForwarding: true } as const;
	const DUAL_OPS = { initiateTransfer: true, createPersistentForwarding: true } as const;
	const INITIATE_ONLY_OPS = { initiateTransfer: true } as const;

	type LegMode = 'managed' | 'pfr' | 'omitted' | 'initiateOnly';

	async function buildForwardingWorld(legMode: LegMode) {
		const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const { userClient: client, fees } = await createNodeAndClient(account);

		const makeToken = async () => {
			const { account: tokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			await client.setInfo(
				{ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS']) },
				{ account: tokenAccount }
			);
			return(tokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
		};

		const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;
		const tokens = { USDC: await makeToken(), USD: await makeToken(), EUR: await makeToken(), KTA: await makeToken() };
		const baseEvmOps = legMode === 'pfr' ? PFR_OPS
			: legMode === 'omitted' ? undefined
				: legMode === 'initiateOnly' ? INITIATE_ONLY_OPS
					: MANAGED_OPS;
		const ethEvmOps = legMode === 'pfr' ? DUAL_OPS
			: legMode === 'omitted' ? undefined
				: legMode === 'initiateOnly' ? INITIATE_ONLY_OPS
					: MANAGED_OPS;

		type AMAssetEntry = KeetaAnchorAssetMovementServerConfig['assetMovement']['supportedAssets'][number];
		type AMSide = AMAssetEntry['paths'][number]['pair'][number];

		const keetaSide = (token: TokenAddress): AMSide => ({
			location: keetaLocation,
			id: token.publicKeyString.get(),
			rails: { common: [{ rail: 'KEETA_SEND', supportedOperations: MANAGED_OPS }] }
		});
		const baseSide = (id: AMSide['id']): AMSide => ({
			location: LOC.base,
			id,
			rails: { common: [{ rail: 'EVM_SEND', ...(baseEvmOps !== undefined ? { supportedOperations: baseEvmOps } : {}) }] }
		});
		const ethSide = (id: AMSide['id']): AMSide => ({
			location: LOC.eth,
			id,
			rails: { common: [{ rail: 'EVM_SEND', ...(ethEvmOps !== undefined ? { supportedOperations: ethEvmOps } : {}) }] }
		});
		const fiatSide = (iso: AMSide['id']): AMSide => ({
			location: LOC.sepa,
			id: iso,
			rails: { common: [{ rail: 'SEPA_PUSH', supportedOperations: MANAGED_OPS }] }
		});
		const pairEntry = (a: AMSide, b: AMSide): AMAssetEntry => ({
			asset: [ a.id, b.id ],
			paths: [{ pair: [ a, b ] }]
		});

		const convert: ChainAnchorConvert = ({ value }) => value;

		const am1 = new TestChainAnchorServer({
			...(DEBUG ? { logger } : {}),
			client,
			convert,
			assetMovement: {
				supportedAssets: [
					pairEntry(keetaSide(tokens.EUR), keetaSide(tokens.USD)),
					pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), keetaSide(tokens.USD)),
					pairEntry(keetaSide(tokens.EUR), fiatSide('EUR'))
				]
			}
		});
		const am2 = new TestChainAnchorServer({
			...(DEBUG ? { logger } : {}),
			client,
			convert,
			assetMovement: {
				supportedAssets: [ pairEntry(keetaSide(tokens.USDC), baseSide(EXTERNAL_IDS.USDC_BASE)) ]
			}
		});
		const am3 = new TestChainAnchorServer({
			...(DEBUG ? { logger } : {}),
			client,
			convert,
			assetMovement: {
				supportedAssets: [ pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), ethSide(EXTERNAL_IDS.USDC_ETH)) ]
			}
		});
		const fx1 = new TestFXServer({
			...(DEBUG ? { logger } : {}),
			quoteSigner: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
			accounts: new KeetaNet.lib.Account.Set([ KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0) ]),
			signer: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
			client,
			giveTokens: async () => {},
			fx: {
				from: [{
					currencyCodes: [ tokens.USDC.publicKeyString.get(), tokens.KTA.publicKeyString.get() ],
					to: [ tokens.USDC.publicKeyString.get(), tokens.KTA.publicKeyString.get() ]
				}]
			}
		});

		await Promise.all([ am1.start(), am2.start(), am3.start(), fx1.start() ]);
		fees.addFeeFreeAccount(client.account);

		await client.setInfo({
			description: 'Forwarding-only getPlans test',
			name: 'TEST',
			metadata: Resolver.Metadata.formatMetadata({
				version: 1,
				currencyMap: Object.fromEntries(Object.entries(tokens).map(([ sym, token ]) => [ `$${sym}`, token.publicKeyString.get() ])),
				services: {
					fx: { FX1: await fx1.serviceMetadata() },
					assetMovement: {
						AM1: await am1.serviceMetadata(),
						AM2: await am2.serviceMetadata(),
						AM3: await am3.serviceMetadata()
					}
				}
			} satisfies ServiceMetadataExternalizable)
		});

		const anchorChaining = new AnchorChaining({
			client,
			resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
		});

		return({
			client,
			tokens,
			keetaLocation,
			anchorChaining,
			recipient: client.account.publicKeyString.get(),
			[Symbol.asyncDispose]: async function() {
				await am1[Symbol.asyncDispose]?.();
				await am2[Symbol.asyncDispose]?.();
				await am3[Symbol.asyncDispose]?.();
				await fx1[Symbol.asyncDispose]?.();
			}
		});
	}

	test('returns a single-leg forwarding plan from base to keeta', async function() {
		await using w = await buildForwardingWorld('pfr');

		const plans = await w.anchorChaining.getPlans({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		}, { limit: 1, forwardingOnly: true });

		expect(plans).not.toBeNull();
		const plan = plans?.[0];
		if (!plan) {
			throw(new Error('Expected a forwarding plan'));
		}

		expect(plan).toBeInstanceOf(AnchorChainingForwardingOnlyPlan);
		expect('execute' in plan).toBe(false);
		expect(isForwardingPlan(plan)).toBe(true);
		expect(plan.plan.steps.map((s) => s.type)).toEqual([ 'forwarded' ]);
		expect(plan.getDepositAddress()).toEqual(expect.any(String));
		expect(getForwardingDepositAddress(plan)).toEqual(plan.getDepositAddress());
	});

	test('getPaths forwardingOnly filters like getPlans', async function() {
		await using pfr = await buildForwardingWorld('pfr');
		await using managed = await buildForwardingWorld('managed');
		await using omitted = await buildForwardingWorld('omitted');

		const requestFor = (w: Awaited<ReturnType<typeof buildForwardingWorld>>) => ({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' as const },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' as const }
		});

		const pfrPaths = await pfr.anchorChaining.getPaths(requestFor(pfr), { forwardingOnly: true });
		expect(pfrPaths).not.toBeNull();
		expect(pfrPaths?.every((path) => isForwardingPath(path, { method: 'explicit' }))).toBe(true);

		const managedPaths = await managed.anchorChaining.getPaths(requestFor(managed), { forwardingOnly: true });
		expect(managedPaths).toBeNull();

		const omittedExplicit = await omitted.anchorChaining.getPaths(requestFor(omitted), { forwardingOnly: { method: 'explicit' }});
		expect(omittedExplicit).toBeNull();

		const omittedImplied = await omitted.anchorChaining.getPaths(requestFor(omitted), { forwardingOnly: { method: 'implied' }});
		expect(omittedImplied).not.toBeNull();
		expect(omittedImplied?.every((path) => isForwardingPath(path, { method: 'implied' }))).toBe(true);
	});

	test('getPaths forwardingOnly honors maxLegs', async function() {
		await using w = await buildForwardingWorld('pfr');

		const request = {
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' as const },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' as const }
		};

		const defaultPaths = await w.anchorChaining.getPaths(request, { forwardingOnly: true });
		expect(defaultPaths).not.toBeNull();
		expect(defaultPaths?.every((path) => path.path.length <= 2)).toBe(true);

		const oneLeg = await w.anchorChaining.getPaths(request, { forwardingOnly: { method: 'explicit', maxLegs: 1 }});
		expect(oneLeg).not.toBeNull();
		expect(oneLeg?.every((path) => path.path.length === 1)).toBe(true);

		const zeroLegs = await w.anchorChaining.getPaths(request, { forwardingOnly: { method: 'explicit', maxLegs: 0 }});
		expect(zeroLegs).toBeNull();
	});

	test('listFees returns persistent address fees for forwarding-only plans', async function() {
		await using w = await buildForwardingWorld('pfr');

		const plans = await w.anchorChaining.getPlans({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		}, { limit: 1, forwardingOnly: true });

		const plan = plans?.[0];
		if (!plan) {
			throw(new Error('Expected a forwarding plan'));
		}

		const fees = plan.listFees();
		expect(fees.lineItems).toHaveLength(1);
		expect(fees.lineItems[0]?.value).toEqual('15');
		expect(fees.lineItems[0]?.metadata.source).toEqual('persistentAddress');
		expect(fees.lineItems[0]?.metadata.step.type).toEqual('forwarded');
		expect(fees.lineItems[0]?.asset).toEqual(EXTERNAL_IDS.USDC_BASE);
		expect('total' in fees).toBe(false);
		expect(plan.plan.steps[0]?.valueOut).toEqual(985n);
	});

	test('returns a two-leg forwarding plan from ethereum to keeta', async function() {
		await using w = await buildForwardingWorld('pfr');

		const plans = await w.anchorChaining.getPlans({
			source: { asset: EXTERNAL_IDS.USDC_ETH, location: LOC.eth, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		}, { limit: 1, forwardingOnly: true });

		expect(plans).not.toBeNull();
		const plan = plans?.[0];
		if (!plan) {
			throw(new Error('Expected a forwarding plan'));
		}

		expect(plan).toBeInstanceOf(AnchorChainingForwardingOnlyPlan);
		expect('execute' in plan).toBe(false);
		expect(isForwardingPlan(plan)).toBe(true);
		expect(plan.plan.steps.map((s) => s.type)).toEqual([ 'forwarded', 'forwarded' ]);
		expect(plan.getDepositAddress()).toEqual(expect.any(String));
		expect(getForwardingDepositAddress(plan)).toEqual(plan.getDepositAddress());
	});

	test('returns null for managed final-leg routes', async function() {
		await using w = await buildForwardingWorld('managed');

		const plans = await w.anchorChaining.getPlans({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		}, { limit: 1, forwardingOnly: true });

		expect(plans).toBeNull();
	});

	test('excludes Keeta-origin and FX routes', async function() {
		await using w = await buildForwardingWorld('pfr');

		const keetaSwapPlans = await w.anchorChaining.getPlans({
			source: { asset: w.tokens.USDC, location: w.keetaLocation, value: 1000n, rail: 'KEETA_SEND' },
			destination: { asset: w.tokens.USD, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		}, { limit: 1, forwardingOnly: true });
		expect(keetaSwapPlans).toBeNull();

		const fxPlans = await w.anchorChaining.getPlans({
			source: { asset: w.tokens.KTA, location: w.keetaLocation, value: 1000n, rail: 'KEETA_SEND' },
			destination: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, recipient: w.recipient, rail: 'EVM_SEND' }
		}, { limit: 1, forwardingOnly: true });
		expect(fxPlans).toBeNull();
	});

	test('excludes bank/fiat routes', async function() {
		await using w = await buildForwardingWorld('pfr');

		const plans = await w.anchorChaining.getPlans({
			source: { asset: w.tokens.EUR, location: w.keetaLocation, value: 1000n, rail: 'KEETA_SEND' },
			destination: { asset: 'EUR', location: LOC.sepa, recipient: w.recipient, rail: 'SEPA_PUSH' }
		}, { limit: 1, forwardingOnly: true });

		expect(plans).toBeNull();
	});

	test('getPlans without forwardingOnly still returns managed plans', async function() {
		await using w = await buildForwardingWorld('managed');

		const plans = await w.anchorChaining.getPlans({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		}, { limit: 1 });

		expect(plans).not.toBeNull();
		expect(plans?.[0]?.plan.steps.map((s) => s.type)).toEqual([ 'assetMovement' ]);
	});

	test('isForwardingPath and isForwardingPlan helpers', async function() {
		await using w = await buildForwardingWorld('pfr');

		const paths = await w.anchorChaining.getPaths({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		});
		const path = paths?.[0];
		if (!path) {
			throw(new Error('Expected path'));
		}

		expect(isForwardingPath(path)).toBe(true);
		expect(isForwardingPath(path, { method: 'explicit', maxLegs: 0 })).toBe(false);

		const plan = await AnchorChainingPlan.create(path);
		expect(isForwardingPlan(plan)).toBe(true);

		const managedWorld = await buildForwardingWorld('managed');
		try {
			const managedPaths = await managedWorld.anchorChaining.getPaths({
				source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
				destination: { asset: managedWorld.tokens.USDC, location: managedWorld.keetaLocation, recipient: managedWorld.recipient, rail: 'KEETA_SEND' }
			});
			const managedPath = managedPaths?.[0];
			if (!managedPath) {
				throw(new Error('Expected managed path'));
			}

			const managedPlan = await AnchorChainingPlan.create(managedPath);
			expect(isForwardingPlan(managedPlan)).toBe(false);
		} finally {
			await managedWorld[Symbol.asyncDispose]?.();
		}
	});

	test('buildForwardingAdjacency and hasForwardingRoute', async function() {
		await using w = await buildForwardingWorld('pfr');

		const nodes = await w.anchorChaining.graph.computeGraphNodes();
		const adjacency = buildForwardingAdjacency(nodes);

		expect(hasForwardingRoute(
			adjacency,
			{ asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base },
			{ asset: w.tokens.USDC, location: w.keetaLocation }
		)).toBe(true);

		expect(hasForwardingRoute(
			adjacency,
			{ asset: EXTERNAL_IDS.USDC_ETH, location: LOC.eth },
			{ asset: w.tokens.USDC, location: w.keetaLocation }
		)).toBe(true);

		const graphAdjacency = await w.anchorChaining.graph.buildForwardingAdjacency();
		expect(graphAdjacency.size).toEqual(adjacency.size);
	});

	test('forwardingOnly uses PFR on the last leg even when initiateTransfer is also supported', async function() {
		const DUAL_OPS = { initiateTransfer: true, createPersistentForwarding: true } as const;
		const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const { userClient: client, fees } = await createNodeAndClient(account);

		const makeToken = async () => {
			const { account: tokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			await client.setInfo(
				{ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS']) },
				{ account: tokenAccount }
			);
			return(tokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
		};

		const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;
		const usdc = await makeToken();

		type AMAssetEntry = KeetaAnchorAssetMovementServerConfig['assetMovement']['supportedAssets'][number];
		type AMSide = AMAssetEntry['paths'][number]['pair'][number];
		const baseSide = (id: AMSide['id']): AMSide => ({
			location: LOC.base,
			id,
			rails: { common: [{ rail: 'EVM_SEND', supportedOperations: DUAL_OPS }] }
		});
		const keetaSide = (token: TokenAddress): AMSide => ({
			location: keetaLocation,
			id: token.publicKeyString.get(),
			rails: { common: [{ rail: 'KEETA_SEND', supportedOperations: MANAGED_OPS }] }
		});

		const am2 = new TestChainAnchorServer({
			...(DEBUG ? { logger } : {}),
			client,
			convert: ({ value }) => value,
			assetMovement: {
				supportedAssets: [ {
					asset: [ keetaSide(usdc).id, baseSide(EXTERNAL_IDS.USDC_BASE).id ],
					paths: [{ pair: [ keetaSide(usdc), baseSide(EXTERNAL_IDS.USDC_BASE) ] }]
				} ]
			}
		});

		await am2.start();
		fees.addFeeFreeAccount(client.account);

		await client.setInfo({
			description: 'Dual-ops forwarding-only test',
			name: 'TEST',
			metadata: Resolver.Metadata.formatMetadata({
				version: 1,
				currencyMap: { '$USDC': usdc.publicKeyString.get() },
				services: { assetMovement: { AM2: await am2.serviceMetadata() }}
			} satisfies ServiceMetadataExternalizable)
		});

		const anchorChaining = new AnchorChaining({
			client,
			resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
		});

		const request = {
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' as const },
			destination: { asset: usdc, location: keetaLocation, recipient: client.account.publicKeyString.get(), rail: 'KEETA_SEND' as const }
		};

		try {
			const managedPlans = await anchorChaining.getPlans(request, { limit: 1 });
			expect(managedPlans?.[0]?.plan.steps.map((s) => s.type)).toEqual([ 'assetMovement' ]);

			const forwardingPlans = await anchorChaining.getPlans(request, { limit: 1, forwardingOnly: true });
			const forwardingPlan = forwardingPlans?.[0];
			if (!forwardingPlan) {
				throw(new Error('Expected a forwarding plan'));
			}
			expect(forwardingPlan.plan.steps.map((s) => s.type)).toEqual([ 'forwarded' ]);
			expect(isForwardingPlan(forwardingPlan)).toBe(true);
		} finally {
			await am2[Symbol.asyncDispose]?.();
		}
	});

	test('AnchorChainingPlan created with forwardingOnly cannot execute', async function() {
		await using w = await buildForwardingWorld('pfr');

		const paths = await w.anchorChaining.getPaths({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		});
		const path = paths?.[0];
		if (!path) {
			throw(new Error('Expected path'));
		}

		const plan = await AnchorChainingPlan.create(path, { forwardingOnly: true });
		await expect(plan.execute()).rejects.toThrow(/cannot be executed/i);
	});

	test('supportsPersistentForwarding distinguishes explicit and implied', function() {
		expect(supportsPersistentForwarding(undefined, 'explicit')).toBe(false);
		expect(supportsPersistentForwarding(undefined, 'implied')).toBe(true);
		expect(supportsPersistentForwarding({ createPersistentForwarding: true }, 'explicit')).toBe(true);
		expect(supportsPersistentForwarding({ createPersistentForwarding: true }, 'implied')).toBe(true);
		expect(supportsPersistentForwarding({ initiateTransfer: true }, 'explicit')).toBe(false);
		expect(supportsPersistentForwarding({ initiateTransfer: true }, 'implied')).toBe(false);
		expect(supportsPersistentForwarding({ createPersistentForwarding: false }, 'implied')).toBe(false);
	});

	test('getPlans method:implied includes omitted supportedOperations; explicit does not', async function() {
		await using w = await buildForwardingWorld('omitted');

		const request = {
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' as const },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' as const }
		};

		const paths = await w.anchorChaining.getPaths(request);
		const path = paths?.[0];
		if (!path) {
			throw(new Error('Expected path with omitted supportedOperations'));
		}
		expect(path.path[0]?.type).toBe('assetMovement');
		if (path.path[0]?.type === 'assetMovement') {
			expect(path.path[0].from.supportedOperations).toBeUndefined();
		}

		expect(isForwardingPath(path, { method: 'explicit' })).toBe(false);
		expect(isForwardingPath(path, { method: 'implied' })).toBe(true);

		const explicitPlans = await w.anchorChaining.getPlans(request, { limit: 1, forwardingOnly: { method: 'explicit' }});
		expect(explicitPlans).toBeNull();

		const impliedPlans = await w.anchorChaining.getPlans(request, { limit: 1, forwardingOnly: { method: 'implied' }});
		expect(impliedPlans).not.toBeNull();
		expect(impliedPlans?.[0]).toBeInstanceOf(AnchorChainingForwardingOnlyPlan);
	});

	test('getPlans method:implied excludes initiateTransfer-only rails', async function() {
		await using w = await buildForwardingWorld('initiateOnly');

		const plans = await w.anchorChaining.getPlans({
			source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' },
			destination: { asset: w.tokens.USDC, location: w.keetaLocation, recipient: w.recipient, rail: 'KEETA_SEND' }
		}, { limit: 1, forwardingOnly: { method: 'implied' }});

		expect(plans).toBeNull();
	});

	test('resolveAssets forwardingOnly respects explicit vs implied', async function() {
		await using omitted = await buildForwardingWorld('omitted');
		await using pfr = await buildForwardingWorld('pfr');
		await using initiateOnly = await buildForwardingWorld('initiateOnly');

		const omittedExplicit = await omitted.anchorChaining.graph.resolveAssets({
			from: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base },
			forwardingOnly: { method: 'explicit' }
		});
		expect(omittedExplicit.to).toHaveLength(0);

		const omittedImplied = await omitted.anchorChaining.graph.resolveAssets({
			from: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base },
			forwardingOnly: { method: 'implied' }
		});
		const omittedKeys = omittedImplied.to.map((item) =>
			`${typeof item.asset === 'string' ? item.asset : item.asset.publicKeyString.get()}@${convertAssetLocationToString(item.location)}`
		);
		expect(omittedKeys).toContain(`${omitted.tokens.USDC.publicKeyString.get()}@${omitted.keetaLocation}`);

		const pfrExplicit = await pfr.anchorChaining.graph.resolveAssets({
			from: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base },
			forwardingOnly: true
		});
		const pfrKeys = pfrExplicit.to.map((item) =>
			`${typeof item.asset === 'string' ? item.asset : item.asset.publicKeyString.get()}@${convertAssetLocationToString(item.location)}`
		);
		expect(pfrKeys).toContain(`${pfr.tokens.USDC.publicKeyString.get()}@${pfr.keetaLocation}`);

		const initiateOnlyImplied = await initiateOnly.anchorChaining.graph.resolveAssets({
			from: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base },
			forwardingOnly: { method: 'implied' }
		});
		expect(initiateOnlyImplied.to).toHaveLength(0);
	});

	test('resolveAssets forwardingOnly honors maxLegs like getPlans', async function() {
		const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const { userClient: client, fees } = await createNodeAndClient(account);
		fees.addFeeFreeAccount(client.account);

		const makeToken = async () => {
			const { account: tokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			await client.setInfo(
				{ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS']) },
				{ account: tokenAccount }
			);
			return(tokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
		};

		const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;
		const tokens = { USDC: await makeToken() };
		const EXTERNAL_MULTI = {
			USDC_ARB: 'evm:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
			USDC_OP: 'evm:0x0b2c639c533813f4aa9d7837caf62653d097ff85'
		} as const;
		const LOC_MULTI = {
			arb: 'chain:evm:42161',
			op: 'chain:evm:10'
		} as const satisfies { [key: string]: AssetLocationLike };

		type AMAssetEntry = KeetaAnchorAssetMovementServerConfig['assetMovement']['supportedAssets'][number];
		type AMSide = AMAssetEntry['paths'][number]['pair'][number];
		const keetaSide = (token: TokenAddress): AMSide => ({
			location: keetaLocation,
			id: token.publicKeyString.get(),
			rails: { common: [{ rail: 'KEETA_SEND', supportedOperations: MANAGED_OPS }] }
		});
		const baseSide = (id: AMSide['id']): AMSide => ({
			location: LOC.base,
			id,
			rails: { common: [{ rail: 'EVM_SEND', supportedOperations: PFR_OPS }] }
		});
		const ethSide = (id: AMSide['id']): AMSide => ({
			location: LOC.eth,
			id,
			rails: { common: [{ rail: 'EVM_SEND', supportedOperations: PFR_OPS }] }
		});
		const arbSide = (id: AMSide['id']): AMSide => ({
			location: LOC_MULTI.arb,
			id,
			rails: { common: [{ rail: 'EVM_SEND', supportedOperations: PFR_OPS }] }
		});
		const opSide = (id: AMSide['id']): AMSide => ({
			location: LOC_MULTI.op,
			id,
			rails: { common: [{ rail: 'EVM_SEND', supportedOperations: PFR_OPS }] }
		});
		const pairEntry = (a: AMSide, b: AMSide): AMAssetEntry => ({
			asset: [ a.id, b.id ],
			paths: [{ pair: [ a, b ] }]
		});

		const am1 = new TestChainAnchorServer({
			...(DEBUG ? { logger } : {}),
			client,
			convert: ({ value }) => value,
			assetMovement: {
				supportedAssets: [
					pairEntry(baseSide(EXTERNAL_IDS.USDC_BASE), ethSide(EXTERNAL_IDS.USDC_ETH)),
					pairEntry(ethSide(EXTERNAL_IDS.USDC_ETH), arbSide(EXTERNAL_MULTI.USDC_ARB)),
					pairEntry(arbSide(EXTERNAL_MULTI.USDC_ARB), opSide(EXTERNAL_MULTI.USDC_OP)),
					pairEntry(opSide(EXTERNAL_MULTI.USDC_OP), keetaSide(tokens.USDC))
				]
			}
		});

		await am1.start();
		await client.setInfo({
			description: 'Forwarding-only maxLegs resolveAssets test',
			name: 'TEST',
			metadata: Resolver.Metadata.formatMetadata({
				version: 1,
				currencyMap: Object.fromEntries(Object.entries(tokens).map(([ sym, token ]) => [ `$${sym}`, token.publicKeyString.get() ])),
				services: { assetMovement: { AM1: await am1.serviceMetadata() }}
			} satisfies ServiceMetadataExternalizable)
		});

		const anchorChaining = new AnchorChaining({
			client,
			resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
		});

		try {
			const assetKey = (item: { asset: string | { publicKeyString: { get(): string }}; location: AssetLocationLike }) =>
				`${typeof item.asset === 'string' ? item.asset : item.asset.publicKeyString.get()}@${convertAssetLocationToString(item.location)}`;

			const defaultForwarding = await anchorChaining.graph.resolveAssets({
				from: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base },
				forwardingOnly: true
			});
			const defaultKeys = defaultForwarding.to.map(assetKey);
			expect(defaultKeys).not.toContain(`${tokens.USDC.publicKeyString.get()}@${keetaLocation}`);
			expect(defaultKeys).toContain(`${EXTERNAL_MULTI.USDC_ARB}@${LOC_MULTI.arb}`);
			expect(defaultKeys).not.toContain(`${EXTERNAL_MULTI.USDC_OP}@${LOC_MULTI.op}`);

			const threeStep = await anchorChaining.graph.resolveAssets({
				from: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base },
				forwardingOnly: true,
				maxStepCount: 3
			});
			expect(threeStep.to.map(assetKey)).toContain(`${EXTERNAL_MULTI.USDC_OP}@${LOC_MULTI.op}`);

			const pathRequest = {
				source: { asset: EXTERNAL_IDS.USDC_BASE, location: LOC.base, value: 1000n, rail: 'EVM_SEND' as const },
				destination: { asset: tokens.USDC, location: keetaLocation, recipient: client.account.publicKeyString.get(), rail: 'KEETA_SEND' as const }
			};

			// 4-leg route exceeds default maxLegs=2
			expect(await anchorChaining.getPaths(pathRequest, { forwardingOnly: true })).toBeNull();
			expect(await anchorChaining.getPaths(pathRequest, { forwardingOnly: { method: 'explicit', maxLegs: 4 }})).not.toBeNull();

			const plans = await anchorChaining.getPlans(pathRequest, { limit: 1, forwardingOnly: true });
			expect(plans).toBeNull();
		} finally {
			await am1[Symbol.asyncDispose]?.();
		}
	});
});

describe('Keeta-to-keeta swap chaining (persistent-forwarding regression)', function() {
	type AssetEntry = KeetaAnchorAssetMovementServerConfig['assetMovement']['supportedAssets'][number];

	async function createKeetaSwapHarness() {
		const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const { userClient: client, fees } = await createNodeAndClient(account);
		fees.addFeeFreeAccount(client.account);

		const makeToken = async () => {
			const { account: tokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			await client.setInfo(
				{ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS']) },
				{ account: tokenAccount }
			);
			return(tokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
		};
		const giveTokens = async (to: GenericAccount, amount: bigint, token: TokenAddress) => {
			await client.modTokenSupplyAndBalance(amount, token, { account: to });
		};

		const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;
		const tokens = { USD: await makeToken(), EUR: await makeToken(), CAD: await makeToken() };

		const convert: ChainAnchorConvert = ({ value }) => {
			const out = value - 10n;
			return(out < 1n ? 1n : out);
		};

		const swapEntry = (a: TokenAddress, b: TokenAddress): AssetEntry => ({
			asset: [ a.publicKeyString.get(), b.publicKeyString.get() ],
			paths: [{ pair: [
				{ location: keetaLocation, id: a.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
				{ location: keetaLocation, id: b.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
			] }]
		});

		const hub = new TestChainAnchorServer({
			...(DEBUG ? { logger } : {}),
			client,
			convert,
			assetMovement: {
				supportedAssets: [
					swapEntry(tokens.USD, tokens.EUR),
					swapEntry(tokens.USD, tokens.CAD)
				]
			}
		});
		await hub.start();

		await client.setInfo({
			description: 'Keeta Swap Hub',
			name: 'TEST',
			metadata: Resolver.Metadata.formatMetadata({
				version: 1,
				currencyMap: {
					'$USD': tokens.USD.publicKeyString.get(),
					'$EUR': tokens.EUR.publicKeyString.get(),
					'$CAD': tokens.CAD.publicKeyString.get()
				},
				services: { assetMovement: { Hub: await hub.serviceMetadata() }}
			} satisfies ServiceMetadataExternalizable)
		});

		const anchorChaining = new AnchorChaining({
			client,
			resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
		});

		const getEurToCadPath = async () => {
			const paths = await anchorChaining.getPaths({
				source: { asset: tokens.EUR, location: keetaLocation, value: 1000n, rail: 'KEETA_SEND' },
				destination: { asset: tokens.CAD, location: keetaLocation, recipient: client.account.publicKeyString.get(), rail: 'KEETA_SEND' }
			});
			const path = paths?.find(p => p.path.length === 2);
			if (!path) {
				throw(new Error(`Expected a 2-leg EUR -> USD -> CAD path, got ${JSON.stringify(paths?.map(p => p.path.length))}`));
			}
			return(path);
		};

		return({
			client, tokens, keetaLocation, anchorChaining, giveTokens, getEurToCadPath,
			[Symbol.asyncDispose]: async function() {
				await hub[Symbol.asyncDispose]?.();
			}
		});
	}

	test('plans EUR -> USD -> CAD as two managed sends, not a forwarded step', async function() {
		await using h = await createKeetaSwapHarness();

		const path = await h.getEurToCadPath();

		const secondLeg = path.path[1];
		if (!secondLeg || secondLeg.type !== 'assetMovement') {
			throw(new Error(`Expected the second path leg to be an asset-movement node`));
		}
		// Bare KEETA_SEND rails omit supportedOperations; plan computation must still
		// treat Keeta-origin hops as managed sends (not persistent forwarding).
		expect(secondLeg.from.supportedOperations).toBeUndefined();

		const plan = await AnchorChainingPlan.create(path);

		expect(plan.plan.steps.map(s => s.type)).toEqual([ 'assetMovement', 'assetMovement' ]);
	});

	test('executes EUR -> USD -> CAD with two user sends (the second send is not skipped)', async function() {
		await using h = await createKeetaSwapHarness();
		await h.giveTokens(h.client.account, 1_000_000n, h.tokens.EUR);
		await h.giveTokens(h.client.account, 1_000_000n, h.tokens.USD);

		const plan = await AnchorChainingPlan.create(await h.getEurToCadPath());

		const sends: { token: string; value: bigint }[] = [];
		plan.on('stepNeedsAction', (payload) => {
			if (payload.type === 'keetaSendAuthRequired') {
				sends.push({ token: payload.action.token.publicKeyString.get(), value: payload.action.value });
				payload.markCompleted({ sent: true });
			} else {
				payload.markCompleted();
			}
		});

		const result = await plan.execute({ requireSendAuth: true });

		expect(plan.state.status).toEqual('completed');
		expect(result.steps.map(s => s.type)).toEqual([ 'assetMovement', 'assetMovement' ]);

		expect(sends).toHaveLength(2);
		expect(sends[0]?.token).toEqual(h.tokens.EUR.publicKeyString.get());
		expect(sends[1]?.token).toEqual(h.tokens.USD.publicKeyString.get());
	});
});

describe('invalid anchor metadata', function() {
	test('computeGraphNodes ignores providers whose metadata cannot be parsed', async function() {
		const testRoot = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const fromToken = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		const toToken = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

		const { userClient, fees } = await createNodeAndClient(testRoot);
		fees.disable();

		await userClient.setInfo({
			name: '',
			description: '',
			metadata: Resolver.Metadata.formatMetadata(toJSONSerializable({
				version: 1,
				currencyMap: {},
				services: {
					fx: {
						good_fx: {
							operations: {
								createExchange: 'https://fx.good.com/createExchange'
							},
							from: [{
								currencyCodes: [fromToken.publicKeyString.get()],
								to: [toToken.publicKeyString.get()]
							}]
						},
						broken_fx: {
							from: 'not-an-array'
						}
					}
				}
			}))
		});

		fees.enable();

		const anchorChaining = new AnchorChaining({
			client: userClient,
			resolver: new Resolver({
				root: testRoot,
				client: userClient,
				trustedCAs: []
			})
		});

		const nodes = await anchorChaining.graph.computeGraphNodes();
		expect(nodes.some(n => n.type === 'fx' && n.providerID === 'good_fx')).toBe(true);
		expect(nodes.some(n => n.providerID === 'broken_fx')).toBe(false);
	});
});
