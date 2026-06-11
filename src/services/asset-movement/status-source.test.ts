import { expect, test } from 'vitest';

import type { AssetLocationString, KeetaAssetMovementTransaction } from './common.js';
import type { ServiceMetadataExternalizable } from '../../lib/resolver.js';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from './server.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { AnchorExternal } from '../../lib/anchor-external.js';
import { AnchorTransactionStatus, isCompletedTransferStatus } from '../../lib/anchor-status.js';
import { BlockListener } from '../../lib/block-listener.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAssetMovementStatusSource from './status-source.js';
import KeetaAssetMovementAnchorClient from './client.js';
import Resolver from '../../lib/resolver.js';

type Account = ReturnType<typeof KeetaNet.lib.Account.fromSeed>;

const EVM_LOCATION: AssetLocationString = 'chain:evm:100';
const EVM_ASSET_ID = 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973';
const EVM_RECIPIENT = 'evm:0x52908400098527886E0F7030069857D2E4169EE7';

function newAccount(): Account {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

/**
 * `true` when a SEND's external field references the given transfer, either
 * as the raw transfer id or as an entry in a decodable plaintext envelope.
 */
async function externalReferencesTransfer(external: unknown, txID: string): Promise<boolean> {
	if (external === txID) {
		return(true);
	}
	if (typeof external !== 'string' || external === '') {
		return(false);
	}

	let decoded;
	try {
		decoded = await AnchorExternal.fromPlainExternal(external);
	} catch {
		return(false);
	}

	return(Object.values(decoded.envelope.anchors).some(function(entry) {
		return('transactionId' in entry && entry.transactionId === txID);
	}));
}

/**
 * The anchor correlates transfers by scanning real on-chain blocks and indexes
 * completions by block hash and operation index so reverse lookups work.
 */
async function createStatusFixture() {
	const rootAccount = newAccount();
	const anchorSigner = newAccount();
	const anchorDepositAccount = newAccount();

	const { userClient: client, fees } = await createNodeAndClient(rootAccount);
	fees.disable();

	const token = client.baseToken;
	const keetaLocation: AssetLocationString = `chain:keeta:${client.network}`;

	const statusMap = new Map<string, KeetaAssetMovementTransaction>();
	const completionIndex = new Map<string, string>();
	const blockListener = new BlockListener({ client: client.client });
	let transferCounter = 0;

	const server = new KeetaNetAssetMovementAnchorHTTPServer({
		metadataSigner: anchorSigner,
		assetMovement: {
			supportedAssets: [{
				asset: token.publicKeyString.get(),
				paths: [{ pair: [
					{ location: keetaLocation, id: token.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
					{ location: EVM_LOCATION, id: EVM_ASSET_ID, rails: { common: [ 'EVM_SEND' ] }}
				] }]
			}],
			initiateTransfer: async function(request) {
				const value = BigInt(request.value);
				const fee = 1n;
				const receive = value - fee;
				transferCounter += 1;
				const txID = `transfer-${transferCounter}`;
				const now = new Date().toISOString();

				statusMap.set(txID, {
					id: txID,
					status: 'PENDING',
					asset: request.asset,
					from: { location: request.from.location, value: value.toString(), transactions: { deposit: null, persistentForwarding: null, finalization: null }},
					to:   { location: request.to.location,   value: receive.toString(), transactions: { withdraw: null }},
					fee: null,
					createdAt: now,
					updatedAt: now
				});

				let listenerHandle: { remove: () => void } | null = null;
				listenerHandle = blockListener.on('block', {
					callback: async function({ block }) {
						const blockHash = block.hash.toString();
						for (let operationIndex = 0; operationIndex < block.operations.length; operationIndex++) {
							const operation = block.operations[operationIndex];
							if (operation?.type === KeetaNet.lib.Block.OperationType.SEND && await externalReferencesTransfer(operation.external, txID)) {
								const existing = statusMap.get(txID);
								if (existing && existing.status !== 'COMPLETE') {
									statusMap.set(txID, { ...existing, status: 'COMPLETE', updatedAt: new Date().toISOString() });
									completionIndex.set(`${blockHash}#${operationIndex}`, txID);
								}
								listenerHandle?.remove();
							}
						}
						return({ requiresWork: false });
					}
				});

				return({
					id: txID,
					instructionChoices: [{
						type: 'KEETA_SEND' as const,
						location: request.from.location,
						sendToAddress: anchorDepositAccount.publicKeyString.get(),
						value: value.toString(),
						tokenAddress: token.publicKeyString.get(),
						assetFee: fee.toString(),
						totalReceiveAmount: receive.toString()
					}]
				});
			},
			getTransferStatus: async function(id) {
				await blockListener.scan();
				const transaction = statusMap.get(id);
				if (!transaction) {
					throw(new KeetaAnchorUserError(`Unknown transfer ID: ${id}`));
				}

				return({ transaction });
			},
			listTransactions: async function(request) {
				await blockListener.scan();
				const transactions: KeetaAssetMovementTransaction[] = [];
				for (const probe of request.transactions ?? []) {
					const txID = completionIndex.get(`${probe.transaction.id}#${probe.transaction.nonce}`);
					if (txID === undefined) {
						continue;
					}

					const transaction = statusMap.get(txID);
					if (transaction) {
						transactions.push(transaction);
					}
				}

				return({ transactions, total: String(transactions.length) });
			}
		}
	});

	await server.start();

	await client.setInfo({
		name: '',
		description: '',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				assetMovement: {
					Test: await server.serviceMetadata()
				}
			}
		} satisfies ServiceMetadataExternalizable)
	});

	const resolver = new Resolver({ root: rootAccount, client, trustedCAs: [] });
	const amClient = new KeetaAssetMovementAnchorClient(client, { resolver });
	const status = new AnchorTransactionStatus(new KeetaAssetMovementStatusSource({ client, resolver }));

	/**
	 * Initiate a real transfer at the anchor over HTTP, keeta -> EVM.
	 */
	async function initiateTransfer(value: bigint) {
		const provider = await amClient.getProviderByAccount(anchorSigner);
		if (provider === null) {
			throw(new Error('Anchor provider did not resolve by its signing account'));
		}

		const transfer = await provider.initiateTransfer({
			asset: { from: token.publicKeyString.get(), to: EVM_ASSET_ID },
			from: { location: keetaLocation },
			to: { location: EVM_LOCATION, recipient: EVM_RECIPIENT },
			value: value
		});

		return(transfer);
	}

	/**
	 * Fund the transfer with a real on-chain SEND carrying a client-built
	 * plaintext envelope.
	 *
	 * @returns The hash of the published send block.
	 */
	async function fundTransfer(transactionId: string, value: bigint): Promise<string> {
		const external = await new AnchorExternal.Builder()
			.setAnchor(anchorSigner, { transactionId })
			.build();

		const published = await client.send(anchorDepositAccount, value, token, external);
		let publishedBlocks;
		if ('blocks' in published) {
			publishedBlocks = published.blocks;
		} else {
			publishedBlocks = published.voteStaple.blocks;
		}

		const sendBlock = publishedBlocks[0];
		if (sendBlock === undefined) {
			throw(new Error('Expected the send to publish a block'));
		}

		return(sendBlock.hash.toString());
	}

	return({
		client,
		token,
		keetaLocation,
		anchorSigner,
		anchorDepositAccount,
		status,
		initiateTransfer,
		fundTransfer,
		[Symbol.asyncDispose]: async function() {
			await server[Symbol.asyncDispose]?.();
		}
	});
}

test('getStatus: live transfer reads PENDING, then COMPLETE once the on-chain send settles', async function() {
	await using fixture = await createStatusFixture();
	const transfer = await fixture.initiateTransfer(5n);

	const pending = await fixture.status.getStatus(fixture.anchorSigner, transfer.transferID);
	expect(pending?.status).toBe('PENDING');
	expect(pending?.transactionID).toBe(transfer.transferID);
	expect(isCompletedTransferStatus(pending?.status ?? '')).toBe(false);

	await fixture.fundTransfer(transfer.transferID, 5n);

	const complete = await fixture.status.getStatus(fixture.anchorSigner, transfer.transferID);
	expect(complete?.status).toBe('COMPLETE');
	expect(isCompletedTransferStatus(complete?.status ?? '')).toBe(true);
	expect(complete?.transaction.id).toBe(transfer.transferID);
});

test.each([
	{ kind: 'plaintext', encrypt: false },
	{ kind: 'encrypted', encrypt: true }
])('getStatusesFromExternal: $kind envelope resolves the live transfer', async function({ encrypt }) {
	await using fixture = await createStatusFixture();
	const recipient = newAccount();
	const transfer = await fixture.initiateTransfer(5n);

	const builder = new AnchorExternal.Builder()
		.setAnchor(fixture.anchorSigner, { transactionId: transfer.transferId });
	if (encrypt) {
		builder.withPrincipals([ recipient ]);
	}

	const external = await builder.build();

	const options: Parameters<typeof fixture.status.getStatusesFromExternal>[1] = {};
	if (encrypt) {
		options.decryptionKeys = [ recipient ];
	}

	const results = await fixture.status.getStatusesFromExternal(external, options);
	const result = results[fixture.anchorSigner.publicKeyString.get()];
	if (result?.kind !== 'status') {
		throw(new Error(`Expected a status result, got ${result?.kind}`));
	}

	expect(result.status.transactionID).toBe(transfer.transferID);
	expect(result.status.status).toBe('PENDING');
});

test('getStatusesFromExternal: entry variants map to unavailable, unresolved, and error', async function() {
	await using fixture = await createStatusFixture();
	const unknownAnchor = newAccount();
	const opaqueAnchor = newAccount();

	const external = await new AnchorExternal.Builder()
		.setAnchor(fixture.anchorSigner, { transactionId: 'no-such-transfer' })
		.setAnchor(unknownAnchor, { transactionId: 'transfer-at-unknown-anchor' })
		.setAnchor(opaqueAnchor, { destination: EVM_RECIPIENT })
		.build();

	const results = await fixture.status.getStatusesFromExternal(external);
	expect(results[fixture.anchorSigner.publicKeyString.get()]?.kind).toBe('error');
	expect(results[unknownAnchor.publicKeyString.get()]?.kind).toBe('unresolved');
	expect(results[opaqueAnchor.publicKeyString.get()]?.kind).toBe('unavailable');
});

test('findByOnChain: resolves the transfer by real on-chain coordinates, null otherwise', async function() {
	await using fixture = await createStatusFixture();
	const transfer = await fixture.initiateTransfer(5n);
	const blockHash = await fixture.fundTransfer(transfer.transferID, 5n);

	const reader = await fixture.status.getReader(fixture.anchorSigner);
	if (reader?.findByOnChain === undefined) {
		throw(new Error('Expected the asset-movement reader to support on-chain lookups'));
	}

	const found = await reader.findByOnChain({
		keetaNetworkID: fixture.client.network,
		blockHash: blockHash,
		operationIndex: 0
	});
	expect(found?.transactionID).toBe(transfer.transferID);
	expect(found?.status).toBe('COMPLETE');

	const missing = await reader.findByOnChain({
		keetaNetworkID: fixture.client.network,
		blockHash: blockHash,
		operationIndex: 7
	});
	expect(missing).toBeNull();
});

test('getReader: an account with no anchor service entry resolves to null', async function() {
	await using fixture = await createStatusFixture();
	const stranger = newAccount();

	const reader = await fixture.status.getReader(stranger);
	expect(reader).toBeNull();
});
