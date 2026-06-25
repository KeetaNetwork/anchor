import { test, expect, describe } from 'vitest';

import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';

import { KeetaNet } from '../../client/index.js';
import { AnchorChainingPlan } from './index.js';
import { AnchorExternal } from '../anchor-external.js';
import {
	createChainingTestHarness,
	createPersistentForwardingHarness,
	collectEvents,
	defaultApproveAction,
	firstPath,
	getKeetaUsdcToUsdc2Path,
	newDestinationAccount,
	runChain,
	stripKeetaSendExternal,
	PFR_SUPPORTED_OPS,
	type ChainingTestHarness
} from './fixtures.js';

/**
 * Resolve a destination-driven (`to` affinity) USDC -> EURC FX plan for a given
 * provider and destination amount.
 */
async function eurcDestinationPlan(h: ChainingTestHarness, providerID: 'FXOne' | 'FXTwo', destinationValue: bigint): Promise<AnchorChainingPlan> {
	const plans = await h.anchorChaining.getPlans({
		source: { asset: h.tokens.USDC, location: h.keetaLocation, rail: 'KEETA_SEND' },
		destination: { asset: h.tokens.EURC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND', value: destinationValue }
	});

	const plan = plans?.find(p => p.path.some(n => n.type === 'fx' && n.providerID === providerID));
	if (!plan) {
		throw(new Error(`No FX plan found for ${providerID}`));
	}

	return(plan);
}

describe('plan preview', function() {
	test.each([
		{ providerID: 'FXOne' as const, fxOut: 88n },
		{ providerID: 'FXTwo' as const, fxOut: 85n }
	])('source-driven FX+AM via $providerID estimates each leg from the prior leg', async function({ providerID, fxOut }) {
		await using h = await createChainingTestHarness();

		const plan = await h.getPlanVia(providerID);
		expect(plan.preview.steps).toHaveLength(2);
		expect(plan.preview.totalValueIn).toEqual(100n);
		/*
		 * The bank withdrawal leg has no simulate support, so the preview carries
		 * its deposit value through unchanged; the rail fee only appears in the
		 * actual execution.
		 */
		expect(plan.preview.totalValueOut).toEqual(fxOut);

		const fxStep = plan.preview.steps.find(s => s.type === 'fx');
		expect(fxStep?.estimatedValueOut).toEqual(fxOut);
		for (let i = 0; i < plan.preview.steps.length - 1; i++) {
			expect(plan.preview.steps[i]?.estimatedValueOut).toEqual(plan.preview.steps[i + 1]?.estimatedValueIn);
		}
	});

	test.each([
		{ providerID: 'FXOne' as const, expectedValueIn: 114n },
		{ providerID: 'FXTwo' as const, expectedValueIn: 118n }
	])('destination-driven FX-only via $providerID prices the source backward', async function({ providerID, expectedValueIn }) {
		await using h = await createChainingTestHarness();

		const plan = await eurcDestinationPlan(h, providerID, 100n);
		expect(plan.preview.totalValueOut).toEqual(100n);
		expect(plan.preview.totalValueIn).toEqual(expectedValueIn);
	});

	test('destination-driven FX-only chains backward for a smaller amount', async function() {
		await using h = await createChainingTestHarness();

		const plan = await eurcDestinationPlan(h, 'FXOne', 50n);
		expect(plan.preview.totalValueIn).toEqual(57n);
		expect(plan.preview.totalValueOut).toEqual(50n);
		for (let i = 0; i < plan.preview.steps.length - 1; i++) {
			expect(plan.preview.steps[i]?.estimatedValueOut).toEqual(plan.preview.steps[i + 1]?.estimatedValueIn);
		}
	});

	test('destination affinity is rejected for paths with asset-movement legs', async function() {
		await using h = await createChainingTestHarness();

		const path = await h.getPathVia('FXOne', 'to');
		await expect(AnchorChainingPlan.create(path)).rejects.toThrow('not supported for asset movement steps');
	});

	test('providing both source.value and destination.value is rejected', async function() {
		await using h = await createChainingTestHarness();

		const path = await h.getPathVia('FXOne');
		path.request.source.value = 100n;
		path.request.destination.value = 100n;
		await expect(AnchorChainingPlan.create(path)).rejects.toThrow('Must have source.value or destination.value but not both');
	});

	test('providing neither source.value nor destination.value is rejected', async function() {
		await using h = await createChainingTestHarness();

		const path = await h.getPathVia('FXOne');
		delete path.request.source.value;
		delete path.request.destination.value;
		await expect(AnchorChainingPlan.create(path)).rejects.toThrow('Must have source.value or destination.value');
	});
});

describe('execute: FX-only (destination-driven)', function() {
	test.each([
		{ providerID: 'FXOne' as const, expectedValueIn: 114n },
		{ providerID: 'FXTwo' as const, expectedValueIn: 118n }
	])('via $providerID settles the exchange and reports state and events', async function({ providerID, expectedValueIn }) {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plan = await eurcDestinationPlan(h, providerID, 100n);
		expect(plan.preview.totalValueIn).toEqual(expectedValueIn);
		expect(plan.preview.totalValueOut).toEqual(100n);
		expect(plan.state.status).toEqual('idle');

		const { result, events } = await runChain(plan);
		expect(result.steps).toHaveLength(1);

		const step = result.steps[0];
		expect(step?.type).toEqual('fx');
		if (step?.type === 'fx') {
			expect(step.exchange.exchange.exchangeID).toBeTruthy();

			const status = await step.exchange.getExchangeStatus();
			expect(status.status).toEqual('completed');
		}

		expect(plan.state.status).toEqual('completed');
		expect(events.stateHistory[0]).toEqual('executing');
		expect(events.stateHistory[events.stateHistory.length - 1]).toEqual('completed');
		expect(events.executed).toHaveLength(1);
		expect(events.executed[0]?.step).toBe(result.steps[0]);
		expect(events.completed).toBe(result);
	});

	test('exchange failure surfaces a failed event at step 0', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await eurcDestinationPlan(h, 'FXOne', 100n);

		h.fxServerOne.failNextExchange('FX destination-driven exchange failed');
		const events = collectEvents(plan);

		// The FX leg surfaces a generic quote-unavailable error; what matters is
		// the failure lands on step 0 with nothing completed.
		await expect(plan.execute()).rejects.toThrow();
		expect(plan.state.status).toEqual('failed');
		if (plan.state.status === 'failed') {
			expect(plan.state.failedAtStepIndex).toEqual(0);
			expect(plan.state.completedSteps).toHaveLength(0);
		}

		expect(events.failed).toHaveLength(1);
		expect(events.failed[0]?.index).toEqual(0);
		expect(events.failed[0]?.completedSteps).toHaveLength(0);
	});

	test('re-executing a completed plan is rejected', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await eurcDestinationPlan(h, 'FXOne', 100n);

		await runChain(plan);
		await expect(plan.execute()).rejects.toThrow('Cannot execute');
	});
});
describe('execute: FX + asset-movement (source-driven)', function() {
	test('settles both legs, reports actual values, emits ordered events, honors off()', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await h.getPlanVia('FXOne');
		expect(plan.state.status).toEqual('idle');

		let removedCalls = 0;
		const removed = () => { removedCalls++; };
		plan.on('stepExecuted', removed);
		plan.off('stepExecuted', removed);

		const { result, events } = await runChain(plan);
		expect(result.steps).toHaveLength(2);

		const [fx, am] = result.steps;
		expect(fx?.type).toEqual('fx');
		if (fx?.type === 'fx') {
			expect(fx.actualValueOut).toEqual(88n);

			const status = await fx.exchange.getExchangeStatus();
			expect(status.status).toEqual('completed');
			if (status.status === 'completed') {
				expect(status.blockhash).toBeTruthy();
			}
		}

		expect(am?.type).toEqual('assetMovement');

		if (am?.type === 'assetMovement') {
			expect(am.actualValueIn).toEqual(88n);
			expect(am.actualValueOut).toEqual(78n);
			expect(am.transfer.transferID).toBeTruthy();

			const transfer = await am.transfer.getTransferStatus();
			expect(transfer.transaction.status).toEqual('COMPLETE');
			expect(transfer.transaction.to.value).toEqual('78');
		}

		expect(result.totalValueOut).toEqual(78n);
		expect(plan.state.status).toEqual('completed');
		expect(events.stateHistory[0]).toEqual('executing');
		expect(events.stateHistory[events.stateHistory.length - 1]).toEqual('completed');
		expect(events.executed).toHaveLength(2);
		events.executed.forEach(({ step, index }) => expect(step).toBe(result.steps[index]));
		expect(events.completed).toBe(result);
		expect(removedCalls).toEqual(0);

		await expect(plan.execute()).rejects.toThrow('Cannot execute');
	});

	test('signs sends from an overridden storage account, leaving the user account untouched', async function() {
		await using h = await createChainingTestHarness();
		const { account: storageAccount } = await h.client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
		await h.client.setInfo({
			name: '',
			description: 'Storage account with permissions from user account',
			metadata: '',
			defaultPermission: new KeetaNet.lib.Permissions([ 'STORAGE_CAN_HOLD', 'STORAGE_DEPOSIT' ])
		}, { account: storageAccount });

		await h.giveTokens(h.client.account, 2000n, h.tokens.USDC);
		await h.client.send(storageAccount, 1000n, h.tokens.USDC);
		await h.client.send(storageAccount, 10n, h.client.baseToken);

		const userUsdcPre = await h.client.balance(h.tokens.USDC);
		const storageUsdcPre = await h.client.balance(h.tokens.USDC, { account: storageAccount });
		const userEurcPre = await h.client.balance(h.tokens.EURC);

		const plan = await h.getPlanVia('FXOne', { overrides: { account: storageAccount }});
		const { result } = await runChain(plan);
		expect(result.steps).toHaveLength(2);
		expect(plan.state.status).toEqual('completed');

		expect(storageUsdcPre - await h.client.balance(h.tokens.USDC, { account: storageAccount })).toEqual(100n);
		expect(await h.client.balance(h.tokens.USDC)).toEqual(userUsdcPre);
		expect(await h.client.balance(h.tokens.EURC)).toEqual(userEurcPre);
	});

	test('FX step failure fails at step 0 with no completed steps', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await h.getPlanVia('FXOne');

		h.fxServerOne.failNextExchange('FX step 0 failed');
		const events = collectEvents(plan);

		await expect(plan.execute()).rejects.toThrow();
		expect(plan.state.status).toEqual('failed');
		if (plan.state.status === 'failed') {
			expect(plan.state.failedAtStepIndex).toEqual(0);
			expect(plan.state.completedSteps).toHaveLength(0);
		}

		expect(events.failed).toHaveLength(1);
		expect(events.failed[0]?.index).toEqual(0);

		await expect(plan.execute()).rejects.toThrow('Cannot execute');
	});

	test('asset-movement poll failure fails at step 1 carrying the completed FX step', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await h.getPlanVia('FXOne');

		h.bankServerEU.failNextTransferStatus('AM step 1 poll failed');
		const events = collectEvents(plan);

		await expect(plan.execute()).rejects.toThrow('AM step 1 poll failed');
		expect(plan.state.status).toEqual('failed');
		if (plan.state.status === 'failed') {
			expect(plan.state.failedAtStepIndex).toEqual(1);
			expect(plan.state.completedSteps).toHaveLength(1);
			expect(plan.state.completedSteps[0]?.type).toEqual('fx');
		}

		expect(events.executed).toHaveLength(1);
		expect(events.executed[0]?.step.type).toEqual('fx');
		expect(events.failed[0]?.index).toEqual(1);
		expect(events.failed[0]?.completedSteps[0]?.type).toEqual('fx');
	});
});
describe('execute: actual-driven value flow', function() {
	test('AM -> FX -> AM re-prices each leg from the prior leg actual output', async function() {
		await using h = await createChainingTestHarness();
		const userAddress = h.client.account.publicKeyString.get();

		const capturedUSRecipients: (string | undefined)[] = [];
		const capturedEURecipients: (string | undefined)[] = [];
		h.bankServerUS.wrapInitiateTransfer(async (request, next) => {
			capturedUSRecipients.push(typeof request.to.recipient === 'string' ? request.to.recipient : undefined);
			return(await next(request));
		});
		h.bankServerEU.wrapInitiateTransfer(async (request, next) => {
			capturedEURecipients.push(typeof request.to.recipient === 'string' ? request.to.recipient : undefined);
			return(await next(request));
		});

		const plans = await h.anchorChaining.getPlans({
			source: { asset: 'USD', location: 'bank-account:us', value: 100n, rail: 'ACH' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: userAddress, rail: 'SEPA_PUSH' }
		});

		const plan = plans?.find(p => p.path.length === 3 && p.path.some(n => n.type === 'fx' && n.providerID === 'FXOne'));
		if (!plan) {
			throw(new Error('Expected 3-step path via FXOne'));
		}

		expect(plan.preview.steps[0]?.estimatedValueIn).toEqual(100n);
		expect(await h.client.balance(h.tokens.USDC)).toEqual(0n);

		const { result } = await runChain(plan, {
			requireSendAuth: true,
			onAction: async (payload) => {
				if (payload.type === 'assetMovementUserExecutionRequired') {
					await h.giveTokens(h.client.account, 90n, h.tokens.USDC);
					payload.markCompleted();
				} else {
					void defaultApproveAction(payload);
				}
			}
		});
		expect(result.steps).toHaveLength(3);

		const [first, fx, last] = result.steps;
		expect(first?.actualValueOut).toEqual(90n);
		expect(fx?.actualValueIn).toEqual(90n);
		expect(fx?.actualValueIn).toEqual(first?.actualValueOut);
		expect(fx?.preview.estimatedValueIn).toEqual(100n);
		expect(fx?.actualValueOut).toEqual(79n);
		expect(last?.actualValueIn).toEqual(79n);
		expect(result.totalValueOut).toEqual(69n);

		expect(plan.state.status).toEqual('completed');
		expect(await h.client.balance(h.tokens.USDC)).toEqual(0n);
		expect(await h.client.balance(h.tokens.EURC)).toEqual(0n);

		expect(capturedUSRecipients.length).toBeGreaterThan(0);
		capturedUSRecipients.forEach(r => expect(r).toBe(userAddress));
		expect(capturedEURecipients.length).toBeGreaterThan(0);
		capturedEURecipients.forEach(r => expect(r).toBe(userAddress));
	});
});

describe('execute: direct Keeta send', function() {
	async function directSendPlan(h: ChainingTestHarness, recipient: GenericAccount, value: bigint): Promise<AnchorChainingPlan> {
		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, value, rail: 'KEETA_SEND' },
			destination: { asset: h.tokens.USDC, location: h.keetaLocation, recipient: recipient.publicKeyString.get(), rail: 'KEETA_SEND' }
		});
		expect(plans).toHaveLength(1);
		return(firstPath(plans));
	}

	test('a same-asset same-location request sends on-chain directly', async function() {
		await using h = await createChainingTestHarness();
		const recipient = newDestinationAccount();
		await h.giveTokens(h.client.account, 500n, h.tokens.USDC);

		const plan = await directSendPlan(h, recipient, 200n);
		expect(plan.path).toHaveLength(1);
		expect(plan.preview.steps).toHaveLength(1);
		expect(plan.preview.totalValueIn).toEqual(200n);
		expect(plan.preview.totalValueOut).toEqual(200n);

		const { result } = await runChain(plan);
		expect(result.steps).toHaveLength(1);
		expect(plan.state.status).toEqual('completed');
		expect(await h.client.client.getBalance(recipient, h.tokens.USDC)).toEqual(200n);
	});

	test('keetaSendAuthRequired carries the recipient, value, and token', async function() {
		await using h = await createChainingTestHarness();
		const recipient = newDestinationAccount();
		await h.giveTokens(h.client.account, 500n, h.tokens.USDC);

		const plan = await directSendPlan(h, recipient, 200n);
		const { events } = await runChain(plan, { requireSendAuth: true });
		expect(events.actions).toHaveLength(1);

		const action = events.actions[0];
		if (action?.type !== 'keetaSendAuthRequired') {
			throw(new Error('Expected keetaSendAuthRequired'));
		}

		expect(action.action.sendToAddress.publicKeyString.get()).toBe(recipient.publicKeyString.get());
		expect(action.action.value).toBe(200n);
		expect(action.action.token.publicKeyString.get()).toBe(h.tokens.USDC.publicKeyString.get());
		expect(action.action.external).toBeUndefined();
		expect(await h.client.client.getBalance(recipient, h.tokens.USDC)).toBe(200n);
	});
});

describe('execute: ACH fiat leg', function() {
	async function bankUSPlan(h: ChainingTestHarness): Promise<AnchorChainingPlan> {
		const plans = await h.anchorChaining.getPlans({
			source: { asset: 'USD', location: 'bank-account:us', value: 100n, rail: 'ACH' },
			destination: { asset: h.tokens.USDC, location: h.keetaLocation, recipient: h.client.account.publicKeyString.get(), rail: 'KEETA_SEND' }
		});
		const plan = plans?.find(p => p.path.length === 1 && p.path[0]?.providerID === 'BankUS');
		if (!plan) {
			throw(new Error('No single-step BankUS plan found'));
		}
		return(plan);
	}

	test('a missing stepNeedsAction listener fails the execution', async function() {
		await using h = await createChainingTestHarness();
		const plan = await bankUSPlan(h);
		expect(plan.preview.steps[0]?.type).toEqual('assetMovement');
		await expect(plan.execute()).rejects.toThrow('No listeners for stepNeedsAction');
	});

	test('acknowledging user execution records the transfer as COMPLETE', async function() {
		await using h = await createChainingTestHarness();
		const plan = await bankUSPlan(h);

		const { result } = await runChain(plan);
		expect(result.steps).toHaveLength(1);

		const step = result.steps[0];
		expect(step?.type).toEqual('assetMovement');
		if (step?.type === 'assetMovement') {
			const status = await step.transfer.getTransferStatus();
			expect(status.transaction.status).toEqual('COMPLETE');
			expect(status.transaction.to.value).toEqual('90');
		}
	});

	test('a transfer poll failure fails at step 0', async function() {
		await using h = await createChainingTestHarness();
		const plan = await bankUSPlan(h);

		h.bankServerUS.failNextTransferStatus('ACH poll failed');
		const events = collectEvents(plan);
		plan.on('stepNeedsAction', defaultApproveAction);

		await expect(plan.execute()).rejects.toThrow('ACH poll failed');
		expect(plan.state.status).toEqual('failed');
		if (plan.state.status === 'failed') {
			expect(plan.state.failedAtStepIndex).toEqual(0);
			expect(plan.state.completedSteps).toHaveLength(0);
		}

		expect(events.failed[0]?.index).toEqual(0);
	});
});
describe('execute: per-leg output floor (slippage)', function() {
	test('a zero-slippage floor surfaces the asset-movement under-delivery and proceeds when approved', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plan = await h.getPlanVia('FXOne', { slippageBps: 100 });
		const { result, events } = await runChain(plan);

		const review = events.actions.find(a => a.type === 'underDeliveryReview');
		if (review?.type !== 'underDeliveryReview') {
			throw(new Error('Expected an underDeliveryReview action'));
		}

		expect(review.action.index).toEqual(1);
		expect(review.action.expectedOutput).toEqual(78n);
		expect(review.action.minimumOutput).toEqual(87n);

		expect(result.totalValueOut).toEqual(78n);
		expect(plan.state.status).toEqual('completed');
	});

	test('a zero-slippage floor aborts before the irreversible send when declined', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plan = await h.getPlanVia('FXOne', { slippageBps: 100 });
		const events = collectEvents(plan);
		plan.on('stepNeedsAction', (payload) => {
			events.actions.push(payload);
			if (payload.type === 'underDeliveryReview') {
				payload.markCompleted({ proceed: false });
			} else {
				void defaultApproveAction(payload);
			}
		});

		await expect(plan.execute()).rejects.toThrow('below the minimum');
		expect(plan.state.status).toEqual('failed');
		if (plan.state.status === 'failed') {
			expect(plan.state.failedAtStepIndex).toEqual(1);
			expect(plan.state.completedSteps).toHaveLength(1);
			expect(plan.state.completedSteps[0]?.type).toEqual('fx');
		}
	});
});

describe('resume', function() {
	test('a failed, unsettled leg is re-driven to completion on resume', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await eurcDestinationPlan(h, 'FXOne', 100n);

		const correlationID = 'resume-fx-only';
		h.fxServerOne.failNextExchange('transient FX failure');

		await expect(plan.execute({ correlationID })).rejects.toThrow();
		expect(plan.state.status).toEqual('failed');
		if (plan.state.status === 'failed') {
			expect(plan.state.failedAtStepIndex).toEqual(0);
		}

		const result = await plan.resume(correlationID);
		expect(result.correlationID).toEqual(correlationID);
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]?.type).toEqual('fx');
		expect(plan.state.status).toEqual('completed');
	});

	test('resuming a settled correlation skips every leg and re-reports the delivered total', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await h.getPlanVia('FXOne');

		const { result } = await runChain(plan, { correlationID: 'resume-settled' });
		expect(result.steps).toHaveLength(2);
		expect(result.totalValueOut).toEqual(78n);

		const resumed = await plan.resume('resume-settled');
		// Settled legs are skipped, so none re-execute, yet the delivered total stands.
		expect(resumed.steps).toHaveLength(0);
		expect(resumed.totalValueOut).toEqual(78n);
		expect(resumed.totalValueIn).toEqual(100n);
	});
});

describe('execute: persistent-forwarding (forwarded leg)', function() {
	test('the forwarded leg is previewed without reserving an address', async function() {
		await using h = await createPersistentForwardingHarness();
		const destination = newDestinationAccount();

		const path = await getKeetaUsdcToUsdc2Path(h, 1000n, destination);
		expect(path.path).toHaveLength(2);

		const lastNode = path.path[1];
		if (!lastNode || lastNode.type !== 'assetMovement') {
			throw(new Error('Expected the last path node to be assetMovement'));
		}

		expect(lastNode.from.supportedOperations).toEqual(PFR_SUPPORTED_OPS);

		const plan = await AnchorChainingPlan.create(path);
		expect(plan.preview.steps).toHaveLength(2);
		expect(plan.preview.steps[0]?.type).toEqual('assetMovement');
		expect(plan.preview.steps[1]?.type).toEqual('forwarded');

		expect(h.bridgeServer.addresses.size).toEqual(0);
	});

	test('execution lazily creates the forwarding address and sweeps end-to-end', async function() {
		await using h = await createPersistentForwardingHarness();
		await h.client.modTokenSupplyAndBalance(2000n, h.tokens.USDC);

		const destination = newDestinationAccount();
		const path = await getKeetaUsdcToUsdc2Path(h, 1000n, destination);
		const plan = await AnchorChainingPlan.create(path);
		expect(h.bridgeServer.addresses.size).toEqual(0);

		const { result } = await runChain(plan);
		expect(h.bridgeServer.addresses.size).toEqual(1);
		expect(result.steps).toHaveLength(2);

		const forwarded = result.steps[1];
		if (forwarded?.type !== 'forwarded') {
			throw(new Error('Expected the last executed step to be forwarded'));
		}

		expect(forwarded.observedTransaction.status).toEqual('COMPLETE');
		expect(forwarded.observedTransaction.from.value).toEqual('1000');
		expect(forwarded.observedTransaction.to.location).toEqual(h.keetaLocation);
		expect(plan.state.status).toEqual('completed');

		const addressMeta = [ ...h.bridgeServer.addresses.values() ][0];
		expect(addressMeta?.destinationAddress).toEqual(destination.publicKeyString.get());
	});
});

describe('execute: keeta send authorization', function() {
	test('a missing listener fails the execution when requireSendAuth is set', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		const plan = await h.getPlanVia('FXOne');
		await expect(plan.execute({ requireSendAuth: true })).rejects.toThrow('No listeners for stepNeedsAction');
	});

	test('the authorization payload carries the send recipient, value, token, and correlation external', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await h.getPlanVia('FXOne');

		const { result, events } = await runChain(plan, { requireSendAuth: true });
		expect(result.steps).toHaveLength(2);

		const action = events.actions.find(a => a.type === 'keetaSendAuthRequired');
		if (action?.type !== 'keetaSendAuthRequired') {
			throw(new Error('Expected a keetaSendAuthRequired action'));
		}

		expect(KeetaNet.lib.Account.isInstance(action.action.sendToAddress)).toBe(true);
		expect(action.action.value).toEqual(88n);
		expect(action.action.token.publicKeyString.get()).toEqual(h.tokens.EURC.publicKeyString.get());
		expect(typeof action.action.external).toEqual('string');
	});

	test('an advisory sent:false still proceeds to completion', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await h.getPlanVia('FXOne');

		const { result } = await runChain(plan, {
			requireSendAuth: true,
			onAction: (payload) => {
				if (payload.type === 'keetaSendAuthRequired') {
					payload.markCompleted({ sent: false });
				} else {
					void defaultApproveAction(payload);
				}
			}
		});
		expect(result.steps).toHaveLength(2);
		expect(plan.state.status).toEqual('completed');
	});

	test('markFailed rejects the execution at the awaiting send step', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		const plan = await h.getPlanVia('FXOne');

		const events = collectEvents(plan);
		plan.on('stepNeedsAction', (payload) => {
			events.actions.push(payload);
			if (payload.type === 'keetaSendAuthRequired') {
				payload.markFailed(new Error('send rejected by user'));
			} else {
				void defaultApproveAction(payload);
			}
		});

		await expect(plan.execute({ requireSendAuth: true })).rejects.toThrow('send rejected by user');
		expect(plan.state.status).toEqual('failed');
		expect(events.failed).toHaveLength(1);
		expect(events.failed[0]?.index).toEqual(1);
		expect(events.failed[0]?.completedSteps[0]?.type).toEqual('fx');
	});
});

describe('execute: external correlation envelope', function() {
	test('a construction-model anchor that omits external is correlated by a client-built envelope', async function() {
		await using h = await createChainingTestHarness();
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);

		/**
		 * The anchor returns KEETA_SEND instructions without an external, so the
		 * client must build the correlation envelope itself for the send to match.
		 */
		h.bankServerEU.wrapInitiateTransfer(stripKeetaSendExternal);
		const plan = await h.getPlanVia('FXOne');

		const { result, events } = await runChain(plan, { requireSendAuth: true });
		expect(result.steps).toHaveLength(2);

		const fxStep = result.steps[0];
		const amStep = result.steps[1];
		if (fxStep?.type !== 'fx' || amStep?.type !== 'assetMovement') {
			throw(new Error('Expected an fx then assetMovement step'));
		}

		const action = events.actions.find(a => a.type === 'keetaSendAuthRequired');
		if (action?.type !== 'keetaSendAuthRequired' || action.action.external === undefined) {
			throw(new Error('Expected a client-built external on the send action'));
		}

		const fxStatus = await fxStep.exchange.getExchangeStatus();
		if (fxStatus.status !== 'completed') {
			throw(new Error('Expected the fx exchange to complete'));
		}

		const decoded = await AnchorExternal.fromPlainExternal(action.action.external);
		expect(decoded.signed).toBeUndefined();
		expect(decoded.envelope.inputs).toEqual([ { blockHash: fxStatus.blockhash } ]);
		expect(decoded.envelope.anchors).toEqual({
			[h.bankSignerEU.publicKeyString.get()]: { transactionId: amStep.transfer.transferID }
		});
	});

	test('chained keeta sends build envelopes that reference the prior send as an on-chain input', async function() {
		await using h = await createChainingTestHarness({ includeSwapAnchor: true });
		await h.giveTokens(h.client.account, 1000n, h.tokens.USDC);
		// The swap anchor settles EURC off-chain here, so the second hop's EURC is pre-funded.
		await h.giveTokens(h.client.account, 1000n, h.tokens.EURC);

		h.swapServer.wrapInitiateTransfer(stripKeetaSendExternal);
		h.bankServerEU.wrapInitiateTransfer(stripKeetaSendExternal);

		const plans = await h.anchorChaining.getPlans({
			source: { asset: h.tokens.USDC, location: h.keetaLocation, value: 100n, rail: 'KEETA_SEND' },
			destination: { asset: 'EUR', location: 'bank-account:iban-swift', recipient: h.client.account.publicKeyString.get(), rail: 'SEPA_PUSH' }
		});
		const plan = plans?.find(p => p.path.length === 2 && p.path[0]?.providerID === 'SwapKeeta' && p.path[1]?.providerID === h.euBankProviderID);
		if (!plan) {
			throw(new Error('Expected a SwapKeeta -> BankEU path'));
		}

		const { result, events } = await runChain(plan, { requireSendAuth: true });
		expect(result.steps).toHaveLength(2);

		const externals = events.actions
			.filter(a => a.type === 'keetaSendAuthRequired')
			.map(a => a.type === 'keetaSendAuthRequired' ? a.action.external : undefined);
		expect(externals).toHaveLength(2);

		const [ firstExternal, secondExternal ] = externals;
		if (firstExternal === undefined || secondExternal === undefined) {
			throw(new Error('Expected client-built externals on both sends'));
		}

		const firstDecoded = await AnchorExternal.fromPlainExternal(firstExternal);
		expect(firstDecoded.envelope.inputs).toBeUndefined();
		expect(Object.keys(firstDecoded.envelope.anchors)).toEqual([ h.swapSigner.publicKeyString.get() ]);

		const secondDecoded = await AnchorExternal.fromPlainExternal(secondExternal);
		expect(Object.keys(secondDecoded.envelope.anchors)).toEqual([ h.bankSignerEU.publicKeyString.get() ]);

		const input = secondDecoded.envelope.inputs?.[0];
		if (input === undefined) {
			throw(new Error('Expected an input referencing the first send'));
		}

		expect(input.operationIndex).toEqual(0);

		const referencedBlock = await h.client.block(input.blockHash);
		if (referencedBlock === null) {
			throw(new Error('Referenced input block not found on chain'));
		}

		const referencedExternals = referencedBlock.operations.flatMap(op =>
			op.type === KeetaNet.lib.Block.OperationType.SEND ? [ op.external ] : []
		);
		expect(referencedExternals).toEqual([ firstExternal ]);
	});
});
