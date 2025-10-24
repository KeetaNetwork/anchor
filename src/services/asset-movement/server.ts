import * as KeetaAnchorHTTPServer from '../../lib/http-server.js';
import KeetaNet from '@keetanetwork/keetanet-client';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type {
	KeetaAssetMovementAnchorCreatePersistentForwardingRequest,
	KeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	KeetaAssetMovementAnchorInitiateTransferRequest,
	KeetaAssetMovementAnchorInitiateTransferResponse,
	KeetaAssetMovementAnchorGetTransferStatusRequest,
	KeetaAssetMovementAnchorGetTransferStatusResponse,
	KeetaAssetMovementAnchorlistTransactionsRequest,
	KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
	KeetaAssetMovementAnchorListPersistentForwardingRequest,
	KeetaAssetMovementAnchorListPersistentForwardingResponse,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest,
	KeetaAssetMovementAnchorListForwardingAddressTemplateRequest,
	KeetaAssetMovementAnchorListForwardingAddressTemplateResponse,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateClientRequest,
	KeetaAssetMovementAnchorListForwardingAddressTemplateClientRequest,
	KeetaAssetMovementAnchorCreatePersistentForwardingClientRequest,
	KeetaAssetMovementAnchorListPersistentForwardingClientRequest,
	KeetaAssetMovementAnchorInitiateTransferClientRequest,
	KeetaAssetMovementAnchorlistTransactionsClientRequest
} from './common.ts';
import {
	assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	assertKeetaAssetMovementAnchorInitiateTransferRequest,
	assertKeetaAssetMovementAnchorInitiateTransferResponse,
	assertKeetaAssetMovementAnchorGetTransferStatusRequest,
	assertKeetaAssetMovementAnchorGetTransferStatusResponse,
	assertKeetaAssetMovementAnchorlistTransactionsRequest,
	assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
	assertKeetaAssetMovementAnchorListPersistentForwardingRequest,
	assertKeetaAssetMovementAnchorListPersistentForwardingResponse
} from './common.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import { assert } from 'console';
import { Signable, VerifySignedData } from '../../lib/utils/signing.js';

type ExtractOk<T> = Omit<Extract<T, { ok: true }>, 'ok'>

export interface KeetaAnchorAssetMovementServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The network client to use for submitting blocks
	 */
	client: { client: KeetaNet.Client; network: bigint; networkAlias: typeof KeetaNet.Client.Config.networksArray[number] } | KeetaNet.UserClient;

	/**
	 * Configuration for asset movement operations
	 */
	assetMovement: {
		/**
		 * Supported assets and their configurations
		 */
		supportedAssets: NonNullable<ServiceMetadata['services']['assetMovement']>[string]['supportedAssets'];

		authenticationRequired?: boolean;

		/**
		 * Method to create a persistent forwarding address template
		 */
		createPersistentForwardingTemplate?: (request: KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest) => Promise<ExtractOk<KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse>>;
		
		/**
		 * Method to list persistent forwarding address templates
		 */
		listPersistentForwardingTemplate?: (request: KeetaAssetMovementAnchorListForwardingAddressTemplateRequest) => Promise<ExtractOk<KeetaAssetMovementAnchorListForwardingAddressTemplateResponse>>;

		/**
		 * Method to create a persistent forwarding address
		 */
		createPersistentForwarding?: (request: KeetaAssetMovementAnchorCreatePersistentForwardingRequest) => Promise<ExtractOk<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>>;

		/**
		 * Method to list persistent forwarding addresses
		 */
		listPersistentForwarding?: (request: KeetaAssetMovementAnchorListPersistentForwardingRequest) => Promise<ExtractOk<KeetaAssetMovementAnchorListPersistentForwardingResponse>>;

		/**
		 * Method to initiate a transfer
		 */
		initiateTransfer?: (request: KeetaAssetMovementAnchorInitiateTransferRequest) => Promise<ExtractOk<KeetaAssetMovementAnchorInitiateTransferResponse>>;

		/**
		 * Method to get the status of a transfer
		 */
		getTransferStatus?: (id: string) => Promise<ExtractOk<KeetaAssetMovementAnchorGetTransferStatusResponse>>;

		/**
		 * Method to list transactions
		 */
		listTransactions?: (request: KeetaAssetMovementAnchorlistTransactionsRequest) => Promise<ExtractOk<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>>;
	}
};

export class KeetaNetAssetMovementAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorAssetMovementServerConfig> implements Required<KeetaAnchorAssetMovementServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorAssetMovementServerConfig['homepage']>;
	readonly client: KeetaAnchorAssetMovementServerConfig['client'];
	readonly assetMovement: NonNullable<KeetaAnchorAssetMovementServerConfig['assetMovement']>;

	constructor(config: KeetaAnchorAssetMovementServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.client = config.client;
		this.assetMovement = config.assetMovement;
	}

	protected async initRoutes(config: KeetaAnchorAssetMovementServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
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

		function addRoute<
			HandlerName extends keyof KeetaAnchorAssetMovementServerConfig['assetMovement'],
			SerializedRequest extends { [key: string]: unknown },
			Response
		>(input: {
			method: 'GET' | 'POST';
			handlerName: HandlerName;
			assertRequest: (data: unknown) => SerializedRequest;
			parseRequest?: (data: SerializedRequest) => NonNullable<KeetaAnchorAssetMovementServerConfig['assetMovement'][HandlerName]> extends (arg: infer R) => any ? R : never;
			serializeResponse?: (data: ExtractOk<Response>) => unknown;
			assertResponse: (data: Response) => void;
			getSigningData?: (data: SerializedRequest) => Signable;
		}) {
			const handler = config.assetMovement[input.handlerName];
			if (handler === undefined) {
				return;
			}

			if (typeof handler !== 'function') {
				throw(new Error(`internal error: handler for ${String(input.handlerName)} is not a function`));
			}

			const authenticationRequired = config.assetMovement.authenticationRequired === true;

			routes[`${input.method} /api/${input.handlerName}`] = async function(_ignore_params, postData) {
				const request = input.assertRequest(postData);

				if (authenticationRequired || 'signed' in request) {
					if (!('account' in request) || !('signed' in request)) {
						throw(new KeetaAnchorUserError('Missing authentication information'));
					}

					if (typeof request.account !== 'string') {
						throw(new KeetaAnchorUserError('Invalid account public key'));
					}

					const signable = input.getSigningData ? input.getSigningData(request) : [];

					await VerifySignedData(
						KeetaNet.lib.Account.fromPublicKeyString(request.account),
						signable,
						request.signed as any
					);
				}

				let parsedRequest;
				if (input.parseRequest) {
					parsedRequest = input.parseRequest(request);
				} else {
					parsedRequest = request as any;
				}

				const result = await handler(parsedRequest as any);

				const resp = input.assertResponse(result as any);

				let serialized;
				if (input.serializeResponse) {
					serialized = input.serializeResponse(resp as any);
				} else {
					serialized = resp;
				}

				return({
					output: JSON.stringify({
						...serialized as any,
						ok: true
					})
				});
			}
		}

		// /**
		//  * Setup the various operation endpoints
		//  */
		// if (config.assetMovement.createPersistentForwarding !== undefined) {
		// 	routes['POST /api/createPersistentForwarding'] = async function(_ignore_params, postData) {
		// 		if (config.assetMovement.createPersistentForwarding === undefined) {
		// 			throw(new Error('internal error: createPersistentForwarding disappeared'));
		// 		}

		// 		const request = assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest(postData);
		// 		const result = await config.assetMovement.createPersistentForwarding(request);
		// 		const output: KeetaAssetMovementAnchorCreatePersistentForwardingResponse = {
		// 			...result,
		// 			ok: true
		// 		};

		// 		assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse(output);

		// 		return({
		// 			output: JSON.stringify(output)
		// 		});
		// 	}
		// }

		addRoute({
			method: 'POST',
			handlerName: 'createPersistentForwarding',
			assertRequest: assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest,
			assertResponse: assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse
		});

		// if (config.assetMovement.listPersistentForwarding !== undefined) {
		// 	routes['POST /api/listPersistentForwarding'] = async function(_ignore_params, postData) {
		// 		if (config.assetMovement.listPersistentForwarding === undefined) {
		// 			throw(new Error('internal error: listTransactions disappeared'));
		// 		}

		// 		const request = assertKeetaAssetMovementAnchorListPersistentForwardingRequest(postData);
		// 		const result = await config.assetMovement.listPersistentForwarding(request);
		// 		const output = assertKeetaAssetMovementAnchorListPersistentForwardingResponse({ ...result, ok: true });

		// 		return({ output: JSON.stringify(output) });
		// 	}
		// }
		addRoute({
			method: 'POST',
			handlerName: 'listPersistentForwarding',
			assertRequest: assertKeetaAssetMovementAnchorListPersistentForwardingRequest,
			assertResponse: assertKeetaAssetMovementAnchorListPersistentForwardingResponse
		});

		// if (config.assetMovement.initiateTransfer !== undefined) {
		// 	routes['POST /api/initiateTransfer'] = async function(_ignore_params, postData) {
		// 		if (config.assetMovement.initiateTransfer === undefined) {
		// 			throw(new Error('internal error: initiateTransfer disappeared'));
		// 		}

		// 		const request = assertKeetaAssetMovementAnchorInitiateTransferRequest(postData);
		// 		const result = await config.assetMovement.initiateTransfer(request);
		// 		const output: KeetaAssetMovementAnchorInitiateTransferResponse = {
		// 			...result,
		// 			ok: true
		// 		};

		// 		assertKeetaAssetMovementAnchorInitiateTransferResponse(output);

		// 		return({
		// 			output: JSON.stringify(output)
		// 		});
		// 	}
		// }

		addRoute({
			method: 'POST',
			handlerName: 'initiateTransfer',
			assertRequest: assertKeetaAssetMovementAnchorInitiateTransferRequest,
			assertResponse: assertKeetaAssetMovementAnchorInitiateTransferResponse
		});

		if (config.assetMovement.getTransferStatus !== undefined) {
			routes['GET /api/getTransferStatus/:id'] = async function(params) {
				if (config.assetMovement.getTransferStatus === undefined) {
					throw(new Error('internal error: getTransferStatus disappeared'));
				}

				const id = params.get('id');
				if (typeof id !== 'string' || id.length === 0) {
					throw(new KeetaAnchorUserError('Missing or invalid id parameter'));
				}

				/*
				 * Validate the request against the defined schema
				 */
				const request = assertKeetaAssetMovementAnchorGetTransferStatusRequest({
					id: id
				} satisfies KeetaAssetMovementAnchorGetTransferStatusRequest);

				const result = await config.assetMovement.getTransferStatus(request.id);
				const output: KeetaAssetMovementAnchorGetTransferStatusResponse = {
					...result,
					ok: true
				};

				assertKeetaAssetMovementAnchorGetTransferStatusResponse(output);

				return({
					output: JSON.stringify(output)
				});
			}
		}

		if (config.assetMovement.listTransactions !== undefined) {
			routes['POST /api/listTransactions'] = async function(_ignore_params, postData) {
				if (config.assetMovement.listTransactions === undefined) {
					throw(new Error('internal error: listTransactions disappeared'));
				}

				const request = assertKeetaAssetMovementAnchorlistTransactionsRequest(postData);
				const result = await config.assetMovement.listTransactions(request);
				const output: KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = {
					...result,
					ok: true
				};

				assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse(output);

				return({
					output: JSON.stringify(output)
				});
			}
		}

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['assetMovement']>[string]> {
		const operations: NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations'] = {};

		for (const op of [
			'initiateTransfer',
			'listTransactions',
			'listTransactions',
			// XXX:TODO these two should be done later
			// 'createPersistentForwardingTemplate',
			// 'listPersistentForwardingTemplate',
			'createPersistentForwarding',
			'listPersistentForwarding'
		] as const) {
			if (this.assetMovement[op] !== undefined) {
				operations[op] = (new URL(`/api/${op}`, this.url)).toString();
			}

		}

		if (this.assetMovement.getTransferStatus !== undefined) {
			operations.getTransferStatus = (new URL('/api/getTransferStatus/{id}', this.url)).toString();
		}

		if (Object.keys(operations).length === 0) {
			throw(new KeetaAnchorUserError('No operations are supported on this server'));
		}
		return({
			operations: operations,
			supportedAssets: this.assetMovement.supportedAssets
		});
	}
}
