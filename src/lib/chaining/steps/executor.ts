import type { ChainStepType, PreviewKnownValue, PreviewStep } from '../types.js';
import type { StepContext } from './context.js';
import type { StepRunInput, StepRunResult } from './run.js';
import { AnchorChainingError } from '../errors.js';
import { FXStep } from './fx.js';
import { AssetMovementStep } from './asset-movement.js';
import { ForwardedStep } from './forwarded.js';
import { KeetaSendStep } from './keeta-send.js';

/**
 * Behavioral contract for one leg of a chain. A step both estimates its
 * amounts side-effect-free ({@link StepExecutor.preview}) and, at execution
 * time, performs its irreversible work driven by the actual upstream output.
 *
 * The `run` half is provided by the execution engine in a later phase; the
 * preview half is consumed by {@link AnchorChainingPlan} with no side effects.
 */
export interface StepExecutor {
	readonly type: ChainStepType;
	readonly index: number;
	/**
	 * Produce a side-effect-free estimate for this leg given the known side
	 * (input value for affinity `from`, output value for affinity `to`).
	 */
	preview(known: PreviewKnownValue): Promise<PreviewStep>;
	/**
	 * Perform this leg's irreversible work, priced from the actual upstream
	 * output, and report the actual delivered output.
	 */
	run(input: StepRunInput): Promise<StepRunResult>;
}

/**
 * Build the {@link StepExecutor} for the path step at `index`, dispatching on
 * the step type and forwarded-step classification carried by the context.
 */
export function createStepExecutor(ctx: StepContext, index: number): StepExecutor {
	const step = ctx.path[index];
	if (!step) {
		throw(new AnchorChainingError('STEP_NOT_DEFINED', `Step ${index} is not defined`));
	}

	switch (step.type) {
		case 'fx':
			return(new FXStep(ctx, index, step));
		case 'assetMovement':
			if (ctx.forwardedIndexes.has(index)) {
				return(new ForwardedStep(ctx, index, step));
			}
			return(new AssetMovementStep(ctx, index, step));
		case 'keetaSend':
			return(new KeetaSendStep(ctx, index, step));
		default:
			throw(new AnchorChainingError('INVALID_PATH', `Unknown step type at index ${index}`));
	}
}
