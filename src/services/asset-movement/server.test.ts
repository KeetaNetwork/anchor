import { expect, test } from 'vitest';

import type { KeetaAnchorAssetMovementServerConfig } from './server.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from './server.js';
import { KeetaNet } from '../../client/index.js';
import { KeetaAnchorUserError, KeetaAnchorError } from '../../lib/error.js';
import { verifyMetadataSignature } from '../../lib/anchor-metadata-server.js';
import { assertHTTPSignedField } from '../../lib/http-server/common.js';
import { Errors, getKeetaAssetMovementAnchorGetAccountStatusRequestSigningData } from './common.js';
import { isKeetaAssetMovementAnchorGetAccountStatusResponse } from './common.generated.js';
import { signRequest } from '../../lib/http-server/request-signing.js';

function makeServerConfig(overrides: Partial<KeetaAnchorAssetMovementServerConfig> = {}): KeetaAnchorAssetMovementServerConfig {
	const asset = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	return({
		assetMovement: {
			supportedAssets: [{
				asset: asset.publicKeyString.get(),
				paths: [{
					pair: [{
						id: 'evm:0xFooBar',
						location: 'chain:evm:123',
						rails: { inbound: [ 'KEETA_SEND' ] }
					}, {
						id: asset.publicKeyString.get(),
						location: 'chain:keeta:123',
						rails: { outbound: [ 'KEETA_SEND' ] }
					}]
				}]
			}],
			createPersistentForwarding: async function(_ignore_request) {
				// TODO
				throw(new KeetaAnchorUserError('not implemented'));
			}
		},
		...overrides
	});
}

test('Asset Movement Server Tests', async function() {
	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeServerConfig());

	await server.start();
	const url = server.url;
	expect(url).toBeDefined();

	const metadata = await server.serviceMetadata();
	expect(metadata).toBeDefined();
	expect(metadata.account).toBeUndefined();
	expect(metadata.signed).toBeUndefined();

	/* XXX:TODO: Tests */
});

test('Asset Movement Server publishes path-parameter operations with literal placeholders', async function() {
	const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();

	const baseConfig = makeServerConfig({ metadataSigner: signer });
	const config: KeetaAnchorAssetMovementServerConfig = {
		...baseConfig,
		assetMovement: {
			...baseConfig.assetMovement,
			/**
			 * Stub out the getTransferStatus and executeTransfer operations
			 * as they are not used but must be present for the server to start.
			 */
			getTransferStatus: async function() { throw(new KeetaAnchorUserError('not implemented')); },
			executeTransfer: async function() { throw(new KeetaAnchorUserError('not implemented')); }
		}
	};

	await using server = new KeetaNetAssetMovementAnchorHTTPServer(config);
	await server.start();

	const { operations } = await server.serviceMetadata();
	for (const endpoint of [ operations.getTransferStatus, operations.executeTransfer ]) {
		expect(endpoint).toContain('{id}');
		expect(endpoint).not.toContain('%7B');
	}
});

test('Asset Movement Server signs metadata when metadataSigner is configured', async function() {
	const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();

	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeServerConfig({ metadataSigner: signer }));
	await server.start();

	const metadata = await server.serviceMetadata();
	expect(metadata.account).toBe(signer.publicKeyString.get());

	const signed = assertHTTPSignedField(metadata.signed);
	const valid = await verifyMetadataSignature(signer, metadata, signed);
	expect(valid).toBe(true);
});

function makeGetAccountStatusConfig(getAccountStatus: NonNullable<NonNullable<KeetaAnchorAssetMovementServerConfig['assetMovement']>['getAccountStatus']>): KeetaAnchorAssetMovementServerConfig {
	const base = makeServerConfig();

	return({
		...base,
		assetMovement: {
			...base.assetMovement,
			getAccountStatus
		}
	});
}

test('Asset Movement Server publishes getAccountStatus with required authentication', async function() {
	/* Note: authenticationRequired is NOT set, yet getAccountStatus must still require auth */
	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeGetAccountStatusConfig(async function() {
		return({ actionRequired: false })
	}));
	await server.start();

	const { operations } = await server.serviceMetadata();
	const endpoint = operations.getAccountStatus;

	expect(endpoint).toBeDefined();
	if (typeof endpoint !== 'object') {
		throw(new Error('Expected getAccountStatus to be published with authentication options'));
	}

	expect(endpoint.url).toContain('/api/getAccountStatus');
	expect(endpoint.options?.authentication).toEqual({ method: 'keeta-account', type: 'required' });
});

/**
 * Sign a getAccountStatus request for `serverURL`, and return a function
 * that sends it
 */
async function signedAccountStatusRequest(serverURL: string, account: InstanceType<typeof KeetaNet.lib.Account>): Promise<() => Promise<Response>> {
	const url = new URL('/api/getAccountStatus', serverURL);
	const body = { account: account.publicKeyString.get() };
	const signed = await signRequest(account.assertAccount(), { method: 'POST', url, body }, getKeetaAssetMovementAnchorGetAccountStatusRequestSigningData());

	return(async function() {
		return(await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ ...body, signed })
		}));
	});
}

test('Asset Movement Server getAccountStatus returns actionRequired false for a ready account', async function() {
	let observedAccount: string | undefined;

	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeGetAccountStatusConfig(async function(account) {
		observedAccount = account.publicKeyString.get();
		return({ actionRequired: false })
	}));
	await server.start();

	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const sendSignedRequest = await signedAccountStatusRequest(server.url, account);

	const response = await sendSignedRequest();

	expect(response.status).toBe(200);
	const json: unknown = await response.json();
	/* The ready branch carries no errors array (toEqual, not toMatchObject, verifies the omission) */
	expect(json).toEqual({ ok: true, actionRequired: false });
	expect(observedAccount).toBe(account.publicKeyString.get());

	/* The same signed request is refused when replayed */
	observedAccount = undefined;
	const replayed = await sendSignedRequest();
	expect(replayed.status).toBeGreaterThanOrEqual(400);
	expect(observedAccount).toBeUndefined();
});

test('Asset Movement Server getAccountStatus returns multiple required actions in one ok response', async function() {
	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeGetAccountStatusConfig(async function(account) {
		return({
			actionRequired: true,
			errors: [
				new Errors.KYCShareNeeded({ shareWithPrincipals: [ account ], acceptedIssuers: [] }),
				new Errors.OperationNotSupported({})
			]
		});
	}));
	await server.start();

	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const sendSignedRequest = await signedAccountStatusRequest(server.url, account);

	const response = await sendSignedRequest();

	expect(response.status).toBe(200);
	const json: unknown = await response.json();

	expect(json).toMatchObject({
		ok: true,
		actionRequired: true,
		errors: [
			{ name: 'KeetaAssetMovementAnchorKYCShareNeededError', code: 'KEETA_ANCHOR_ASSET_MOVEMENT_KYC_SHARE_NEEDED' },
			{ name: 'KeetaAssetMovementAnchorOperationNotSupportedError', code: 'KEETA_ANCHOR_ASSET_MOVEMENT_OPERATION_NOT_SUPPORTED' }
		]
	});

	/* Each entry rehydrates back into its typed error (the same path the client uses) */
	if (!isKeetaAssetMovementAnchorGetAccountStatusResponse(json) || !json.ok || !json.actionRequired) {
		throw(new Error('Expected an action-required getAccountStatus response'));
	}

	const rehydrated = await Promise.all(json.errors.map(function(entry) {
		return(KeetaAnchorError.fromJSON(entry));
	}));

	expect(rehydrated[0]).toBeInstanceOf(Errors.KYCShareNeeded);
	expect(rehydrated[1]).toBeInstanceOf(Errors.OperationNotSupported);
});

test('Asset Movement Server getAccountStatus rejects unauthenticated requests', async function() {
	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeGetAccountStatusConfig(async function() {
		return({ actionRequired: false });
	}));
	await server.start();

	const response = await fetch(new URL('/api/getAccountStatus', server.url), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({})
	});

	expect(response.ok).toBe(false);
	const json: unknown = await response.json();
	expect(json).toMatchObject({ ok: false });
});

test('Asset Movement Server accepts share-KYC bodies over the 1 MiB default and refuses them elsewhere', async function() {
	const baseConfig = makeServerConfig();
	await using server = new KeetaNetAssetMovementAnchorHTTPServer({
		...baseConfig,
		assetMovement: {
			...baseConfig.assetMovement,
			shareKYC: async function() { throw(new KeetaAnchorUserError('not implemented')); },
			initiateTransfer: async function() { throw(new KeetaAnchorUserError('not implemented')); }
		}
	});
	await server.start();

	const body = JSON.stringify({ attributes: 'x'.repeat(2 * 1024 * 1024) });
	async function post(path: string): Promise<number> {
		const response = await fetch(new URL(path, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
		await response.arrayBuffer();
		return(response.status);
	}

	expect(await post('/api/shareKYC')).not.toBe(413);
	expect(await post('/api/initiateTransfer')).toBe(413);
});

test('Asset Movement Server refuses a request that names an account without signing for it', async function() {
	const asset = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const victim = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const accountsSeen: unknown[] = [];

	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeServerConfig({
		assetMovement: {
			...makeServerConfig().assetMovement,
			createPersistentForwarding: async function(request) {
				accountsSeen.push(request.account);
				throw(new KeetaAnchorUserError('not implemented'));
			}
		}
	}));
	await server.start();

	const response = await fetch(new URL('/api/createPersistentForwarding', server.url), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: victim.publicKeyString.get(),
			sourceLocation: 'chain:evm:123',
			asset: asset.publicKeyString.get(),
			persistentAddressTemplateId: 'template-1'
		})
	});

	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(response.status).toBeLessThan(500);
	expect(accountsSeen).toEqual([]);
});
