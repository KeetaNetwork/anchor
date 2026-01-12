import { KeetaNet } from "../../client/index.js";
import { KeetaAnchorUserError } from "../../lib/error.js";

export function assertExchangeBlockParameters(args: {
	block: InstanceType<typeof KeetaNet['lib']['Block']>;
	liquidityAccount: InstanceType<typeof KeetaNet['lib']['Account']>;

	allowedLiquidityAccounts: null | InstanceType<typeof KeetaNet['lib']['Account']['Set']>;

	userSendsMinimum: {
		[tokenPublicKey: string]: bigint;
	};

	userWillReceiveMaximum: {
		[tokenPublicKey: string]: bigint;
	};
}): void {
	if (args.allowedLiquidityAccounts !== null && !(args.allowedLiquidityAccounts.has(args.liquidityAccount))) {
		throw(new KeetaAnchorUserError(`Invalid liquidity account provided ${args.liquidityAccount.publicKeyString.get()}`));
	}

	const userSent: { [tokenPublicKey: string]: bigint; } = {};
	const userExpectsReceive: { [tokenPublicKey: string]: bigint; } = {};
	for (const operation of args.block.operations) {
		if (operation.type === KeetaNet.lib.Block.OperationType.SEND) {
			if (!(operation.to.comparePublicKey(args.liquidityAccount))) {
				continue;
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
		}
	}

	for (const [ tokenPub, amount ] of Object.entries(args.userSendsMinimum)) {
		const userDidSend = userSent[tokenPub] ?? 0n;

		if (userDidSend < amount) {
			throw(new KeetaAnchorUserError(`Expected send of ${amount}, only saw ${userDidSend} for token ${tokenPub}`));
		}
	}

	for (const [ tokenPub, amount ] of Object.entries(args.userWillReceiveMaximum)) {
		const userAskedReceive = userExpectsReceive[tokenPub] ?? 0n;

		if (userAskedReceive > amount) {
			throw(new KeetaAnchorUserError(`Expected to receive maximum of ${amount}, user asked for ${userAskedReceive} for token ${tokenPub}`));
		}
	}
}
