/**
 * The interface a card issuer integration implements for the cards anchor.
 *
 * The anchor owns the rules (who may act, limits, revocation).  The provider
 * only talks to the issuer: for Bridge and Stripe Issuing that means the
 * Bridge customer with its `cards` endorsement for the owner, and Stripe
 * Issuing cards funded from a non-custodial wallet.  Real-time authorization
 * requests arrive from the issuer (for Stripe, the synchronous
 * `issuing_authorization.request` webhook); the provider's webhook route
 * passes them to {@link KeetaNetCardsAnchorHTTPServer.authorize} and returns
 * the decision.
 */
import type { CardControls, CardFundingWallet, CardRevealToken } from './common.js';
import type * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Routes } from '../../lib/http-server/index.js';

type Account = InstanceType<typeof KeetaNet.lib.Account>;

export type CardProviderCreateInput = {
	/** The owner: the person or business the issuer verified */
	owner: Account;
	/** The storage account the card spends for */
	storage: Account;
	wallet: CardFundingWallet;
	controls: CardControls;
	label?: string;
};

export type CardProviderCard = {
	providerCardID: string;
	last4: string;
	expiry: string;
	/**
	 * For prepaid issuers (such as Lithic), the issuer's deposit address the
	 * card's balance is funded at.  Issuers that pull from the owner's
	 * wallet at authorization (Bridge and Stripe) leave it out.
	 */
	deposit?: CardFundingWallet;
};

export interface CardProvider {
	/** A short name for logs and reveal tokens, such as "stripe" or "mock" */
	readonly name: string;

	/**
	 * Issue a virtual card for the owner, funded from the wallet.  Fails if
	 * the owner has no approved card customer with the issuer.
	 */
	createCard(input: CardProviderCreateInput): Promise<CardProviderCard>;

	freezeCard(providerCardID: string): Promise<void>;
	unfreezeCard(providerCardID: string): Promise<void>;

	/** Permanently cancel the card */
	closeCard(providerCardID: string): Promise<void>;

	/**
	 * Mirror the anchor's limits onto the issuer's own spending controls
	 * where it supports them, as a second line of defense.  The anchor
	 * still checks every authorization itself.
	 */
	updateControls(providerCardID: string, controls: CardControls): Promise<void>;

	/** A short-lived token for the issuer's secure card display */
	createRevealToken(providerCardID: string, clientNonce: string): Promise<CardRevealToken>;

	/**
	 * HTTP routes the issuer calls, such as its real-time authorization
	 * webhook.  The cards anchor serves them next to its own.
	 */
	routes?(): Routes;
}
