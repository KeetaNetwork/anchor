import { KeetaNet } from '../../client/index.js';
import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import {
	assertKeetaUsernameAnchorResolveRequest,
	assertKeetaUsernameAnchorClaimRequest,
	getUsernameClaimSignable,
	validateUsernameDefault,
	type KeetaUsernameAnchorResolutionContext,
	type KeetaUsernameAnchorClaimContext,
	Errors
} from './common.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import type { Routes } from '../../lib/http-server/index.ts';
import { KeetaAnchorUserError } from '../../lib/error.js';
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

export interface KeetaAnchorUsernameServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	homepage?: string | (() => Promise<string> | string);
	providerID: string;
	usernames: {
		resolve: (input: KeetaUsernameAnchorResolutionContext) => Promise<InstanceType<typeof KeetaNet.lib.Account> | null> | null;
		claim?: ((input: KeetaUsernameAnchorClaimContext) => Promise<ClaimHandlerResponse>) | undefined;
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

	#assertProviderIssuedNameValid(username: string): void {
		validateUsernameDefault(username, {
			pattern: this.#usernamePattern,
			fieldPath: 'username'
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

		routes['POST /api/resolve'] = async (_params, body) => {
			const request = assertKeetaUsernameAnchorResolveRequest(body);

			this.#assertProviderIssuedNameValid(request.username);

			const resolvedAccount = await this.usernames.resolve({ username: request.username });

			return({
				output: JSON.stringify({
					ok: true,
					account: KeetaNet.lib.Account.toPublicKeyString(resolvedAccount)
				}),
				contentType: 'application/json'
			});
		};

		if (this.usernames.claim) {
			routes['POST /api/claim'] = async (_params, body) => {
				const request = assertKeetaUsernameAnchorClaimRequest(body);

				const username = request.username;

				this.#assertProviderIssuedNameValid(username);
				const account = KeetaNet.lib.Account.fromPublicKeyString(request.account);

				const signable = getUsernameClaimSignable(username, account);
				const verified = await Signing.VerifySignedData(account, signable, request.signed);
				if (!verified) {
					throw(new KeetaAnchorUserError('Invalid username claim signature'));
				}

				const claimHandler = this.usernames.claim;
				if (!claimHandler) {
					throw(new Error('Invariant: claim handler missing'));
				}

				const claimResponse = await claimHandler({
					username: request.username,
					account: account,
					signed: request.signed
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

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['username']>[string]> {
		const resolveURL = (new URL('/api/resolve', this.url)).toString();
		const operations: NonNullable<ServiceMetadata['services']['username']>[string]['operations'] = {
			resolve: resolveURL
		};

		if (this.usernames.claim) {
			operations.claim = {
				url: (new URL('/api/claim', this.url)).toString(),
				options: {
					authentication: {
						method: 'keeta-account',
						type: 'required'
					}
				}
			};
		}

		return({
			operations,
			...(this.#usernamePattern ? { usernamePattern: this.#usernamePattern.source } : {})
		});
	}
}
