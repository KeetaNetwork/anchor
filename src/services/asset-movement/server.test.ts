import { expect, test } from 'vitest';

import type { KeetaAnchorAssetMovementServerConfig } from './server.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from './server.js';
import { KeetaNet } from '../../client/index.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { verifyMetadataSignature } from '../../lib/anchor-metadata-server.js';
import { assertHTTPSignedField } from '../../lib/http-server/common.js';

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
