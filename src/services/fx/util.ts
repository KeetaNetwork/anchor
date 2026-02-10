import type { TokenAddress } from "@keetanetwork/keetanet-client/lib/account.js";
import { KeetaNet } from "../../client/index.js";
import { KeetaAnchorUserError } from "../../lib/error.js";
import type { ConversionInputCanonical, ConversionInputCanonicalJSON, KeetaNetToken } from "./common.js";
import type { ValidateQuoteArguments } from "./server.js";

export function convertQuoteToExpectedSwapWithoutCost(input: {
	quote: Omit<ValidateQuoteArguments, 'account'>,
	request: ConversionInputCanonical | ConversionInputCanonicalJSON,
}): NonNullable<{
		receive: {
			token: KeetaNetToken;
			amount: bigint;
		};
		send: {
			token: KeetaNetToken;
			amount: bigint;
		};
	}> {
	let expectedSendAmount: bigint;
	let expectedReceiveAmount: bigint;

	if (input.request.affinity === 'to') {
		expectedSendAmount = BigInt(input.request.amount);
		expectedReceiveAmount = input.quote.convertedAmount;
	} else {
		expectedSendAmount = input.quote.convertedAmount;
		expectedReceiveAmount = BigInt(input.request.amount);
	}

	return({
		receive: {
			token: KeetaNet.lib.Account.toAccount(input.request.from),
			amount: expectedReceiveAmount
		},
		send: {
			token: KeetaNet.lib.Account.toAccount(input.request.to),
			amount: expectedSendAmount
		}
	})
}

export type RefundValue = { token: TokenAddress; amount: bigint; };
export function assertExchangeBlockParameters(args: {
	block: InstanceType<typeof KeetaNet['lib']['Block']>;
	liquidityAccount: InstanceType<typeof KeetaNet['lib']['Account']>;

	allowedLiquidityAccounts: null | InstanceType<typeof KeetaNet['lib']['Account']['Set']>;

	checks: Parameters<typeof convertQuoteToExpectedSwapWithoutCost>[0];
}): {
		refunds: RefundValue[];
	} {
	if (args.allowedLiquidityAccounts !== null && !(args.allowedLiquidityAccounts.has(args.liquidityAccount))) {
		throw(new KeetaAnchorUserError(`Invalid liquidity account provided ${args.liquidityAccount.publicKeyString.get()}`));
	}

	const userSent: { [tokenPublicKey: string]: bigint; } = {};
	const userExpectsReceive: { [tokenPublicKey: string]: bigint; } = {};
	for (const operation of args.block.operations) {
		if (operation.type === KeetaNet.lib.Block.OperationType.SEND) {
			if (!(operation.to.comparePublicKey(args.liquidityAccount))) {
				throw(new KeetaAnchorUserError('Send operations in exchange block must be made sending to liquidity account'));
			}

			const tokenPub = operation.token.publicKeyString.get();

			if (!(userSent[tokenPub])) {
				userSent[tokenPub] = 0n;
			}

			userSent[tokenPub] += operation.amount;
		} else if (operation.type === KeetaNet.lib.Block.OperationType.RECEIVE) {
			if (!(operation.from.comparePublicKey(args.liquidityAccount))) {
				throw(new KeetaAnchorUserError('Receive operations in exchange block must be made requesting from liquidity account'));
			}

			const tokenPub = operation.token.publicKeyString.get();

			if (!(userExpectsReceive[tokenPub])) {
				userExpectsReceive[tokenPub] = 0n;
			}

			userExpectsReceive[tokenPub] += operation.amount;
		} else {
			throw(new KeetaAnchorUserError(`Invalid operation type in exchange block: ${operation.type}`));
		}
	}

	const expected = convertQuoteToExpectedSwapWithoutCost(args.checks);

	const userSendsMinimum = {
		[expected.receive.token.publicKeyString.get()]: expected.receive.amount
	};

	const userWillReceiveMaximum = {
		[expected.send.token.publicKeyString.get()]: expected.send.amount
	};

	const costValue = args.checks.quote.cost;
	if (costValue.amount > 0n) {
		const feeTokenPub = costValue.token.publicKeyString.get();

		if (!userSendsMinimum[feeTokenPub]) {
			userSendsMinimum[feeTokenPub] = 0n;
		}

		userSendsMinimum[feeTokenPub] += costValue.amount;
	}

	const refunds: RefundValue[] = [];

	for (const [ tokenPub, amount ] of Object.entries(userSendsMinimum)) {
		const userDidSend = userSent[tokenPub] ?? 0n;

		if (userDidSend < amount) {
			throw(new KeetaAnchorUserError(`Expected send of ${amount}, only saw ${userDidSend} for token ${tokenPub}`));
		}

		// If the user sent more than the minimum and the excess is in the expected receive token or the cost token, consider it a refund. This allows users to send more than the minimum if they want to receive more than the expected amount, but still ensures that if they do so by mistake they will get a refund of the excess.
		if (userDidSend > amount) {
			let isRefundable = false;

			const excessToken = KeetaNet.lib.Account.toAccount(tokenPub).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

			if (excessToken.comparePublicKey(expected.receive.token)) {
				// If the affinity is from, and the user choose to send excess they should not be refunded
				if (args.checks.request.affinity === 'to') {
					isRefundable = true;
				}
			} else if (costValue.amount > 0n && excessToken.comparePublicKey(costValue.token)) {
				isRefundable = true;
			}

			const excessAmount = userDidSend - amount;
			if (isRefundable && excessAmount > 0n) {
				refunds.push({
					token: excessToken,
					amount: excessAmount
				});
			}
		}
	}

	for (const [ tokenPub, amount ] of Object.entries(userWillReceiveMaximum)) {
		const userAskedReceive = userExpectsReceive[tokenPub] ?? 0n;

		if (userAskedReceive > amount) {
			throw(new KeetaAnchorUserError(`Expected to receive maximum of ${amount}, user asked for ${userAskedReceive} for token ${tokenPub}`));
		}
	}

	return({ refunds });
}
