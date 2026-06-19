import { expect, test } from 'vitest';

import type { KeetaAnchorAssetMovementServerConfig } from './server.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from './server.js';
import { KeetaNet } from '../../client/index.js';
import { KeetaAnchorUserError, KeetaAnchorError } from '../../lib/error.js';
import { verifyMetadataSignature } from '../../lib/anchor-metadata-server.js';
import { assertHTTPSignedField } from '../../lib/http-server/common.js';
import { Errors, getKeetaAssetMovementAnchorGetAccountStatusRequestSigningData } from './common.js';
import { isKeetaAssetMovementAnchorGetAccountStatusResponse } from './common.generated.js';
import { SignData } from '../../lib/utils/signing.js';

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
		return({ errors: [] });
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

test('Asset Movement Server getAccountStatus returns actionRequired false for a ready account', async function() {
	let observedAccount: string | undefined;

	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeGetAccountStatusConfig(async function(account) {
		observedAccount = account.publicKeyString.get();
		return({ errors: [] });
	}));
	await server.start();

	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const signed = await SignData(account.assertAccount(), getKeetaAssetMovementAnchorGetAccountStatusRequestSigningData());

	const response = await fetch(new URL('/api/getAccountStatus', server.url), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({ account: account.publicKeyString.get(), signed })
	});

	expect(response.status).toBe(200);
	const json: unknown = await response.json();
	/* The ready branch carries no errors array (toEqual, not toMatchObject, verifies the omission) */
	expect(json).toEqual({ ok: true, actionRequired: false });
	expect(observedAccount).toBe(account.publicKeyString.get());
});

test('Asset Movement Server getAccountStatus returns multiple required actions in one ok response', async function() {
	await using server = new KeetaNetAssetMovementAnchorHTTPServer(makeGetAccountStatusConfig(async function(account) {
		return({
			errors: [
				new Errors.KYCShareNeeded({ shareWithPrincipals: [ account ], acceptedIssuers: [] }),
				new Errors.OperationNotSupported({})
			]
		});
	}));
	await server.start();

	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const signed = await SignData(account.assertAccount(), getKeetaAssetMovementAnchorGetAccountStatusRequestSigningData());

	const response = await fetch(new URL('/api/getAccountStatus', server.url), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({ account: account.publicKeyString.get(), signed })
	});

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
		return({ errors: [] });
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
