import { KeetaNet } from '../../client/index.js';
import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import type {
	KeetaUsernameAnchorUsernameResolutionContext,
	KeetaUsernameAnchorAccountResolutionContext,
	KeetaUsernameAnchorClaimRequest,
	KeetaUsernameAnchorReleaseRequest,
	KeetaUsernameAnchorSearchRequestParameters,
	KeetaUsernameAnchorUsernameWithAccount,
	KeetaUsernameAnchorSearchResponseJSON } from './common.js';
import {
	getUsernameClaimSignable,
	validateUsernameDefault,
	type KeetaUsernameAnchorClaimContext,
	Errors,
	isKeetaNetPublicKeyString,
	assertKeetaUsernameAnchorClaimRequestJSON,
	getUsernameTransferSignable,
	assertKeetaUsernameAnchorReleaseRequestJSON,
	getUsernameReleaseSignable
} from './common.js';
import type { ServiceMetadata, ServiceMetadataAuthenticationType } from '../../lib/resolver.ts';
import type { Routes } from '../../lib/http-server/index.ts';
import { KeetaAnchorUserError, KeetaAnchorUserValidationError } from '../../lib/error.js';
import * as Signing from '../../lib/utils/signing.js';

function normalizeUsernamePattern(pattern: string | RegExp): RegExp {
	if (typeof pattern === 'string') {
		try {
			return(new RegExp(pattern));
		} catch (error) {
			throw(new Error(`Invalid usernamePattern regex: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	if (pattern.flags !== '') {
		throw(new Error('usernamePattern RegExp must not specify flags')); // Flags cannot be reliably shared via metadata string
	}

	return(new RegExp(pattern.source));
}

type ClaimHandlerResponse = { ok: true; } | { ok: false; taken?: false; } | { ok: false; taken: true; };
type SearchHandlerResponse = { results: KeetaUsernameAnchorUsernameWithAccount[] };

export interface KeetaAnchorUsernameServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	homepage?: string | (() => Promise<string> | string);
	providerID: string;
	usernames: {
		resolveUsername: (input: KeetaUsernameAnchorUsernameResolutionContext) => Promise<{ account: InstanceType<typeof KeetaNet.lib.Account>; } | null>;
		resolveAccount: (input: KeetaUsernameAnchorAccountResolutionContext) => Promise<{ username: string; } | null>;

		releaseUsername?: (input: { account: InstanceType<typeof KeetaNet.lib.Account>; }) => Promise<{ ok: boolean; }>;
		claim?: ((input: KeetaUsernameAnchorClaimContext) => Promise<ClaimHandlerResponse>);

		search?: ((input: KeetaUsernameAnchorSearchRequestParameters) => Promise<SearchHandlerResponse>);
	};
	routes?: Routes;
	usernamePattern?: string | RegExp;
}

export class KeetaNetUsernameAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorUsernameServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorUsernameServerConfig['homepage']>;
	readonly usernames: KeetaAnchorUsernameServerConfig['usernames'];
	readonly providerID: string;
	readonly routes: NonNullable<KeetaAnchorUsernameServerConfig['routes']>;
	readonly #usernamePattern?: RegExp;

	constructor(config: KeetaAnchorUsernameServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.usernames = config.usernames;
		this.providerID = config.providerID;
		this.routes = config.routes ?? {};
		if (config.usernamePattern !== undefined) {
			this.#usernamePattern = normalizeUsernamePattern(config.usernamePattern);
		}
	}

	#assertProviderIssuedNameValid(username: string, fieldPath = 'username'): void {
		validateUsernameDefault(username, {
			pattern: this.#usernamePattern,
			fieldPath: fieldPath
		});
	}

	protected async initRoutes(config: KeetaAnchorUsernameServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = { ...this.routes };

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
					contentType: 'text/html; charset=utf-8'
				});
			};
		}

		routes['GET /api/resolve/:toResolve'] = async (params) => {
			let toResolve = params.get('toResolve');
			if (!toResolve) {
				throw(new KeetaAnchorUserError('Missing toResolve parameter'));
			}

			let resolution;
			let account = null;
			let username = null;
			if (isKeetaNetPublicKeyString(toResolve)) {
				account = KeetaNet.lib.Account.fromPublicKeyString(toResolve);
				resolution = await this.usernames.resolveAccount({ account });
			} else {
				try {
					toResolve = decodeURIComponent(toResolve);
				} catch {
					throw(new KeetaAnchorUserValidationError({
						fields: [
							{
								path: 'toResolve',
								message: 'toResolve parameter is not a valid URI component',
								receivedValue: toResolve
							}
						]
					}));
				}

				this.#assertProviderIssuedNameValid(toResolve);
				username = toResolve;
				resolution = await this.usernames.resolveUsername({ username });
			}

			if (!resolution) {
				throw(new Errors.UserNotFound({ username: username ?? undefined, account: account ?? undefined }));
			}

			if ('account' in resolution) {
				if (account !== null && !(account.comparePublicKey(resolution.account))) {
					throw(new Error('internal: Resolved account does not match requested account'));
				}

				account = resolution.account;
			}

			if ('username' in resolution) {
				if (username !== null && username !== resolution.username) {
					throw(new Error('internal: Resolved username does not match requested username'));
				}

				username = resolution.username;
			}

			if (!account || !username) {
				throw(new Error('internal: We should know both the account and username here'));
			}

			return({
				output: JSON.stringify({
					ok: true,
					account: KeetaNet.lib.Account.toPublicKeyString(account),
					username: username
				}),
				contentType: 'application/json'
			});
		};

		const claimHandler = this.usernames.claim;
		if (claimHandler) {
			routes['POST /api/claim'] = async (_params, body) => {

				const request: KeetaUsernameAnchorClaimRequest = (() => {
					const raw = assertKeetaUsernameAnchorClaimRequestJSON(body);

					const ret: KeetaUsernameAnchorClaimRequest = {
						username: raw.username,
						account: KeetaNet.lib.Account.toAccount(raw.account),
						signed: raw.signed
					};

					if (raw.transfer) {
						ret.transfer = {
							from: KeetaNet.lib.Account.toAccount(raw.transfer.from),
							signed: raw.transfer.signed
						};
					}

					return(ret);
				})();

				const username = request.username;

				this.#assertProviderIssuedNameValid(username);

				if (request.transfer) {
					const transferSignable = getUsernameTransferSignable({
						username: request.username,
						from: request.transfer.from,
						to: request.account
					});

					const verifiedTransfer = await Signing.VerifySignedData(request.transfer.from, transferSignable, request.transfer.signed);

					if (!verifiedTransfer) {
						throw(new KeetaAnchorUserError('Invalid username claim transfer signature'));
					}
				}

				const verified = await Signing.VerifySignedData(request.account, getUsernameClaimSignable(request), request.signed);
				if (!verified) {
					throw(new KeetaAnchorUserError('Invalid username claim signature'));
				}

				const claimResponse = await claimHandler({
					username: request.username,
					account: request.account,
					fromUser: request.transfer?.from ?? null
				});

				if (!claimResponse.ok) {
					if (claimResponse.taken) {
						throw(new Errors.UsernameAlreadyTaken({ username }));
					} else {
						throw(new KeetaAnchorUserError('Username claim rejected'));
					}
				}

				return({
					output: JSON.stringify({ ok: true }),
					contentType: 'application/json'
				});
			};
		}

		const releaseHandler = this.usernames.releaseUsername;
		if (releaseHandler) {
			routes['POST /api/release'] = async (_params, body) => {
				const request: KeetaUsernameAnchorReleaseRequest = (() => {
					const raw = assertKeetaUsernameAnchorReleaseRequestJSON(body);

					return({
						account: KeetaNet.lib.Account.toAccount(raw.account),
						signed: raw.signed
					});
				})();


				const verified = await Signing.VerifySignedData(request.account, getUsernameReleaseSignable(request), request.signed);
				if (!verified) {
					throw(new KeetaAnchorUserError('Invalid username claim signature'));
				}

				const releaseResponse = await releaseHandler({ account: request.account });

				if (!releaseResponse.ok) {
					throw(new KeetaAnchorUserError('Release claim rejected'));
				}

				return({
					output: JSON.stringify({ ok: true }),
					contentType: 'application/json'
				});
			};
		}

		const searchHandler = this.usernames.search;
		if (searchHandler) {
			routes['GET /api/search'] = async (_ignore_params, _ignore_body, _ignore_headers, url) => {
				const request: KeetaUsernameAnchorSearchRequestParameters = (() => {
					const searchParameter = url.searchParams.get('search');

					if (!searchParameter) {
						throw(new KeetaAnchorUserValidationError({
							fields: [
								{
									path: 'search',
									message: 'Missing search parameter',
									receivedValue: searchParameter
								}
							]
						}));
					}

					this.#assertProviderIssuedNameValid(searchParameter, 'search');

					return({ search: searchParameter });
				})();

				const searchResponse = await searchHandler(request);

				const formatted: KeetaUsernameAnchorSearchResponseJSON = {
					ok: true,
					results: searchResponse.results.map(function(result) {
						return({
							username: result.username,
							account: result.account.publicKeyString.get()
						});
					})
				}

				return({
					output: JSON.stringify(formatted),
					contentType: 'application/json'
				});
			};
		}


		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['username']>[string]> {
		const operations: NonNullable<ServiceMetadata['services']['username']>[string]['operations'] = {
			resolve: (new URL('/api/resolve/{toResolve}', this.url)).toString()
		};

		const authentication: ServiceMetadataAuthenticationType = {
			method: 'keeta-account',
			type: 'required'
		}

		if (this.usernames.claim) {
			operations.claim = {
				url: (new URL('/api/claim', this.url)).toString(),
				options: { authentication }
			};
		}

		if (this.usernames.releaseUsername) {
			operations.release = {
				url: (new URL('/api/release', this.url)).toString(),
				options: { authentication }
			};
		}

		if (this.usernames.search) {
			operations.search = { url: (new URL('/api/search', this.url)).toString() };
		}

		return({
			operations,
			...(this.#usernamePattern ? { usernamePattern: this.#usernamePattern.source } : {})
		});
	}
}
