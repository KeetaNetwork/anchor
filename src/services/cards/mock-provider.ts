/**
 * An in-memory card issuer for tests and local development.
 *
 * It behaves like Stripe Issuing with Bridge non-custodial funding, as their
 * documentation describes it:
 *  - Each card spends from a stablecoin wallet that approved the issuer's
 *    spender contract (an ERC-20 allowance).
 *  - At authorization the issuer declines if the approval or the wallet
 *    balance is too low, otherwise asks the platform in real time, then pulls
 *    the amount from the wallet.  Nothing is held in a card balance.
 *  - Refunds go back to the wallet.
 *
 * USDC amounts use 6 decimals, so one cent is 10,000 base units.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { CardAuthorizationDecision, CardAuthorizationRequest, CardControls, CardMerchant, CardRevealToken } from './common.js';
import type { CardProvider, CardProviderCard, CardProviderCreateInput } from './provider.js';

import { centsToUSDCUnits } from './wallet.js';

export { USDC_UNITS_PER_CENT, centsToUSDCUnits } from './wallet.js';

/**
 * A tiny stand-in for a stablecoin contract on an EVM chain: balances and
 * allowances, keyed by lower-case address.
 */
export class MockStablecoinLedger {
	readonly #balances = new Map<string, bigint>();
	readonly #allowances = new Map<string, bigint>();

	balanceOf(address: string): bigint {
		return(this.#balances.get(address.toLowerCase()) ?? 0n);
	}

	allowance(owner: string, spender: string): bigint {
		return(this.#allowances.get(`${owner.toLowerCase()}:${spender.toLowerCase()}`) ?? 0n);
	}

	/** Credit a wallet, as a bridge or asset-movement anchor delivering funds would */
	mint(address: string, units: bigint): void {
		this.#balances.set(address.toLowerCase(), this.balanceOf(address) + units);
	}

	/** The wallet owner's ERC-20 approve() */
	approve(owner: string, spender: string, units: bigint): void {
		this.#allowances.set(`${owner.toLowerCase()}:${spender.toLowerCase()}`, units);
	}

	/** The wallet owner's transfer(), for sweeps back */
	transfer(from: string, to: string, units: bigint): void {
		const balance = this.balanceOf(from);
		if (balance < units) {
			throw(new Error('transfer amount exceeds balance'));
		}

		this.#balances.set(from.toLowerCase(), balance - units);
		this.mint(to, units);
	}

	/** The spender's transferFrom() */
	transferFrom(spender: string, from: string, to: string, units: bigint): void {
		const allowed = this.allowance(from, spender);
		if (allowed < units) {
			throw(new Error('transfer amount exceeds allowance'));
		}

		this.transfer(from, to, units);
		this.approve(from, spender, allowed - units);
	}
}

type MockCard = {
	providerCardID: string;
	owner: string;
	walletAddress: string;
	status: 'active' | 'frozen' | 'closed';
	controls: CardControls;
	purchases: { amountCents: number; merchant: CardMerchant; }[];
};

export type MockPurchaseResult = CardAuthorizationDecision | { approved: false; reason: 'issuer_declined'; detail: string; };

export class MockCardProvider implements CardProvider {
	readonly name = 'mock';
	readonly ledger: MockStablecoinLedger;
	/** The issuer's spender contract that wallets approve */
	readonly spender: string;
	/** Where pulled funds settle */
	readonly settlementAddress: string;

	readonly #cards = new Map<string, MockCard>();
	readonly #customers = new Set<string>();
	#authorizer: ((request: CardAuthorizationRequest) => Promise<CardAuthorizationDecision>) | null = null;

	constructor(options?: { ledger?: MockStablecoinLedger; spender?: string; settlementAddress?: string; }) {
		this.ledger = options?.ledger ?? new MockStablecoinLedger();
		this.spender = options?.spender ?? '0x8cc0d9e8a157b73d1172a22f5066048bda46c0e3';
		this.settlementAddress = options?.settlementAddress ?? '0x000000000000000000000000000000000000dead';
	}

	/**
	 * Mark an owner as having an approved card customer (the Bridge `cards`
	 * endorsement).  Owners without one cannot be issued cards.
	 */
	approveCustomer(ownerPublicKey: string): void {
		this.#customers.add(ownerPublicKey);
	}

	/**
	 * Where real-time authorization requests go.  The cards anchor server
	 * registers itself here when given this provider.
	 */
	setAuthorizer(authorizer: (request: CardAuthorizationRequest) => Promise<CardAuthorizationDecision>): void {
		this.#authorizer = authorizer;
	}

	async createCard(input: CardProviderCreateInput): Promise<CardProviderCard> {
		const owner = input.owner.publicKeyString.get();
		if (!this.#customers.has(owner)) {
			throw(new Error('The owner has no approved card customer with the issuer'));
		}

		const providerCardID = `ic_mock_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
		const last4 = String(randomInt(1000, 10000));
		const expiryDate = new Date();
		expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + 3);
		const expiry = `${String(expiryDate.getUTCMonth() + 1).padStart(2, '0')}/${String(expiryDate.getUTCFullYear()).slice(2)}`;

		this.#cards.set(providerCardID, {
			providerCardID,
			owner,
			walletAddress: input.wallet.address,
			status: 'active',
			controls: { ...input.controls },
			purchases: []
		});

		return({ providerCardID, last4, expiry });
	}

	#card(providerCardID: string): MockCard {
		const card = this.#cards.get(providerCardID);
		if (!card) {
			throw(new Error(`Unknown card ${providerCardID}`));
		}

		return(card);
	}

	async freezeCard(providerCardID: string): Promise<void> {
		const card = this.#card(providerCardID);
		if (card.status !== 'closed') {
			card.status = 'frozen';
		}
	}

	async unfreezeCard(providerCardID: string): Promise<void> {
		const card = this.#card(providerCardID);
		if (card.status === 'closed') {
			throw(new Error('A closed card cannot be unfrozen'));
		}

		card.status = 'active';
	}

	async closeCard(providerCardID: string): Promise<void> {
		this.#card(providerCardID).status = 'closed';
	}

	async updateControls(providerCardID: string, controls: CardControls): Promise<void> {
		this.#card(providerCardID).controls = { ...controls };
	}

	async createRevealToken(providerCardID: string, clientNonce: string): Promise<CardRevealToken> {
		const card = this.#card(providerCardID);
		if (card.status === 'closed') {
			throw(new Error('A closed card cannot be revealed'));
		}

		return({
			provider: this.name,
			token: `ephemeral_key_mock_${clientNonce.slice(0, 8)}_${randomUUID().slice(0, 8)}`,
			expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
		});
	}

	issuerStatus(providerCardID: string): MockCard['status'] {
		return(this.#card(providerCardID).status);
	}

	purchases(providerCardID: string): MockCard['purchases'] {
		return([...this.#card(providerCardID).purchases]);
	}

	/**
	 * Simulate a purchase at a merchant, the way a sandbox "test helper"
	 * authorization works: issuer checks, then the platform's real-time
	 * decision, then the onchain pull.
	 */
	async simulatePurchase(providerCardID: string, amountCents: number, merchant: CardMerchant): Promise<MockPurchaseResult> {
		const card = this.#card(providerCardID);
		if (card.status !== 'active') {
			return({ approved: false, reason: 'issuer_declined', detail: `card is ${card.status}` });
		}

		const units = centsToUSDCUnits(amountCents);
		if (this.ledger.allowance(card.walletAddress, this.spender) < units) {
			return({ approved: false, reason: 'issuer_declined', detail: 'wallet approval is lower than the amount' });
		}

		if (this.ledger.balanceOf(card.walletAddress) < units) {
			return({ approved: false, reason: 'issuer_declined', detail: 'wallet balance is lower than the amount' });
		}

		if (!this.#authorizer) {
			throw(new Error('No authorizer registered with the mock card provider'));
		}

		const decision = await this.#authorizer({ cardID: providerCardID, amountCents, merchant });
		if (!decision.approved) {
			return(decision);
		}

		this.ledger.transferFrom(this.spender, card.walletAddress, this.settlementAddress, units);
		card.purchases.push({ amountCents, merchant });

		return(decision);
	}

	/** Simulate a merchant refund: funds return to the card's wallet */
	async simulateRefund(providerCardID: string, amountCents: number): Promise<void> {
		const card = this.#card(providerCardID);
		this.ledger.transfer(this.settlementAddress, card.walletAddress, centsToUSDCUnits(amountCents));
	}
}
