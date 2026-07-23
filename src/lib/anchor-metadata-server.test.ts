import { test, expect } from 'vitest';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import Resolver from './resolver.js';
import { KeetaAnchorMetadataServer } from './anchor-metadata-server.js';
import type { KeetaAnchorMetadataServerConfig, SignableServiceMetadata } from './anchor-metadata-server.js';
import { addSignatureToURL } from './http-server/common.js';
import { SignData } from './utils/signing.js';
import { createNodeAndClient, setResolverInfo as setInfo } from './utils/tests/node.js';

const EXTERNAL_URL_KEY = '2b828e33-2692-46e9-817e-9b93d63f28fd';

type PublishedServiceMetadata = SignableServiceMetadata & {
	version: 1;
	currencyMap: { [key: string]: never };
	services: { [key: string]: never };
	/** Optional nested external URL, used to verify signing passes through every hop. */
	nested?: unknown;
};

const SERVICE_METADATA = {
	version: 1,
	currencyMap: {},
	services: {},
	operations: {
		createAccount: 'https://example.com/api/v1/createAccount'
	}
} satisfies PublishedServiceMetadata;

interface TestMetadataServerConfig extends KeetaAnchorMetadataServerConfig {
	metadata: PublishedServiceMetadata;
}

/**
 * Minimal concrete {@link KeetaAnchorMetadataServer} that publishes a
 * configurable metadata document and exercises the `GET /serviceMetadata`
 * endpoint and its signature verification.
 */
class TestMetadataServer extends KeetaAnchorMetadataServer<PublishedServiceMetadata, TestMetadataServerConfig> {
	readonly #metadata: PublishedServiceMetadata;

	constructor(config: TestMetadataServerConfig) {
		super(config);

		this.#metadata = config.metadata;
	}

	protected async buildServiceMetadata(): Promise<PublishedServiceMetadata> {
		return(this.#metadata);
	}
}

function makeAccount() {
	return(KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0));
}

type TestAccount = ReturnType<typeof makeAccount>;

/**
 * Sign a `/serviceMetadata` request URL exactly the way the resolver client
 * does: derive the canonical signable, sign it, and attach the signature to
 * the URL query string.
 */
async function signServiceMetadataURL(baseUrl: string, signer: TestAccount): Promise<URL> {
	const url = new URL('/serviceMetadata', baseUrl);
	const signable = Resolver.getExternalURLSignable(url);
	const signed = await SignData(signer.assertAccount(), signable);

	return(addSignatureToURL(url, { signedField: signed, account: signer.assertAccount() }));
}

/**
 * Exercises external-URL signing end-to-end against a single authenticated
 * `serviceMetadataEndpoint`:
 *  - direct requests covering the full verification matrix (valid, missing,
 *    disallowed, tampered, account/signature mismatch), and
 *  - the resolver client signing an external-URL reference to the same endpoint.
 *
 * `allowAccount` is invoked only AFTER the signature is verified, so the
 * captured account tells us whether verification succeeded for a given request.
 */
test('signed serviceMetadata endpoint: verification matrix and resolver round trip', async function() {
	const allowed = makeAccount();
	let allowedAccounts: TestAccount[] = [allowed];
	let verifiedAccount: string | undefined;

	await using server = new TestMetadataServer({
		port: 0,
		metadata: SERVICE_METADATA,
		serviceMetadataEndpoint: {
			expose: true,
			authentication: {
				required: true,
				allowAccount: async function(account) {
					/* Reached only after the signature has been verified */
					verifiedAccount = account.publicKeyString.get();

					return(allowedAccounts.some(function(candidate) { return(account.comparePublicKey(candidate)); }));
				}
			}
		}
	});
	await server.start();

	/* 1. Allowed account with a valid signature -> 200 and the published metadata */
	{
		verifiedAccount = undefined;
		const response = await fetch(await signServiceMetadataURL(server.url, allowed), { headers: { 'Accept': 'application/json' }});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		expect(await response.json()).toEqual(SERVICE_METADATA);
		expect(verifiedAccount).toBe(allowed.publicKeyString.get());
	}

	/* 2. Missing signature -> 404 (allowAccount never reached) */
	{
		verifiedAccount = undefined;
		const response = await fetch(new URL('/serviceMetadata', server.url), { headers: { 'Accept': 'application/json' }});

		expect(response.status).toBe(404);
		expect(verifiedAccount).toBeUndefined();
	}

	/* 3. Valid signature from a disallowed account -> 404 (verified, but rejected by the allowlist) */
	{
		const other = makeAccount();
		verifiedAccount = undefined;
		const response = await fetch(await signServiceMetadataURL(server.url, other), { headers: { 'Accept': 'application/json' }});

		expect(response.status).toBe(404);
		expect(verifiedAccount).toBe(other.publicKeyString.get());
	}

	/* 4. Tampered signature -> 404 (verification fails before allowAccount) */
	{
		verifiedAccount = undefined;
		const requestUrl = await signServiceMetadataURL(server.url, allowed);
		const original = requestUrl.searchParams.get('signed.signature') ?? '';
		requestUrl.searchParams.set('signed.signature', (original.startsWith('A') ? 'B' : 'A') + original.slice(1));

		const response = await fetch(requestUrl, { headers: { 'Accept': 'application/json' }});
		expect(response.status).toBe(404);
		expect(verifiedAccount).toBeUndefined();
	}

	/* 5. Account parameter swapped away from the signer -> 404 (signature/account binding fails) */
	{
		const otherAllowed = makeAccount();
		/* Allowlist both so that only the signature binding can reject the request */
		allowedAccounts = [allowed, otherAllowed];
		verifiedAccount = undefined;

		const requestUrl = await signServiceMetadataURL(server.url, allowed);
		requestUrl.searchParams.set('account', otherAllowed.publicKeyString.get());

		const response = await fetch(requestUrl, { headers: { 'Accept': 'application/json' }});
		expect(response.status).toBe(404);
		expect(verifiedAccount).toBeUndefined();

		allowedAccounts = [allowed];
	}

	/*
	 * 6. Resolver follows a CHAIN of authenticated external URLs.
	 *
	 * A live KeetaNet root account's on-chain metadata is a top-level external
	 * URL pointing at an OUTER endpoint, whose metadata embeds a different
	 * external URL pointing at an INNER endpoint. Both endpoints require
	 * authentication, so the resolver must sign every hop -- including the
	 * nested reference -- for the chain to resolve.
	 */
	{
		let innerVerified: string | undefined;
		await using innerServer = new TestMetadataServer({
			port: 0,
			metadata: SERVICE_METADATA,
			serviceMetadataEndpoint: {
				expose: true,
				authentication: {
					required: true,
					allowAccount: async function(account) {
						innerVerified = account.publicKeyString.get();

						return(account.comparePublicKey(allowed));
					}
				}
			}
		});
		await innerServer.start();

		const outerMetadata = {
			version: 1,
			currencyMap: {},
			services: {},
			operations: { createAccount: 'https://example.com/api/v1/createAccount' },
			nested: {
				external: EXTERNAL_URL_KEY,
				url: new URL('/serviceMetadata', innerServer.url).toString(),
				options: { authentication: { method: 'keeta-account', type: 'required' }}
			}
		} satisfies PublishedServiceMetadata;

		let outerVerified: string | undefined;
		await using outerServer = new TestMetadataServer({
			port: 0,
			metadata: outerMetadata,
			serviceMetadataEndpoint: {
				expose: true,
				authentication: {
					required: true,
					allowAccount: async function(account) {
						outerVerified = account.publicKeyString.get();

						return(account.comparePublicKey(allowed));
					}
				}
			}
		});
		await outerServer.start();

		const rootAccount = makeAccount();
		const { userClient, fees } = await createNodeAndClient(rootAccount);
		fees.disable();

		await setInfo(rootAccount, userClient, {
			external: EXTERNAL_URL_KEY,
			url: new URL('/serviceMetadata', outerServer.url).toString(),
			options: { authentication: { method: 'keeta-account', type: 'required' }}
		});

		const resolver = new Resolver({
			root: rootAccount,
			client: userClient,
			trustedCAs: [],
			metadataConfig: {
				allowInsecureProtocols: true,
				signing: { account: allowed.assertAccount() }
			}
		});
		fees.enable();

		const rootMetadata = await resolver.getRootMetadata();
		const resolved = await Resolver.Metadata.fullyResolveValuizable(rootMetadata);

		/* Every hop -- the outer reference and the nested inner reference -- was signed and verified */
		expect(outerVerified).toBe(allowed.publicKeyString.get());
		expect(innerVerified).toBe(allowed.publicKeyString.get());
		/* The nested external URL resolved to the inner endpoint's published metadata */
		expect(resolved).toEqual({ ...outerMetadata, nested: SERVICE_METADATA });
	}
});
