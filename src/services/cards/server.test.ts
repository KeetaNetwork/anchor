import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { agentSpendingClient, openAgentSpendingAccount, revokeAgentSpending } from '../../lib/agent-spending.js';
import { KeetaCardsAnchorClient } from './client.js';
import { MockCardProvider, centsToUSDCUnits } from './mock-provider.js';
import { KeetaNetCardsAnchorHTTPServer } from './server.js';

function newAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

const groceries = { name: 'Corner Grocer', categoryCode: '5411' };
const casino = { name: 'Lucky Casino', categoryCode: '7995' };
const walletAddress = '0x' + 'ab'.repeat(20);

async function setup() {
	const owner = newAccount();
	const agent = newAccount();
	const otherAgent = newAccount();

	const nodeAndClient = await createNodeAndClient(owner);
	const ownerClient = nodeAndClient.userClient;

	const { account: usd } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const usdToken = usd.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await ownerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: usd });
	await ownerClient.modTokenSupplyAndBalance(10_000n, usdToken);

	const spending = await openAgentSpendingAccount(ownerClient, { agent, funding: [{ token: usd, amount: 500n }] });
	const otherSpending = await openAgentSpendingAccount(ownerClient, { agent: otherAgent, funding: [{ token: usd, amount: 500n }] });

	const provider = new MockCardProvider();
	provider.approveCustomer(owner.publicKeyString.get());

	/* The owner's Base wallet: funded and approved for the issuer's spender */
	provider.ledger.mint(walletAddress, centsToUSDCUnits(200_00));
	provider.ledger.approve(walletAddress, provider.spender, centsToUSDCUnits(150_00));

	const server = new KeetaNetCardsAnchorHTTPServer({ client: { client: ownerClient.client }, provider });
	await server.start();

	const cardsFor = function(storage: InstanceType<typeof KeetaNet.lib.Account>, signer: InstanceType<typeof KeetaNet.lib.Account>) {
		return(new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(ownerClient, storage, signer) }));
	};

	return({
		owner, agent, otherAgent, ownerClient, usd, spending, otherSpending, provider, server, cardsFor,
		async [Symbol.asyncDispose]() {
			await server.stop();
			await nodeAndClient[Symbol.asyncDispose]();
		}
	});
}

const wallet = { chain: 'base', currency: 'usdc', address: walletAddress };

/* Issuer calls made after answering an authorization land a moment later */
async function eventually(check: () => void | Promise<void>): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await check();
			return;
		} catch (error) {
			if (attempt >= 50) {
				throw(error);
			}

			await new Promise(function(resolve) { setTimeout(resolve, 10); });
		}
	}
}

test('an agent issues a card and its purchases follow the anchor rules', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);

	const card = await agentCards.createCard({
		wallet,
		label: 'Groceries',
		controls: { perPurchaseLimitCents: 80_00, lifetimeLimitCents: 120_00, blockedCategories: ['7995'] }
	});
	expect(card.status).toBe('active');
	expect(card.createdBy).toBe(env.agent.publicKeyString.get());
	expect(card.account).toBe(env.spending.storage.publicKeyString.get());

	/* The card is listed for the storage account, by the owner too */
	expect((await ownerCards.listCards()).map(function(c) { return(c.id); })).toEqual([card.id]);

	expect(await env.provider.simulatePurchase(card.id, 50_00, groceries)).toEqual({ approved: true });
	expect(env.provider.ledger.balanceOf(walletAddress)).toBe(centsToUSDCUnits(150_00));

	expect(await env.provider.simulatePurchase(card.id, 90_00, groceries)).toEqual({ approved: false, reason: 'over_per_purchase_limit' });
	expect(await env.provider.simulatePurchase(card.id, 10_00, casino)).toEqual({ approved: false, reason: 'merchant_category_blocked' });
	expect(await env.provider.simulatePurchase(card.id, 75_00, groceries)).toEqual({ approved: false, reason: 'over_lifetime_limit' });

	const after = await agentCards.getCard(card.id);
	expect(after.spentCents).toBe(50_00);

	/* Declines leave the wallet alone; refunds go back to it */
	await env.provider.simulateRefund(card.id, 20_00);
	expect(env.provider.ledger.balanceOf(walletAddress)).toBe(centsToUSDCUnits(170_00));

	/* Reveal returns an issuer token, never a card number */
	const reveal = await agentCards.revealCard(card.id, 'nonce-1234567890');
	expect(reveal.provider).toBe('mock');
	expect(JSON.stringify(reveal)).not.toMatch(/\d{12,}/);
});

test('the issuer declines when the wallet approval or balance is too low', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const card = await agentCards.createCard({ wallet });

	const overApproval = await env.provider.simulatePurchase(card.id, 160_00, groceries);
	expect(overApproval).toMatchObject({ approved: false, reason: 'issuer_declined' });

	env.provider.ledger.approve(walletAddress, env.provider.spender, centsToUSDCUnits(1_000_00));
	const overBalance = await env.provider.simulatePurchase(card.id, 250_00, groceries);
	expect(overBalance).toMatchObject({ approved: false, reason: 'issuer_declined', detail: 'wallet balance is lower than the amount' });
	expect((await agentCards.getCard(card.id)).spentCents).toBe(0);
});

test('agents can freeze but only the owner can unfreeze or change limits', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);
	const card = await agentCards.createCard({ wallet });

	expect((await agentCards.freezeCard(card.id)).status).toBe('frozen');
	expect(env.provider.issuerStatus(card.id)).toBe('frozen');
	expect(await env.provider.simulatePurchase(card.id, 1_00, groceries)).toMatchObject({ approved: false });

	await expect(agentCards.unfreezeCard(card.id)).rejects.toThrow(/not available to storage account delegates/);
	await expect(agentCards.updateControls(card.id, { perPurchaseLimitCents: 1_000_00 })).rejects.toThrow(/not available to storage account delegates/);

	expect((await ownerCards.unfreezeCard(card.id)).status).toBe('active');
	expect((await ownerCards.updateControls(card.id, { perPurchaseLimitCents: 5_00 })).controls).toEqual({ perPurchaseLimitCents: 5_00 });
	expect(await env.provider.simulatePurchase(card.id, 6_00, groceries)).toEqual({ approved: false, reason: 'over_per_purchase_limit' });

	expect((await agentCards.closeCard(card.id)).status).toBe('closed');
	expect(env.provider.issuerStatus(card.id)).toBe('closed');
	await expect(ownerCards.unfreezeCard(card.id)).rejects.toThrow(/closed/);
});

test('revoking the agent declines and freezes its cards', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const card = await agentCards.createCard({ wallet });
	expect(await env.provider.simulatePurchase(card.id, 10_00, groceries)).toEqual({ approved: true });

	await revokeAgentSpending(env.ownerClient, { agent: env.agent, storage: env.spending.storage });

	/* The issuer still sees an active card, so it asks; the anchor says no */
	expect(await env.provider.simulatePurchase(card.id, 10_00, groceries)).toEqual({ approved: false, reason: 'delegate_revoked' });
	await eventually(function() { expect(env.provider.issuerStatus(card.id)).toBe('frozen'); });

	/* The revoked agent can no longer reach the card */
	await expect(agentCards.getCard(card.id)).rejects.toThrow(/Invalid signature/);
	const ownerView = await env.cardsFor(env.spending.storage, env.owner).getCard(card.id);
	expect(ownerView).toMatchObject({ status: 'frozen', statusReason: 'delegate_revoked' });
});

test('a failing issuer freeze does not turn a revoked decline into an error', async function() {
	await using env = await setup();
	const card = await env.cardsFor(env.spending.storage, env.agent).createCard({ wallet });
	await revokeAgentSpending(env.ownerClient, { agent: env.agent, storage: env.spending.storage });

	env.provider.freezeCard = async function() {
		throw(new Error('issuer is down'));
	};
	expect(await env.server.authorize({ cardID: card.id, amountCents: 1_00, merchant: groceries })).toEqual({ approved: false, reason: 'delegate_revoked' });
});

test('concurrent purchases cannot overspend the lifetime limit or reuse a single-use card', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const limited = await agentCards.createCard({ wallet, controls: { lifetimeLimitCents: 100_00 }});

	const results = await Promise.all([
		env.server.authorize({ cardID: limited.id, amountCents: 90_00, merchant: groceries }),
		env.server.authorize({ cardID: limited.id, amountCents: 90_00, merchant: groceries })
	]);
	expect(results.filter(function(result) { return(result.approved); })).toHaveLength(1);
	expect(results).toContainEqual({ approved: false, reason: 'over_lifetime_limit' });
	expect((await agentCards.getCard(limited.id)).spentCents).toBe(90_00);

	const once = await agentCards.createCard({ wallet, controls: { singleUse: true }});
	const onceResults = await Promise.all([1, 2, 3].map(function() {
		return(env.server.authorize({ cardID: once.id, amountCents: 5_00, merchant: groceries }));
	}));
	expect(onceResults.filter(function(result) { return(result.approved); })).toHaveLength(1);

	/* An issuer retry of the same authorization gets the same answer and counts once */
	const retried = await agentCards.createCard({ wallet });
	const first = await env.server.authorize({ cardID: retried.id, amountCents: 7_00, merchant: groceries, authorizationID: 'auth_1' });
	const again = await env.server.authorize({ cardID: retried.id, amountCents: 7_00, merchant: groceries, authorizationID: 'auth_1' });
	expect(again).toEqual(first);
	expect((await agentCards.getCard(retried.id)).spentCents).toBe(7_00);

	/* A status change made meanwhile keeps the recorded spend */
	await agentCards.freezeCard(retried.id);
	expect((await agentCards.getCard(retried.id)).spentCents).toBe(7_00);
});

test('an agent can only tighten the operator\'s default controls', async function() {
	await using env = await setup();
	const ceiling = { perPurchaseLimitCents: 50_00, lifetimeLimitCents: 200_00, blockedCategories: ['7995'] };
	await using server = new KeetaNetCardsAnchorHTTPServer({ client: { client: env.ownerClient.client }, provider: env.provider, defaultControls: ceiling });
	await server.start();
	const client = function(signer: InstanceType<typeof KeetaNet.lib.Account>) {
		return(new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(env.ownerClient, env.spending.storage, signer) }));
	};

	const loose = await client(env.agent).createCard({ wallet, controls: { perPurchaseLimitCents: 999_00, lifetimeLimitCents: 100_00, blockedCategories: ['5813'] }});
	expect(loose.controls).toEqual({ perPurchaseLimitCents: 50_00, lifetimeLimitCents: 100_00, blockedCategories: ['7995', '5813'] });

	const none = await client(env.agent).createCard({ wallet, controls: {}});
	expect(none.controls).toEqual(ceiling);

	/* The owner may set looser limits */
	const owners = await client(env.owner).createCard({ wallet, controls: { perPurchaseLimitCents: 999_00 }});
	expect(owners.controls.perPurchaseLimitCents).toBe(999_00);
});

test('an agent only sees and acts on the cards it made', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);
	const agents = await agentCards.createCard({ wallet, label: 'Agent' });
	const owners = await ownerCards.createCard({ wallet, label: 'Owner' });

	expect((await agentCards.listCards()).map(function(card) { return(card.id); })).toEqual([agents.id]);
	expect((await ownerCards.listCards()).map(function(card) { return(card.id); }).sort()).toEqual([agents.id, owners.id].sort());
	await expect(agentCards.revealCard(owners.id, 'nonce-1234567890')).rejects.toThrow(/Card not found/);
	await expect(agentCards.closeCard(owners.id)).rejects.toThrow(/Card not found/);
	await expect(agentCards.getCard(owners.id)).rejects.toThrow(/Card not found/);
	expect(env.provider.issuerStatus(owners.id)).toBe('active');

	/* Closed cards keep their limits */
	await ownerCards.closeCard(owners.id);
	await expect(ownerCards.updateControls(owners.id, { perPurchaseLimitCents: 1_00 })).rejects.toThrow(/closed/);
});

test('revoking the agent freezes all of its cards at once', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);
	const agentKey = env.agent.publicKeyString.get();

	const first = await agentCards.createCard({ wallet, label: 'Office' });
	const second = await agentCards.createCard({ wallet, label: 'Cloud' });
	const pausedByAgent = await agentCards.createCard({ wallet, label: 'Paused' });
	await agentCards.freezeCard(pausedByAgent.id);
	const closed = await agentCards.createCard({ wallet, label: 'Done' });
	await agentCards.closeCard(closed.id);
	const ownersOwn = await ownerCards.createCard({ wallet, label: 'Owner' });

	/* Only the owner may ask */
	await expect(agentCards.freezeAgentCards(agentKey)).rejects.toThrow(/not available to storage account delegates/);

	await revokeAgentSpending(env.ownerClient, { agent: env.agent, storage: env.spending.storage });

	const result = await ownerCards.freezeAgentCards(env.agent);
	expect(result.failed).toEqual([]);
	expect(result.cards.map(function(card) { return(card.id); }).sort()).toEqual([first.id, second.id, pausedByAgent.id].sort());
	for (const card of result.cards) {
		expect(card).toMatchObject({ status: 'frozen', statusReason: 'delegate_revoked' });
		expect(env.provider.issuerStatus(card.id)).toBe('frozen');
	}

	/* Closed cards and the owner's own cards are left as they were */
	expect(env.provider.issuerStatus(closed.id)).toBe('closed');
	expect((await ownerCards.getCard(ownersOwn.id)).status).toBe('active');

	/* The agent may still hold the numbers, so these cards only close */
	await expect(ownerCards.unfreezeCard(first.id)).rejects.toThrow(/can only be closed/);
	expect(env.provider.issuerStatus(first.id)).toBe('frozen');
	expect((await ownerCards.closeCard(first.id)).status).toBe('closed');

	/* Asking again is harmless */
	const again = await ownerCards.freezeAgentCards(agentKey);
	expect(again.cards.map(function(card) { return(card.id); }).sort()).toEqual([second.id, pausedByAgent.id].sort());

	/* The owner is not an agent, and a malformed key is an error, not an empty answer */
	await expect(ownerCards.freezeAgentCards(env.owner)).rejects.toThrow(/not the owner/);
	await expect(ownerCards.freezeAgentCards('keeta_not_a_key')).rejects.toThrow(/Invalid agent public key/);
});

test('listing cards freezes a revoked agent\'s cards the wallet missed', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);
	const card = await agentCards.createCard({ wallet });
	const other = await agentCards.createCard({ wallet });

	/* Still granted: listing changes nothing */
	expect((await ownerCards.listCards()).map(function(c) { return(c.status); })).toEqual(['active', 'active']);

	await revokeAgentSpending(env.ownerClient, { agent: env.agent, storage: env.spending.storage });

	const listed = await ownerCards.listCards();
	expect(listed.map(function(c) { return([c.status, c.statusReason]); })).toEqual([['frozen', 'delegate_revoked'], ['frozen', 'delegate_revoked']]);
	expect(env.provider.issuerStatus(card.id)).toBe('frozen');
	expect(env.provider.issuerStatus(other.id)).toBe('frozen');
});

test('cards stay within their storage account', async function() {
	await using env = await setup();
	const card = await env.cardsFor(env.spending.storage, env.agent).createCard({ wallet });

	/* Another agent of the same owner, on a different storage account */
	const otherCards = env.cardsFor(env.otherSpending.storage, env.otherAgent);
	await expect(otherCards.getCard(card.id)).rejects.toThrow(/Card not found/);
	await expect(otherCards.closeCard(card.id)).rejects.toThrow(/Card not found/);
	expect(await otherCards.listCards()).toEqual([]);

	/* The other agent signing for a storage account it has no grant on */
	await expect(env.cardsFor(env.spending.storage, env.otherAgent).listCards()).rejects.toThrow(/Invalid signature/);

	/* A stranger */
	await expect(env.cardsFor(env.spending.storage, newAccount()).createCard({ wallet })).rejects.toThrow(/Invalid signature/);
});

test('a single-use card closes after its first purchase', async function() {
	await using env = await setup();
	const card = await env.cardsFor(env.spending.storage, env.agent).createCard({ wallet, controls: { singleUse: true }});

	expect(await env.provider.simulatePurchase(card.id, 10_00, groceries)).toEqual({ approved: true });
	await new Promise(function(resolve) { setImmediate(resolve); });
	expect(env.provider.issuerStatus(card.id)).toBe('closed');
	expect(await env.provider.simulatePurchase(card.id, 1_00, groceries)).toMatchObject({ approved: false, reason: 'issuer_declined' });
});

test('a card needs an approved issuer customer and a valid wallet', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	await expect(agentCards.createCard({ wallet: { ...wallet, address: '0x1234' }})).rejects.toThrow(/20-byte/);
	await expect(agentCards.createCard({ wallet, controls: { perPurchaseLimitCents: -1 }})).rejects.toThrow(/positive/);

	const unapproved = new MockCardProvider();
	await using server = new KeetaNetCardsAnchorHTTPServer({ client: { client: env.ownerClient.client }, provider: unapproved });
	await server.start();
	const cards = new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(env.ownerClient, env.spending.storage, env.agent) });
	await expect(cards.createCard({ wallet })).rejects.toThrow();
});
