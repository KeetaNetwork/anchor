import type { AssetMovementGraphNode, AssetMovementProvider, ExecutedStep, PreviewKnownValue, PreviewStep } from '../types.js';
import type { AssetTransferInstructions, SimulatedAssetTransferInstructions } from '../../../services/asset-movement/common.js';
import type { StepContext } from './context.js';
import type { StepRunInput, StepRunResult, WithdrawRef } from './run.js';
import type { PublishedInputRecord } from '../store.js';
import { applySlippage, resolveAccountsForAction } from './context.js';
import { AnchorChainingError } from '../errors.js';
import { pollTransferStatus } from './poll.js';
import { buildKeetaSendExternal } from './external.js';

/**
 * Find the instruction matching a rail in a transfer's instruction set.
 */
function findInstruction<R extends AssetTransferInstructions['type']>(
	instructions: AssetTransferInstructions[],
	type: R
): Extract<AssetTransferInstructions, { type: R }> {
	const found = instructions.find((instr): instr is Extract<AssetTransferInstructions, { type: R }> => instr.type === type);
	if (!found) {
		throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Expected to find instruction of type ${type} in transfer instructions`));
	}

	return(found);
}

/**
 * Read the delivered amount an instruction promises, preferring the explicit
 * total-receive amount over the raw value.
 */
function instructionTotalReceive(instruction: AssetTransferInstructions): bigint | undefined {
	let totalReceive: string | undefined = instruction.totalReceiveAmount;
	if (totalReceive === undefined && 'value' in instruction) {
		totalReceive = instruction.value;
	}

	if (totalReceive === undefined) {
		return(undefined);
	}

	return(BigInt(totalReceive));
}

/**
 * Resolve the asset-movement provider for a leg, or fail with a typed error.
 */
export async function resolveMovementProvider(ctx: StepContext, node: AssetMovementGraphNode): Promise<AssetMovementProvider> {
	const providers = await ctx.assetMovementClient.getProvidersForTransfer(
		{ asset: { from: node.from.asset, to: node.to.asset }, from: node.from.location, to: node.to.location },
		{ providerIDs: [ node.providerID ] }
	);

	const provider = providers?.[0];
	if (!provider) {
		throw(new AnchorChainingError('PROVIDER_UNAVAILABLE', `Could not get asset movement provider ${node.providerID}`));
	}

	return(provider);
}

/**
 * Best-effort, side-effect-free estimate of an asset-movement leg's delivered
 * output for a deposit of `amount`: simulate when supported, otherwise assume
 * the rail takes no fee.
 */
export async function estimateMovementValueOut(
	ctx: StepContext,
	node: AssetMovementGraphNode,
	provider: AssetMovementProvider,
	amount: bigint
): Promise<bigint> {
	if (!await provider.isOperationSupported('simulateTransfer')) {
		return(amount);
	}

	try {
		const { signer } = await resolveAccountsForAction(ctx.client, {
			type: 'assetMovement',
			providerMethod: 'initiateTransfer',
			provider
		}, ctx.overrides);

		const simulated = await provider.simulateTransfer({
			account: signer,
			asset: { from: node.from.asset, to: node.to.asset },
			from: { location: node.from.location },
			to: { location: node.to.location },
			value: amount
		});

		const simulatedInstruction = simulated.instructions.find((instr): instr is Extract<SimulatedAssetTransferInstructions, { type: typeof node.from.rail }> => instr.type === node.from.rail);
		let totalReceive: string | undefined = simulatedInstruction?.totalReceiveAmount;
		if (totalReceive === undefined && simulatedInstruction && 'value' in simulatedInstruction) {
			totalReceive = simulatedInstruction.value;
		}

		if (totalReceive !== undefined) {
			return(BigInt(totalReceive));
		}
	} catch (error) {
		ctx.logger?.debug('AssetMovementStep::estimate', `simulateTransfer estimate failed for step ${node.providerID}; falling back to deposit value`, error);
	}

	return(amount);
}

/**
 * An asset-movement leg that initiates a managed transfer through a provider.
 * Previews via `simulateTransfer` and never initiates.
 */
export class AssetMovementStep {
	readonly type = 'assetMovement' as const;
	readonly index: number;
	readonly #ctx: StepContext;
	readonly #node: AssetMovementGraphNode;

	constructor(ctx: StepContext, index: number, node: AssetMovementGraphNode) {
		this.#ctx = ctx;
		this.index = index;
		this.#node = node;
	}

	async preview(known: PreviewKnownValue): Promise<PreviewStep> {
		if (this.#ctx.affinity === 'to') {
			throw(new AnchorChainingError('UNSUPPORTED_AFFINITY', `Chaining with affinity 'to' is not supported for asset movement steps`));
		}

		const amount = known.value;
		const provider = await resolveMovementProvider(this.#ctx, this.#node);
		const estimatedValueOut = await estimateMovementValueOut(this.#ctx, this.#node, provider, amount);

		return({
			type: 'assetMovement',
			index: this.index,
			providerID: this.#node.providerID,
			from: this.#node.from,
			to: this.#node.to,
			estimatedValueIn: amount,
			estimatedValueOut,
			minOutput: applySlippage(estimatedValueOut, this.#ctx.slippageBps)
		});
	}

	async run(input: StepRunInput): Promise<StepRunResult> {
		if (this.#ctx.affinity === 'to') {
			throw(new AnchorChainingError('UNSUPPORTED_AFFINITY', `Chaining with affinity 'to' is not supported for asset movement steps`));
		}

		const provider = await resolveMovementProvider(this.#ctx, this.#node);
		const { signer } = await resolveAccountsForAction(this.#ctx.client, {
			type: 'assetMovement',
			providerMethod: 'initiateTransfer',
			provider
		}, this.#ctx.overrides);

		const { recipient } = await input.resolveRecipient();

		/*
		 * Re-initiate from the actual upstream output so the transfer reflects
		 * what arrived rather than a stale plan amount.
		 */
		const transfer = await provider.initiateTransfer({
			account: signer,
			asset: { from: this.#node.from.asset, to: this.#node.to.asset },
			from: { location: this.#node.from.location },
			to: { location: this.#node.to.location, recipient },
			value: input.actualInput
		});

		const usingInstruction = findInstruction(transfer.instructions, this.#node.from.rail);
		const expectedOutput = instructionTotalReceive(usingInstruction) ?? input.actualInput;

		await input.checkFloor(expectedOutput);

		input.record.intent = {
			idempotencyKey: input.idempotencyKey,
			kind: 'assetMovement',
			createdAtMs: Date.now()
		};
		input.record.transferID = transfer.transferID;
		input.record.status = 'intent';
		await input.persist();

		const published: PublishedInputRecord[] = [];

		if (usingInstruction.type === 'KEETA_SEND') {
			let sentBlockHash = input.record.sendBlockHash;
			if (sentBlockHash === undefined) {
				let external = usingInstruction.external;
				if (external === undefined) {
					external = await buildKeetaSendExternal(provider, transfer.transferID, input.publishedInputs);
				}

				sentBlockHash = await input.authorizedSend({
					to: usingInstruction.sendToAddress,
					value: BigInt(usingInstruction.value),
					token: usingInstruction.tokenAddress,
					external
				});

				if (sentBlockHash !== undefined) {
					input.record.sendBlockHash = sentBlockHash;
					await input.persist();
				}
			}

			if (sentBlockHash !== undefined) {
				published.push({ blockHash: sentBlockHash, operationIndex: 0 });
			}
		} else if (this.index === 0) {
			await input.awaitAssetMovementExecution(transfer);
		} else if (usingInstruction.type === 'EVM_SEND') {
			this.#ctx.logger?.debug('AssetMovementStep::run', `EVM_SEND instruction for step ${this.index}; assuming prior step delivered to ${usingInstruction.sendToAddress}`);
		} else {
			throw(new AnchorChainingError('UNSUPPORTED_INSTRUCTION', `Unsupported instruction type ${usingInstruction.type} for step ${this.index}`));
		}

		const status = await pollTransferStatus(transfer, input.poll);
		const actualOutput = BigInt(status.transaction.to.value);

		let withdrawTx: WithdrawRef | null = null;
		const withdraw = status.transaction.to.transactions.withdraw;
		if (withdraw) {
			withdrawTx = {
				location: this.#node.to.location,
				transaction: { id: withdraw.id }
			};
		}

		const executed: ExecutedStep = {
			type: 'assetMovement',
			index: this.index,
			preview: input.preview,
			actualValueIn: input.actualInput,
			actualValueOut: actualOutput,
			transfer
		};

		return({
			actualOutput,
			executed,
			publishedInputs: published,
			withdrawTx
		});
	}
}
