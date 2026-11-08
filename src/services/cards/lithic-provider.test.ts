import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { agentSpendingClient, openAgentSpendingAccount, revokeAgentSpending } from '../../lib/agent-spending.js';
import { Buffer } from '../../lib/utils/buffer.js';
import { KeetaCardsAnchorClient } from './client.js';
import { LITHIC_PRODUCTION_URL, LithicCardProvider, lithicAuthorizationRequest, lithicSpendLimit, verifyLithicWebhook } from './lithic-provider.js';
import { KeetaNetCardsAnchorHTTPServer } from './server.js';

function newAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

/* Generated per run so no credential-like literal is checked in */
const SECRET = 'whsec_' + randomBytes(32).toString('base64');
const API_KEY = randomUUID();
const DEPOSIT = '0x' + 'cd'.repeat(20);
const wallet = { chain: 'base', currency: 'usdc', address: '0x' + 'ab'.repeat(20) };

/**
 * Enough of Lithic's API for the provider, recording each call.  Shapes
 * follow docs.lithic.com (Create card, Update card, List financial
 * accounts, Create card embed session).
 */
function fakeLithic(options: { ledger?: boolean; rateLimitWrites?: number; } = {}) {
	let rateLimited = options.rateLimitWrites ?? 0;
	const calls: { method: string; path: string; body: unknown; authorization: string | null; }[] = [];
	const cards = new Map<string, { [key: string]: unknown }>();

	const fetcher: typeof fetch = async function(input, init) {
		const url = new URL(input instanceof Request ? input.url : input);
		const method = init?.method ?? 'GET';
		const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		const headers = new Headers(init?.headers);
		calls.push({ method, path: url.pathname + url.search, body, authorization: headers.get('Authorization') });

		const reply = function(status: number, value: unknown) {
			return(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' }}));
		};

		/* The sandbox allows about one write a second */
		if (method !== 'GET' && rateLimited > 0) {
			rateLimited--;
			return(new Response(JSON.stringify({ message: 'Rate limit exceeded.' }), { status: 429, headers: { 'Retry-After': '0.01' }}));
		}

		if (method === 'POST' && url.pathname === '/v1/cards') {
			const token = randomUUID();
			const card = { token, last_four: '4821', exp_month: '11', exp_year: '2031', state: 'OPEN', ...(typeof body === 'object' && body !== null ? body : {}) };
			cards.set(token, card);
			return(reply(201, card));
		}

		const cardPath = /^\/v1\/cards\/([^/]+)(\/embed)?$/.exec(url.pathname);
		if (cardPath?.[1] !== undefined) {
			const card = cards.get(cardPath[1]);
			if (!card) {
				return(reply(404, { message: 'Card not found' }));
			}

			if (method === 'PATCH') {
				if (card['state'] === 'CLOSED') {
					return(reply(405, { message: 'Card not active', error_data: { message: 'Sorry, you cannot modify a closed card' }}));
				}

				Object.assign(card, body);
				return(reply(200, card));
			}

			if (method === 'POST' && cardPath[2] === '/embed') {
				if (typeof body !== 'object' || body === null || !('type' in body) || !('target_origin' in body)) {
					return(reply(400, { message: 'Failed to deserialize the JSON body into the target type: missing field `type`' }));
				}

				return(reply(200, { session: `embed_${cardPath[1]}` }));
			}
		}

		if (method === 'GET' && url.pathname === '/v1/financial_accounts') {
			/* What the sandbox answers for an account outside a ledger program */
			if (options.ledger === false) {
				return(reply(400, { message: 'Account does not support this operation' }));
			}

			return(reply(200, { data: [
				{ token: 'fa_reserve', type: 'RESERVE', blockchain_addresses: null },
				{ token: 'fa_issuing', type: 'ISSUING', blockchain_addresses: { BASE: DEPOSIT, ETHEREUM: '0x' + 'ee'.repeat(20) }}
			], has_more: false }));
		}

		return(reply(404, { message: `No route for ${method} ${url.pathname}` }));
	};

	return({ calls, cards, fetcher });
}

function asaRequest(cardToken: string, amountCents: number, mcc: string, status = 'AUTHORIZATION') {
	return({
		token: randomUUID(),
		status,
		card: { token: cardToken, last_four: '4821', state: 'OPEN', type: 'VIRTUAL', tags: {}},
		merchant: { descriptor: 'CLOUD HOSTING CO', mcc, country: 'USA', city: 'SAN FRANCISCO' },
		amounts: { cardholder: { amount: amountCents, currency: 'USD', conversion_rate: '1' }, merchant: { amount: amountCents, currency: 'USD' }},
		amount: amountCents
	});
}

function sign(body: string, secret = SECRET, at = new Date()) {
	const id = `msg_${randomUUID()}`;
	const timestamp = String(Math.floor(at.getTime() / 1000));
	const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
	const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
	return({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` });
}

test('Lithic helpers: one issuer limit, webhook signatures and ASA parsing', function() {
	expect(lithicSpendLimit({ perPurchaseLimitCents: 25_00, lifetimeLimitCents: 100_00 })).toEqual({ spend_limit: 25_00, spend_limit_duration: 'TRANSACTION' });
	expect(lithicSpendLimit({ lifetimeLimitCents: 100_00 })).toEqual({ spend_limit: 100_00, spend_limit_duration: 'FOREVER' });
	expect(lithicSpendLimit({})).toEqual({ spend_limit: 0, spend_limit_duration: 'FOREVER' });

	const body = JSON.stringify(asaRequest('card_1', 12_00, '5734'));
	const headers = sign(body);
	const signed = { id: headers['webhook-id'], timestamp: headers['webhook-timestamp'], signature: headers['webhook-signature'] };
	expect(verifyLithicWebhook(SECRET, signed, Buffer.from(body))).toBe(true);
	expect(verifyLithicWebhook(SECRET, signed, Buffer.from(body + ' '))).toBe(false);
	expect(verifyLithicWebhook('whsec_' + randomBytes(32).toString('base64'), signed, Buffer.from(body))).toBe(false);
	expect(verifyLithicWebhook(SECRET, { ...signed, signature: `v1,bm9wZQ== ${signed.signature}` }, Buffer.from(body))).toBe(true);
	expect(verifyLithicWebhook(SECRET, signed, Buffer.from(body), new Date(Date.now() + 10 * 60 * 1000))).toBe(false);
	expect(verifyLithicWebhook(SECRET, { ...signed, id: undefined }, Buffer.from(body))).toBe(false);

	const parsed = lithicAuthorizationRequest(JSON.parse(body));
	expect(parsed.request).toEqual({ cardID: 'card_1', authorizationID: parsed.token, amountCents: 12_00, merchant: { name: 'CLOUD HOSTING CO', categoryCode: '5734', country: 'USA' }});
	expect(lithicAuthorizationRequest(asaRequest('card_1', 5_00, '5734', 'CREDIT_AUTHORIZATION'))).toMatchObject({ request: undefined });
	expect(lithicAuthorizationRequest(asaRequest('card_1', 0, '5734', 'BALANCE_INQUIRY')).decline).toBeUndefined();
	/* A status this code doesn't know is declined, not approved */
	expect(lithicAuthorizationRequest(asaRequest('card_1', 5_00, '5734', 'SOMETHING_NEW')).decline).toBe(true);

	/* A fuel pump asks for 1.00 and Lithic holds 150.00: the hold is checked */
	const fuel = { ...asaRequest('card_1', 1_00, '5542'), amounts: { cardholder: { amount: 1_00, currency: 'USD', conversion_rate: '1' }, hold: { amount: 150_00, currency: 'USD' }}};
	expect(lithicAuthorizationRequest(fuel).request?.amountCents).toBe(150_00);
	expect(function() { lithicAuthorizationRequest({ token: 'x' }); }).toThrow(/Not a Lithic ASA request/);
});

test('Lithic cards through the anchor: issue, deposit address, controls, signed ASA, revoke', async function() {
	const owner = newAccount();
	const agent = newAccount();
	await using nodeAndClient = await createNodeAndClient(owner);
	const ownerClient = nodeAndClient.userClient;

	const { account: usd } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const usdToken = usd.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await ownerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: usd });
	await ownerClient.modTokenSupplyAndBalance(10_000n, usdToken);
	const spending = await openAgentSpendingAccount(ownerClient, { agent, funding: [{ token: usd, amount: 500n }] });

	const lithic = fakeLithic();
	const accountsAsked: string[] = [];
	const provider = new LithicCardProvider({
		apiKey: API_KEY,
		baseURL: 'https://sandbox.lithic.test',
		asaSecret: SECRET,
		embedOrigin: 'https://wallet.keeta.test/agents',
		fetch: lithic.fetcher,
		accountFor: async function(input) {
			accountsAsked.push(input.storage.publicKeyString.get());
			return('acct_owner_verified');
		}
	});

	const server = new KeetaNetCardsAnchorHTTPServer({ client: { client: ownerClient.client }, provider });
	await server.start();
	try {
		const agentCards = new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(ownerClient, spending.storage, agent) });
		const ownerCards = new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(ownerClient, spending.storage, owner) });

		const card = await agentCards.createCard({ wallet, label: 'Cloud credits', controls: { perPurchaseLimitCents: 25_00, lifetimeLimitCents: 100_00, blockedCategories: ['7995'] }});
		expect(accountsAsked).toEqual([spending.storage.publicKeyString.get()]);
		expect(card.last4).toBe('4821');
		expect(card.expiry).toBe('11/31');
		expect(card.deposit).toEqual({ chain: 'base', currency: 'usdc', address: DEPOSIT });

		const created = lithic.calls.find(function(call) { return(call.method === 'POST' && call.path === '/v1/cards'); });
		expect(created?.authorization).toBe(API_KEY);
		expect(created?.body).toEqual({
			type: 'VIRTUAL',
			account_token: 'acct_owner_verified',
			state: 'OPEN',
			memo: 'Cloud credits',
			spend_limit: 25_00,
			spend_limit_duration: 'TRANSACTION',
			tags: { keeta_storage: spending.storage.publicKeyString.get() }
		});

		const asa = async function(body: unknown, headers?: { [name: string]: string }) {
			const text = JSON.stringify(body);
			const response = await fetch(new URL('/api/cards/lithic/asa', server.url), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(headers ?? sign(text)) },
				body: text
			});
			const answer: unknown = await response.json();
			const result = typeof answer === 'object' && answer !== null && 'result' in answer ? answer.result : undefined;
			return({ status: response.status, body: answer, result });
		};

		const approved = asaRequest(card.id, 20_00, '5734');
		expect(await asa(approved)).toMatchObject({ status: 200, body: { result: 'APPROVED', token: approved.token }});
		expect((await asa(asaRequest(card.id, 30_00, '5734'))).result).toBe('VELOCITY_EXCEEDED');
		expect((await asa(asaRequest(card.id, 5_00, '7995'))).result).toBe('UNAUTHORIZED_MERCHANT');
		expect((await asa(asaRequest(card.id, 5_00, '5734', 'CREDIT_AUTHORIZATION'))).result).toBe('APPROVED');
		expect((await asa(asaRequest(card.id, 5_00, '5734', 'SOMETHING_NEW'))).result).toBe('SUSPECTED_FRAUD');
		expect((await agentCards.getCard(card.id)).spentCents).toBe(20_00);

		/* Lithic's retry (or a replay) of the same authorization is answered the same and counted once */
		expect((await asa(approved)).body).toEqual({ result: 'APPROVED', token: approved.token });
		expect((await agentCards.getCard(card.id)).spentCents).toBe(20_00);

		/* Unsigned or forged requests are refused before any decision */
		expect((await asa(approved, { 'webhook-id': 'msg_1', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,Zm9yZ2Vk' })).status).toBe(401);
		expect((await asa(approved, {})).status).toBe(401);

		/* Freeze, owner-only unfreeze and limits map onto Lithic card updates */
		await agentCards.freezeCard(card.id);
		expect(lithic.cards.get(card.id)?.state).toBe('PAUSED');
		await expect(agentCards.unfreezeCard(card.id)).rejects.toThrow(/delegates/);
		await ownerCards.unfreezeCard(card.id);
		expect(lithic.cards.get(card.id)?.state).toBe('OPEN');
		await ownerCards.updateControls(card.id, { lifetimeLimitCents: 150_00 });
		expect(lithic.cards.get(card.id)).toMatchObject({ spend_limit: 150_00, spend_limit_duration: 'FOREVER' });

		/* Reveal is a Lithic embed session, never the card number */
		const reveal = await agentCards.revealCard(card.id, 'nonce-1234567890');
		expect(reveal).toMatchObject({ provider: 'lithic', token: `embed_${card.id}` });
		expect(JSON.stringify(reveal)).not.toMatch(/\d{12,}/);

		/* After revoke the next purchase is declined and the card paused at Lithic */
		await revokeAgentSpending(ownerClient, spending);
		const afterRevoke = asaRequest(card.id, 5_00, '5734');
		expect((await asa(afterRevoke)).body).toEqual({ result: 'CARD_PAUSED', token: afterRevoke.token });
		/* Paused at Lithic just after the answer, off the ASA time budget */
		for (let attempt = 0; attempt < 50 && lithic.cards.get(card.id)?.state !== 'PAUSED'; attempt++) {
			await new Promise(function(resolve) { setTimeout(resolve, 10); });
		}
		expect(lithic.cards.get(card.id)?.state).toBe('PAUSED');
		expect((await ownerCards.getCard(card.id)).statusReason).toBe('delegate_revoked');

		/* A single-use card is a Lithic SINGLE_USE card */
		const once = await ownerCards.createCard({ wallet, controls: { singleUse: true }});
		expect(lithic.cards.get(once.id)?.type).toBe('SINGLE_USE');
		await ownerCards.closeCard(once.id);
		expect(lithic.cards.get(once.id)?.state).toBe('CLOSED');
	} finally {
		await server.stop();
	}
});

test('Lithic accounts without a ledger, rate limits and reveal sessions (found against the sandbox)', async function() {
	const lithic = fakeLithic({ ledger: false, rateLimitWrites: 2 });
	const provider = new LithicCardProvider({
		baseURL: 'https://sandbox.lithic.test',
		embedOrigin: 'https://wallet.keeta.test/agents',
		fetch: lithic.fetcher,
		accountFor: async function() { return('acct_no_ledger'); }
	});

	const card = await provider.createCard({ owner: newAccount(), storage: newAccount(), wallet, controls: { perPurchaseLimitCents: 25_00 }, label: 'No ledger' });
	expect(card.deposit).toBeUndefined();
	expect(lithic.cards.get(card.providerCardID)?.spend_limit).toBe(25_00);

	/* The deposit lookup runs first, so a failing one never leaves a card behind; two 429s were retried */
	expect(lithic.calls.map(function(call) { return(`${call.method} ${call.path.split('?')[0]}`); })).toEqual([
		'GET /v1/financial_accounts', 'POST /v1/cards', 'POST /v1/cards', 'POST /v1/cards'
	]);

	/* No key is configured, so none is sent: the proxy in front adds it */
	expect(lithic.calls[0]?.authorization).toBeNull();

	await provider.createRevealToken(card.providerCardID, 'nonce');
	expect(lithic.calls.at(-1)?.body).toMatchObject({ type: 'CARD_EMBED', target_origin: 'https://wallet.keeta.test' });

	const noOrigin = new LithicCardProvider({ baseURL: 'https://sandbox.lithic.test', fetch: lithic.fetcher, accountFor: async function() { return('acct_no_ledger'); } });
	await expect(noOrigin.createRevealToken(card.providerCardID, 'nonce')).rejects.toThrow(/embedOrigin/);

	/* Closing twice (Lithic closes used single-use cards itself) is fine; other changes to a closed card are not */
	await provider.closeCard(card.providerCardID);
	await provider.closeCard(card.providerCardID);
	await expect(provider.freezeCard(card.providerCardID)).rejects.toMatchObject({ status: 405 });

	const failing = fakeLithic({ rateLimitWrites: 10 });
	const limited = new LithicCardProvider({ baseURL: 'https://sandbox.lithic.test', fetch: failing.fetcher, accountFor: async function() { return('acct'); } });
	await expect(limited.createCard({ owner: newAccount(), storage: newAccount(), wallet, controls: {}})).rejects.toMatchObject({ status: 429 });
});

test('the Lithic ASA route fails closed without its secret', async function() {
	const lithic = fakeLithic();
	const accountFor = async function() { return('acct'); };
	const unsigned = new LithicCardProvider({ baseURL: 'https://sandbox.lithic.test', fetch: lithic.fetcher, accountFor });
	const route = unsigned.routes()['POST /api/cards/lithic/asa'];
	if (typeof route !== 'object' || route.bodyType !== 'raw') {
		throw(new Error('ASA route missing'));
	}

	const body = Buffer.from(JSON.stringify(asaRequest('card_1', 1_00, '5734')));
	const answer = await route.handler(new Map(), body, {}, new URL('http://localhost/api/cards/lithic/asa'));
	expect(answer).toMatchObject({ statusCode: 503 });

	expect(function() {
		return(new LithicCardProvider({ baseURL: LITHIC_PRODUCTION_URL, allowUnsignedWebhooks: true, accountFor }));
	}).toThrow(/production/);
});
