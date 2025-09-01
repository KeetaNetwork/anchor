import * as http from 'http';
import KeetaNet from '@keetanetwork/keetanet-client';
import { createAssert } from 'typia';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type {
	ConversionInputCanonical,
	KeetaFXAnchorEstimateResponse,
	KeetaFXAnchorQuoteResponse
} from './common.ts';
import type { JSONSerializable } from '../../lib/utils/json.ts';
import type { Logger } from '../../lib/log/index.ts';
import { Log } from '../../lib/log/index.js';

/**
 * The maximum size of a request (128KiB)
 */
const MAX_REQUEST_SIZE = 1024 * 128;

const assertConversionInputCanonical = createAssert<ConversionInputCanonical>();
const assertErrorData = createAssert<{ error: string; statusCode?: number; contentType?: string; }>();

type Routes = {
	[route: string]: (postData: JSONSerializable | undefined) => Promise<{ output: string; statusCode?: number; contentType?: string; }>;
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
		getConversionRateAndFee: (request: ConversionInputCanonical) => Promise<Omit<Extract<KeetaFXAnchorEstimateResponse, { ok: true }>, 'ok' | 'request'>>;
	};

	/**
	 * The port for the HTTP server to listen on (default is an ephemeral port).
	 */
	port?: number;

	/**
	 * The network client to use for submitting blocks
	 */
	client: { client: KeetaNet.Client; network: bigint; } | KeetaNet.UserClient;

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
	routes['POST /api/getEstimate'] = async function(postData) {
		if (!postData) {
			throw(new Error('No POST data provided'));
		}

		const conversion = assertConversionInputCanonical(postData);
		const rateAndFee = await config.fx.getConversionRateAndFee(conversion);
		const estimateResponse: KeetaFXAnchorEstimateResponse = {
			ok: true,
			request: conversion,
			...rateAndFee
		};

		return({
			output: JSON.stringify(estimateResponse)
		});
	}

	routes['POST /api/getQuote'] = async function(postData) {
		if (!postData) {
			throw(new Error('No POST data provided'));
		}

		const conversion = assertConversionInputCanonical(postData);
		const rateAndFee = await config.fx.getConversionRateAndFee(conversion);
		const quoteResponse: KeetaFXAnchorQuoteResponse = {
			ok: true,
			request: conversion,
			...rateAndFee
		};

		return({
			output: JSON.stringify(quoteResponse)
		});
	}


	routes['ERROR'] = async function(postData) {
		const errorInfo = assertErrorData(postData);

		return({
			output: errorInfo.error,
			statusCode: errorInfo.statusCode ?? 400,
			contentType: errorInfo.contentType ?? 'text/plain'
		});
	}

	return(routes);
}

export class KeetaNetFaucetHTTPServer implements Required<KeetaAnchorFXServerConfig> {
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

	private async main(onSetPort?: (port: number) => void): Promise<void> {
		this.logger?.debug('KeetaAnchorFX.Server', 'Starting HTTP server...');

		const port = this.port;

		const routes = await initRoutes(this);

		const server = new http.Server(async (request, response) => {
			const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
			const path = url.pathname;

			/*
			 * Lookup the route based on the request
			 */
			const checkRouteKey = `${request.method ?? 'UNKNOWN'} ${path}`;
			const route = routes[checkRouteKey as keyof typeof routes];
			if (route === undefined) {
				response.statusCode = 404;
				response.setHeader('Content-Type', 'text/plain');
				response.write('Not Found');
				response.end();
				return;
			}

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
							postData = JSON.parse(data.toString('utf-8'));
						} catch (err) {
							throw(new Error('Invalid JSON data'));
						}
					} else {
						throw(new Error('Unsupported content type'));
					}
				}

				/**
				 * Call the route handler
				 */
				result = await route(postData);
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
							result = await errorHandlerRoute(err.asErrorResponse('application/json'));
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

		return(`http://localhost:${this.port}/`);
	}

	[Symbol.asyncDispose](): Promise<void> {
		return(this.stop());
	}

}
