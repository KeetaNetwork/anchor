import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import type KeetaNet from '@keetanetwork/keetanet-client';
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
	KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse
} from './common.ts';
import {
	assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	assertKeetaAssetMovementAnchorInitiateTransferRequest,
	assertKeetaAssetMovementAnchorInitiateTransferResponse,
	assertKeetaAssetMovementAnchorGetTransferStatusRequest,
	assertKeetaAssetMovementAnchorGetTransferStatusResponse,
	assertKeetaAssetMovementAnchorlistTransactionsRequest,
	assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse
} from './common.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';

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

		/**
		 * Method to create a persistent forwarding address
		 */
		createPersistentForwarding?: (request: KeetaAssetMovementAnchorCreatePersistentForwardingRequest) => Promise<Omit<Extract<KeetaAssetMovementAnchorCreatePersistentForwardingResponse, { ok: true }>, 'ok'>>;

		/**
		 * Method to initiate a transfer
		 */
		initiateTransfer?: (request: KeetaAssetMovementAnchorInitiateTransferRequest) => Promise<Omit<Extract<KeetaAssetMovementAnchorInitiateTransferResponse, { ok: true }>, 'ok'>>;

		/**
		 * Method to get the status of a transfer
		 */
		getTransferStatus?: (id: string) => Promise<Omit<Extract<KeetaAssetMovementAnchorGetTransferStatusResponse, { ok: true }>, 'ok'>>;

		/**
		 * Method to list transactions
		 */
		listTransactions?: (request: KeetaAssetMovementAnchorlistTransactionsRequest) => Promise<Omit<Extract<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse, { ok: true }>, 'ok'>>;
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

		/**
		 * Setup the various operation endpoints
		 */
		if (config.assetMovement.createPersistentForwarding !== undefined) {
			routes['POST /api/createPersistentForwarding'] = async function(_ignore_params, postData) {
				if (config.assetMovement.createPersistentForwarding === undefined) {
					throw(new Error('internal error: createPersistentForwarding disappeared'));
				}

				const request = assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest(postData);
				const result = await config.assetMovement.createPersistentForwarding(request);
				const output: KeetaAssetMovementAnchorCreatePersistentForwardingResponse = {
					...result,
					ok: true
				};

				assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse(output);

				return({
					output: JSON.stringify(output)
				});
			}
		}

		if (config.assetMovement.initiateTransfer !== undefined) {
			routes['POST /api/initiateTransfer'] = async function(_ignore_params, postData) {
				if (config.assetMovement.initiateTransfer === undefined) {
					throw(new Error('internal error: initiateTransfer disappeared'));
				}

				const request = assertKeetaAssetMovementAnchorInitiateTransferRequest(postData);
				const result = await config.assetMovement.initiateTransfer(request);
				const output: KeetaAssetMovementAnchorInitiateTransferResponse = {
					...result,
					ok: true
				};

				assertKeetaAssetMovementAnchorInitiateTransferResponse(output);

				return({
					output: JSON.stringify(output)
				});
			}
		}

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

		if (this.assetMovement.createPersistentForwarding !== undefined) {
			operations.createPersistentForwarding = (new URL('/api/createPersistentForwarding', this.url)).toString();
		}
		if (this.assetMovement.initiateTransfer !== undefined) {
			operations.initiateTransfer = (new URL('/api/initiateTransfer', this.url)).toString();
		}
		if (this.assetMovement.getTransferStatus !== undefined) {
			operations.getTransferStatus = (new URL('/api/getTransferStatus/{id}', this.url)).toString();
		}
		if (this.assetMovement.listTransactions !== undefined) {
			operations.listTransactions = (new URL('/api/listTransactions', this.url)).toString();
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
