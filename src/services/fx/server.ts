import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import { KeetaNet } from '../../client/index.js';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import {
	assertConversionInputCanonicalJSON,
	assertConversionQuoteJSON,
	Errors
} from './common.js';
import type {
	ConversionInputCanonicalJSON,
	KeetaFXAnchorEstimateResponse,
	KeetaFXAnchorExchangeResponse,
	KeetaFXAnchorQuote,
	KeetaFXAnchorQuoteJSON,
	KeetaFXAnchorQuoteResponse,
	KeetaNetAccount,
	KeetaNetStorageAccount
} from './common.ts';
import * as Signing from '../../lib/utils/signing.js';
import type { AssertNever } from '../../lib/utils/never.ts';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import { KeetaAnchorQueueRunner, KeetaAnchorQueueStorageDriverMemory } from '../../lib/queue/index.js';
import type { KeetaAnchorQueueStorageDriver, KeetaAnchorQueueRequestID } from '../../lib/queue/index.ts';
import { KeetaAnchorQueuePipelineBasic } from '../../lib/queue/pipeline.js';
import type { JSONSerializable } from '../../lib/utils/json.ts';
import { assertNever } from '../../lib/utils/never.js';

export interface KeetaAnchorFXServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The account to use for performing swaps for a given pair
	 *
	 * This may be either a function or a KeetaNet Account instance.
	 */
	account: KeetaNetAccount | KeetaNetStorageAccount | ((request: ConversionInputCanonicalJSON) => Promise<KeetaNetAccount | KeetaNetStorageAccount> | KeetaNetAccount | KeetaNetStorageAccount);
	/**
	 * Account which can be used to sign transactions
	 * for the account above (if not supplied the
	 * account will be used).
	 *
	 * This may be either a function or a KeetaNet Account instance.
	 */
	signer?: InstanceType<typeof KeetaNet.lib.Account> | ((request: ConversionInputCanonicalJSON) => Promise<InstanceType<typeof KeetaNet.lib.Account>> | InstanceType<typeof KeetaNet.lib.Account>);

	/**
	 * Account which performs the signing and validation of quotes
	 */
	quoteSigner: Signing.SignableAccount;

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
		getConversionRateAndFee: (request: ConversionInputCanonicalJSON) => Promise<Omit<KeetaFXAnchorQuote, 'request' | 'signed' >>;
		/**
		 * Optional callback to validate a quote before completing an exchange
		 *
		 * This allows the FX Server operator to reject quotes that are no longer
		 * acceptable (e.g., due to price changes, expiry, or other business logic)
		 *
		 * @param quote The quote to validate
		 * @returns true to accept the quote and proceed with the exchange, false to reject it
		 */
		validateQuote?: (quote: KeetaFXAnchorQuoteJSON) => Promise<boolean> | boolean;
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

async function requestToAccounts(config: KeetaAnchorFXServerConfig, request: ConversionInputCanonicalJSON): Promise<{ signer: Signing.SignableAccount; account: KeetaNetAccount | KeetaNetStorageAccount; }> {
	const account = KeetaNet.lib.Account.isInstance(config.account) ? config.account : await config.account(request);
	let signer: Signing.SignableAccount | null = null;
	if (config.signer !== undefined) {
		signer = (KeetaNet.lib.Account.isInstance(config.signer) ? config.signer : await config.signer(request)).assertAccount();
	}

	if (signer === null) {
		signer = account.assertAccount();
	}

	if (!account.isAccount() && !account.isStorage()) {
		throw(new Error('FX Account should be an Account or Storage Account'))
	}

	return({
		signer: signer,
		account: account
	});
}

/* QUEUE PROCESSOR PIPELINE */
type KeetaFXAnchorQueueStage1Request = {
	block: Parameters<typeof KeetaNet.UserClient['acceptSwapRequest']>[0]['block'];
	request: ConversionInputCanonicalJSON;
	expected: Required<NonNullable<Parameters<typeof KeetaNet.UserClient['acceptSwapRequest']>[0]['expected']>>;
};
type KeetaFXAnchorQueueStage1RequestJSON = {
	/* Base64 encoded block from the user */
	block: string;
	/* Original request */
	request: ConversionInputCanonicalJSON;
	/* Expected exchange details for verification */
	expected: {
		token: string;
		amount: string;
	};
};
type KeetaFXAnchorQueueStage1Response = {
	/**
	 * All the blocks for the given swap request
	 */
	blocks?: string[];
	/**
	 * The hash of one of the blocks submitted
	 */
	blockHash: string;
};
class KeetaFXAnchorQueuePipelineStage1 extends KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response> {
	protected readonly serverConfig: KeetaAnchorFXServerConfig;
	protected sequential = true;

	constructor(config: ConstructorParameters<typeof KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>>[0] & { serverConfig: KeetaAnchorFXServerConfig; }) {
		super(config);

		this.serverConfig = config.serverConfig;
	}

	protected async processor(entry: Parameters<KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>['processor']>[0]): ReturnType<KeetaAnchorQueueRunner<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response>['processor']> {
		const { block, expected, request } = entry.request;
		const expectedToken = expected.token;
		const expectedAmount = expected.amount;
		const config = this.serverConfig;

		let userClient: KeetaNet.UserClient;

		if (KeetaNet.UserClient.isInstance(config.client)) {
			userClient = config.client;
		} else {
			const { account, signer } = await requestToAccounts(config, request);

			userClient = new KeetaNet.UserClient({
				client: config.client.client,
				network: config.client.network,
				networkAlias: config.client.networkAlias,
				account: account,
				signer: signer
			});
		}

		/* Check for the block already being on the network, if so we can mark this job as completed */
		const blockExists = await userClient.block(block.hash);
		if (blockExists !== null) {
			return({
				status: 'completed',
				output: {
					blockHash: block.hash.toString()
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
		const swapBlocks = await userClient.acceptSwapRequest({ block, expected: { token: expectedToken, amount: BigInt(expectedAmount) }});
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
				blockHash: block.hash.toString()
			}
		});
	}

	protected encodeRequest(request: KeetaFXAnchorQueueStage1Request): JSONSerializable {
		const retval: KeetaFXAnchorQueueStage1RequestJSON = {
			block: Buffer.from(request.block.toBytes()).toString('base64'),
			request: request.request,
			expected: {
				token: request.expected.token?.publicKeyString.get(),
				amount: request.expected.amount?.toString()
			}
		};

		return(retval);
	}

	protected encodeResponse(response: KeetaFXAnchorQueueStage1Response | null): JSONSerializable | null {
		return(response);
	}

	protected decodeRequest(request: JSONSerializable): KeetaFXAnchorQueueStage1Request {
		// XXX:TODO: Use typia to validate structure
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const reqJSON = request as KeetaFXAnchorQueueStage1RequestJSON;

		const retval: KeetaFXAnchorQueueStage1Request = {
			block: new KeetaNet.lib.Block(reqJSON.block),
			request: reqJSON.request,
			expected: {
				token: KeetaNet.lib.Account.fromPublicKeyString(reqJSON.expected.token).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
				amount: BigInt(reqJSON.expected.amount)
			}
		};

		return(retval);
	}

	protected decodeResponse(response: JSONSerializable | null): KeetaFXAnchorQueueStage1Response | null {
		// XXX:TODO: Use typia to validate structure
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(response as KeetaFXAnchorQueueStage1Response | null);
	}
}

class KeetaFXAnchorQueuePipeline extends KeetaAnchorQueuePipelineBasic<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response, KeetaFXAnchorQueueStage1Response> {
	protected readonly stages: readonly [{
		name: 'process_swap_request';
		runner: typeof KeetaFXAnchorQueuePipelineStage1;
		args: [{
			serverConfig: KeetaAnchorFXServerConfig;
		}];
	}];

	constructor(options: ConstructorParameters<typeof KeetaAnchorQueuePipelineBasic<KeetaFXAnchorQueueStage1Request, KeetaFXAnchorQueueStage1Response, KeetaFXAnchorQueueStage1Response>>[0] & { serverConfig: KeetaAnchorFXServerConfig; }) {
		super(options);

		this.stages = [{
			name: 'process_swap_request',
			runner: KeetaFXAnchorQueuePipelineStage1,
			args: [{
				serverConfig: options.serverConfig
			}]
		}] as const;
	}
}

export class KeetaNetFXAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorFXServerConfig> implements Required<KeetaAnchorFXServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorFXServerConfig['homepage']>;
	readonly client: KeetaAnchorFXServerConfig['client'];
	readonly account: KeetaAnchorFXServerConfig['account'];
	readonly signer: NonNullable<KeetaAnchorFXServerConfig['signer']>;
	readonly quoteSigner: KeetaAnchorFXServerConfig['quoteSigner'];
	readonly fx: KeetaAnchorFXServerConfig['fx'];
	readonly pipeline: KeetaFXAnchorQueuePipeline;
	protected pipelineAutoRunInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: KeetaAnchorFXServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.client = config.client;
		this.fx = config.fx;
		this.account = config.account;
		this.signer = config.signer ?? config.account;
		this.quoteSigner = config.quoteSigner;

		/*
		 * If no storage driver is provided, we default to an in-memory
		 * that we auto-run
		 */
		let autorun = this.fx.storage?.autoRun ?? false;
		if (this.fx.storage === undefined) {
			autorun = true;
		}

		/*
		 * Create the pipeline to process transactions
		 */
		this.pipeline = new KeetaFXAnchorQueuePipeline({
			id: 'keeta-fx-anchor-queue-pipeline',
			baseQueue: this.fx.storage?.queue ?? new KeetaAnchorQueueStorageDriverMemory({
				id: 'keeta-fx-anchor-queue-pipeline-memory-driver',
				logger: this.logger
			}),
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
					await this.pipeline.run(5000);
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
			const estimateResponse: KeetaFXAnchorEstimateResponse = {
				ok: true,
				estimate: KeetaNet.lib.Utils.Conversion.toJSONSerializable({
					request: conversion,
					convertedAmount: rateAndFee.convertedAmount,
					expectedCost: {
						min: rateAndFee.cost.amount,
						max: rateAndFee.cost.amount,
						token: rateAndFee.cost.token
					}
				})
			};

			return({
				output: JSON.stringify(estimateResponse)
			});
		}

		routes['POST /api/getQuote'] = async function(_ignore_params, postData) {
			if (!postData || typeof postData !== 'object') {
				throw(new Error('No POST data provided'));
			}
			if (!('request' in postData)) {
				throw(new Error('POST data missing request'));
			}

			const conversion = assertConversionInputCanonicalJSON(postData.request);
			const rateAndFee = await config.fx.getConversionRateAndFee(conversion);

			const unsignedQuote: Omit<KeetaFXAnchorQuoteJSON, 'signed'> = KeetaNet.lib.Utils.Conversion.toJSONSerializable({
				request: conversion,
				...rateAndFee
			});

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
			const request = postData.request;
			if (!request || typeof request !== 'object') {
				throw(new Error('Request is not an object'));
			}

			if (!('quote' in request)) {
				throw(new Error('Quote is missing from request'));
			}
			if (!('block' in request) || typeof request.block !== 'string') {
				throw(new Error('Block was not provided in exchange request'));
			}

			const quote = assertConversionQuoteJSON(request.quote);
			const isValidQuote = await verifySignedData(config.quoteSigner, quote);
			if (!isValidQuote) {
				throw(new Error('Invalid quote signature'));
			}

			/* Validate the quote using the optional callback */
			if (config.fx.validateQuote !== undefined) {
				const isAcceptable = await config.fx.validateQuote(quote);
				if (!isAcceptable) {
					throw(new Errors.QuoteValidationFailed());
				}
			}

			const block = new KeetaNet.lib.Block(request.block);

			/* Get Expected Amount and Token to Verify Swap */
			const expectedToken = KeetaNet.lib.Account.fromPublicKeyString(quote.request.from);
			let expectedAmount = quote.request.affinity === 'from' ? BigInt(quote.request.amount) : BigInt(quote.convertedAmount);
			/* If cost is required verify the amounts and token. */
			if (BigInt(quote.cost.amount) > 0) {
				/* If swap token matches the cost token the add the amount since they should be combined in one block and will be checked in `acceptSwapRequest` */
				if (expectedToken.comparePublicKey(quote.cost.token)) {
					expectedAmount += BigInt(quote.cost.amount);
				/* If token is different then check block operations for matching amount and token */
				} else {
					let requestIncludesCost = false;
					for (const operation of block.operations) {
						if (operation.type === KeetaNet.lib.Block.OperationType.SEND) {
							const recipientMatches = operation.to.comparePublicKey(quote.account);
							const tokenMatches = operation.token.comparePublicKey(quote.cost.token);
							const amountMatches = operation.amount === BigInt(quote.cost.amount);
							if (recipientMatches && tokenMatches && amountMatches) {
								requestIncludesCost = true;
							}
						}
					}
					if (!requestIncludesCost) {
						throw(new Error('Exchange missing required cost'));
					}
				}
			}

			/* Enqueue the exchange request */
			const exchangeID = await instance.pipeline.add({
				block: block,
				request: quote.request,
				expected: {
					token: expectedToken,
					amount: BigInt(expectedAmount)
				}
			});

			const exchangeResponse: KeetaFXAnchorExchangeResponse = {
				ok: true,
				exchangeID: exchangeID?.toString() ?? 'XXX:TODO',
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
			const status: Extract<KeetaFXAnchorExchangeResponse, { ok: true }>['status'] = (function() {
				const inputStatus = queueEntryInfo?.status;
				switch (inputStatus) {
					case undefined:
						throw(new KeetaAnchorUserError('Exchange ID not found'));
					case 'pending':
					case 'processing':
					case 'stuck':
					case 'aborted':
					case 'failed_temporarily':
						return('pending');
					case 'completed':
						return('completed');
					case 'failed_permanently':
						return('failed');
					case 'moved':
						throw(new Error('Exchange ID has been moved'));
					case '@internal':
						throw(new Error('Invalid exchange status @internal'));
					default:
						assertNever(inputStatus);
				}
			})();

			const exchangeResponse: KeetaFXAnchorExchangeResponse = {
				ok: true,
				exchangeID: exchangeID,
				status: status
			};

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
			getExchangeStatus: (new URL('/api/getExchangeStatus', this.url)).toString() + '/{id}'
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

		await super.stop();
	}
}
