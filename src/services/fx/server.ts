import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import { KeetaNet } from '../../client/index.js';
import {
	KeetaAnchorError,
	KeetaAnchorUserError
} from '../../lib/error.js';
import {
	assertConversionInputCanonicalJSON,
	assertKeetaFXAnchorClientCreateExchangeRequestJSON,
	Errors
} from './common.js';
import type {
	ConversionInputCanonicalJSON,
	KeetaFXAnchorEstimateResponse,
	KeetaFXAnchorExchangeResponse,
	KeetaFXAnchorQuoteJSON,
	KeetaFXAnchorQuoteResponse,
	KeetaFXInternalPriceQuote,
	KeetaNetAccount,
	KeetaNetStorageAccount
} from './common.ts';
import * as Signing from '../../lib/utils/signing.js';
import type { AssertNever } from '../../lib/utils/never.ts';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import { KeetaAnchorQueueRunner, KeetaAnchorQueueStorageDriverMemory } from '../../lib/queue/index.js';
import type { KeetaAnchorQueueStorageDriver, KeetaAnchorQueueRequestID } from '../../lib/queue/index.ts';
import { KeetaAnchorQueuePipelineAdvanced } from '../../lib/queue/pipeline.js';
import type { JSONSerializable, ToJSONSerializable } from '../../lib/utils/json.ts';
import { assertNever } from '../../lib/utils/never.js';
import * as typia from 'typia';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { assertExchangeBlockParameters } from './util.js';

/**
 * Enable additional runtime "paranoid" checks in the FX server.
 *
 * This may have a small performance impact but increases safety
 * by ensuring that the accounts used in quotes are actually
 * configured in the server.
 *
 * During the transition to multiple accounts this may help catch
 * misconfigurations so it is enabled by default for now.
 */
const PARANOID = true;

export interface KeetaAnchorFXServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * All accounts that may be used by the server to perform swaps
	 *
	 * Temporary compatibility: If this is not provided, the single
	 * `account` property will be used to create a set of one account.
	 */
	accounts?: InstanceType<typeof KeetaNet.lib.Account.Set>;

	/**
	 * Account to use to perform transactions
	 *
	 * @deprecated Use `signer` and `accounts` instead
	 */
	account?: InstanceType<typeof KeetaNet.lib.Account> | undefined;

	/**
	 * Account which can be used to sign transactions
	 * for the accounts above
	 *
	 * This may be either a function or a KeetaNet Account instance.
	 *
	 * Temporary compatibility: If not provided, the `account` property
	 * will be used as the signer.
	 */
	signer?: InstanceType<typeof KeetaNet.lib.Account> | ((request: ConversionInputCanonicalJSON) => Promise<InstanceType<typeof KeetaNet.lib.Account>> | InstanceType<typeof KeetaNet.lib.Account>);

	/**
	 * Account which performs the signing and validation of quotes,
	 * This can be null but only if `requiresQuote.issueQuotes` is false.
	 */
	quoteSigner: Signing.SignableAccount | null;

	/**
	 * Indicates whether the liquidity provider requires a quote before performing an exchange, defaults to true
	 */
	requiresQuote: true | {
		requiresQuote: false;

		/**
		 * Indicates whether to call validateQuote before performing the exchange, defaults to true if validateQuote is provided
		 */
		validateQuoteBeforeExchange: boolean;

		/**
		 * Indicates if the server should issue quotes when requested, if not it will throw a
		 */
		issueQuotes: boolean;
	};

	/**
	 * Configuration for FX handling
	 */
	fx: {
		/**
		 * Supported conversions
		 */
		from?: NonNullable<ServiceMetadata['services']['fx']>[string]['from'];
		/**
		 * Handle the conversion request of one token to another
		 *
		 * This is used to handle quotes and estimates
		 */
		getConversionRateAndFee: (request: ConversionInputCanonicalJSON) => Promise<KeetaFXInternalPriceQuote>;

		/**
		 * Optional callback to validate a quote before completing an exchange
		 *
		 * This allows the FX Server operator to reject quotes that are no longer
		 * acceptable (e.g., due to price changes, expiry, or other business logic)
		 *
		 * @param quote The quote to validate
		 * @returns true to accept the quote and proceed with the exchange, false to reject it
		 */
		validateQuote?: (quote: KeetaFXAnchorQuoteJSON | KeetaFXInternalPriceQuote) => Promise<boolean> | boolean;
	};

	/**
	 * Storage driver to use for stateful operation and managing queues
	 *
	 * You are responsible for running and maintaining the queue processor unless
	 * you enable auto-run below.
	 */
	storage?: {
		/**
		 * The storage driver or queue runner to use to serialize
		 * and batch requests
		 */
		queue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>;
		/**
		 * If enabled the server will automatically run the queue processor
		 */
		autoRun?: boolean;
	};

	/**
	 * The network client to use for submitting blocks
	 */
	client: { client: KeetaNet.Client; network: bigint; networkAlias: typeof KeetaNet.Client.Config.networksArray[number] } | KeetaNet.UserClient;
};

async function formatQuoteSignable(unsignedQuote: Omit<KeetaFXAnchorQuoteJSON, 'signed'>): Promise<Signing.Signable> {
	const retval: Signing.Signable = [
		unsignedQuote.request.from,
		unsignedQuote.request.to,
		unsignedQuote.request.amount,
		unsignedQuote.request.affinity,
		unsignedQuote.account,
		unsignedQuote.convertedAmount,
		unsignedQuote.cost.token,
		unsignedQuote.cost.amount
	];

	return(retval);

	/**
	 * This is a static assertion to ensure that this function is updated
	 * if new fields are added to the KeetaFXAnchorQuote type to ensure
	 * that we are always signing all the fields.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	type _ignore_static_assert = AssertNever<
		// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
		AssertNever<keyof Omit<typeof unsignedQuote['request'], 'from' | 'to' | 'amount' | 'affinity'>> &
		// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents,@typescript-eslint/no-duplicate-type-constituents
		AssertNever<keyof Omit<typeof unsignedQuote['cost'], 'token' | 'amount'>> &
		// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents,@typescript-eslint/no-duplicate-type-constituents
		AssertNever<keyof Omit<typeof unsignedQuote, 'request' | 'convertedAmount' | 'cost' | 'account'>>
	>;
}

async function generateSignedQuote(signer: Signing.SignableAccount, unsignedQuote: Omit<KeetaFXAnchorQuoteJSON, 'signed'>): Promise<KeetaFXAnchorQuoteJSON> {
	const signableQuote = await formatQuoteSignable(unsignedQuote);
	const signed = await Signing.SignData(signer, signableQuote);

	return({
		...unsignedQuote,
		signed: signed
	});
}

async function verifySignedData(signedBy: Signing.VerifableAccount, quote: KeetaFXAnchorQuoteJSON): Promise<boolean> {
	const signableQuote = await formatQuoteSignable(quote);

	return(await Signing.VerifySignedData(signedBy, signableQuote, quote.signed));
}

async function requestToAccounts(config: KeetaAnchorFXServerConfig, request: ConversionInputCanonicalJSON): Promise<{ signer: Signing.SignableAccount; account: KeetaNetAccount | KeetaNetStorageAccount | null; }> {
	let account: KeetaNetAccount | KeetaNetStorageAccount | null;
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	if (config.account !== undefined) {
		const rateFee = await config.fx.getConversionRateAndFee(request);
		account = rateFee.account;
	} else {
		account = null;
	}

	let signer: Signing.SignableAccount | null = null;
	if (config.signer !== undefined) {
		signer = (KeetaNet.lib.Account.isInstance(config.signer) ? config.signer : await config.signer(request)).assertAccount();
	}

	if (account !== null) {
		if (signer === null) {
			signer = account.assertAccount();
		}

		if (!account.isAccount() && !account.isStorage()) {
			throw(new Error('FX Account should be an Account or Storage Account'));
		}
	} else if (signer === null) {
		throw(new Error('Either account or signer must be provided'));
	}

	return({
		account: account,
		signer: signer
	});
}

/* QUEUE PROCESSOR PIPELINE */
type KeetaFXAnchorQueueStage1Request = {
	account: KeetaNetAccount;
	block: Parameters<typeof KeetaNet.UserClient['acceptSwapRequest']>[0]['block'];
	request: ConversionInputCanonicalJSON;
	expected: {
		receive: {
			token: TokenAddress;
			amount: bigint;
		};

		send: {
			token: TokenAddress;
			amount: bigint;
		}
	}
};
type KeetaFXAnchorQueueStage1RequestJSON = {
	/** Version of the request format */
	version: 1;
	/** FX Anchor Account performing swap */
	account: string;
	/** Base64 encoded block from the user */
	block: string;
	/** Original request */
	request: ConversionInputCanonicalJSON;
	/** Expected exchange details for verification */
	expected: ToJSONSerializable<KeetaFXAnchorQueueStage1Request['expected']>;
};
type KeetaFXAnchorQueueStage1Response = {
	/**
	 * All the blocks for the given swap request
	 */
	blocks: string[];
	/**
	 * The hash of one of the blocks submitted
	 */
	blockhash: string;
};

class KeetaFXAnchorQueuePipelineStage1 extends KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response> {
	protected readonly serverConfig: KeetaAnchorFXServerConfig;
	protected sequential = true;

	/**
	 * Timeout for processing a single job -- if exceeded the job is marked as aborted
	 */
	protected processTimeout: number = 60 * 1000;

	constructor(config: ConstructorParameters<typeof KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>>[0] & { serverConfig: KeetaAnchorFXServerConfig; }) {
		super(config);

		this.serverConfig = config.serverConfig;
		this.processorAborted = this.processorStuck.bind(this);
	}

	/**
	 * Handles both stuck (no status update after a long period) and
	 * aborted (timeout while processing an entry) states.
	 *
	 * We just put the job back into pending because the processor
	 * will check the network state again.
	 */
	protected async processorStuck(entry: Parameters<NonNullable<KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>['processorStuck']>>[0]): ReturnType<NonNullable<KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>['processorStuck']>> {
		return({
			status: 'pending',
			output: entry.output
		});
	}

	/**
	 * Process the entry, attempting to submit the swap block(s)
	 * to the network.  Verifies the block can be submitted before
	 * attempting submission.  Also verifies if the block is already
	 * on the network and marks the job as completed if so.
	 */
	protected async processor(entry: Parameters<KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>['processor']>[0]): ReturnType<KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>['processor']> {
		const { block, expected, request } = entry.request;
		const config = this.serverConfig;

		let userClient: KeetaNet.UserClient;

		if (KeetaNet.UserClient.isInstance(config.client)) {
			userClient = config.client;

			if (!(userClient.account.comparePublicKey(entry.request.account))) {
				return({
					status: 'failed_permanently',
					output: null,
					error: `Mismatched account for FX request with configured UserClient account`
				});
			}
		} else {
			const { signer, account: checkAccount } = await requestToAccounts(config, request);

			if (checkAccount === null) {
				if (this.serverConfig.accounts === undefined) {
					throw(new Error('No accounts configured for FX server'));
				}

				if (!this.serverConfig.accounts.has(entry.request.account)) {
					return({
						status: 'failed_permanently',
						output: null,
						error: `Mismatched account for FX request and configured account (no matching account found)`
					});
				}
			} else if (!checkAccount.comparePublicKey(entry.request.account)) {
				return({
					status: 'failed_permanently',
					output: null,
					error: `Mismatched account for FX request and configured account (single account not matched)`
				});
			}

			userClient = new KeetaNet.UserClient({
				client: config.client.client,
				network: config.client.network,
				networkAlias: config.client.networkAlias,
				account: entry.request.account,
				signer: signer
			});
		}

		/* Check for the block already being on the network, if so we can mark this job as completed */
		const blockExists = await userClient.block(block.hash);
		if (blockExists !== null) {
			const existingOutput = entry.output;
			const blocks = existingOutput?.blocks ?? [Buffer.from(block.toBytes()).toString('base64')];

			return({
				status: 'completed',
				output: {
					blockhash: block.hash.toString(),
					blocks: blocks
				}
			});
		}

		/* Get the current head block of the account in the block */
		const accountHead = await userClient.head({ account: block.account });
		let isHeadBlock = false;
		if (accountHead !== null) {
			isHeadBlock = accountHead.compare(block.previous);
		} else {
			isHeadBlock = block['$opening'];
		}

		/* If the account's head block is not the block's previous, see if the block's previous exists on the network */
		if (!isHeadBlock) {
			let previousBlockOnNetwork = false;
			if (block['$opening']) {
				/* Opening block means that there is no previous block, so we are free to proceed */
				previousBlockOnNetwork = true;
			} else {
				const previousBlock = await userClient.block(block.previous);
				if (previousBlock !== null) {
					previousBlockOnNetwork = true;
				}
			}

			let blockPreviousString: string;
			if (block['$opening']) {
				blockPreviousString = '<opening>';
			} else {
				blockPreviousString = block.previous.toString();
			}

			/* If block.previous exists on the network, and it's not the account head block we can mark this job as failed_permanently */
			if (previousBlockOnNetwork) {
				/* Block's previous exists on the network, but is not the account head -- mark as failed_permanently */
				return({
					status: 'failed_permanently',
					output: null,
					error: `Block previous (${blockPreviousString}) exists on the network but is not the account head`
				});
			} else {
				/* If block.previous does not exist on the network we can mark this job as failed_temporarily -- it can't process until the missing block is added */
				/* Block's previous does not exist on the network -- mark as failed_temporarily */
				return({
					status: 'failed_temporarily',
					output: null,
					error: `Block previous (${blockPreviousString}) does not exist on the network`
				});
			}
		}

		/* We are clear to attempt the swap now */

		const builder = userClient.initBuilder();
		builder.send(block.account, expected.send.amount, expected.send.token);

		const sendBlock = await builder.computeBlocks();

		const swapBlocks = [ ...sendBlock.blocks, block ];

		const publishOptions: Parameters<typeof userClient.client.transmit>[1] = {};
		if (userClient.config.generateFeeBlock !== undefined) {
			publishOptions.generateFeeBlock = userClient.config.generateFeeBlock;
		}
		const publishResult = await userClient.client.transmit(swapBlocks, publishOptions);
		if (!publishResult.publish) {
			throw(new Error('Exchange Publish Failed'));
		}

		/* Set the output and mark the job as pending so we can run the queue again and check for completion */
		return({
			status: 'pending',
			output: {
				blockhash: block.hash.toString(),
				blocks: swapBlocks.map(function(block) {
					return(Buffer.from(block.toBytes()).toString('base64'));
				})
			}
		});
	}

	protected encodeRequest(request: KeetaFXAnchorQueueStage1Request): JSONSerializable {
		const retval: KeetaFXAnchorQueueStage1RequestJSON = {
			version: 1,
			account: request.account.publicKeyString.get(),
			block: Buffer.from(request.block.toBytes()).toString('base64'),
			request: request.request,
			expected: {
				receive: {
					token: request.expected.receive.token.publicKeyString.get(),
					amount: request.expected.receive.amount.toString()
				},
				send: {
					token: request.expected.send.token.publicKeyString.get(),
					amount: request.expected.send.amount.toString()
				}
			}
		};

		return(retval);
	}

	protected encodeResponse(response: KeetaFXAnchorQueueStage1Response | null): JSONSerializable | null {
		return(response);
	}

	protected decodeRequest(request: JSONSerializable): KeetaFXAnchorQueueStage1Request {
		/* See note at bottom of file */
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		const reqJSON = assertKeetaFXAnchorQueueStage1RequestJSON(request);

		if (reqJSON.version !== 1) {
			throw(new Error(`Unsupported KeetaFXAnchorQueueStage1Request version ${reqJSON.version}`));
		}

		const retval: KeetaFXAnchorQueueStage1Request = {
			account: KeetaNet.lib.Account.fromPublicKeyString(reqJSON.account),
			block: new KeetaNet.lib.Block(reqJSON.block),
			request: reqJSON.request,
			expected: {
				receive: {
					token: KeetaNet.lib.Account.fromPublicKeyString(reqJSON.expected.receive.token).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
					amount: BigInt(reqJSON.expected.receive.amount)
				},
				send: {
					token: KeetaNet.lib.Account.fromPublicKeyString(reqJSON.expected.send.token).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
					amount: BigInt(reqJSON.expected.send.amount)
				}
			}
		};

		return(retval);
	}

	protected decodeResponse(response: JSONSerializable | null): KeetaFXAnchorQueueStage1Response | null {
		/* See note at bottom of file */
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		return(assertKeetaFXAnchorQueueStage1ResponseOrNull(response));
	}
}

class KeetaFXAnchorQueuePipeline extends KeetaAnchorQueuePipelineAdvanced<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response> {
	private readonly serverConfig: KeetaAnchorFXServerConfig;
	private readonly accounts: InstanceType<typeof KeetaNet.lib.Account.Set>;
	private runners: { [account: string]: KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>; } = {};

	constructor(options: ConstructorParameters<typeof KeetaAnchorQueuePipelineAdvanced<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>>[0] & { serverConfig: KeetaAnchorFXServerConfig; accounts: InstanceType<typeof KeetaNet.lib.Account.Set>; }) {
		super(options);

		this.serverConfig = options.serverConfig;
		this.accounts = options.accounts;
	}

	protected async createPipeline(): Promise<void> {
		for (const account of this.accounts) {
			const queue = await this.baseQueue.partition(account.publicKeyAndTypeString);
			this.queues.push(queue);

			const runner = new KeetaFXAnchorQueuePipelineStage1({
				id: `keeta-fx-anchor-runner-${account.publicKeyAndTypeString}`,
				queue: queue,
				logger: this.logger,
				serverConfig: this.serverConfig
			});
			this.runners[account.publicKeyAndTypeString] = runner;
		}
	}

	protected getStage(stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.first | typeof KeetaAnchorQueuePipelineAdvanced.StageID.last): KeetaFXAnchorQueuePipelineStage1;
	protected getStage(_ignore_stageID: typeof KeetaAnchorQueuePipelineAdvanced.StageID.first | typeof KeetaAnchorQueuePipelineAdvanced.StageID.last | string): KeetaFXAnchorQueuePipelineStage1 | null {
		throw(new Error('method not supported'));
	}

	async add(request: KeetaFXAnchorQueueStage1Request): ReturnType<KeetaFXAnchorQueuePipelineStage1['add']> {
		await super.init();

		const account = request.account.publicKeyAndTypeString;

		const runner = this.runners[account];
		if (runner === undefined) {
			throw(new Error(`No queue runner for account ${account}`));
		}

		return(await runner.add(request));
	}

	async get(id: KeetaAnchorQueueRequestID): ReturnType<KeetaFXAnchorQueuePipelineStage1['get']> {
		await super.init();

		for (const account of this.accounts) {
			const runner = this.runners[account.publicKeyAndTypeString];
			if (runner === undefined) {
				continue;
			}

			const entry = await runner.get(id);
			if (entry !== null) {
				return(entry);
			}
		}

		return(null);
	}

	async run(options?: Parameters<KeetaFXAnchorQueuePipelineStage1['run']>[0]): ReturnType<KeetaFXAnchorQueuePipelineStage1['run']> {
		await super.init();

		let retval = false;
		for (const account of this.accounts) {
			const runner = this.runners[account.publicKeyAndTypeString];
			if (runner === undefined) {
				continue;
			}

			const more = await runner.run(options);
			if (more) {
				retval = true;
			}
		}

		return(retval);
	}

	async maintain(): Promise<void> {
		await super.init();

		for (const account of this.accounts) {
			const runner = this.runners[account.publicKeyAndTypeString];
			if (runner === undefined) {
				continue;
			}

			await runner.maintain();
		}
	}

	async destroy(): Promise<void> {
		const logger = this.methodLogger('destroy');

		if (this.destroyed) {
			return;
		}
		this.destroyed = true;

		await super.destroy();

		for (const runner of Object.values(this.runners)) {
			try {
				await runner.destroy();
			} catch (error) {
				logger?.error('Error destroying runner:', error);
			}
		}
	}

}

export class KeetaNetFXAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorFXServerConfig> implements Omit<Required<KeetaAnchorFXServerConfig>, 'storage'> {
	readonly homepage: NonNullable<KeetaAnchorFXServerConfig['homepage']>;
	readonly client: KeetaAnchorFXServerConfig['client'];
	readonly accounts: NonNullable<KeetaAnchorFXServerConfig['accounts']>;
	readonly account: KeetaAnchorFXServerConfig['account'] = undefined;
	readonly signer: NonNullable<KeetaAnchorFXServerConfig['signer']>;
	readonly quoteSigner: KeetaAnchorFXServerConfig['quoteSigner'];
	readonly fx: KeetaAnchorFXServerConfig['fx'];
	readonly pipeline: KeetaFXAnchorQueuePipeline;
	readonly requiresQuote: KeetaAnchorFXServerConfig['requiresQuote'];

	protected pipelineAutoRunInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: KeetaAnchorFXServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.client = config.client;
		this.fx = config.fx;
		this.quoteSigner = config.quoteSigner;
		this.requiresQuote = config.requiresQuote;

		/*
		 * Setup the accounts
		 */
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		if (config.account !== undefined && config.accounts === undefined) {
			/*
			 * Deprecated: If a single account is provided, use that
			 * along with the signer to create the accounts set
			 */
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this.accounts = new KeetaNet.lib.Account.Set([config.account]);
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this.signer = config.signer ?? config.account;
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		} else if (config.accounts !== undefined && config.account === undefined) {
			/*
			 * Only allow either "account" or "accounts"+"signer" to be provided
			 */
			if (config.signer === undefined) {
				throw(new Error('If "accounts" is provided, "signer" must also be provided'));
			}

			this.accounts = config.accounts;
			this.signer = config.signer;
		} else {
			throw(new Error('Either "account" (and optional "signer") or "accounts" and "signer" must be provided, but not both "account" and "accounts"'));
		}

		if (this.accounts.size === 0) {
			throw(new Error('No FX accounts provided'));
		}

		/*
		 * If no storage driver is provided, we default to an in-memory
		 * that we auto-run
		 */
		let autorun = config.storage?.autoRun ?? false;
		if (config.storage === undefined) {
			autorun = true;
		}

		/*
		 * Create the pipeline to process transactions
		 */
		this.pipeline = new KeetaFXAnchorQueuePipeline({
			id: 'keeta-fx-anchor-queue-pipeline',
			baseQueue: config.storage?.queue ?? new KeetaAnchorQueueStorageDriverMemory({
				id: 'keeta-fx-anchor-queue-pipeline-memory-driver',
				logger: this.logger
			}),
			accounts: this.accounts,
			logger: this.logger,
			serverConfig: this
		});

		/*
		 * If auto-run is enabled, setup the interval to run the pipeline
		 */
		if (autorun) {
			let running = false;
			this.pipelineAutoRunInterval = setInterval(async () => {
				if (running) {
					return;
				}
				running = true;
				try {
					await this.pipeline.maintain();
				} catch (error) {
					this.logger.error('KeetaNetFXAnchorHTTPServer::pipelineAutoRunInterval', 'Error maintaining pipeline:', error);
				}
				try {
					await this.pipeline.run({ timeoutMs: 5000 });
				} catch (error) {
					this.logger.error('KeetaNetFXAnchorHTTPServer::pipelineAutoRunInterval', 'Error running pipeline:', error);
				} finally {
					running = false;
				}
			}, 1000);
		}
	}

	protected async initRoutes(config: KeetaAnchorFXServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = {};
		const logger = this.logger;

		/*
		 * To use the instance within the route handlers, we need to
		 * make a local reference to it.
		 */
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const instance = this;

		/**
		 * If a homepage is provided, setup the route for it
		 */
		if ('homepage' in config) {
			routes['GET /'] = async function() {
				let homepageData: string;
				if (typeof config.homepage === 'string') {
					homepageData = config.homepage;
				} else {
					if (!config.homepage) {
						throw(new Error('internal error: No homepage function provided'));
					}

					homepageData = await config.homepage();
				}

				return({
					output: homepageData,
					contentType: 'text/html'
				});
			};
		}

		/**
		 * Setup the request handler for an estimate request
		 */
		routes['POST /api/getEstimate'] = async function(_ignore_params, postData) {
			if (!postData || typeof postData !== 'object') {
				throw(new Error('No POST data provided'));
			}
			if (!('request' in postData)) {
				throw(new Error('POST data missing request'));
			}

			const conversion = assertConversionInputCanonicalJSON(postData.request);
			const rateAndFee = await config.fx.getConversionRateAndFee(conversion);

			let requiresQuoteBody: { requiresQuote: true } | { requiresQuote: false; account: KeetaNetAccount | KeetaNetStorageAccount; };
			if (config.requiresQuote === true) {
				requiresQuoteBody = { requiresQuote: true };
			} else {
				if (config.requiresQuote.requiresQuote) {
					throw(new Error('Invalid requiresQuote configuration'));
				}

				if (rateAndFee.convertedAmountBound === undefined) {
					instance.logger.warn('POST /api/getEstimate', 'FX configuration indicates quotes are not required, but "convertedAmountBound" was not provided in the rate and fee response');
				} else {
					if (conversion.affinity === 'to' && (BigInt(conversion.amount) > rateAndFee.convertedAmountBound)) {
						throw(new KeetaAnchorError('Affinity is to, but bound is less than estimated sent amount'));
					}

					if (conversion.affinity === 'from' && (BigInt(conversion.amount) < rateAndFee.convertedAmountBound)) {
						throw(new KeetaAnchorError('Affinity is from, but bound is greater than estimated received amount'));
					}
				}

				requiresQuoteBody = { requiresQuote: false, account: rateAndFee.account };
			}

			const estimateResponse: KeetaFXAnchorEstimateResponse = {
				ok: true,
				estimate: KeetaNet.lib.Utils.Conversion.toJSONSerializable({
					request: conversion,
					convertedAmount: rateAndFee.convertedAmount,
					convertedAmountBound: rateAndFee.convertedAmountBound,
					expectedCost: {
						min: rateAndFee.cost.amount,
						max: rateAndFee.cost.amount,
						token: rateAndFee.cost.token
					},
					...requiresQuoteBody
				})
			};

			return({
				output: JSON.stringify(estimateResponse)
			});
		}

		async function getUnsignedQuoteData(conversion: ConversionInputCanonicalJSON) {
			const rateAndFee = await config.fx.getConversionRateAndFee(conversion);

			if (PARANOID) {
				const quoteAccount = rateAndFee.account;
				if (!instance.accounts.has(quoteAccount)) {
					throw(new Error('"getConversionRateAndFee" returned an account not configured for this server'));
				}
			}

			return(rateAndFee);
		}

		routes['POST /api/getQuote'] = async function(_ignore_params, postData) {
			if (config.requiresQuote !== true && !config.requiresQuote.issueQuotes) {
				throw(new Errors.QuoteIssuanceDisabled());
			}

			if (!postData || typeof postData !== 'object') {
				throw(new Error('No POST data provided'));
			}

			if (!('request' in postData)) {
				throw(new Error('POST data missing request'));
			}

			const conversion = assertConversionInputCanonicalJSON(postData.request);
			const rateAndFee = await getUnsignedQuoteData(conversion);

			const unsignedQuote: Omit<KeetaFXAnchorQuoteJSON, 'signed'> = KeetaNet.lib.Utils.Conversion.toJSONSerializable({
				request: conversion,
				...rateAndFee
			});

			if (config.quoteSigner === null) {
				throw(new Error('Quote signer not configured, this is required when issuing quotes'));
			}

			const signedQuote = await generateSignedQuote(config.quoteSigner, unsignedQuote);
			const quoteResponse: KeetaFXAnchorQuoteResponse = {
				ok: true,
				quote: signedQuote
			};

			return({
				output: JSON.stringify(quoteResponse)
			});
		}

		routes['POST /api/createExchange'] = async function(_ignore_params, postData) {
			if (!postData || typeof postData !== 'object') {
				throw(new Error('No POST data provided'));
			}

			if (!('request' in postData)) {
				throw(new Error('POST data missing request'));
			}

			const request = assertKeetaFXAnchorClientCreateExchangeRequestJSON(postData.request);

			if ('quote' in request && 'estimate' in request && request.quote && request.estimate) {
				throw(new Error('Request cannot contain both quote and estimate'));
			}
			if (!('block' in request) || typeof request.block !== 'string') {
				throw(new Error('Block was not provided in exchange request'));
			}

			const block = new KeetaNet.lib.Block(request.block);

			let quote;
			let conversionInput;
			let shouldValidateQuote;
			let liquidityAccount;
			if ('quote' in request && request.quote) {
				shouldValidateQuote = true;
				quote = request.quote;
				conversionInput = quote.request;

				const isValidQuote = await (async () => {
					if (config.quoteSigner === null) {
						return(false);
					}

					return(await verifySignedData(config.quoteSigner, quote));
				})();

				if (!isValidQuote) {
					throw(new Errors.QuoteValidationFailed());
				}

				liquidityAccount = quote.account;
			} else if ('request' in request && request.request) {
				if (config.requiresQuote === true) {
					throw(new Errors.QuoteRequired());
				}

				conversionInput = request.request;
				quote = await getUnsignedQuoteData(conversionInput);

				if (config.requiresQuote.validateQuoteBeforeExchange !== undefined) {
					shouldValidateQuote = config.requiresQuote.validateQuoteBeforeExchange;
				} else {
					shouldValidateQuote = config.fx.validateQuote !== undefined
				}

				for (const operation of block.operations) {
					if (operation.type === KeetaNet.lib.Block.OperationType.SEND) {
						if (!config.accounts) {
							throw(new Error('No accounts configured for FX server, cannot infer liquidity account from block'));
						}

						if (config.accounts.has(operation.to)) {
							liquidityAccount = operation.to;
							break;
						}
					}
				}

				if (!liquidityAccount) {
					throw(new KeetaAnchorUserError('Could not determine liquidity account from exchange block'));
				}
			} else {
				throw(new Error('Either quote or request must be provided in exchange request'));
			}

			/* Validate the quote using the optional callback */
			if (config.fx.validateQuote !== undefined && shouldValidateQuote) {
				const isAcceptable = await config.fx.validateQuote(quote);
				if (!isAcceptable) {
					throw(new Errors.QuoteValidationFailed());
				}
			}

			let expectedSendAmount: bigint;
			let expectedReceiveAmount: bigint;

			if (conversionInput.affinity === 'to') {
				expectedSendAmount = BigInt(conversionInput.amount);
				expectedReceiveAmount = BigInt(quote.convertedAmount);
			} else {
				expectedSendAmount = BigInt(quote.convertedAmount);
				expectedReceiveAmount = BigInt(conversionInput.amount);
			}
			const liquidityAccountInstance = KeetaNet.lib.Account.toAccount(liquidityAccount);

			const userSendsMinimum = { [conversionInput.from]: expectedReceiveAmount };
			const userWillReceiveMaximum = { [conversionInput.to]: expectedSendAmount };

			if (BigInt(quote.cost.amount) > 0) {
				const feeTokenPub = KeetaNet.lib.Account.toPublicKeyString(quote.cost.token);

				if (!userSendsMinimum[feeTokenPub]) {
					userSendsMinimum[feeTokenPub] = 0n;
				}

				userSendsMinimum[feeTokenPub] += BigInt(quote.cost.amount);
			}

			let allowedLiquidityAccounts;
			if (config.accounts) {
				allowedLiquidityAccounts = config.accounts;
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			} else if (config.account) {
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				allowedLiquidityAccounts = new KeetaNet.lib.Account.Set([ config.account ]);
			} else {
				throw(new Error('config.account or config.accounts must be provided'));
			}

			assertExchangeBlockParameters({
				block: block,
				liquidityAccount: liquidityAccountInstance,
				allowedLiquidityAccounts: allowedLiquidityAccounts,
				userSendsMinimum: userSendsMinimum,
				userWillReceiveMaximum: userWillReceiveMaximum
			});

			/* Enqueue the exchange request */
			const exchangeID = await instance.pipeline.add({
				account: liquidityAccountInstance,
				block: block,
				request: conversionInput,
				expected: {
					receive: {
						token: KeetaNet.lib.Account.fromPublicKeyString(conversionInput.from),
						amount: expectedReceiveAmount
					},
					send: {
						token: KeetaNet.lib.Account.fromPublicKeyString(conversionInput.to),
						amount: expectedSendAmount
					}
				}
			});

			const exchangeResponse: KeetaFXAnchorExchangeResponse = {
				ok: true,
				exchangeID: exchangeID.toString(),
				status: 'pending'
			};

			return({
				output: JSON.stringify(exchangeResponse)
			});
		}

		routes['GET /api/getExchangeStatus/:id'] = async function(params) {
			if (params === undefined || params === null) {
				throw(new KeetaAnchorUserError('Expected params'));
			}
			const exchangeID = params.get('id');
			if (typeof exchangeID !== 'string') {
				throw(new Error('Missing exchangeID in params'));
			}

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const queueEntryInfo = await instance.pipeline.get(exchangeID as unknown as KeetaAnchorQueueRequestID);
			const exchangeResponse = (function(): KeetaFXAnchorExchangeResponse {
				const inputStatus = queueEntryInfo?.status;
				switch (inputStatus) {
					case undefined:
						throw(new KeetaAnchorUserError('Exchange ID not found'));
					case 'pending':
					case 'processing':
					case 'stuck':
					case 'aborted':
					case 'failed_temporarily':
						return({
							ok: true,
							status: 'pending',
							exchangeID: exchangeID
						});
					case 'completed': {
						const blockhash = queueEntryInfo?.output?.blockhash;
						if (blockhash === undefined) {
							return({
								ok: true,
								status: 'pending',
								exchangeID: exchangeID
							});
						} else {
							return({
								ok: true,
								status: 'completed',
								exchangeID: exchangeID,
								blockhash: blockhash
							});
						}
					}
					case 'failed_permanently':
						return({
							ok: false,
							exchangeID: exchangeID,
							status: 'failed',
							error: 'Exchange failed'
						});
					case 'moved':
						throw(new Error('Exchange ID has been moved'));
					case '@internal':
						throw(new Error('Invalid exchange status @internal'));
					default:
						assertNever(inputStatus);
				}
			})();

			logger.debug('GET /api/getExchangeStatus/:id', 'Exchange Status for ID', exchangeID, 'is', exchangeResponse, 'based on jobInfo', queueEntryInfo);

			return({
				output: JSON.stringify(exchangeResponse)
			});
		}

		return(routes);
	}

	/**
	 * Return the servers endpoints and possible currency conversions metadata
	 */
	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['fx']>[string]> {
		const operations: NonNullable<ServiceMetadata['services']['fx']>[string]['operations'] = {
			getEstimate: (new URL('/api/getEstimate', this.url)).toString(),
			getQuote: (new URL('/api/getQuote', this.url)).toString(),
			createExchange: (new URL('/api/createExchange', this.url)).toString(),
			getExchangeStatus: (new URL('/api/getExchangeStatus', this.url)).toString() + '/{exchangeID}'
		};

		return({
			from: this.fx.from ?? [],
			operations: operations
		});
	}

	async stop(): Promise<void> {
		if (this.pipelineAutoRunInterval !== null) {
			clearInterval(this.pipelineAutoRunInterval);
			this.pipelineAutoRunInterval = null;
		}

		await this.pipeline.destroy();

		await super.stop();
	}
}

/*
 * These are placed at the bottom of the file because the generation
 * breaks the code coverage computation;  Normally, we'd place these
 * in a ".generated.ts" file but for simplicity of internal types
 * we keep them here.
 */
const assertKeetaFXAnchorQueueStage1RequestJSON = typia.createAssert<KeetaFXAnchorQueueStage1RequestJSON>();
const assertKeetaFXAnchorQueueStage1ResponseOrNull = typia.createAssert<KeetaFXAnchorQueueStage1Response | null>();
