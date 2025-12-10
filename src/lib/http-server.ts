import * as http from 'http';
import {
	KeetaAnchorError,
	KeetaAnchorUserError
} from './error.js';
import type { JSONSerializable } from './utils/json.js';
import type { Logger, LogLevel } from './log/index.js';
import { Log } from './log/index.js';
import { createAssert } from 'typia';
import { assertNever } from './utils/never.js';

export const AssertHTTPErrorData: (input: unknown) => { error: string; statusCode?: number; contentType?: string; } = createAssert<{ error: string; statusCode?: number; contentType?: string; }>();

/**
 * The maximum size of a request (128KiB)
 */
const MAX_REQUEST_SIZE = 1024 * 128;

export type Routes = {
	[route: string]: (urlParams: Map<string, string>, postData: JSONSerializable | undefined, requestHeaders: http.IncomingHttpHeaders) => Promise<{ output: string | Buffer; statusCode?: number; contentType?: string; headers?: { [headerName: string]: string; }; }>;
};

export interface KeetaAnchorHTTPServerConfig {
	/**
	 * Identifier for the server instance -- if one is not given
	 * a random one will be generated.
	 */
	id?: string;

	/**
	 * The port for the HTTP server to listen on (default is an ephemeral port).
	 */
	port?: number;

	/**
	 * Enable debug logging
	 */
	logger?: Logger;
};

export abstract class KeetaNetAnchorHTTPServer<ConfigType extends KeetaAnchorHTTPServerConfig = KeetaAnchorHTTPServerConfig> implements Required<KeetaAnchorHTTPServerConfig> {
	readonly port: NonNullable<KeetaAnchorHTTPServerConfig['port']>;
	readonly logger: NonNullable<KeetaAnchorHTTPServerConfig['logger']>;
	readonly id: NonNullable<KeetaAnchorHTTPServerConfig['id']>;
	#serverPromise?: Promise<void>;
	#server?: http.Server;
	#url: undefined | string | URL | ((object: this) => string);
	readonly #config: ConfigType;

	constructor(config: ConfigType) {
		this.#config = { ...config };
		this.port = config.port ?? 0;
		this.id = config.id ?? crypto.randomUUID();
		this.logger = config.logger ?? Log.Legacy('ANCHOR');
	}

	protected abstract initRoutes(config: ConfigType): Promise<Routes>;

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

	private static addCORS(routes: Routes): Routes {
		const newRoutes: Routes = {};

		const validMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);

		const methodsByPath: { [key: string]: Set<string>; } = {};
		for (const routeKey in routes) {
			const methodAndPath = routeKey.split(' ');
			const method = methodAndPath[0];
			const path = methodAndPath.slice(1).join(' ');

			if (method === undefined || path === undefined) {
				continue;
			}

			if (!validMethods.has(method)) {
				continue;
			}

			if (!(path in methodsByPath)) {
				methodsByPath[path] = new Set<string>();
			}

			if (methodsByPath[path] === undefined) {
				throw(new Error(`internal error: methodsByPath missing path for ${path}`));
			}

			methodsByPath[path].add(method);
		}

		const seenPaths = new Set<string>();
		for (const routeKey in routes) {
			const methodAndPath = routeKey.split(' ');
			const method = methodAndPath[0];
			const path = methodAndPath.slice(1).join(' ');

			const routeHandler = routes[routeKey];
			if (routeHandler === undefined) {
				throw(new Error(`internal error: routeHandler missing for routeKey ${routeKey}`));
			}

			if (method !== 'ERROR') {
				if (method === undefined || path === undefined) {
					newRoutes[routeKey] = routeHandler;

					continue;
				}

				if (!validMethods.has(method)) {
					newRoutes[routeKey] = routeHandler;

					continue;
				}
			}

			const validMethodsForPath = methodsByPath[path];

			let validMethodsForPathParts: string[] = [];
			if (validMethodsForPath !== undefined) {
				validMethodsForPath.add('OPTIONS');
				validMethodsForPathParts = Array.from(validMethodsForPath);
			} else {
				validMethodsForPathParts = [...Array.from(validMethods), 'OPTIONS'];
			}

			newRoutes[routeKey] = async function(...args: Parameters<typeof routes[keyof typeof routes]>) {
				const retval = await routeHandler(...args);

				/* Add CORS headers to the response for the original route handler */
				if (retval.contentType === 'application/json' || retval.contentType === undefined) {
					if (!('headers' in retval) || retval.headers === undefined) {
						retval.headers = {};
					}
					retval.headers['Access-Control-Allow-Origin'] = '*';
				}

				return(retval);
			};

			if (!seenPaths.has(path) && path !== '' && path !== undefined) {
				const corsRouteKey = `OPTIONS ${path}`;

				newRoutes[corsRouteKey] = async function() {
					return({
						output: '',
						statusCode: 204,
						contentType: 'text/plain',
						headers: {
							'Access-Control-Allow-Origin': '*',
							'Access-Control-Allow-Methods': validMethodsForPathParts.join(', '),
							'Access-Control-Allow-Headers': 'Content-Type',
							'Access-Control-Max-Age': '86400'
						}
					});
				};
				seenPaths.add(path);
			}
		}

		return(newRoutes);
	}

	private async main(onSetPort?: (port: number) => void): Promise<void> {
		this.logger?.debug('KeetaAnchorHTTP.Server', 'Starting HTTP server...');

		const port = this.port;

		const routes = KeetaNetAnchorHTTPServer.addCORS({
			ERROR: async function(_ignore_params, postData) {
				const errorInfo = AssertHTTPErrorData(postData);

				const retval = {
					output: errorInfo.error,
					statusCode: errorInfo.statusCode ?? 400,
					contentType: errorInfo.contentType ?? 'text/plain'
				};

				return(retval);
			},
			...(await this.initRoutes(this.#config))
		});

		const server = new http.Server(async (request, response) => {
			const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
			const method = request.method ?? 'GET';

			/*
			 * Finalize the response by syncing the logger and ending
			 * the response.
			 */
			const responseFinalize = async () => {
				if ('sync' in this.logger && typeof this.logger.sync === 'function') {
					try {
						await this.logger.sync();
					} catch {
						/* ignore errors */
					}
				}

				response.end();
			};

			/*
			 * Lookup the route based on the request
			 */
			const requestedRouteAndParams = KeetaNetAnchorHTTPServer.routeFind(method, url, routes);
			if (requestedRouteAndParams === null) {
				response.statusCode = 404;
				response.setHeader('Content-Type', 'text/plain');
				response.write('Not Found');
				await responseFinalize();
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
			let result: Awaited<ReturnType<typeof route>> | undefined = undefined;
			let generatedResult = false;
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
						throw(new KeetaAnchorUserError('Unsupported content type'));
					}
					/**
					 * Call the route handler
					 */
					result = await route(params, postData, request.headers);
				} else {
					result = await route(params, undefined, request.headers);
				}

				generatedResult = true;
			} catch (err) {
				let logLevel: Lowercase<LogLevel> = 'error';
				if (KeetaAnchorError.isInstance(err)) {
					/*
					 * We're able to safely cast this here because the cast
					 * duplicates the logic.
					 */
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					logLevel = err.logLevel.toLowerCase() as Lowercase<typeof err.logLevel>;
				}

				/**
				 * If an error occurs, log it and return an error page
				 */
				this.logger?.[logLevel]('KeetaAnchorHTTP.Server', err);

				/**
				 * If it is a user error, provide a user-friendly error page
				 */
				const errorHandlerRoute = routes['ERROR'];
				if (errorHandlerRoute !== undefined) {
					if (KeetaAnchorUserError.isInstance(err)) {
						result = await errorHandlerRoute(new Map(), err.asErrorResponse('application/json'), request.headers);
					} else {
						result = await errorHandlerRoute(new Map(), {
							error: JSON.stringify({ ok: false, error: 'Internal Server Error' }),
							statusCode: 500,
							contentType: 'application/json'
						}, request.headers);
					}
					generatedResult = true;
				}

				if (!generatedResult) {
					/**
					 * Otherwise provide a generic error page
					 */
					response.statusCode = 500;
					response.setHeader('Content-Type', 'text/plain');
					response.write('Internal Server Error');
					await responseFinalize();
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

			for (const headerKey in result.headers ?? {}) {
				const headerValue = result.headers?.[headerKey];
				if (headerValue !== undefined) {
					response.setHeader(headerKey, headerValue);
				}
			}

			response.setHeader('Content-Type', result.contentType ?? 'application/json');
			response.write(result.output);
			await responseFinalize();
		});
		this.#server = server;

		/**
		 * Create a promise to wait for the server to close
		 */
		const waiter = new Promise<void>((resolve) => {
			server.on('close', () => {
				this.logger?.debug('KeetaAnchorHTTP.Server', 'Server closed');
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
			this.logger?.debug('KeetaAnchorHTTP.Server', 'Listening on port:', this.port);
		});

		/**
		 * Wait for the server to close
		 */
		await waiter;
	}

	/**
	 * Start the HTTP server and wait for it to be fully initialized.
	 */
	async start(): Promise<void> {
		/*
		 * Start the server and wait for it to be initialized before returning
		 */
		await new Promise<void>((resolve, reject) => {
			this.#serverPromise = this.main(function() {
				resolve();
			}).catch(function(error: unknown) {
				// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
				reject(error);
			});
		});
	}

	/**
	 * Wait for the server to terminate. This will only resolve once the
	 * server has been stopped.
	 */
	async wait(): Promise<void> {
		await this.#serverPromise;
	}

	/**
	 * Stop the HTTP server and wait for it to be fully terminated.
	 */
	async stop(): Promise<void> {
		this.#server?.close();
		// @ts-ignore
		this.#server = undefined;
		await this.wait();
	}

	/**
	 * Get the URL of the server, which can be used to make requests to
	 * it.  This will use "localhost" as the hostname and the port that
	 * the server is listening on by default but can be overridden by
	 * setting a custom URL.
	 */
	get url(): string {
		if (this.port === 0 || this.#server === undefined) {
			throw(new Error('Server not started'));
		}

		if (this.#url !== undefined) {
			let newURL: string;
			if (typeof this.#url === 'string') {
				newURL = this.#url;
			} else if (this.#url instanceof URL || ('port' in this.#url && 'hostname' in this.#url && 'toString' in this.#url)) {
				newURL = this.#url.toString();
			} else if (typeof this.#url === 'function') {
				newURL = this.#url(this);
			} else {
				assertNever(this.#url);
			}

			const newURLObj = new URL(newURL);
			newURLObj.pathname = '/';
			newURLObj.search = '';

			return(newURLObj.toString());
		}

		return(`http://localhost:${this.port}`);
	}

	set url(value: string | URL | ((object: this) => string)) {
		this.#url = value;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return(this.stop());
	}
}
