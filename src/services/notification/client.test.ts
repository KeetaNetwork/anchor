import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import KeetaNotificationAnchorClient from './client.js';
import { KeetaNetNotificationAnchorHTTPServer } from './server.js';
import type { NotificationSubscriptionArguments, NotificationTargetWithIDResponse, SupportedChannelConfigurationMetadata, KeetaNotificationAnchorSendClientRequest } from './common.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import Resolver from '../../lib/resolver.js';
import { asNonNull, assertExternalSubscription, assertHTTPRequestError } from './test-utils.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

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

test('notification client supports EXTERNAL subscription roundtrip', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	const providerID = 'notification-provider-external';
	const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();

	const subscriptions = new Map<string, NotificationSubscriptionArguments>();
	let nextSubID = 1;

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
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
				return({ ok: subscriptions.delete(id) });
			}
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

	const sub: NotificationSubscriptionArguments = {
		type: 'EXTERNAL',
		target: { ids: ['device-1'] },
		publisher,
		kind: 'inbox'
	};

	const created = await provider.createSubscription({ account: userAccount, subscription: sub });
	expect(typeof created.id).toBe('string');
	expect(subscriptions.size).toBe(1);

	const listed = await provider.listSubscriptions({ account: userAccount });
	expect(listed.subscriptions).toHaveLength(1);
	const roundtripped = asNonNull(listed.subscriptions[0]).subscription;
	const externalSubscription = assertExternalSubscription(roundtripped);
	expect(externalSubscription.publisher.publicKeyString.get()).toBe(publisher.publicKeyString.get());
	expect(externalSubscription.kind).toBe('inbox');
}, 20_000);

test('notification client send signs internally and dispatches', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	const providerID = 'notification-provider-send';
	const publisherAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();

	const calls: Required<KeetaNotificationAnchorSendClientRequest>[] = [];

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async send(args) {
				calls.push(args);
				return({ dispatched: true });
			}
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
		account: publisherAccount,
		logger
	});

	const provider = asNonNull(await notificationClient.getProvider(providerID));

	const result = await provider.send({
		recipient,
		kind: 'inbox',
		nonce: 'test-nonce-12345',
		payload: { title: 'Hi', body: 'There', data: { key: 'value' }}
	});

	expect(result.dispatched).toBe(true);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.account.publicKeyString.get()).toBe(publisherAccount.publicKeyString.get());
	expect(calls[0]?.recipient.publicKeyString.get()).toBe(recipient.publicKeyString.get());
}, 20_000);

test('notification client send throws KeetaAnchorHTTPRequestError preserving HTTP status', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	const providerID = 'notification-provider-send-fail';
	const publisherAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async send() {
				throw(new Error('synthetic upstream failure'));
			}
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
		account: publisherAccount,
		logger
	});

	const provider = asNonNull(await notificationClient.getProvider(providerID));

	const thrown = await provider.send({
		recipient,
		kind: 'inbox',
		nonce: 'test-nonce-12345',
		payload: { title: 'Hi', body: 'There' }
	}).then(function() {
		throw(new Error('Expected provider.send to reject'));
	}, function(error: unknown) {
		return(error);
	});

	const error = assertHTTPRequestError(thrown);
	expect(error.httpStatus).toBe(500);
	expect(error.retryable).toBe(true);
}, 20_000);

test('notification client throws KeetaAnchorHTTPRequestError uniformly across all operations', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	const providerID = 'notification-provider-uniform-failure';
	const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();
	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();

	const failure = (): Promise<never> => {
		throw(new Error('synthetic upstream failure'));
	};

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			registerTarget: failure,
			listTargets: failure,
			deleteTarget: failure,
			createSubscription: failure,
			listSubscriptions: failure,
			deleteSubscription: failure,
			send: failure
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

	async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
		return(await promise.then(function() {
			throw(new Error('Expected operation to reject'));
		}, function(error: unknown) {
			return(error);
		}));
	}

	const channel = { type: 'FCM' as const, fcmToken: 'fcm-token', appId: 'app-id' };
	const subscription: NotificationSubscriptionArguments = { type: 'EXTERNAL', target: { ids: ['device-1'] }, publisher, kind: 'inbox' };

	const operations: { name: string; call: () => Promise<unknown> }[] = [
		{ name: 'registerTarget', call: () => provider.registerTarget({ channel }) },
		{ name: 'listTargets', call: () => provider.listTargets() },
		{ name: 'deleteTarget', call: () => provider.deleteTarget({ id: 'some-id' }) },
		{ name: 'createSubscription', call: () => provider.createSubscription({ subscription }) },
		{ name: 'listSubscriptions', call: () => provider.listSubscriptions() },
		{ name: 'deleteSubscription', call: () => provider.deleteSubscription({ id: 'some-id' }) },
		{ name: 'send', call: () => provider.send({ recipient, kind: 'inbox', nonce: 'test-nonce-12345', payload: { title: 'Hi', body: 'There' }}) }
	];

	for (const op of operations) {
		const error = assertHTTPRequestError(await captureRejection(op.call()));
		expect(error.httpStatus, `${op.name} httpStatus`).toBe(500);
		expect(error.retryable, `${op.name} retryable`).toBe(true);
	}
}, 30_000);
