import type { KeetaFXAnchorEstimate, KeetaFXAnchorQuote } from '../../../services/fx/common.js';
import type { KeetaFXAnchorCreateExchangeOptions } from '../../../services/fx/client.js';

type ShownResult = { isQuote: true; quote: KeetaFXAnchorQuote; } | { isQuote: false; estimate: KeetaFXAnchorEstimate; };

/**
 * `createExchange` options that accept exactly the amounts and fee a quote
 * or estimate showed, as an app does once the user has seen them. For
 * tests that are not about the limits themselves.
 */
export function acceptShownTerms(result: ShownResult): KeetaFXAnchorCreateExchangeOptions {
	if (result.isQuote) {
		const { quote } = result;
		const convertedAmount = quote.convertedAmount;
		return({
			limits: {
				...(quote.request.affinity === 'to' ? { maxSend: convertedAmount } : { minReceive: convertedAmount }),
				maxCost: { token: quote.cost.token, amount: quote.cost.amount }
			}
		});
	}

	const { estimate } = result;
	const convertedAmount = estimate.convertedAmountBound ?? estimate.convertedAmount;
	return({
		limits: {
			...(estimate.request.affinity === 'to' ? { maxSend: convertedAmount } : { minReceive: convertedAmount }),
			maxCost: { token: estimate.expectedCost.token, amount: estimate.expectedCost.max }
		}
	});
}
