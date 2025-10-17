import { expect, test } from 'vitest';
import { KeetaNetAssetMovementAnchorHTTPServer } from './server.js';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { KeetaAnchorUserError } from '../../lib/error.js';

test('FX Server Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client } = await createNodeAndClient(account);

	const xxx = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	await using server = new KeetaNetAssetMovementAnchorHTTPServer({
		client: client,
		assetMovement: {
			supportedAssets: [{
				asset: xxx.publicKeyString.get(),
				paths: [{
					pair: [{
						id: 'foo',
						location: 'xxx',
						rails: { inbound: [ 'KEETA_SEND' ] }
					}, {
						id: 'bar',
						location: 'yyy',
						rails: { outbound: [ 'KEETA_SEND' ] }
					}]
				}]
			}],
			createPersistentForwarding: async function(_ignore_request) {
				// TODO
				throw(new KeetaAnchorUserError('not implemented'));
			}
		}
	});

	await server.start();
	const url = server.url;
	expect(url).toBeDefined();

	expect(await server.serviceMetadata()).toBeDefined();

	/* XXX:TODO: Tests */
});
