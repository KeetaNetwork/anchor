import { test, expect } from 'vitest';
import { KeetaNet } from '../client/index.js';
import { createNodeAndClient } from './utils/tests/node.js';
import Resolver from './resolver.js';
import type { ServiceMetadataExternalizable } from './resolver.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from '../services/asset-movement/server.js';
import type { KeetaAssetMovementTransaction, TransactionStatus } from '../services/asset-movement/common.js';
import { AnchorTransactionStatus, isCompletedTransferStatus } from './anchor-status.js';
import KeetaAssetMovementStatusSource from '../services/asset-movement/status-source.js';
import { AnchorExternalBuilder } from './anchor-external.js';
import { assertEncodedAnchorExternalEnvelopeV2 } from './anchor-external.generated.js';
import { canonicalizeJson } from './utils/signing.js';

const completedCases: { status: TransactionStatus; completed: boolean }[] = [
	{ status: 'COMPLETE', completed: true },
	{ status: 'PENDING', completed: false },
	{ status: 'FAILED_VALUE_TOO_LOW', completed: false }
];

test.each(completedCases)('isCompletedTransferStatus($status) is $completed', function({ status, completed }) {
	expect(isCompletedTransferStatus(status)).toBe(completed);
});

/*
 * The settled `tx-1` outcome the fixture server always returns.
 */
function completeStatusResult(transaction: KeetaAssetMovementTransaction) {
	return({
		kind: 'status',
		status: { status: 'COMPLETE', transactionId: 'tx-1', transaction }
	});
}

async function startStatusFixture(authenticationRequired: boolean) {
	const rootAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const anchorAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const strangerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { userClient, fees } = await createNodeAndClient(rootAccount);
	fees.disable();

	const baseToken = userClient.baseToken;
	const now = (new Date()).toISOString();

	const observed: { id?: string; accountKey?: string | null } = {};

	const transaction: KeetaAssetMovementTransaction = {
		id: 'tx-1',
		status: 'COMPLETE',
		asset: baseToken.publicKeyString.get(),
		from: {
			location: 'chain:evm:100',
			value: '100',
			transactions: { persistentForwarding: null, deposit: null, finalization: null }
		},
		to: {
			location: 'chain:keeta:123',
			value: '100',
			transactions: { withdraw: null }
		},
		fee: null,
		createdAt: now,
		updatedAt: now
	};

	const server = new KeetaNetAssetMovementAnchorHTTPServer({
		metadataSigner: anchorAccount,
		assetMovement: {
			authenticationRequired: authenticationRequired,
			supportedAssets: [
				{
					asset: baseToken.publicKeyString.get(),
					paths: [
						{
							pair: [
								{ location: 'chain:keeta:123', id: baseToken.publicKeyString.get(), rails: { common: [ { rail: 'KEETA_SEND' } ] }},
								{ location: 'chain:evm:100', id: 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }}
							]
						}
					]
				}
			],
			getTransferStatus: async function(id, account) {
				observed.id = id;
				if (account === null) {
					observed.accountKey = null;
				} else {
					observed.accountKey = account.publicKeyString.get();
				}

				return({ transaction });
			}
		}
	});

	await server.start();

	await userClient.setInfo({
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

	fees.enable();

	const resolver = new Resolver({ root: rootAccount, client: userClient, trustedCAs: [] });
	const source = new KeetaAssetMovementStatusSource({ client: userClient, resolver });
	const anchorStatus = new AnchorTransactionStatus(source);

	return({ server, anchorStatus, rootAccount, anchorAccount, strangerAccount, transaction, observed });
}

test('AnchorTransactionStatus resolves a provider by account and reads canonical status', async function() {
	const fixture = await startStatusFixture(false);
	await using server = fixture.server;
	void server;

	const reader = await fixture.anchorStatus.getReader(fixture.anchorAccount.publicKeyString.get());
	expect(reader).not.toBeNull();

	const missing = await fixture.anchorStatus.getReader(fixture.strangerAccount.publicKeyString.get());
	expect(missing).toBeNull();

	const status = await fixture.anchorStatus.getStatus(fixture.anchorAccount.publicKeyString.get(), 'tx-1');
	expect(status).toEqual(completeStatusResult(fixture.transaction).status);
	expect(fixture.observed.id).toBe('tx-1');
	expect(fixture.observed.accountKey).toBeNull();

	const unresolved = await fixture.anchorStatus.getStatus(fixture.strangerAccount.publicKeyString.get(), 'tx-1');
	expect(unresolved).toBeNull();

	const statusResult = completeStatusResult(fixture.transaction);

	const external = await new AnchorExternalBuilder()
		.addAnchor(fixture.anchorAccount, { transactionId: 'tx-1' })
		.addAnchor(fixture.strangerAccount, { transactionId: 'tx-2' })
		.addAnchor(fixture.rootAccount, { persistentForwardingId: 'fwd-1' })
		.build();

	const statuses = await fixture.anchorStatus.getStatusesFromExternal(external);
	expect(statuses[fixture.anchorAccount.publicKeyString.get()]).toEqual(statusResult);
	expect(statuses[fixture.strangerAccount.publicKeyString.get()]).toEqual({ kind: 'unresolved' });
	expect(statuses[fixture.rootAccount.publicKeyString.get()]).toEqual({ kind: 'unavailable' });

	const encryptedExternal = await new AnchorExternalBuilder()
		.addAnchor(fixture.anchorAccount, { transactionId: 'tx-1' }, { encryptFor: [fixture.anchorAccount] })
		.build();

	const opaque = await fixture.anchorStatus.getStatusesFromExternal(encryptedExternal);
	expect(opaque[fixture.anchorAccount.publicKeyString.get()]).toEqual({ kind: 'unavailable' });

	const opened = await fixture.anchorStatus.getStatusesFromExternal(encryptedExternal, { decryptionKeys: [fixture.anchorAccount] });
	expect(opened[fixture.anchorAccount.publicKeyString.get()]).toEqual(statusResult);
});

test('AnchorTransactionStatus forwards the requester account when the provider requires authentication', async function() {
	const fixture = await startStatusFixture(true);
	await using server = fixture.server;
	void server;

	const status = await fixture.anchorStatus.getStatus(fixture.anchorAccount.publicKeyString.get(), 'tx-1', { requesterAccount: fixture.rootAccount });
	expect(status?.status).toBe('COMPLETE');
	expect(fixture.observed.id).toBe('tx-1');
	expect(fixture.observed.accountKey).toBe(fixture.rootAccount.publicKeyString.get());

	const external = await new AnchorExternalBuilder()
		.addAnchor(fixture.anchorAccount, { transactionId: 'tx-1' })
		.build();

	const errored = await fixture.anchorStatus.getStatusesFromExternal(external);
	expect(errored[fixture.anchorAccount.publicKeyString.get()]?.kind).toBe('error');

	const authed = await fixture.anchorStatus.getStatusesFromExternal(external, { requesterAccount: fixture.rootAccount });
	expect(authed[fixture.anchorAccount.publicKeyString.get()]).toEqual(completeStatusResult(fixture.transaction));
});

test('AnchorTransactionStatus resolves a keyless anchor by provider id', async function() {
	const fixture = await startStatusFixture(false);
	await using server = fixture.server;
	void server;

	const reader = await fixture.anchorStatus.getReader({ providerId: 'Test' });
	expect(reader).not.toBeNull();

	const missing = await fixture.anchorStatus.getReader({ providerId: 'does-not-exist' });
	expect(missing).toBeNull();

	const external = await new AnchorExternalBuilder()
		.addProvider('Test', { transactionId: 'tx-1' })
		.build();

	const statuses = await fixture.anchorStatus.getStatusesFromExternal(external);
	expect(statuses['Test']).toEqual(completeStatusResult(fixture.transaction));
});

test('getStatusesFromExternal maps a malformed anchor id to a per-anchor error', async function() {
	const fixture = await startStatusFixture(false);
	await using server = fixture.server;
	void server;

	const valid = await new AnchorExternalBuilder()
		.addAnchor(fixture.anchorAccount, { transactionId: 'tx-1' })
		.build();

	const decoded = assertEncodedAnchorExternalEnvelopeV2(JSON.parse(Buffer.from(valid, 'base64').toString('utf-8')));
	const container = decoded.anchors[fixture.anchorAccount.publicKeyString.get()];
	const tampered = canonicalizeJson({ version: decoded.version, anchors: { 'not-a-valid-account': container }});
	const external = Buffer.from(tampered, 'utf-8').toString('base64');

	const statuses = await fixture.anchorStatus.getStatusesFromExternal(external);
	expect(statuses['not-a-valid-account']?.kind).toBe('error');
});
