import * as KeetaAnchorHTTPServer from '../../lib/http-server.js';
import KeetaNet from '@keetanetwork/keetanet-client';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import {
	assertConversionInputCanonicalJSON,
	assertConversionQuoteJSON
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
		 * Handle the conversion request of one token to another
		 *
		 * This is used to handle quotes and estimates
		 */
		getConversionRateAndFee: (request: ConversionInputCanonicalJSON) => Promise<Omit<KeetaFXAnchorQuote, 'request' | 'signed' >>;
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

export class KeetaNetFXAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorFXServerConfig> implements Required<KeetaAnchorFXServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorFXServerConfig['homepage']>;
	readonly client: KeetaAnchorFXServerConfig['client'];
	readonly account: KeetaAnchorFXServerConfig['account'];
	readonly signer: NonNullable<KeetaAnchorFXServerConfig['signer']>;
	readonly quoteSigner: KeetaAnchorFXServerConfig['quoteSigner'];
	readonly fx: KeetaAnchorFXServerConfig['fx'];

	constructor(config: KeetaAnchorFXServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.client = config.client;
		this.fx = config.fx;
		this.account = config.account;
		this.signer = config.signer ?? config.account;
		this.quoteSigner = config.quoteSigner;
	}

	protected async initRoutes(config: KeetaAnchorFXServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = {};

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

			const block = new KeetaNet.lib.Block(request.block);
			let userClient: KeetaNet.UserClient;
			if (KeetaNet.UserClient.isInstance(config.client)) {
				userClient = config.client;
			} else {
				const { account, signer } = await requestToAccounts(config, quote.request);

				userClient = new KeetaNet.UserClient({
					client: config.client.client,
					network: config.client.network,
					networkAlias: config.client.networkAlias,
					account: account,
					signer: signer
				});
			}

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

			/* Verify Request and Generate the Accept Swap Block */
			const swapBlocks = await userClient.acceptSwapRequest({ block, expected: { token: expectedToken, amount: BigInt(expectedAmount) }});
			const publishOptions: Parameters<typeof userClient.client.transmit>[1] = {};
			if (userClient.config.generateFeeBlock !== undefined) {
				publishOptions.generateFeeBlock = userClient.config.generateFeeBlock;
			}
			const publishResult = await userClient.client.transmit(swapBlocks, publishOptions);
			if (!publishResult.publish) {
				throw(new Error('Exchange Publish Failed'));
			}
			const exchangeResponse: KeetaFXAnchorExchangeResponse = {
				ok: true,
				exchangeID: block.hash.toString()
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
			const blockLookup = await config.client.client.getVoteStaple(exchangeID);
			if (blockLookup === null) {
				throw(new Error('Block Not Found'));
			}
			const exchangeResponse: KeetaFXAnchorExchangeResponse = {
				ok: true,
				exchangeID: exchangeID
			};

			return({
				output: JSON.stringify(exchangeResponse)
			});
		}

		return(routes);
	}
}
