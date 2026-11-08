import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { agentSpendingClient, openAgentSpendingAccount, revokeAgentSpending } from '../../lib/agent-spending.js';
import { KeetaCardsAnchorClient } from './client.js';
import { MockCardProvider, centsToUSDCUnits } from './mock-provider.js';
import { CARD_AGENT_OPERATIONS } from './common.js';
import { KeetaNetCardsAnchorHTTPServer, tokenUnitsToCents } from './server.js';
import type { KeetaAnchorCardsServerConfig } from './server.js';

function newAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

const groceries = { name: 'Corner Grocer', categoryCode: '5411' };
const casino = { name: 'Lucky Casino', categoryCode: '7995' };
const walletAddress = '0x' + 'ab'.repeat(20);
const wallet = { chain: 'base', currency: 'usdc', address: walletAddress };

async function setup(extra: (usd: InstanceType<typeof KeetaNet.lib.Account>) => Partial<KeetaAnchorCardsServerConfig> = function() { return({}); }) {
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

	const server = new KeetaNetCardsAnchorHTTPServer({ client: { client: ownerClient.client }, provider, delegateOperations: CARD_AGENT_OPERATIONS, ...extra(usd) });
	await server.start();

	const cardsFor = function(storage: InstanceType<typeof KeetaNet.lib.Account>, signer: InstanceType<typeof KeetaNet.lib.Account>) {
		return(new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(ownerClient, storage, signer) }));
	};

	/* The owner approves the Base wallet for both accounts' agents */
	await cardsFor(spending.storage, owner).registerWallet(wallet);
	await cardsFor(otherSpending.storage, owner).registerWallet(wallet);

	return({
		owner, agent, otherAgent, ownerClient, usd, spending, otherSpending, provider, server, cardsFor,
		async [Symbol.asyncDispose]() {
			await server.stop();
			await nodeAndClient[Symbol.asyncDispose]();
		}
	});
}

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

test('with funding tokens, purchases cannot spend past the storage account balance', async function() {
	/* usd has 2 decimals here, so the agent's 500 units are 5.00 */
	await using env = await setup(function(usd) { return({ fundingTokens: [{ token: usd.publicKeyString.get(), decimals: 2 }] }); });
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const card = await agentCards.createCard({ wallet });

	expect(await env.provider.simulatePurchase(card.id, 5_01, groceries)).toEqual({ approved: false, reason: 'insufficient_funds' });
	expect(await env.provider.simulatePurchase(card.id, 5_00, groceries)).toEqual({ approved: true });
	expect((await agentCards.getCard(card.id)).spentCents).toBe(5_00);

	/* Once the owner revokes and the balance is swept, the revoke wins */
	await revokeAgentSpending(env.ownerClient, env.spending);
	expect(await env.provider.simulatePurchase(card.id, 1, groceries)).toEqual({ approved: false, reason: 'delegate_revoked' });
});

test('token balances convert to whole cents, rounded down', function() {
	expect(tokenUnitsToCents(12_345_678n, 6)).toBe(1234);
	expect(tokenUnitsToCents(500n, 2)).toBe(500);
	expect(tokenUnitsToCents(3n, 0)).toBe(300);
	expect(tokenUnitsToCents(10n ** 40n, 6)).toBe(Number.MAX_SAFE_INTEGER);
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
	await using server = new KeetaNetCardsAnchorHTTPServer({ client: { client: env.ownerClient.client }, provider: env.provider, defaultControls: ceiling, delegateOperations: CARD_AGENT_OPERATIONS });
	await server.start();
	const client = function(signer: InstanceType<typeof KeetaNet.lib.Account>) {
		return(new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(env.ownerClient, env.spending.storage, signer) }));
	};
	await client(env.owner).registerWallet(wallet);

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

	/* The revoked agent may still hold the numbers: no purchase goes through, and the owner can't unfreeze */
	expect(await env.provider.simulatePurchase(first.id, 1_00, groceries)).toMatchObject({ approved: false });
	expect(await env.server.authorize({ cardID: first.id, amountCents: 1_00, merchant: groceries })).toEqual({ approved: false, reason: 'card_not_active' });
	await expect(ownerCards.unfreezeCard(first.id)).rejects.toThrow(/Grant the agent access again/);
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
	await using server = new KeetaNetCardsAnchorHTTPServer({ client: { client: env.ownerClient.client }, provider: unapproved, delegateOperations: CARD_AGENT_OPERATIONS });
	await server.start();
	const cards = new KeetaCardsAnchorClient({ baseURL: server.url, client: agentSpendingClient(env.ownerClient, env.spending.storage, env.agent) });
	await expect(cards.createCard({ wallet })).rejects.toThrow();
});

test('agents only fund cards from wallets the owner registered', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);
	const other = { chain: 'base', currency: 'usdc', address: '0x' + 'ef'.repeat(20) };
	const ownersPick = { chain: 'base', currency: 'usdc', address: '0x' + '12'.repeat(20) };

	await expect(agentCards.createCard({ wallet: other })).rejects.toThrow(/wallet the owner registered/);
	await expect(agentCards.registerWallet(other)).rejects.toThrow(/not available to storage account delegates/);

	/* Registered by the owner: the agent can use it, in any letter case */
	await ownerCards.registerWallet(other);
	const card = await agentCards.createCard({ wallet: { ...other, address: other.address.toUpperCase().replace('0X', '0x') }});
	expect(card.walletSource).toBe('registered');

	/* A wallet the owner names on its own card is approved by that, and listed for the agent */
	expect((await ownerCards.createCard({ wallet: ownersPick })).walletSource).toBe('owner');
	const listed = await agentCards.listWallets();
	expect(listed.map(function(entry) { return(entry.address); })).toEqual([walletAddress, other.address, ownersPick.address]);
	expect(listed[0]?.registeredBy).toBe(env.owner.publicKeyString.get());

	/* Without delegateOperations, agents can sign nothing */
	await using closedServer = new KeetaNetCardsAnchorHTTPServer({ client: { client: env.ownerClient.client }, provider: env.provider });
	await closedServer.start();
	const viaClosed = new KeetaCardsAnchorClient({ baseURL: closedServer.url, client: agentSpendingClient(env.ownerClient, env.spending.storage, env.agent) });
	await expect(viaClosed.listCards()).rejects.toThrow(/not available to storage account delegates/);
});

test('a revoke-frozen card comes back only with a new number or a new grant', async function() {
	await using env = await setup();
	const agentCards = env.cardsFor(env.spending.storage, env.agent);
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);

	const kept = await agentCards.createCard({ wallet, label: 'Office', controls: { lifetimeLimitCents: 50_00 }});
	const granted = await agentCards.createCard({ wallet, label: 'Cloud' });
	expect(await env.provider.simulatePurchase(kept.id, 20_00, groceries)).toEqual({ approved: true });

	await revokeAgentSpending(env.ownerClient, { agent: env.agent, storage: env.spending.storage });
	await ownerCards.freezeAgentCards(env.agent);

	/* Only to someone who can act for the account now */
	await expect(ownerCards.replaceCard(kept.id, env.agent)).rejects.toThrow(/no grant/);
	await expect(agentCards.replaceCard(kept.id)).rejects.toThrow();

	/* A new number for the owner: the old one is dead, the limits and spend carry over */
	const replacement = await ownerCards.replaceCard(kept.id);
	expect(replacement).toMatchObject({ status: 'active', label: 'Office', replaces: kept.id, spentCents: 20_00, controls: { lifetimeLimitCents: 50_00 }, createdBy: env.owner.publicKeyString.get() });
	expect(replacement.id).not.toBe(kept.id);
	expect(await ownerCards.getCard(kept.id)).toMatchObject({ status: 'closed', statusReason: 'replaced' });
	expect(env.provider.issuerStatus(kept.id)).toBe('closed');
	expect(await env.provider.simulatePurchase(kept.id, 1_00, groceries)).toMatchObject({ approved: false });
	expect(await env.provider.simulatePurchase(replacement.id, 40_00, groceries)).toEqual({ approved: false, reason: 'over_lifetime_limit' });
	expect(await env.provider.simulatePurchase(replacement.id, 30_00, groceries)).toEqual({ approved: true });

	/* Granting the agent access again lets the owner unfreeze its other card */
	await expect(ownerCards.unfreezeCard(granted.id)).rejects.toThrow(/Grant the agent access again/);
	const builder = env.ownerClient.initBuilder();
	builder.updatePermissions(env.agent, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, undefined, { account: env.spending.storage });
	await env.ownerClient.publishBuilder(builder);

	expect(await ownerCards.unfreezeCard(granted.id)).toMatchObject({ status: 'active' });
	expect(env.provider.issuerStatus(granted.id)).toBe('active');
	expect(await env.provider.simulatePurchase(granted.id, 5_00, groceries)).toEqual({ approved: true });
});

test('a replacement the issuer fails to issue says the old card is closed', async function() {
	await using env = await setup();
	const ownerCards = env.cardsFor(env.spending.storage, env.owner);
	const card = await ownerCards.createCard({ wallet });
	env.provider.createCard = async function() {
		throw(new Error('issuer down'));
	};

	await expect(ownerCards.replaceCard(card.id)).rejects.toThrow(/old card is closed/);
	expect(await ownerCards.getCard(card.id)).toMatchObject({ status: 'closed', statusReason: 'replaced' });
});
