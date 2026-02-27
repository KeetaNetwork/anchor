import * as http from 'http';
import {
	KeetaAnchorError,
	KeetaAnchorUserError
} from '../error.js';
import type { JSONSerializable } from '../utils/json.js';
import type { Logger, LogLevel } from '../log/index.js';
import { Log } from '../log/index.js';
import { createAssert } from 'typia';
import { assertNever } from '../utils/never.js';

export const AssertHTTPErrorData: (input: unknown) => { error: string; statusCode?: number; contentType?: string; } = createAssert<{ error: string; statusCode?: number; contentType?: string; }>();

/**
 * The maximum size of a request (128MiB)
 */
const MAX_REQUEST_SIZE = 128 * (1024 ** 2);

type RouteHandlerMethod<BodyDataType = JSONSerializable | undefined> = (urlParams: Map<string, string>, postData: BodyDataType, requestHeaders: http.IncomingHttpHeaders, requestUrl: URL) => Promise<{ output: string | Buffer; statusCode?: number; contentType?: string; headers?: { [headerName: string]: string; }; }>;
type RouteHandlerWithConfig = {
	bodyType: 'raw';
	maxBodySize?: number;
	handler: RouteHandlerMethod<Buffer>;
} | {
	bodyType: 'parsed';
	maxBodySize?: number;
	handler: RouteHandlerMethod;
} | {
	bodyType: 'none';
	handler: RouteHandlerMethod<undefined>;
};
type RouteHandler = RouteHandlerMethod | RouteHandlerWithConfig;
export type Routes = { [route: string]: RouteHandler };
export type RoutesWithConfigs = { [route: string]: RouteHandlerWithConfig };

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
	logger?: Logger | undefined;
	/**
	 * The URL for the server. By default, this will be generated based on
	 * the port and will use "localhost" as the hostname, but it can be
	 * overridden by setting this to a string, URL, or function that
	 * generates the URL
	 */
	url?: undefined | string | URL | ((object: KeetaNetAnchorHTTPServer) => string) | {
		hostname?: string;
		port?: number;
		protocol?: string;
	};
};

export abstract class KeetaNetAnchorHTTPServer<ConfigType extends KeetaAnchorHTTPServerConfig = KeetaAnchorHTTPServerConfig> implements Required<KeetaAnchorHTTPServerConfig> {
	readonly port: NonNullable<KeetaAnchorHTTPServerConfig['port']>;
	readonly logger: NonNullable<KeetaAnchorHTTPServerConfig['logger']>;
	readonly id: NonNullable<KeetaAnchorHTTPServerConfig['id']>;
	#serverPromise?: Promise<void>;
	#server?: http.Server;
	#urlParts: undefined | { hostname?: string; port?: number; protocol?: string; };
	#url: undefined | string | URL | ((object: this) => string);
	readonly #config: ConfigType;

	constructor(config: ConfigType) {
		this.#config = { ...config };
		this.port = config.port ?? 0;
		this.id = config.id ?? crypto.randomUUID();
		this.logger = config.logger ?? Log.Legacy('ANCHOR');

		if (config.url !== undefined) {
			if (config.url instanceof URL || typeof config.url === 'string') {
				this.#url = config.url;
				this.#urlParts = undefined;
			} else if (typeof config.url === 'function') {
				/**
				 * The parameter for the call back is typed as
				 * `this`, which means any subclass is typed
				 * but the interface can't identify that --
				 * instead it types it as the base class
				 * (KeetaNetAnchorHTTPServer), which means it
				 * can't be assigned to the type of `#url`
				 * without overriding the type check. However,
				 * we know that `this` will be at least
				 * compatible with the base class.
				 */
				// @ts-ignore
				this.#url = config.url;
				this.#urlParts = undefined;
			} else {
				this.#url = undefined;
				this.#urlParts = config.url;
			}
		}
	}

	protected abstract initRoutes(config: ConfigType): Promise<Routes>;

	private static routeMatch(requestURL: URL, routeURL: URL): ({ match: true; params: Map<string, string>; wildcard?: { prefixLength: number }} | { match: false }) {
		const requestURLPaths = requestURL.pathname.split('/');
		const routeURLPaths = routeURL.pathname.split('/');

		// Check if route ends with wildcard /**
		const isWildcard = routeURLPaths.length > 0 && routeURLPaths[routeURLPaths.length - 1] === '**';
		if (isWildcard) {
			// For wildcard routes, request must have more segments than route prefix (minus the **)
			// This ensures at least one segment is captured by the wildcard
			const prefixLength = routeURLPaths.length - 1;
			if (requestURLPaths.length <= prefixLength) {
				return({ match: false });
			}

			// Check that prefix segments match
			const params = new Map<string, string>();
			for (let partIndex = 0; partIndex < prefixLength; partIndex++) {
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

			// Capture the remainder as the wildcard param
			// Filter empty segments to handle trailing slashes correctly
			const remainder = requestURLPaths.slice(prefixLength)
				.filter(function(s) {
					return(s !== '');
				})
				.join('/');

			if (remainder === '') {
				// Reject if wildcard would capture nothing
				return({ match: false });
			}

			params.set('**', remainder);

			return({ match: true, params: params, wildcard: { prefixLength }});
		}

		// Non-wildcard: require exact segment count
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
		let wildcardMatch: { route: Routes[keyof Routes]; params: Map<string, string> } | null = null;
		let wildcardPrefixLength = -1;

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
				// Exact matches take priority over wildcard matches
				if (matchResult.wildcard === undefined) {
					return({
						route: route,
						params: matchResult.params
					});
				}

				// Keep the most specific wildcard (longest prefix wins)
				if (matchResult.wildcard.prefixLength > wildcardPrefixLength) {
					wildcardPrefixLength = matchResult.wildcard.prefixLength;
					wildcardMatch = {
						route: route,
						params: matchResult.params
					};
				}
			}
		}

		// Return most specific wildcard match if no exact match found
		return(wildcardMatch);
	}

	private static addCORS(routes: Routes): RoutesWithConfigs {
		const newRoutes: RoutesWithConfigs = {};

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

			let newRoute: RouteHandlerWithConfig;

			if (typeof routeHandler === 'function') {
				newRoute = {
					bodyType: 'parsed',
					handler: routeHandler
				};
			} else {
				newRoute = routeHandler;
			}

			if (method !== 'ERROR') {
				if (method === undefined || path === undefined) {
					newRoutes[routeKey] = newRoute;

					continue;
				}

				if (!validMethods.has(method)) {
					newRoutes[routeKey] = newRoute;

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

			newRoutes[routeKey] = {
				...newRoute,
				async handler(...args: Parameters<RouteHandlerMethod<unknown>>) {
					// This is typed properly, but TS can't infer it here
					// @ts-ignore
					const retval = await newRoute.handler(...args);

					/* Add CORS headers to the response for the original route handler */
					if (retval.contentType === 'application/json' || retval.contentType === undefined) {
						if (!('headers' in retval) || retval.headers === undefined) {
							retval.headers = {};
						}
						retval.headers['Access-Control-Allow-Origin'] = '*';
					}

					return(retval);
				}
			};

			if (!seenPaths.has(path) && path !== '' && path !== undefined) {
				const corsRouteKey = `OPTIONS ${path}`;

				newRoutes[corsRouteKey] = {
					bodyType: 'none',
					async handler() {
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
					}
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
			/*
			 * Get the Base URL from the request Host header (if
			 * available) or default to localhost. This is used
			 * to construct the full URL for routing.
			 */
			const inputURLBaseRaw = new URL(`http://${request.headers.host ?? 'localhost'}`);
			const inputURLBase = inputURLBaseRaw.protocol + '//' + inputURLBaseRaw.host;

			/*
			 * Normalize the input URL by stripping leading slashes and
			 * combining it with the base URL to get the full URL for routing.
			 */
			const inputURLRaw = (request.url ?? '/').replace(/^\/+/, '/');
			const inputURLObject = new URL(inputURLRaw, 'http://localhost');
			const inputURL = inputURLObject.pathname + (function() {
				if (inputURLObject.search === '') {
					return('');
				}

				return('?' + inputURLObject.searchParams.toString());
			})();
			const url = new URL(inputURL, inputURLBase);
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
			 * If the request is malformed, reject it immediately
			 */
			if (inputURLRaw.at(0) !== '/') {
				response.statusCode = 400;
				response.setHeader('Content-Type', 'text/plain');
				response.write('Bad Request');
				await responseFinalize();
				return;
			}

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
			let result: Awaited<ReturnType<RouteHandlerMethod>> | undefined = undefined;
			let generatedResult = false;
			try {
				if (!request.method) {
					throw(new Error('internal error: No request method'));
				}

				let bodyData: JSONSerializable | Buffer | undefined;

				const shouldCheckBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);

				if (typeof route === 'function') {
					throw(new Error('internal error: Route handler missing body type configuration, should have been added in addCORS'));
				}

				/**
				 * If POST'ing, PUT'ing, or PATCH'ing, read and parse the request body
				 */
				if (shouldCheckBody && route.bodyType !== 'none') {
					const bodySizeLimit = route.maxBodySize ?? MAX_REQUEST_SIZE;

					// Early rejection based on Content-Length header
					const contentLength = request.headers['content-length'];
					if (contentLength !== undefined) {
						const declaredSize = parseInt(contentLength, 10);
						if (!isNaN(declaredSize) && declaredSize > bodySizeLimit) {
							request.resume();

							response.statusCode = 413;
							response.setHeader('Content-Type', 'text/plain');
							response.write('Payload Too Large');

							await responseFinalize();

							return;
						}
					}

					const data = await request.map(function(chunk) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
						return(Buffer.from(chunk));
					}).reduce(function(prev, curr) {
						if (prev.length > bodySizeLimit) {
							throw(new Error('Request too large'));
						}

						if (!Buffer.isBuffer(curr)) {
							throw(new Error(`internal error: Current item is not a buffer -- ${typeof curr}`));
						}
						return(Buffer.concat([prev, curr]));
					}, Buffer.from(''));

					if (route.bodyType === 'raw') {
						bodyData = data;
					} else if (route.bodyType === 'parsed' && request.headers['content-type'] === 'application/json') {
						try {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
							bodyData = JSON.parse(data.toString('utf-8'));
						} catch {
							throw(new Error('Invalid JSON data'));
						}
					} else {
						throw(new KeetaAnchorUserError('Unsupported content type'));
					}
				}

				/**
				 * Call the route handler
				 */
				// @ts-ignore
				result = await route.handler(params, bodyData, request.headers, url);

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
					let errBody;
					if (KeetaAnchorError.isInstance(err) && err['userError']) {
						errBody = err.asErrorResponse('application/json');
					} else {
						errBody = {
							error: JSON.stringify({ ok: false, error: 'Internal Server Error' }),
							statusCode: 500,
							contentType: 'application/json'
						};
					}

					// @ts-ignore
					result = await errorHandlerRoute.handler(new Map(), errBody, request.headers, url);
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

			const retval = newURLObj.toString();

			return(retval);
		}

		const urlObj = new URL('http://localhost');
		urlObj.port = String(this.#urlParts?.port ?? this.port);
		urlObj.hostname = this.#urlParts?.hostname ?? 'localhost';
		urlObj.protocol = this.#urlParts?.protocol ?? 'http:';
		urlObj.pathname = '/';
		urlObj.search = '';

		const retval = urlObj.toString();

		return(retval);
	}

	set url(value: undefined | string | URL | ((object: this) => string)) {
		this.#urlParts = undefined;
		this.#url = value;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return(this.stop());
	}
}
