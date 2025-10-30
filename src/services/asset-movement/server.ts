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
	KeetaAssetMovementAnchorGetTransferStatusResponse,
	KeetaAssetMovementAnchorlistTransactionsRequest,
	KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
	KeetaAssetMovementAnchorListPersistentForwardingRequest,
	KeetaAssetMovementAnchorListPersistentForwardingResponse,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest,
	KeetaAssetMovementAnchorListForwardingAddressTemplateRequest,
	KeetaAssetMovementAnchorListForwardingAddressTemplateResponse
} from './common.ts';
import {
	assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	assertKeetaAssetMovementAnchorInitiateTransferRequest,
	assertKeetaAssetMovementAnchorInitiateTransferResponse,
	assertKeetaAssetMovementAnchorGetTransferStatusResponse,
	assertKeetaAssetMovementAnchorlistTransactionsRequest,
	assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
	assertKeetaAssetMovementAnchorListPersistentForwardingRequest,
	assertKeetaAssetMovementAnchorListPersistentForwardingResponse,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
	getKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequestSigningData,
	assertKeetaAssetMovementAnchorListForwardingAddressTemplateRequest,
	assertKeetaAssetMovementAnchorListForwardingAddressTemplateResponse,
	getKeetaAssetMovementAnchorListForwardingAddressTemplateRequestSigningData
} from './common.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import type { Signable } from '../../lib/utils/signing.js';
import { VerifySignedData } from '../../lib/utils/signing.js';
import type Account from '@keetanetwork/keetanet-client/lib/account.js';
import type { HTTPSignedFieldURLParameters } from '../../lib/http-server-shared.js';
import { assertHTTPSignedField, parseSignatureFromURL } from '../../lib/http-server-shared.js';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';

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
		getTransferStatus?: (id: string, account: Account.Account | null) => Promise<ExtractOk<KeetaAssetMovementAnchorGetTransferStatusResponse>>;

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
			SerializedRequest extends { [key: string]: unknown } | undefined,
			Response
		>(input: {
			method: 'GET' | 'POST';
			handlerName: HandlerName;
			pathName?: string;
			assertRequest?: (data: unknown) => SerializedRequest;
			serializeResponse?: (data: Response) => unknown;
			assertResponse: (data: unknown) => Response;
			getSigningData?: (data: SerializedRequest, params: Map<string, string>) => Signable;
			parseRequestToArgs?: (params: {
				params: Map<string, string>;
				body: JSONSerializable | SerializedRequest | undefined,
				url: URL,
				account: Account.Account | null
				// Typescript needs any here, but eslint does not like it
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			}) => NonNullable<KeetaAnchorAssetMovementServerConfig['assetMovement'][HandlerName]> extends (...args: infer R extends any[]) => any ? R : never;
			getSignatureFieldAccountFromRequest?: (params: { body: JSONSerializable | undefined, url: URL }) => HTTPSignedFieldURLParameters;
		}) {
			const handler = config.assetMovement[input.handlerName];
			if (handler === undefined) {
				return;
			}

			if (typeof handler !== 'function') {
				throw(new Error(`internal error: handler for ${String(input.handlerName)} is not a function`));
			}

			const authenticationRequired = config.assetMovement.authenticationRequired === true;

			routes[`${input.method} /api/${input.pathName ?? input.handlerName}`] = async function(params, postData, _ignore_headers, url) {
				let request: SerializedRequest;
				if (input.method === 'GET') {
					// For GET requests, we do not expect a body
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					request = undefined as SerializedRequest;
				} else {
					if (!input.assertRequest) {
						throw(new Error('input.assertRequest is required when method = POST'));
					}
					request = input.assertRequest(postData);
				}

				let account: Account.Account | null = null;
				if (authenticationRequired || (request && 'signed' in request)) {
					let signed;
					if (input.getSignatureFieldAccountFromRequest !== undefined) {
						const parsed = input.getSignatureFieldAccountFromRequest({ body: postData, url })

						if (!parsed.account || !parsed.signedField) {
							throw(new KeetaAnchorUserError('Missing authentication information'));
						}

						account = parsed.account;
						signed = parsed.signedField;
					} else if (request) {
						if (!('account' in request) || !('signed' in request)) {
							throw(new KeetaAnchorUserError('Missing authentication information'));
						}

						if (typeof request.account !== 'string') {
							throw(new KeetaAnchorUserError('Invalid account public key'));
						}

						account = KeetaNet.lib.Account.fromPublicKeyString(request.account).assertAccount();
						signed = assertHTTPSignedField(request.signed);
					} else {
						throw(new Error('when request is not defined, getSignatureFieldAccountFromRequest must be'))
					}


					const signable = input.getSigningData ? input.getSigningData(request, params) : [];

					const valid = await VerifySignedData(account, signable, signed);

					if (!valid) {
						throw(new KeetaAnchorUserError('Invalid signature'));
					}
				}

				let parsedRequest;
				if (input.parseRequestToArgs) {
					parsedRequest = input.parseRequestToArgs({ body: request, params, url, account: account ?? null });
				} else {
					parsedRequest = request;
				}

				// @ts-ignore
				const result = await handler(...parsedRequest);

				const resp = input.assertResponse(result);

				let serialized;
				if (input.serializeResponse) {
					serialized = input.serializeResponse(resp);
				} else {
					serialized = resp;
				}

				if (typeof serialized !== 'object' || serialized === null) {
					throw(new Error('internal error: response serialization must be an object'));
				}

				if ('ok' in serialized && (serialized.ok !== undefined || serialized.ok !== true)) {
					throw(new Error('internal error: response serialization must not have ok field'));
				}

				return({
					output: JSON.stringify({ ...serialized, ok: true })
				});
			}
		}

		addRoute({
			method: 'POST',
			handlerName: 'createPersistentForwarding',
			assertRequest: assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest,
			assertResponse: assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse
		});

		addRoute({
			method: 'POST',
			handlerName: 'listPersistentForwarding',
			assertRequest: assertKeetaAssetMovementAnchorListPersistentForwardingRequest,
			assertResponse: assertKeetaAssetMovementAnchorListPersistentForwardingResponse
		});

		addRoute({
			method: 'POST',
			handlerName: 'initiateTransfer',
			assertRequest: assertKeetaAssetMovementAnchorInitiateTransferRequest,
			assertResponse: assertKeetaAssetMovementAnchorInitiateTransferResponse
		});

		addRoute({
			method: 'GET',
			handlerName: 'getTransferStatus',
			pathName: 'getTransferStatus/:id',
			assertRequest: (input) => {
				if (input !== undefined) {
					throw(new KeetaAnchorUserError('No body expected for getTransferStatus'));
				}

				return(undefined);
			},
			assertResponse: assertKeetaAssetMovementAnchorGetTransferStatusResponse,
			getSignatureFieldAccountFromRequest: ({ url }) => parseSignatureFromURL(url),
			parseRequestToArgs: ({ params, account }) => {
				const id = params.get('id');
				if (typeof id !== 'string' || id.length === 0) {
					throw(new KeetaAnchorUserError('Missing or invalid id parameter'));
				}

				return([ id, account ] as const);
			}
		});

		addRoute({
			method: 'POST',
			handlerName: 'listTransactions',
			assertRequest: assertKeetaAssetMovementAnchorlistTransactionsRequest,
			assertResponse: assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse
		});

		addRoute({
			method: 'POST',
			handlerName: 'createPersistentForwardingTemplate',
			assertRequest: assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest,
			assertResponse: assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
			getSigningData: getKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequestSigningData
		});

		addRoute({
			method: 'POST',
			handlerName: 'listPersistentForwardingTemplate',
			assertRequest: assertKeetaAssetMovementAnchorListForwardingAddressTemplateRequest,
			assertResponse: assertKeetaAssetMovementAnchorListForwardingAddressTemplateResponse,
			getSigningData: getKeetaAssetMovementAnchorListForwardingAddressTemplateRequestSigningData
		});

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['assetMovement']>[string]> {
		const operations: NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations'] = {};

		const routes = [
			'initiateTransfer',
			'listTransactions',
			'listTransactions',
			// XXX:TODO these two should be done later
			'createPersistentForwardingTemplate',
			'listPersistentForwardingTemplate',
			'createPersistentForwarding',
			'listPersistentForwarding',
			[ 'getTransferStatus', 'getTransferStatus/{id}' ]
		] as const satisfies ((keyof typeof operations) | [ keyof typeof operations, string ])[];

		for (const inp of routes) {
			let op;
			let url;
			if (Array.isArray(inp)) {
				op = inp[0];
				url = inp[1];
			} else {
				op = inp;
				url = inp;
			}

			if (this.assetMovement[op] !== undefined) {
				operations[op] = (new URL(`/api/${url}`, this.url)).toString();
			}
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
