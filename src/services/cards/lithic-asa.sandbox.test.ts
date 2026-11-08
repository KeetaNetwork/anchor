/*
 * Live test of Lithic's approval webhook (ASA) and transaction events
 * against the Lithic sandbox.  Skipped unless LITHIC_ASA_PUBLIC_URL is set
 * to a public HTTPS address that forwards to
 * http://localhost:${LITHIC_ASA_PORT ?? 4100}.  The Lithic key comes from
 * LITHIC_API_KEY (or a proxy that adds it).  It is never printed.
 * Enrolling sends every simulated authorization on the sandbox to this
 * anchor, so the test removes its ASA enrollment and event subscription and
 * closes its card at the end.
 */
import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { agentSpendingClient, openAgentSpendingAccount, revokeAgentSpending } from '../../lib/agent-spending.js';
import { KeetaCardsAnchorClient } from './client.js';
import { CARD_AGENT_OPERATIONS } from './common.js';
import { LithicCardProvider, LITHIC_SANDBOX_URL } from './lithic-provider.js';
import { KeetaNetCardsAnchorHTTPServer } from './server.js';

const PUBLIC_URL = process.env['LITHIC_ASA_PUBLIC_URL'];
const PORT = Number(process.env['LITHIC_ASA_PORT'] ?? 4100);
const API_KEY = process.env['LITHIC_API_KEY'] ?? 'added-by-proxy';

type Json = { [key: string]: unknown };

function isRecord(value: unknown): value is Json {
	return(typeof value === 'object' && value !== null);
}

function field(value: unknown, ...path: (string | number)[]): unknown {
	let at = value;
	for (const key of path) {
		if (!isRecord(at)) {
			return(undefined);
		}
		at = at[String(key)];
	}
	return(at);
}
const sleep = function(ms: number) { return(new Promise(function(resolve) { setTimeout(resolve, ms); })); };

async function lithic(method: string, path: string, body?: unknown): Promise<Json> {
	for (let attempt = 0; attempt < 5; attempt++) {
		await sleep(1100);
		const response = await fetch(new URL(path, LITHIC_SANDBOX_URL), {
			method,
			headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
			...(body !== undefined ? { body: JSON.stringify(body) } : {})
		});
		if (response.status === 429) {
			continue;
		}
		const text = await response.text();
		if (!response.ok) {
			throw(new Error(`Lithic ${method} ${path}: ${response.status} ${text.slice(0, 200)}`));
		}
		const parsed: unknown = text ? JSON.parse(text) : {};
		return(isRecord(parsed) ? parsed : {});
	}
	throw(new Error(`Lithic ${method} ${path}: rate limited`));
}

function newAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

test.skipIf(!PUBLIC_URL)('Lithic sandbox: ASA decisions, holds on the balance, and transaction events', { timeout: 300_000 }, async function() {
	const results: { [step: string]: unknown } = {};
	const cards: string[] = [];

	const owner = newAccount();
	const agent = newAccount();
	await using nodeAndClient = await createNodeAndClient(owner);
	const ownerClient = nodeAndClient.userClient;
	const { account: usd } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const usdToken = usd.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await ownerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: usd });
	await ownerClient.modTokenSupplyAndBalance(1_000_000n, usdToken);
	/* The agent's balance: 20.00 in the spending account (a 2-decimal token, so cents) */
	const spending = await openAgentSpendingAccount(ownerClient, { agent, funding: [{ token: usd, amount: 20_00n }] });
	const account = spending.storage.publicKeyString.get();

	const accountToken = String(field(await lithic('GET', '/v1/accounts?page_size=1'), 'data', 0, 'token'));
	const asaSecret = String(field(await lithic('GET', '/v1/auth_stream/secret'), 'secret'));
	const created = await lithic('POST', '/v1/event_subscriptions', { url: new URL('/api/cards/lithic/events', PUBLIC_URL).toString(), event_types: ['card_transaction.updated'], description: 'Keeta cards anchor live test' });
	const subscription = String(created['token']);
	const eventsSecret = String(field(await lithic('GET', `/v1/event_subscriptions/${subscription}/secret`), 'secret'));
	const provider = new LithicCardProvider({ apiKey: API_KEY, asaSecret, eventsSecret, accountFor: async function() { return(accountToken); } });

	const asked: { ms: number; result: string }[] = [];
	const answer = provider.answerASA.bind(provider);
	provider.answerASA = async function(body) {
		const started = Date.now();
		const reply = await answer(body);
		asked.push({ ms: Date.now() - started, result: reply.result });
		return(reply);
	};

	const server = new KeetaNetCardsAnchorHTTPServer({
		client: { client: ownerClient.client },
		provider,
		delegateOperations: CARD_AGENT_OPERATIONS,
		fundingTokens: [{ token: usd.publicKeyString.get(), decimals: 2 }],
		port: PORT
	});
	await server.start();
	try {
		results['enroll'] = await lithic('POST', '/v1/responder_endpoints', { type: 'AUTH_STREAM_ACCESS', url: new URL('/api/cards/lithic/asa', PUBLIC_URL).toString() });
		/* Lithic starts signing ASA requests "within minutes" of the secret being fetched */
		await sleep(5000);

		const wallet = { chain: 'base', currency: 'usdc', address: '0x' + 'ab'.repeat(20) };
		const ownerCards = new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(ownerClient, spending.storage, owner) });
		const agentCards = new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(ownerClient, spending.storage, agent) });
		await ownerCards.registerWallet(wallet);
		const card = await agentCards.createCard({ wallet, label: 'ASA live test', controls: { perPurchaseLimitCents: 500_00 }});
		cards.push(card.id);
		const pan = String(field(await lithic('GET', `/v1/cards/${card.id}`), 'pan'));

		const holds = async function() {
			return((await server.store.listHolds(account)).map(function(hold) { return({ pending: hold.pendingCents, settled: hold.settledCents }); }));
		};
		/* Events arrive a few seconds after the change; wait for the holds to show it */
		const waitForHolds = async function(step: string, done: (list: { pending: number; settled: number }[]) => boolean) {
			const started = Date.now();
			let list = await holds();
			while (!done(list) && Date.now() - started < 60_000) {
				await sleep(1000);
				list = await holds();
			}
			results[step] = { holds: list, waitedMS: Date.now() - started };
			console.log(`[asa] ${step}: ${JSON.stringify(results[step])}`);
			return(done(list));
		};

		let purchases = 0;
		const buy = async function(step: string, cents: number) {
			const before = asked.length;
			purchases += 1;
			const simulated = await lithic('POST', '/v1/simulate/authorize', { pan, amount: cents, descriptor: `KEETA TEST ${purchases}`, mcc: '5734' });
			await sleep(1500);
			const tx = await lithic('GET', `/v1/transactions/${simulated['token']}`);
			results[step] = { lithic: tx['result'], detailed: field(tx, 'events', 0, 'detailed_results'), anchor: asked.slice(before), holds: await holds() };
			console.log(`[asa] ${step}: ${JSON.stringify(results[step])}`);
			return({ token: String(simulated['token']), lithic: String(tx['result']), anchor: asked.slice(before) });
		};

		const five = await buy('granted 5.00', 5_00);
		const overBalance = await buy('over the balance 300.00', 300_00);
		const ten = await buy('second purchase 10.00 (5.00 still held)', 10_00);
		const tooMuch = await buy('another 10.00 with 15.00 held of 20.00', 10_00);

		/* The merchant voids the 10.00: Lithic's event releases its hold */
		await lithic('POST', '/v1/simulate/void', { token: ten.token });
		const released = await waitForHolds('after voiding the 10.00', function(list) { return(list.reduce(function(sum, hold) { return(sum + hold.pending + hold.settled); }, 0) === 5_00); });
		const again = await buy('10.00 again after the void', 10_00);

		/* The 5.00 settles for 4.00: the hold keeps the settled 4.00 */
		await lithic('POST', '/v1/simulate/clearing', { token: five.token, amount: 4_00 });
		const settled = await waitForHolds('after the 5.00 settles for 4.00', function(list) { return(list.some(function(hold) { return(hold.settled === 4_00); })); });

		await revokeAgentSpending(ownerClient, spending);
		const revoked = await buy('after revoke 1.00', 1_00);

		expect(five.lithic).toBe('APPROVED');
		expect(overBalance.anchor[0]?.result).toBe('INSUFFICIENT_FUNDS');
		expect(ten.lithic).toBe('APPROVED');
		expect(tooMuch.anchor[0]?.result).toBe('INSUFFICIENT_FUNDS');
		expect(released).toBe(true);
		expect(again.lithic).toBe('APPROVED');
		expect(settled).toBe(true);
		expect(revoked.anchor[0]?.result).toBe('CARD_PAUSED');
		expect(revoked.lithic).not.toBe('APPROVED');
	} finally {
		await lithic('DELETE', '/v1/responder_endpoints?type=AUTH_STREAM_ACCESS').catch(function(error: unknown) { console.log('[asa] removing the ASA enrollment failed', String(error)); });
		await lithic('DELETE', `/v1/event_subscriptions/${subscription}`).catch(function(error: unknown) { console.log('[asa] subscription delete failed', String(error)); });
		results['after'] = await lithic('GET', '/v1/responder_endpoints?type=AUTH_STREAM_ACCESS').catch(function(error: unknown) { return(String(error)); });
		for (const token of cards) {
			await lithic('PATCH', `/v1/cards/${token}`, { state: 'CLOSED' }).catch(function() { /* already closed */ });
		}
		await server.stop();
		console.log(`[asa] results ${JSON.stringify(results)}`);
	}
});
