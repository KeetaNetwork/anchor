import { test, expect } from 'vitest';
import { assertExchangeBlockParameters, convertQuoteToExpectedSwapWithoutCost } from './util.js';
import { KeetaNet } from '../../client/index.js';

const toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

test('convertQuoteToExpectedSwapWithoutCost', function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const tokenA = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
	const tokenB = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);

	const checks: {
		args: Parameters<typeof convertQuoteToExpectedSwapWithoutCost>[0];
		expected: ReturnType<typeof convertQuoteToExpectedSwapWithoutCost>;
	}[] = [
		{
			args: {
				quote: {
					convertedAmount: 4000n,
					cost: {
						amount: 0n,
						token: tokenA
					}
				},
				request: {
					affinity: 'to',
					amount: 2000n,
					from: tokenA,
					to: tokenB
				}
			},
			expected: {
				receive: { token: tokenA, amount: 4000n },
				send: { token: tokenB, amount: 2000n }
			}
		},
		{
			args: {
				quote: {
					convertedAmount: 3000n,
					cost: {
						amount: 0n,
						token: tokenB
					}
				},
				request: {
					affinity: 'from',
					amount: 100n,
					from: tokenB,
					to: tokenA
				}
			},
			expected: {
				receive: { token: tokenB, amount: 100n },
				send: { token: tokenA, amount: 3000n }
			}
		}
	];

	for (const check of checks) {
		const result = convertQuoteToExpectedSwapWithoutCost(check.args);
		expect(toJSONSerializable(result)).toEqual(toJSONSerializable(check.expected));
	}
});


test('assertExchangeBlockParameters', async function() {
	const accountA = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const accountB = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const tokenA = accountA.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
	const tokenB = accountA.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);
	const tokenC = accountA.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 2);

	const networkId = KeetaNet.UserClient.Config.NetworkIDs.test;

	const aSendsTokenAToBBlock = await (new KeetaNet.lib.Block.Builder({
		network: networkId,
		previous: KeetaNet.lib.Block.NO_PREVIOUS,
		signer: accountA,
		operations: [
			{
				type: KeetaNet.lib.Block.OperationType.RECEIVE,
				from: accountB,
				token: tokenB,
				amount: 500n
			},
			{
				type: KeetaNet.lib.Block.OperationType.SEND,
				to: accountB,
				token: tokenA,
				amount: 500n
			}
		]
	}).seal())

	const baseQuoteRequest = {
		quote: {
			convertedAmount: 4000n,
			cost: {
				amount: 0n,
				token: tokenA
			}
		},
		request: {
			affinity: 'from',
			amount: 500n,
			from: tokenA,
			to: tokenB
		}
	} as const satisfies Parameters<typeof convertQuoteToExpectedSwapWithoutCost>[0];

	const checks: {
		args: Parameters<typeof assertExchangeBlockParameters>[0];
		pass: boolean;
	}[] = [
		{
			args: {
				allowedLiquidityAccounts: new KeetaNet.lib.Account.Set([accountB]),
				block: aSendsTokenAToBBlock,
				liquidityAccount: accountB,
				checks: baseQuoteRequest
			},
			pass: true
		},
		{
			args: {
				allowedLiquidityAccounts: new KeetaNet.lib.Account.Set([accountB]),
				block: aSendsTokenAToBBlock,
				liquidityAccount: accountA,
				checks: baseQuoteRequest
			},
			pass: false
		},
		{
			args: {
				allowedLiquidityAccounts: new KeetaNet.lib.Account.Set([accountB]),
				block: aSendsTokenAToBBlock,
				liquidityAccount: accountB,
				checks: {
					...baseQuoteRequest,
					request: {
						...baseQuoteRequest.request,
						amount: 501n
					}
				}
			},
			pass: false
		},
		{
			args: {
				allowedLiquidityAccounts: new KeetaNet.lib.Account.Set([accountB]),
				block: aSendsTokenAToBBlock,
				liquidityAccount: accountB,
				checks: {
					...baseQuoteRequest,
					quote: {
						...baseQuoteRequest.quote,
						convertedAmount: 499n
					}
				}
			},
			pass: false
		},
		{
			args: {
				allowedLiquidityAccounts: new KeetaNet.lib.Account.Set([accountB]),
				block: aSendsTokenAToBBlock,
				liquidityAccount: accountB,
				checks: {
					...baseQuoteRequest,
					quote: {
						...baseQuoteRequest.quote,
						cost: {
							token: tokenA,
							amount: 25n
						}
					},
					request: {
						...baseQuoteRequest.request,
						amount: 475n
					}
				}
			},
			pass: true
		},
		{
			args: {
				allowedLiquidityAccounts: new KeetaNet.lib.Account.Set([accountB]),
				block: aSendsTokenAToBBlock,
				liquidityAccount: accountB,
				checks: {
					...baseQuoteRequest,
					quote: {
						...baseQuoteRequest.quote,
						cost: {
							token: tokenA,
							amount: 25n
						}
					},
					request: {
						...baseQuoteRequest.request,
						amount: 480n
					}
				}
			},
			pass: false
		},
		{
			args: {
				allowedLiquidityAccounts: new KeetaNet.lib.Account.Set([accountB]),
				block: aSendsTokenAToBBlock,
				liquidityAccount: accountB,
				checks: {
					...baseQuoteRequest,
					quote: {
						...baseQuoteRequest.quote,
						cost: {
							token: tokenC,
							amount: 1n
						}
					}
				}
			},
			pass: false
		}
	];

	for (const check of checks) {
		let passed = true;
		try {
			assertExchangeBlockParameters(check.args);
		} catch {
			passed = false;
		}

		expect(passed).toEqual(check.pass);
	}
});
