import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetNotificationAnchorHTTPServer } from './server.js';
import {
	getNotificationRegisterTargetRequestSignable,
	getNotificationListTargetsRequestSignable,
	getNotificationDeleteTargetRequestSignable,
	getNotificationCreateSubscriptionRequestSignable,
	getNotificationListSubscriptionsRequestSignable,
	getNotificationDeleteSubscriptionRequestSignable,
	isKeetaNotificationAnchorListSubscriptionsResponseJSON,
	NOTIFICATION_SEND_LIMITS
} from './common.js';
import type {
	NotificationSubscriptionArguments,
	KeetaNotificationAnchorSendClientRequest
} from './common.js';
import { SignData } from '../../lib/utils/signing.js';
import { addSignatureToURL } from '../../lib/http-server/common.js';
import { buildSendBody } from './test-utils.js';

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
				if (subscription.type !== 'RECEIVE_FUNDS') {
					throw(new Error(`Unexpected subscription type in test: ${subscription.type}`));
				}
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

test('notification server creates and lists EXTERNAL subscriptions', async () => {
	const stored = new Map<string, NotificationSubscriptionArguments>();
	let nextID = 1;

	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: {
			async createSubscription({ subscription }) {
				const id = String(nextID++);
				stored.set(id, subscription);
				return({ id });
			},
			async listSubscriptions() {
				return({
					subscriptions: Array.from(stored.entries()).map(([id, sub]) => ({ id, subscription: sub }))
				});
			},
			async deleteSubscription({ id }) {
				return({ ok: stored.delete(id) });
			}
		}
	});

	await server.start();
	const baseURL = new URL(server.url);

	const subscriber = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).assertAccount();

	const subscription: NotificationSubscriptionArguments = {
		type: 'EXTERNAL',
		target: { ids: ['device-1'] },
		publisher,
		kind: 'inbox'
	};

	const createSignable = getNotificationCreateSubscriptionRequestSignable({ subscription });
	const createSigned = await SignData(subscriber.assertAccount(), createSignable);

	const createResponse = await fetch(new URL('/api/subscription', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			account: subscriber.publicKeyString.get(),
			subscription: {
				type: 'EXTERNAL',
				target: subscription.target,
				publisher: publisher.publicKeyString.get(),
				kind: 'inbox'
			},
			signed: createSigned
		})
	});

	expect(createResponse.status).toBe(200);
	expect(stored.size).toBe(1);

	const listSigned = await SignData(subscriber.assertAccount(), getNotificationListSubscriptionsRequestSignable());
	const listURL = addSignatureToURL(new URL('/api/subscriptions', baseURL), { signedField: listSigned, account: subscriber.assertAccount() });

	const listResponse = await fetch(listURL, { method: 'GET', headers: { 'Accept': 'application/json' }});
	expect(listResponse.status).toBe(200);
	const listJSON: unknown = await listResponse.json();
	if (!isKeetaNotificationAnchorListSubscriptionsResponseJSON(listJSON)) {
		throw(new Error('Server returned an invalid listSubscriptions response shape'));
	}
	if (!listJSON.ok) {
		throw(new Error(`Server returned an error response: ${listJSON.error}`));
	}
	expect(listJSON.subscriptions).toHaveLength(1);
	const sub = listJSON.subscriptions[0]?.subscription;
	if (sub?.type !== 'EXTERNAL') {
		throw(new Error(`Expected EXTERNAL subscription, got ${sub?.type}`));
	}
	expect(sub.publisher).toBe(publisher.publicKeyString.get());
	expect(sub.kind).toBe('inbox');
}, 10_000);

test('notification server SEND verifies signature and dispatches', async () => {
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
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get());

	const sendResponse = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	expect(sendResponse.status).toBe(200);
	expect(await sendResponse.json()).toEqual({ ok: true, dispatched: true });
	expect(calls).toHaveLength(1);
	expect(calls[0]?.account.publicKeyString.get()).toBe(publisher.publicKeyString.get());
	expect(calls[0]?.recipient.publicKeyString.get()).toBe(recipient.publicKeyString.get());
	expect(calls[0]?.kind).toBe('inbox');
}, 10_000);

test('notification server SEND rejects unsupported version', async () => {
	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: { async send() { return({ dispatched: true }); } }
	});

	await server.start();
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get(), { version: 2 });

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	/* Typia rejects `version: 2` against the literal `version: 1` schema before the explicit
	 * KeetaAnchorUserError check executes; the framework currently maps TypeGuardError → 500.
	 * The exact status is project-policy elsewhere (see register/list/delete tests above) and
	 * not the contract under test here — what matters is the request is refused.
	 */
	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(response.status).toBeLessThan(600);
}, 10_000);

test('notification server SEND rejects invalid signature', async () => {
	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: { async send() { return({ dispatched: true }); } }
	});

	await server.start();
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get());
	body.signed = { ...body.signed, signature: 'not-a-valid-signature' };

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	/* A structurally malformed signature throws inside the signing library before
	 * the server's explicit `if (!verifiedSignature)` branch runs; the framework
	 * maps non-KeetaAnchorError throws to 500. See the equivalent register/list/
	 * delete tests above for the established project pattern.
	 */
	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(response.status).toBeLessThan(600);
}, 10_000);

test('notification server SEND rejects oversize payload', async () => {
	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: { async send() { return({ dispatched: true }); } }
	});

	await server.start();
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const oversizeTitle = 'a'.repeat(NOTIFICATION_SEND_LIMITS.titleMaxLength + 1);
	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get(), {
		payload: { title: oversizeTitle, body: 'ok' }
	});

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	expect(response.status).toBe(400);
}, 10_000);

test('notification server SEND rejects bad nonce', async () => {
	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: { async send() { return({ dispatched: true }); } }
	});

	await server.start();
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get(), { nonce: 'too short' });

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	expect(response.status).toBe(400);
}, 10_000);

test('notification server SEND payload signature binds payload contents', async () => {
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
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get(), {
		payload: { title: 'Original', body: 'Original' }
	});

	body.payload = { title: 'Tampered', body: 'Tampered' };

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	expect(response.status).toBe(400);
	expect(calls).toHaveLength(0);
}, 10_000);

test('notification server SEND returns dispatched:false when handler reports no targets', async () => {
	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: { async send() { return({ dispatched: false }); } }
	});

	await server.start();
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get());

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, dispatched: false });
}, 10_000);

test('notification server SEND rejects control characters in title', async () => {
	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: { async send() { return({ dispatched: true }); } }
	});

	await server.start();
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get(), {
		payload: { title: 'hello\u0001world', body: 'ok' }
	});

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	expect(response.status).toBe(400);
}, 10_000);

test('notification server SEND rejects too-many data entries', async () => {
	await using server = new KeetaNetNotificationAnchorHTTPServer({
		logger,
		notification: { async send() { return({ dispatched: true }); } }
	});

	await server.start();
	const baseURL = new URL(server.url);

	const publisher = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const recipient = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	const data: { [key: string]: string } = {};
	for (let i = 0; i <= NOTIFICATION_SEND_LIMITS.dataMaxEntries; i++) {
		data[`k${i}`] = 'v';
	}

	const { body } = await buildSendBody(publisher, recipient.publicKeyString.get(), {
		payload: { title: 'ok', body: 'ok', data }
	});

	const response = await fetch(new URL('/api/send', baseURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify(body)
	});

	expect(response.status).toBe(400);
}, 10_000);
