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
	expect(env.provider.issuerStatus(card.id)).toBe('frozen');

	/* The revoked agent can no longer reach the card */
	await expect(agentCards.getCard(card.id)).rejects.toThrow(/Invalid signature/);
	const ownerView = await env.cardsFor(env.spending.storage, env.owner).getCard(card.id);
	expect(ownerView).toMatchObject({ status: 'frozen', statusReason: 'delegate_revoked' });
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
