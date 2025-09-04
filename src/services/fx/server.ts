import * as http from 'http';
import KeetaNet from '@keetanetwork/keetanet-client';
import { createAssert } from 'typia';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type {
	ConversionInputCanonical,
	KeetaFXAnchorEstimateResponse,
	KeetaFXAnchorExchangeResponse,
	KeetaFXAnchorQuote,
	KeetaFXAnchorQuoteResponse
} from './common.ts';
import { acceptSwapRequest } from './common.js';
import type { JSONSerializable } from '../../lib/utils/json.js';
import type { Logger } from '../../lib/log/index.js';
import { Log } from '../../lib/log/index.js';

/**
 * The maximum size of a request (128KiB)
 */
const MAX_REQUEST_SIZE = 1024 * 128;

const assertConversionInputCanonical = createAssert<ConversionInputCanonical>();
const assertConversionQuote = createAssert<KeetaFXAnchorQuote>();
const assertErrorData = createAssert<{ error: string; statusCode?: number; contentType?: string; }>();

type Routes = {
	[route: string]: (urlParams: Map<string, string>, postData: JSONSerializable | undefined) => Promise<{ output: string; statusCode?: number; contentType?: string; }>;
};

export interface KeetaAnchorFXServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The account to use for performing swaps for a given pair
	 *
	 * This may be either a function or a KeetaNet Account instance.
	 */
	account: InstanceType<typeof KeetaNet.lib.Account> | ((request: ConversionInputCanonical) => Promise<InstanceType<typeof KeetaNet.lib.Account>> | InstanceType<typeof KeetaNet.lib.Account>);
	/**
	 * Account which can be used to sign transactions
	 * for the account above (if not supplied the
	 * account will be used).
	 *
	 * This may be either a function or a KeetaNet Account instance.
	 */
	signer?: InstanceType<typeof KeetaNet.lib.Account> | ((request: ConversionInputCanonical) => Promise<InstanceType<typeof KeetaNet.lib.Account>> | InstanceType<typeof KeetaNet.lib.Account>);

	/**
	 * Configuration for FX handling
	 */
	fx: {
		/**
		 * Handle the conversion request of one token to another
		 *
		 * This is used to handle quotes and estimates
		 */
		getConversionRateAndFee: (request: ConversionInputCanonical) => Promise<Omit<KeetaFXAnchorQuote, 'request' | 'signed' >>;
	};

	/**
	 * The port for the HTTP server to listen on (default is an ephemeral port).
	 */
	port?: number;

	/**
	 * The network client to use for submitting blocks
	 */
	client: { client: KeetaNet.Client; network: bigint; networkAlias: typeof KeetaNet.Client.Config.networksArray[number] } | KeetaNet.UserClient;

	/**
	 * Enable debug logging
	 */
	logger?: Logger;
};

async function initRoutes(config: KeetaAnchorFXServerConfig): Promise<Routes> {
	const routes: Routes = {};

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

		const conversion = assertConversionInputCanonical(postData.request);
		const rateAndFee = await config.fx.getConversionRateAndFee(conversion);
		const estimateResponse: KeetaFXAnchorEstimateResponse = {
			ok: true,
			estimate: {
				request: conversion,
				convertedAmount: rateAndFee.convertedAmount,
				expectedCost: {
					min: rateAndFee.cost.amount,
					max: rateAndFee.cost.amount,
					token: rateAndFee.cost.token
				}
			}
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

		const conversion = assertConversionInputCanonical(postData.request);
		const rateAndFee = await config.fx.getConversionRateAndFee(conversion);
		const nonce = crypto.randomUUID();
		const timestamp = (new Date()).toISOString();
		const signature = ''; // TODO implement signature
		const quoteResponse: KeetaFXAnchorQuoteResponse = {
			ok: true,
			quote: {
				request: conversion,
				...rateAndFee,
				signed: {
					nonce,
					timestamp,
					signature
				}
			}
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

		const quote = assertConversionQuote(request.quote);

		const block = new KeetaNet.lib.Block(request.block);
		let userClient: KeetaNet.UserClient;
		if (KeetaNet.UserClient.isInstance(config.client)) {
			userClient = config.client;
		} else {
			const account = KeetaNet.lib.Account.isInstance(config.account) ? config.account : await config.account(quote.request);
			let signer: InstanceType<typeof KeetaNet.lib.Account<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.ECDSA_SECP256K1 | typeof KeetaNet.lib.Account.AccountKeyAlgorithm.ED25519 | typeof KeetaNet.lib.Account.AccountKeyAlgorithm.ECDSA_SECP256R1>> | null = null;
			if (config.signer !== undefined) {
				signer = (KeetaNet.lib.Account.isInstance(config.signer) ? config.signer : await config.signer(quote.request)).assertAccount();
			}

			userClient = new KeetaNet.UserClient({
				client: config.client.client,
				network: config.client.network,
				networkAlias: config.client.networkAlias,
				account,
				signer: signer
			});
		}

		const expectedToken = KeetaNet.lib.Account.fromPublicKeyString(quote.request.from);
		const expectedAmount = quote.request.affinity === 'from' ? quote.request.amount : quote.convertedAmount;
		const swapBlocks = await acceptSwapRequest(userClient, block, { token: expectedToken, amount: BigInt(expectedAmount) });
		const publishResult = await userClient.client.transmit(swapBlocks);
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
			throw(new Error('Expected params'));
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


	routes['ERROR'] = async function(_ignore_params, postData) {
		const errorInfo = assertErrorData(postData);

		return({
			output: errorInfo.error,
			statusCode: errorInfo.statusCode ?? 400,
			contentType: errorInfo.contentType ?? 'text/plain'
		});
	}

	return(routes);
}

export class KeetaNetFXAnchorHTTPServer implements Required<KeetaAnchorFXServerConfig> {
	readonly port: NonNullable<KeetaAnchorFXServerConfig['port']>;
	readonly homepage: NonNullable<KeetaAnchorFXServerConfig['homepage']>;
	readonly client: KeetaAnchorFXServerConfig['client'];
	readonly logger: NonNullable<KeetaAnchorFXServerConfig['logger']>;
	readonly account: KeetaAnchorFXServerConfig['account'];
	readonly signer: NonNullable<KeetaAnchorFXServerConfig['signer']>;
	readonly fx: KeetaAnchorFXServerConfig['fx'];
	#serverPromise?: Promise<void>;
	#server?: http.Server;

	constructor(config: KeetaAnchorFXServerConfig) {
		this.homepage = config.homepage ?? '';
		this.port = config.port ?? 0;
		this.client = config.client;
		this.fx = config.fx;
		this.account = config.account;
		this.signer = config.signer ?? config.account;
		this.logger = config.logger ?? new Log();
	}

	private static routeMatch(requestURL: URL, routeURL: URL): ({ match: true; params: Map<string, string> } | { match: false }) {
		const requestURLPaths = requestURL.pathname.split('/');
		const routeURLPaths = routeURL.pathname.split('/');

		if (requestURLPaths.length !== routeURLPaths.length) {
			return({ match: false });
		}

		const params = new Map<string, string>();
		for (let partIndex = 0; partIndex < requestURLPaths.length; partIndex++) {
			const requestPath = requestURLPaths[partIndex];
			const routePath = routeURLPaths[partIndex];

			if (routePath === undefined || requestPath === undefined) {
				return({ match: false });
			}

			if (routePath.startsWith(':')) {
				params.set(routePath.slice(1), requestPath);
			} else if (requestPath !== routePath) {
				return({ match: false });
			}
		}

		return({ match: true, params: params });
	}

	private static routeFind(method: string, requestURL: URL, routes: Routes): { route: Routes[keyof Routes]; params: Map<string, string> } | null {
		for (const routeKey in routes) {
			const route = routes[routeKey];
			if (route === undefined) {
				continue;
			}

			const [routeMethod, ...routePathParts] = routeKey.split(' ');
			const routePath = `/${routePathParts.join(' ')}`.replace(/^\/+/, '/');

			if (method !== routeMethod) {
				continue;
			}

			const routeURL = new URL(routePath, 'http://localhost');
			const matchResult = this.routeMatch(requestURL, routeURL);
			if (matchResult.match) {
				return({
					route: route,
					params: matchResult.params
				});
			}
		}

		return(null);
	}

	private async main(onSetPort?: (port: number) => void): Promise<void> {
		this.logger?.debug('KeetaAnchorFX.Server', 'Starting HTTP server...');

		const port = this.port;

		const routes = await initRoutes(this);

		const server = new http.Server(async (request, response) => {
			const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
			const method = request.method ?? 'GET';

			/*
			 * Lookup the route based on the request
			 */
			const requestedRouteAndParams = KeetaNetFXAnchorHTTPServer.routeFind(method, url, routes);
			if (requestedRouteAndParams === null) {
				response.statusCode = 404;
				response.setHeader('Content-Type', 'text/plain');
				response.write('Not Found');
				response.end();
				return;
			}

			/*
			 * Extract the route handler and the parameters from
			 * the request
			 */
			const { route, params } = requestedRouteAndParams;

			/**
			 * Attempt to run the route, catch any errors
			 */
			let result, generatedResult = false;
			try {
				/**
				 * If POST'ing, read and parse the POST data
				 */
				let postData: JSONSerializable | undefined;
				if (request.method === 'POST') {
					const data = await request.map(function(chunk) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
						return(Buffer.from(chunk));
					}).reduce(function(prev, curr) {
						if (prev.length > MAX_REQUEST_SIZE) {
							throw(new Error('Request too large'));
						}

						if (!Buffer.isBuffer(curr)) {
							throw(new Error(`internal error: Current item is not a buffer -- ${typeof curr}`));
						}
						return(Buffer.concat([prev, curr]));
					}, Buffer.from(''));

					if (request.headers['content-type'] === 'application/json') {
						try {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
							postData = JSON.parse(data.toString('utf-8'));
						} catch {
							throw(new Error('Invalid JSON data'));
						}
					} else {
						throw(new Error('Unsupported content type'));
					}
					/**
					 * Call the route handler
					 */
					result = await route(params, postData);
				} else {
					result = await route(params, undefined);
				}

				generatedResult = true;
			} catch (err) {
				/**
				 * If an error occurs, log it and return an error page
				 */
				this.logger?.error('KeetaAnchorFX.Server', err);

				/**
				 * If it is a user error, provide a user-friendly error page
				 */
				if (typeof err === 'object' && err !== null && 'userError' in err && err.userError === true) {
					if (KeetaAnchorUserError.isInstance(err)) {
						const errorHandlerRoute = routes['ERROR'];
						if (errorHandlerRoute !== undefined) {
							result = await errorHandlerRoute(new Map(), err.asErrorResponse('application/json'));
							generatedResult = true;
						}
					}
				}

				if (!generatedResult) {
					/**
					 * Otherwise provide a generic error page
					 */
					response.statusCode = 500;
					response.setHeader('Content-Type', 'text/plain');
					response.write('Internal Server Error');
					response.end();
					return;
				}
			}

			if (result === undefined) {
				throw(new Error('internal error: No result'));
			}

			/**
			 * Write the response to the client
			 */
			response.statusCode = result.statusCode ?? 200;
			response.setHeader('Content-Type', result.contentType ?? 'application/json');
			response.write(result.output);
			response.end();
		});
		this.#server = server;

		/**
		 * Create a promise to wait for the server to close
		 */
		const waiter = new Promise<void>((resolve) => {
			server.on('close', () => {
				this.logger?.debug('KeetaAnchorFX.Server', 'Server closed');
				resolve();
			});
		});

		/**
		 * Start listening on the port
		 */
		server.listen(port, () => {
			const address = server.address();
			if (address !== null && typeof address === 'object') {
				// @ts-ignore
				this.port = address.port;
				onSetPort?.(this.port);
			}
			this.logger?.debug('KeetaAnchorFX.Server', 'Listening on port:', this.port);
		});

		/**
		 * Wait for the server to close
		 */
		await waiter;
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.#serverPromise = this.main(function() {
				resolve();
			});
		});
	}

	async wait(): Promise<void> {
		await this.#serverPromise;
	}

	async stop(): Promise<void> {
		this.#server?.close();
		await this.wait();
	}

	get url(): string {
		if (this.port === 0 || this.#server === undefined) {
			throw(new Error('Server not started'));
		}

		return(`http://localhost:${this.port}`);
	}

	[Symbol.asyncDispose](): Promise<void> {
		return(this.stop());
	}

}
