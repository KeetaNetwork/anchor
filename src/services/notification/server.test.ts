import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetNotificationAnchorHTTPServer } from './server.js';
import {
	getNotificationRegisterTargetRequestSignable,
	getNotificationListTargetsRequestSignable,
	getNotificationDeleteTargetRequestSignable,
	getNotificationCreateSubscriptionRequestSignable,
	getNotificationListSubscriptionsRequestSignable,
	getNotificationDeleteSubscriptionRequestSignable
} from './common.js';
import { SignData } from '../../lib/utils/signing.js';
import { addSignatureToURL } from '../../lib/http-server/common.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

test('notification server registers, lists, and deletes targets', async () => {
	const targets = new Map<string, { channel: { type: 'FCM'; fcmToken: string; appId: string; }}>();
	let nextID = 1;

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async registerTarget({ channel }) {
				const id = String(nextID++);
				targets.set(id, { channel });
				return({ id });
			},
			async listTargets() {
				return({
					targets: Array.from(targets.entries()).map(([id, { channel }]) => ({ id, channel }))
				});
			},
			async deleteTarget({ id }) {
				const deleted = targets.delete(id);
				return({ ok: deleted });
			}
		}
	});

	await server.start();
	const baseURL = new URL(server.url);

	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const channel = { type: 'FCM' as const, fcmToken: 'test-fcm-token-123', appId: 'test-app-id-456' };

	// --- registerTarget ---
	const registerSignable = getNotificationRegisterTargetRequestSignable({ channel });
	const registerSigned = await SignData(account.assertAccount(), registerSignable);

	const registerResponse = await fetch(new URL('/api/target', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: account.publicKeyString.get(),
			channel,
			signed: registerSigned
		})
	});

	expect(registerResponse.status).toBe(200);
	const registerJSON: unknown = await registerResponse.json();
	if (typeof registerJSON !== 'object' || registerJSON === null || !('id' in registerJSON) || typeof registerJSON.id !== 'string') {
		throw(new Error('Invalid register response JSON'));
	}
	expect(registerJSON).toMatchObject({ ok: true });
	const registeredID = registerJSON.id;

	// --- listTargets ---
	const listSignable = getNotificationListTargetsRequestSignable();
	const listSigned = await SignData(account.assertAccount(), listSignable);
	const listURL = addSignatureToURL(new URL('/api/targets', baseURL), { signedField: listSigned, account: account.assertAccount() });

	const listResponse = await fetch(listURL, {
		method: 'GET',
		headers: { 'Accept': 'application/json' }
	});

	expect(listResponse.status).toBe(200);
	expect(await listResponse.json()).toEqual({ ok: true, targets: [{ id: registeredID, channel }] });

	// --- deleteTarget ---
	const deleteSignable = getNotificationDeleteTargetRequestSignable({ id: registeredID });
	const deleteSigned = await SignData(account.assertAccount(), deleteSignable);

	const deleteResponse = await fetch(new URL('/api/delete-target', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: account.publicKeyString.get(),
			id: registeredID,
			signed: deleteSigned
		})
	});

	expect(deleteResponse.status).toBe(200);
	expect(await deleteResponse.json()).toMatchObject({ ok: true });
	expect(targets.size).toBe(0);
}, 10_000);

test('notification server rejects invalid signatures', async () => {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const channel = { type: 'FCM' as const, fcmToken: 'test-token', appId: 'test' };

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async registerTarget() { return({ id: 'never' }); },
			async listTargets() { return({ targets: [] }); },
			async deleteTarget() { return({ ok: true }); }
		}
	});

	await server.start();
	const baseURL = new URL(server.url);

	// Invalid registerTarget signature
	const registerSigned = await SignData(account.assertAccount(), getNotificationRegisterTargetRequestSignable({ channel }));

	const badRegisterResponse = await fetch(new URL('/api/target', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: account.publicKeyString.get(),
			channel,
			signed: { ...registerSigned, signature: 'invalid-signature' }
		})
	});

	expect(badRegisterResponse.status).toBeGreaterThanOrEqual(400);
	expect(badRegisterResponse.status).toBeLessThan(600);

	// Invalid listTargets signature
	const listSigned = await SignData(account.assertAccount(), getNotificationListTargetsRequestSignable());
	const badListURL = addSignatureToURL(new URL('/api/targets', baseURL), {
		signedField: { ...listSigned, signature: 'invalid-signature' },
		account: account.assertAccount()
	});

	const badListResponse = await fetch(badListURL, {
		method: 'GET',
		headers: { 'Accept': 'application/json' }
	});

	expect(badListResponse.status).toBeGreaterThanOrEqual(400);
	expect(badListResponse.status).toBeLessThan(600);

	// Invalid deleteTarget signature
	const deleteSigned = await SignData(account.assertAccount(), getNotificationDeleteTargetRequestSignable({ id: 'some-id' }));

	const badDeleteResponse = await fetch(new URL('/api/delete-target', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: account.publicKeyString.get(),
			id: 'some-id',
			signed: { ...deleteSigned, signature: 'invalid-signature' }
		})
	});

	expect(badDeleteResponse.status).toBeGreaterThanOrEqual(400);
	expect(badDeleteResponse.status).toBeLessThan(600);
}, 10_000);

test('notification server creates, lists, and deletes subscriptions', async () => {
	const subscriptions = new Map<string, { type: 'RECEIVE_FUNDS'; target: { ids: string[] }}>();
	let nextID = 1;

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async createSubscription({ subscription }) {
				const id = String(nextID++);
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
			}
		}
	});

	await server.start();
	const baseURL = new URL(server.url);

	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const subscription = { type: 'RECEIVE_FUNDS' as const, target: { ids: ['target-1'] }};

	// --- createSubscription ---
	const createSignable = getNotificationCreateSubscriptionRequestSignable({ subscription });
	const createSigned = await SignData(account.assertAccount(), createSignable);

	const createResponse = await fetch(new URL('/api/subscription', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: account.publicKeyString.get(),
			subscription,
			signed: createSigned
		})
	});

	expect(createResponse.status).toBe(200);
	const createJSON: unknown = await createResponse.json();
	if (typeof createJSON !== 'object' || createJSON === null || !('id' in createJSON) || typeof createJSON.id !== 'string') {
		throw(new Error('Invalid createSubscription response'));
	}
	expect(createJSON).toMatchObject({ ok: true });
	const subscriptionID = createJSON.id;

	// --- listSubscriptions ---
	const listSignable = getNotificationListSubscriptionsRequestSignable();
	const listSigned = await SignData(account.assertAccount(), listSignable);
	const listURL = addSignatureToURL(new URL('/api/subscriptions', baseURL), { signedField: listSigned, account: account.assertAccount() });

	const listResponse = await fetch(listURL, {
		method: 'GET',
		headers: { 'Accept': 'application/json' }
	});

	expect(listResponse.status).toBe(200);
	expect(await listResponse.json()).toEqual({
		ok: true,
		subscriptions: [{ id: subscriptionID, subscription }]
	});

	// --- deleteSubscription ---
	const deleteSignable = getNotificationDeleteSubscriptionRequestSignable({ id: subscriptionID });
	const deleteSigned = await SignData(account.assertAccount(), deleteSignable);

	const deleteResponse = await fetch(new URL('/api/delete-subscription', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: account.publicKeyString.get(),
			id: subscriptionID,
			signed: deleteSigned
		})
	});

	expect(deleteResponse.status).toBe(200);
	expect(await deleteResponse.json()).toMatchObject({ ok: true });
	expect(subscriptions.size).toBe(0);
}, 10_000);
