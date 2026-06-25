import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { randomUUID } from 'node:crypto';

import type { KeetaAnchorAssetMovementServerConfig } from '../../services/asset-movement/server.js';
import type { AnchorTokenLocationMetadata, AssetLocationLike, KeetaAssetMovementTransaction, KeetaPersistentForwardingAddressDetails } from '../../services/asset-movement/common.js';
import type { KeetaAnchorFXServerConfig, GetConversionRateAndFeeContext, KeetaFXInternalPriceQuote } from '../../services/fx/server.js';
import type { ConversionInputCanonicalJSON } from '../../services/fx/common.js';
import type { ServiceMetadataExternalizable } from '../resolver.js';
import type { AnchorChainingPath, AnchorChainingPathState, ExecutedStep, AnchorChainingAsset, ComputePlanOptions, AnchorChainingPathExecuteOptions, AnchorChainingPathExecuteResult, StepNeededActionEventPayload, AnchorChainingPlan } from './index.js';
import type { AnchorMetadataLegalField } from '../metadata.types.js';
import { createNodeAndClient } from '../utils/tests/node.js';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from '../../services/asset-movement/server.js';
import { convertAssetLocationToString, toAssetLocation, toAssetPair } from '../../services/asset-movement/common.js';
import { KeetaNetFXAnchorHTTPServer } from '../../services/fx/server.js';
import { Resolver } from '../index.js';
import { AnchorChaining } from './index.js';
import { KeetaAnchorUserError } from '../error.js';
import { AnchorExternal } from '../anchor-external.js';
import { BlockListener } from '../block-listener.js';


const DEBUG = false;
const logger = DEBUG ? console : undefined;

export type InitiateTransferFn = NonNullable<KeetaAnchorAssetMovementServerConfig['assetMovement']['initiateTransfer']>;
export type RateFn = (request: ConversionInputCanonicalJSON, context: GetConversionRateAndFeeContext) => Promise<KeetaFXInternalPriceQuote>;

const EMPTY_FROM_TRANSACTIONS = { deposit: null, persistentForwarding: null, finalization: null } as const;
const EMPTY_TO_TRANSACTIONS = { withdraw: null } as const;

type KeetaAccount = InstanceType<typeof KeetaNet.lib.Account>;
type TestNodeAndClient = Awaited<ReturnType<typeof createNodeAndClient>>;
type TestUserClient = NonNullable<TestNodeAndClient['userClient']>;
type TestFees = TestNodeAndClient['fees'];
type DisclaimerList = Exclude<AnchorMetadataLegalField['disclaimers'], undefined>;

/**
 * The full corridor fixture: two fiat bank anchors (US/EU), a Keeta-to-Keeta
 * swap anchor, and two FX anchors at different rates, wired into a resolver.
 */
export interface ChainingTestHarness extends AsyncDisposable {
	client: TestUserClient;
	fees: TestFees;
	tokens: { USDC: TokenAddress; EURC: TokenAddress };
	keetaLocation: AssetLocationLike;
	bankServerUS: TestBankServer;
	bankServerEU: TestBankServer;
	swapServer: TestBankServer;
	bankSignerUS: KeetaAccount;
	bankSignerEU: KeetaAccount;
	swapSigner: KeetaAccount;
	fxServerOne: TestFXServer;
	fxServerTwo: TestFXServer;
	anchorChaining: AnchorChaining;
	bankProviderDisclaimers: { BankUS: DisclaimerList; BankEU: DisclaimerList };
	euBankProviderID: 'BankEU';
	usBankProviderID: 'BankUS';
	fxProviderDisclaimers: { FXOne: DisclaimerList; FXTwo: DisclaimerList };
	fxOneProviderID: 'FXOne';
	fxTwoProviderID: 'FXTwo';
	giveTokens: (to: GenericAccount, amount: bigint, token: TokenAddress) => Promise<void>;
	getPlanVia: (fxProviderID: 'FXOne' | 'FXTwo', options?: ComputePlanOptions) => Promise<AnchorChainingPlan>;
	getPathVia: (fxProviderID: 'FXOne' | 'FXTwo', affinity?: 'to' | 'from') => Promise<AnchorChainingPath>;
}

/**
 * A bridge fixture exposing external-chain asset metadata for two providers.
 */
export interface MetadataHarness extends AsyncDisposable {
	client: TestUserClient;
	tokens: { USDC: TokenAddress };
	keetaLocation: AssetLocationLike;
	evmChainLocation: AssetLocationLike;
	usdcEvmId: AnchorChainingAsset;
	bridgeOneMetadata: AnchorTokenLocationMetadata;
	bridgeTwoMetadata: AnchorTokenLocationMetadata;
	anchorChaining: AnchorChaining;
}

/**
 * A persistent-forwarding bridge fixture for forwarded-leg chaining.
 */
export interface PersistentForwardingHarness extends AsyncDisposable {
	client: TestUserClient;
	anchorChaining: AnchorChaining;
	tokens: { USDC: TokenAddress; USDC2: TokenAddress };
	keetaLocation: AssetLocationLike;
	evmChainLocation: AssetLocationLike;
	bridgeServer: TestPersistentForwardingBridgeServer;
}

/**
 * A 3-leg fiat corridor fixture for path-discovery assertions.
 */
export interface AssetMovementPathHarness extends AsyncDisposable {
	client: TestUserClient;
	tokens: { USDC: TokenAddress; EURC: TokenAddress; USDT: TokenAddress; BTC: TokenAddress };
	keetaLocation: AssetLocationLike;
	evmChainLocation: AssetLocationLike;
	anchorChaining: AnchorChaining;
}

/**
 * `true` when a SEND's external field references the given transfer, either
 * as the raw transfer id (anchor-provided external) or as an entry in a
 * decodable plaintext envelope (client-constructed external).
 */
export async function externalReferencesTransfer(external: unknown, txId: string): Promise<boolean> {
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
export async function stripKeetaSendExternal(request: Parameters<InitiateTransferFn>[0], next: InitiateTransferFn): ReturnType<InitiateTransferFn> {
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
export function buildTxRecord(args: {
	id: string;
	status: KeetaAssetMovementTransaction['status'];
	asset: KeetaAssetMovementTransaction['asset'];
	fromLocation: KeetaAssetMovementTransaction['from']['location'];
	toLocation: KeetaAssetMovementTransaction['to']['location'];
	fromValue: string;
	toValue: string;
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
		updatedAt: now
	});
}

export class TestBankServer extends KeetaNetAssetMovementAnchorHTTPServer {
	private readonly _initiateRef: { fn: InitiateTransferFn };
	readonly #defaultInitiateRef: { fn: InitiateTransferFn; };
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
				const txId = `tx-${randomUUID()}`;

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
						throw(new TypeError('invalid keeta send asset'));
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
		fn ??= this.#defaultInitiateRef.fn;

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
			const txId = `tx-${randomUUID()}`;
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
				throw(new TypeError('invalid keeta send recipient'));
			}

			const assetPair = toAssetPair(request.asset);
			const tokenAddress = assetPair.from;
			if (typeof tokenAddress !== 'string') {
				throw(new TypeError('invalid keeta send asset'));
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

export type TestFXServerConfig = Omit<KeetaAnchorFXServerConfig, 'fx'> & {
	fx: Pick<KeetaAnchorFXServerConfig['fx'], 'from' | 'legal'>;
	giveTokens: (to: GenericAccount, amount: bigint, token: TokenAddress) => Promise<void>;
	/** Must be a UserClient so we can read LP balances and mint tokens on demand. */
	client: KeetaNet.UserClient;
};

export class TestFXServer extends KeetaNetFXAnchorHTTPServer {
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

export type PersistentForwardingBridgeAddressMeta = {
	sourceLocation: AssetLocationLike;
	destinationLocation: AssetLocationLike;
	destinationAddress: string;
	asset: KeetaAssetMovementTransaction['asset'];
};

export type TestPersistentForwardingBridgeServerConfig = Omit<KeetaAnchorAssetMovementServerConfig, 'assetMovement'> & {
	assetMovement: Omit<
		KeetaAnchorAssetMovementServerConfig['assetMovement'],
		'initiateTransfer' | 'getTransferStatus' | 'simulateTransfer' | 'createPersistentForwarding' | 'listPersistentForwarding' | 'listTransactions'
	>;
	client: KeetaNet.UserClient;
};

/**
 * Test bridge for the persistent-forwarding flow used by anchor chaining.
 */
export class TestPersistentForwardingBridgeServer extends KeetaNetAssetMovementAnchorHTTPServer {
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
					const txId = `tx-${randomUUID()}`;
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
											id: `persistentForwarding-tx-${randomUUID()}`,
											status: 'COMPLETE',
											asset: meta.asset,
											fromLocation: convertAssetLocationToString(meta.sourceLocation),
											toLocation: convertAssetLocationToString(meta.destinationLocation),
											fromValue: value.toString(),
											toValue: value.toString()
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
						throw(new TypeError('invalid keeta send asset'));
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
						throw(new TypeError('invalid asset for simulate'));
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
					return({
						instructionChoices: [{
							type: 'EVM_SEND' as const,
							location: request.from.location,
							value: value.toString(),
							tokenAddress: evmTokenHex,
							assetFee: '0',
							totalReceiveAmount: value.toString()
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

					const address = `persistentForwarding-${randomUUID()}`;
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
							destinationAddress: meta.destinationAddress
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


export async function createChainingTestHarness(options: { includeSwapAnchor?: boolean } = {}): Promise<ChainingTestHarness> {
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

	const getPlanVia = async (fxProviderID: 'FXOne' | 'FXTwo', options?: ComputePlanOptions) => {
		const plans = await anchorChaining.getPlans({
			source: { asset: tokens.USDC, location: keetaLocation, value: 100n, rail: 'KEETA_SEND' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: client.account.publicKeyString.get(), rail: 'SEPA_PUSH' }
		}, options);

		const plan = plans?.find(p => p.path.some(n => n.type === 'fx' && n.providerID === fxProviderID));

		if (!plan) {
			throw(new Error(`No plan found using ${fxProviderID}`));
		}

		return(plan);
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

export async function createMetadataHarness(): Promise<MetadataHarness> {
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

export const PFR_SUPPORTED_OPS = { initiateTransfer: false, createPersistentForwarding: true } as const;

export function newDestinationAccount(): KeetaAccount {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

export function firstPath<T>(paths: T[] | null | undefined): T {
	const found = paths?.[0];
	if (!paths || !found) {
		throw(new Error(`No paths found`));
	}

	return(found);
}

export async function getKeetaUsdcToUsdc2Path(h: PersistentForwardingHarness, value: bigint, recipient: GenericAccount): Promise<AnchorChainingPath> {
	const paths = await h.anchorChaining.getPaths({
		source: { asset: h.tokens.USDC, location: h.keetaLocation, value, rail: 'KEETA_SEND' },
		destination: { asset: h.tokens.USDC2, location: h.keetaLocation, recipient: recipient.publicKeyString.get(), rail: 'KEETA_SEND' }
	});
	return(firstPath(paths));
}

export async function createPersistentForwardingHarness(): Promise<PersistentForwardingHarness> {
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

/**
 * A 3-leg fiat corridor (USD bank -> Keeta FX -> EUR bank) used to exercise
 * path discovery across mixed asset-movement and FX providers.
 */
export async function createAssetMovementPathHarness(): Promise<AssetMovementPathHarness> {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client } = await createNodeAndClient(account);

	const makeTokenAssert = async () => {
		const { account: tokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		return(tokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
	};

	const evmChainLocation = 'chain:evm:500' satisfies AssetLocationLike;
	const keetaLocation = `chain:keeta:${client.network}` satisfies AssetLocationLike;

	const tokens = {
		USDC: await makeTokenAssert(),
		EURC: await makeTokenAssert(),
		USDT: await makeTokenAssert(),
		BTC: await makeTokenAssert()
	};

	const baseAnchorAssetMovementServer = new KeetaNetAssetMovementAnchorHTTPServer({
		...(logger ? { logger } : {}),
		assetMovement: {
			supportedAssets: [
				{
					asset: tokens.USDC.publicKeyString.get(),
					paths: [{
						pair: [
							{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { common: [ { rail: 'KEETA_SEND' } ] }},
							{ location: evmChainLocation, id: 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] }}
						]
					}]
				},
				{
					asset: '$USDC',
					paths: [{
						pair: [
							{ location: evmChainLocation, id: 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }},
							{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { inbound: [ 'KEETA_SEND' ] }}
						]
					}]
				}
			],
			async createPersistentForwarding() {
				throw(new Error('createPersistentForwarding not used in path-discovery fixture'));
			},
			async initiateTransfer() {
				throw(new Error('initiateTransfer not used in path-discovery fixture'));
			},
			async getTransferStatus() {
				return({
					transaction: buildTxRecord({
						id: 'tx123',
						status: 'PENDING',
						asset: tokens.USDC.publicKeyString.get(),
						fromLocation: evmChainLocation,
						toLocation: keetaLocation,
						fromValue: '500',
						toValue: '500'
					})
				});
			}
		}
	});

	const bankAnchorServer = new KeetaNetAssetMovementAnchorHTTPServer({
		...(logger ? { logger } : {}),
		assetMovement: {
			supportedAssets: [
				{
					asset: [ tokens.USDC.publicKeyString.get(), 'USD' ],
					paths: [{
						pair: [
							{ location: 'bank-account:us', id: 'USD', rails: { common: [ 'ACH', 'WIRE' ] }},
							{ location: keetaLocation, id: tokens.USDC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
						]
					}]
				},
				{
					asset: [ tokens.EURC.publicKeyString.get(), 'EUR' ],
					paths: [{
						pair: [
							{ location: 'bank-account:iban-swift', id: 'EUR', rails: { common: [ 'SEPA_PUSH' ] }},
							{ location: keetaLocation, id: tokens.EURC.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
						]
					}]
				}
			],
			async getTransferStatus() {
				return({
					transaction: buildTxRecord({
						id: 'tx123',
						status: 'PENDING',
						asset: tokens.USDC.publicKeyString.get(),
						fromLocation: evmChainLocation,
						toLocation: keetaLocation,
						fromValue: '500',
						toValue: '500'
					})
				});
			},
			async createPersistentForwarding() {
				throw(new Error('createPersistentForwarding not used in path-discovery fixture'));
			},
			async initiateTransfer() {
				throw(new Error('initiateTransfer not used in path-discovery fixture'));
			}
		}
	});

	const fxServerLiquidityProvider = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const fxServer = new KeetaNetFXAnchorHTTPServer({
		...(logger ? { logger } : {}),
		quoteSigner: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		accounts: new KeetaNet.lib.Account.Set([ fxServerLiquidityProvider ]),
		signer: fxServerLiquidityProvider,
		client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
		fx: {
			from: [{
				currencyCodes: [ tokens.USDC.publicKeyString.get(), tokens.USDT.publicKeyString.get(), tokens.BTC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ],
				to: [ tokens.USDC.publicKeyString.get(), tokens.USDT.publicKeyString.get(), tokens.BTC.publicKeyString.get(), tokens.EURC.publicKeyString.get() ]
			}],
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
				return([ `$${symbol}`, token.publicKeyString.get() ]);
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
		client,
		resolver: new Resolver({ root: client.account, client, trustedCAs: [] })
	});

	return({
		client,
		tokens,
		keetaLocation,
		evmChainLocation,
		anchorChaining,
		[Symbol.asyncDispose]: async function() {
			await fxServer[Symbol.asyncDispose]?.();
			await baseAnchorAssetMovementServer[Symbol.asyncDispose]?.();
			await bankAnchorServer[Symbol.asyncDispose]?.();
		}
	});
}

/**
 * A record of every event a plan emitted during a run, for behavioral
 * assertions without re-deriving listener boilerplate in each test.
 */
export interface ChainEventRecorder {
	stateHistory: AnchorChainingPathState['status'][];
	executed: { step: ExecutedStep; index: number }[];
	actions: StepNeededActionEventPayload[];
	completed: AnchorChainingPathExecuteResult | null;
	failed: { error: Error; completedSteps: ExecutedStep[]; index: number }[];
}

/**
 * A consumer-supplied handler for a {@link StepNeededActionEventPayload}. It is
 * responsible for eventually calling `markCompleted`/`markFailed`.
 */
export type StepActionHandler = (payload: StepNeededActionEventPayload) => void | Promise<void>;

/**
 * The default action handler: approve sends, acknowledge user-execution
 * prompts, and proceed through under-delivery reviews.
 */
export const defaultApproveAction: StepActionHandler = function(payload) {
	switch (payload.type) {
		case 'keetaSendAuthRequired':
			payload.markCompleted({ sent: true });
			break;
		case 'assetMovementUserExecutionRequired':
			payload.markCompleted();
			break;
		case 'underDeliveryReview':
			payload.markCompleted({ proceed: true });
			break;
	}
};

/**
 * Attach listeners that record every emitted event into a returned recorder.
 */
export function collectEvents(plan: AnchorChainingPlan): ChainEventRecorder {
	const recorder: ChainEventRecorder = { stateHistory: [], executed: [], actions: [], completed: null, failed: [] };

	plan.on('stateChange', (state) => recorder.stateHistory.push(state.status));
	plan.on('stepExecuted', (step, index) => recorder.executed.push({ step, index }));
	plan.on('completed', (result) => { recorder.completed = result; });
	plan.on('failed', (error, completedSteps, index) => recorder.failed.push({ error, completedSteps, index }));

	return(recorder);
}

/**
 * Options governing {@link runChain}.
 */
export interface RunChainOptions {
	requireSendAuth?: boolean;
	correlationID?: string;
	/**
	 * Per-action handler; defaults to {@link defaultApproveAction}. Every
	 * action is recorded regardless of the handler.
	 */
	onAction?: StepActionHandler;
}

/**
 * Execute a plan with event recording and a default action handler, returning
 * the result alongside the recorded events. The action handler is invoked for
 * every `stepNeedsAction`, after the payload is recorded.
 */
export async function runChain(plan: AnchorChainingPlan, options: RunChainOptions = {}): Promise<{ result: AnchorChainingPathExecuteResult; events: ChainEventRecorder }> {
	const events = collectEvents(plan);
	const handler = options.onAction ?? defaultApproveAction;

	plan.on('stepNeedsAction', (payload) => {
		events.actions.push(payload);
		void Promise.resolve(handler(payload));
	});

	const executeOptions: AnchorChainingPathExecuteOptions = {};
	if (options.requireSendAuth !== undefined) {
		executeOptions.requireSendAuth = options.requireSendAuth;
	}
	if (options.correlationID !== undefined) {
		executeOptions.correlationID = options.correlationID;
	}

	const result = await plan.execute(executeOptions);
	return({ result, events });
}
