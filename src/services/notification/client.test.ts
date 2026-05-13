import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import KeetaNotificationAnchorClient from './client.js';
import { KeetaNetNotificationAnchorHTTPServer } from './server.js';
import type { NotificationSubscriptionArguments, NotificationTargetWithIDResponse, SupportedChannelConfigurationMetadata } from './common.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { buildCert, buildChain } from '../../lib/utils/tests/certificates.js';
import { KeetaAnchorCertificateRequiredError } from '../../lib/error.js';
import Resolver from '../../lib/resolver.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

function asNonNull<T>(value: T): NonNullable<T> {
	if (value === null || value === undefined) {
		throw(new Error('Value is null or undefined'));
	}

	return(value);
}

test('notification client registers, lists, and deletes targets through resolver', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	const providerID = 'notification-provider-1';
	const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const targets = new Map<string, NotificationTargetWithIDResponse>();
	const subscriptions = new Map<string, NotificationSubscriptionArguments>();
	let nextID = 1;
	let nextSubID = 1;

	const testSupportedChannels: SupportedChannelConfigurationMetadata = {
		FCM: [
			{
				projectId: 'project-id-123',
				messagingSenderId: 'messaging-sender-id-456',
				appId: 'app-id-789',
				apiKey: 'api-key-abc'
			},
			{
				projectId: 'project-id-two',
				messagingSenderId: 'messaging-sender-id-three',
				appId: 'app-id-four',
				apiKey: 'api-key-five',
				bundleId: 'com.example.app'
			}
		]
	}

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async registerTarget({ channel }) {
				const id = String(nextID++);
				targets.set(id, { id, channel });
				return({ id });
			},
			async listTargets() {
				return({ targets: Array.from(targets.values()) });
			},
			async deleteTarget({ id }) {
				return({ ok: targets.delete(id) });
			},
			async createSubscription({ subscription }) {
				const id = String(nextSubID++);
				subscriptions.set(id, subscription);
				return({ id });
			},
			async listSubscriptions() {
				return({
					subscriptions: Array.from(subscriptions.entries()).map(function([id, subscription]) {
						return({ id, subscription });
					})
				});
			},
			async deleteSubscription({ id }) {
				const deleted = subscriptions.delete(id);
				return({ ok: deleted });
			},
			supportedChannels: testSupportedChannels,
			supportedSubscriptions: ['RECEIVE_FUNDS']
		}
	});

	await server.start();

	await client.setInfo({
		description: '', name: '',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				notification: { [providerID]: await server.serviceMetadata() }
			}
		})
	});

	const notificationClient = new KeetaNotificationAnchorClient(client, {
		root: providerAccount,
		account: userAccount,
		logger
	});

	const provider = asNonNull(await notificationClient.getProvider(providerID));

	expect(provider.serviceInfo.supportedChannels).toEqual(testSupportedChannels);

	const channel = { type: 'FCM' as const, fcmToken: 'device-token-abc', appId: 'hello' };

	// registerTarget
	const registerResult = await provider.registerTarget({ account: userAccount, channel });
	expect(typeof registerResult.id).toBe('string');
	const targetID = registerResult.id;
	expect(targets.has(targetID)).toBe(true);

	// listTargets
	const listResult = await provider.listTargets({ account: userAccount });
	expect(listResult.targets).toHaveLength(1);
	expect(listResult.targets[0]).toMatchObject({ id: targetID, channel });

	// Register a second target
	const channel2 = { type: 'FCM' as const, fcmToken: 'device-token-xyz', appId: 'hello' };
	const registerResult2 = await provider.registerTarget({ account: userAccount, channel: channel2 });
	const targetID2 = registerResult2.id;

	const listResult2 = await provider.listTargets({ account: userAccount });
	expect(listResult2.targets).toHaveLength(2);

	// deleteTarget
	const deleteResult = await provider.deleteTarget({ account: userAccount, id: targetID });
	expect(deleteResult.ok).toBe(true);
	expect(targets.has(targetID)).toBe(false);

	const listAfterDelete = await provider.listTargets({ account: userAccount });
	expect(listAfterDelete.targets).toHaveLength(1);
	expect(listAfterDelete.targets[0]?.id).toBe(targetID2);

	// createSubscription
	const sub = { type: 'RECEIVE_FUNDS' as const, target: { ids: [targetID2] }, locale: new Intl.Locale('en-US') };
	const createSubResult = await provider.createSubscription({ account: userAccount, subscription: sub });
	expect(typeof createSubResult.id).toBe('string');
	const subID = createSubResult.id;
	expect(subscriptions.has(subID)).toBe(true);

	const listSubsResult = await provider.listSubscriptions({ account: userAccount });
	expect(listSubsResult.subscriptions).toHaveLength(1);
	expect(listSubsResult.subscriptions[0]?.id).toEqual(subID);
	expect({
		...listSubsResult.subscriptions[0]?.subscription,
		locale: listSubsResult.subscriptions[0]?.subscription.locale?.toString()
	}).toMatchObject({ ...sub, locale: sub.locale.toString() });

	const sub2 = { type: 'RECEIVE_FUNDS' as const, target: { ids: [targetID2] }};
	const createSubResult2 = await provider.createSubscription({ account: userAccount, subscription: sub2 });
	const subID2 = createSubResult2.id;

	expect((await provider.listSubscriptions({ account: userAccount })).subscriptions).toHaveLength(2);

	const deleteSubResult = await provider.deleteSubscription({ account: userAccount, id: subID });
	expect(deleteSubResult.ok).toBe(true);
	expect(subscriptions.has(subID)).toBe(false);

	const listAfterSubDelete = await provider.listSubscriptions({ account: userAccount });
	expect(listAfterSubDelete.subscriptions).toHaveLength(1);
	expect(listAfterSubDelete.subscriptions[0]?.id).toBe(subID2);
}, 20_000);

/**
 * Stand up a notification server that requires a cert chain rooted at
 * `rootCA`, register it under `providerID`, and return a function that
 * builds a `KeetaNotificationAnchorClient` for an arbitrary caller account.
 */
type NetworkAccount = ReturnType<typeof KeetaNet.lib.Account.fromSeed>;
type AnchorClient = NonNullable<Awaited<ReturnType<typeof createNodeAndClient>>['userClient']>;

interface GatedNotificationFixture extends AsyncDisposable {
	client: AnchorClient;
	network: NetworkAccount;
	rootCA: Awaited<ReturnType<typeof buildCert>>;
	makeCaller: (account: NetworkAccount) => Promise<() => Promise<{ id: string }>>;
}

/**
 * Stand up a notification server that requires a cert chain rooted at
 * `rootCA`. Returns the underlying network handles so callers can publish
 * certificates for arbitrary accounts on the same node and a `makeCaller`
 * helper that builds a notification client bound to a given account.
 */
async function setupGatedNotificationServer(seed: string | ArrayBuffer): Promise<GatedNotificationFixture> {
	const providerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
	const nodeAndClient = await createNodeAndClient(providerAccount);

	nodeAndClient.fees.disable();

	const client = nodeAndClient.userClient;
	const rootIssuer = KeetaNet.lib.Account.fromSeed(seed, 200);
	const rootCA = await buildCert({
		issuer: rootIssuer, subject: rootIssuer, serial: 1, validForMs: 1000 * 60 * 60 * 24 * 365
	});

	const server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async registerTarget() {
				return({ id: 'ok' });
			},
			supportedChannels: { FCM: [] },
			supportedSubscriptions: ['RECEIVE_FUNDS']
		},
		requireCertificateChain: { trustedIssuers: [rootCA], client: client.client }
	});

	await server.start();

	const providerID = 'cert-gated-provider';
	await client.setInfo({
		description: '', name: '',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: { notification: { [providerID]: await server.serviceMetadata() }}
		})
	});

	async function makeCaller(account: NetworkAccount) {
		const callerClient = new KeetaNotificationAnchorClient(client, {
			root: providerAccount, account, logger
		});
		const provider = asNonNull(await callerClient.getProvider(providerID));
		return(() => provider.registerTarget({
			account,
			channel: { type: 'FCM' as const, fcmToken: 'tok', appId: 'a' }
		}));
	}

	return({
		client,
		network: providerAccount,
		rootCA,
		makeCaller,
		async [Symbol.asyncDispose]() {
			await server[Symbol.asyncDispose]();
			await nodeAndClient[Symbol.asyncDispose]();
		}
	});
}

test('notification cert-gate: account without published cert is rejected (401 missing)', async () => {
	await using gate = await setupGatedNotificationServer(KeetaNet.lib.Account.generateRandomSeed());

	const noCertAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const registerTarget = await gate.makeCaller(noCertAccount);
	await expect(registerTarget()).rejects.toSatisfy(function(error: unknown) {
		return(KeetaAnchorCertificateRequiredError.isInstance(error) && error.kind === 'missing' && error.statusCode === 401);
	});
}, 20_000);

test('notification cert-gate: account with cert outside trust set is rejected (403 untrusted)', async () => {
	await using gate = await setupGatedNotificationServer(KeetaNet.lib.Account.generateRandomSeed());

	const otherAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { leaf: untrustedLeaf } = await buildChain({
		rootIssuer: otherAccount,
		leafSubject: otherAccount
	});

	const otherUserClient = new KeetaNet.UserClient({
		client: gate.client.client,
		signer: otherAccount,
		usePublishAid: false,
		network: gate.client.network,
		networkAlias: 'test'
	});
	await otherUserClient.modifyCertificate(KeetaNet.lib.Block.AdjustMethod.ADD, untrustedLeaf, null);

	const registerTarget = await gate.makeCaller(otherAccount);
	await expect(registerTarget()).rejects.toSatisfy(function(error: unknown) {
		return(KeetaAnchorCertificateRequiredError.isInstance(error) && error.kind === 'untrusted' && error.statusCode === 403);
	});
}, 20_000);
