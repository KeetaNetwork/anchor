import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import KeetaNotificationAnchorClient from './client.js';
import { KeetaNetNotificationAnchorHTTPServer } from './server.js';
import type { NotificationTargetWithIDResponse } from './common.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
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
	const subscriptions = new Map<string, { type: 'RECEIVE_FUNDS'; target: { ids: string[] }}>();
	let nextID = 1;
	let nextSubID = 1;

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
				const deleted = targets.delete(id);
				return({ ok: deleted });
			},
			async createSubscription({ subscription }) {
				const id = String(nextSubID++);
				subscriptions.set(id, { type: subscription.type, target: subscription.target });
				return({ id });
			},
			async listSubscriptions() {
				return({
					subscriptions: Array.from(subscriptions.entries()).map(([id, sub]) => ({ id, subscription: sub }))
				});
			},
			async deleteSubscription({ id }) {
				const deleted = subscriptions.delete(id);
				return({ ok: deleted });
			},
			supportedChannels: {
				FCM: [{
					projectId: 'project-id-123',
					messagingSenderId: 'messaging-sender-id-456',
					appId: 'app-id-789',
					apiKey: 'api-key-abc'
				}]
			},
			supportedSubscriptions: ['RECEIVE_FUNDS']
		}
	});

	await server.start();

	await client.setInfo({
		description: 'Notification Provider',
		name: 'NOTIF',
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
	const sub = { type: 'RECEIVE_FUNDS' as const, target: { ids: [targetID2] }};
	const createSubResult = await provider.createSubscription({ account: userAccount, subscription: sub });
	expect(typeof createSubResult.id).toBe('string');
	const subID = createSubResult.id;
	expect(subscriptions.has(subID)).toBe(true);

	const listSubsResult = await provider.listSubscriptions({ account: userAccount });
	expect(listSubsResult.subscriptions).toHaveLength(1);
	expect(listSubsResult.subscriptions[0]).toMatchObject({ id: subID, subscription: sub });

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

test('notification client getProviders returns all matching providers', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	await using server1 = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async registerTarget() { return({ id: '1' }); },
			async listTargets() { return({ targets: [] }); },
			supportedChannels: {
				FCM: [{
					projectId: 'project-id-123',
					messagingSenderId: 'messaging-sender-id-456',
					appId: 'app-id-789',
					apiKey: 'api-key-abc'
				}]
			}
		}
	});

	await using server2 = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async registerTarget() { return({ id: '2' }); },
			async listTargets() { return({ targets: [] }); },
			supportedChannels: {
				FCM: [{
					projectId: 'project-id-123',
					messagingSenderId: 'messaging-sender-id-456',
					appId: 'app-id-789',
					apiKey: 'api-key-abc'
				}]
			}
		}
	});

	await server1.start();
	await server2.start();

	await client.setInfo({
		description: 'Multi Notification Provider',
		name: 'NOTIF',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				notification: {
					'provider-1': await server1.serviceMetadata(),
					'provider-2': await server2.serviceMetadata()
				}
			}
		})
	});

	const notificationClient = new KeetaNotificationAnchorClient(client, {
		root: providerAccount,
		logger
	});

	const providers = asNonNull(await notificationClient.getProviders());
	expect(providers).toHaveLength(2);

	const providerIDs = providers.map((p) => String(p.providerID)).sort();
	expect(providerIDs).toEqual(['provider-1', 'provider-2']);
}, 20_000);
