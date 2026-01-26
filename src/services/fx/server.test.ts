import { expect, test } from 'vitest';
import { KeetaNetFXAnchorHTTPServer } from './server.js';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { KeetaAnchorQueueStorageDriverMemory } from '../../lib/queue/index.js';
import { asleep } from '../../lib/utils/asleep.js';

const DEBUG = false;
const TestLogger = DEBUG ? console : undefined;

/*
 * Helper functions for autoRun tests
 */
function extractExchangeID(exchange: unknown): string {
	if (typeof exchange !== 'object' || exchange === null || !('exchangeID' in exchange) || typeof exchange.exchangeID !== 'string') {
		throw(new Error('Invalid exchange response'));
	}
	return(exchange.exchangeID);
}

async function getExchangeStatus(serverURL: string, exchangeID: string) {
	const response = await fetch(`${serverURL}/api/getExchangeStatus/${exchangeID}`, {
		method: 'GET',
		headers: {
			'Accept': 'application/json'
		}
	});

	expect(response.status).toBe(200);
	const data: unknown = await response.json();
	expect(data).toHaveProperty('ok', true);
	expect(data).toHaveProperty('status');

	return(data);
}

async function waitForExchangeCompletion(serverURL: string, exchangeID: string, timeoutMs = 30000) {
	const startTime = Date.now();
	while (Date.now() - startTime < timeoutMs) {
		const status = await getExchangeStatus(serverURL, exchangeID);

		if (typeof status === 'object' && status !== null && 'status' in status) {
			if (status.status === 'completed') {
				return(status);
			} else if (status.status === 'failed') {
				throw(new Error(`Exchange ${exchangeID} failed`));
			}
		}

		await asleep(100);
	}

	throw(new Error(`Exchange ${exchangeID} did not complete within ${timeoutMs}ms`));
}

async function getQuoteFromServer(serverURL: string, fromToken: string, toToken: string, amount: string) {
	const response = await fetch(`${serverURL}/api/getQuote`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				from: fromToken,
				to: toToken,
				amount: amount,
				affinity: 'from'
			}
		})
	});

	expect(response.status).toBe(200);
	const data: unknown = await response.json();
	expect(data).toHaveProperty('ok', true);
	expect(data).toHaveProperty('quote');

	if (typeof data !== 'object' || data === null || !('quote' in data)) {
		throw(new Error('Invalid quote response'));
	}

	return(data.quote);
}

async function createExchangeOnServer(
	serverURL: string,
	quote: unknown,
	client: InstanceType<typeof KeetaNet.UserClient>,
	sendToken: InstanceType<typeof KeetaNet.lib.Account<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>>,
	amount: bigint
) {
	if (typeof quote !== 'object' || quote === null || !('account' in quote) || typeof quote.account !== 'string') {
		throw(new Error('Invalid quote'));
	}

	const builder = client.initBuilder();
	builder.send(KeetaNet.lib.Account.fromPublicKeyString(quote.account), amount, sendToken);
	const computed = await builder.computeBlocks();
	const block = computed.blocks[0];
	if (!block) {
		throw(new Error('No block computed'));
	}

	const response = await fetch(`${serverURL}/api/createExchange`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				quote: quote,
				block: Buffer.from(block.toBytes()).toString('base64')
			}
		})
	});

	expect(response.status).toBe(200);
	const data: unknown = await response.json();
	expect(data).toHaveProperty('ok', true);

	return(data);
}

test('FX Server Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const storage = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE, undefined, 0);
	const token1 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);
	const token2 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 2);
	const { userClient: client } = await createNodeAndClient(account);

	for (const fxAccount of [account, storage]) {
		await using server = new KeetaNetFXAnchorHTTPServer({
			logger: TestLogger,
			account: fxAccount,
			signer: account,
			client: client,
			quoteSigner: account,
			fx: {
				from: [{
					currencyCodes: [token1.publicKeyString.get()],
					to: [token2.publicKeyString.get()]
				}],
				getConversionRateAndFee: async function() {
					return({
						account: fxAccount,
						convertedAmount: 1000n,
						cost: {
							amount: 0n,
							token: KeetaNet.lib.Account.fromTokenPublicKey(KeetaNet.lib.Account.generateRandomSeed())
						}
					});
				}
			}
		});

		await server.start();
		const url = server.url;

		const serviceMetadata = await server.serviceMetadata();
		expect(serviceMetadata).toEqual({
			from: [{
				currencyCodes: [token1.publicKeyString.get()],
				to: [token2.publicKeyString.get()]
			}],
			operations: {
				getEstimate: `${url}/api/getEstimate`,
				getQuote: `${url}/api/getQuote`,
				createExchange: `${url}/api/createExchange`,
				getExchangeStatus: `${url}/api/getExchangeStatus/{id}`
			}
		});

		const testData = [
			null,
			undefined,
			{},
			{ request: null },
			{ request: undefined },
			{ request: {}},
			{ request: { quote: null }},
			{ request: { quote: {}}},
			{ request: { quote: {}, block: null }},
			{ request: { quote: {}, block: undefined }},
			{ request: { quote: {}, block: 123 }},
			{ request: { quote: {}, block: '' }}
		]

		const postRoutes = [
			{ test: '/api/getEstimate', error: 500 },
			{ test: '/api/getQuote', error: 500 },
			{ test: '/api/createExchange', error: 500 },
			{ test: '/api/missing', error: 404 },
			{ test: '/api/getEstimate', error: 500, skipJSON: true },
			{ test: '/api/getEstimate', error: 400, contentType: 'text/plain' }
		]

		for (const route of postRoutes) {
			for (const data of testData) {
				const serverURL = `${url}${route.test}`;
				const results = await fetch(serverURL, {
					method: 'POST',
					headers: {
						'Content-Type': route.contentType ?? 'application/json',
						'Accept': 'application/json'
					},
					body: route.skipJSON ? '123' : JSON.stringify({
						request: data
					})
				});
				expect(results.status).toBe(route.error);
			}
		}


		const getParams = [
			{ test: '', error: 404 },
			{ test: '/[object Object]', error: 400 },
			{ test: '123', error: 404 },
			{ test: '/123', error: 400 }
		]
		for (const param of getParams) {
			const serverURL = `${url}/api/getExchangeStatus${param.test}`;
			const result = await fetch(serverURL, {
				method: 'GET',
				headers: {
					'Accept': 'application/json'
				}
			});
			expect(result.status).toBe(param.error);
		}

		{
			/*
			* Verify that CORS headers are set correctly
			*/
			const corsTestURL = `${url}/api/getEstimate`;

			const checks = [
				{
					request: {
						from: 'keeta_amx',
						to: 'keeta_anx',
						amount: '1.00',
						affinity: 'to'
					},
					responseStatus: 200
				}, {
					request: {},
					responseStatus: 500
				}
			];
			for (const check of checks) {
				const result_POST = await fetch(corsTestURL, {
					method: 'POST',
					headers: {
						'Origin': 'http://example.com',
						'Content-Type': 'application/json',
						'Accept': 'application/json'
					},
					body: JSON.stringify({
						request: check.request
					})
				});

				expect(result_POST.status).toBe(check.responseStatus);
				expect(result_POST.headers.get('Access-Control-Allow-Origin')).toBe('*');
			}

			const result_OPTIONS = await fetch(corsTestURL, {
				method: 'OPTIONS',
				headers: {
					'Origin': 'http://example.com',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'Content-Type'
				}
			});

			expect(result_OPTIONS.status).toBe(204);
			expect(result_OPTIONS.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(result_OPTIONS.headers.get('Access-Control-Allow-Methods')?.split(',').map(function(part) {
				return(part.trim());
			}).sort().join(',')).toBe('OPTIONS,POST');
			expect(result_OPTIONS.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
			expect(Number(result_OPTIONS.headers.get('Access-Control-Max-Age'))).toBeGreaterThan(30);
		}
	}
});

test('FX Server Quote Validation Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const token1 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);
	const token2 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 2);
	const { userClient: client } = await createNodeAndClient(account);

	let validateQuoteCalled = false;
	let shouldAcceptQuote = true;

	await using server = new KeetaNetFXAnchorHTTPServer({
		logger: TestLogger,
		account: account,
		client: client,
		quoteSigner: account,
		fx: {
			from: [{
				currencyCodes: [token1.publicKeyString.get()],
				to: [token2.publicKeyString.get()]
			}],
			getConversionRateAndFee: async function() {
				return({
					account: account,
					convertedAmount: 1000n,
					cost: {
						amount: 0n,
						token: token1
					}
				});
			},
			validateQuote: async function(quote) {
				validateQuoteCalled = true;
				/* Verify that the quote has the expected structure */
				expect(quote).toHaveProperty('request');
				expect(quote).toHaveProperty('account');
				expect(quote).toHaveProperty('convertedAmount');
				expect(quote).toHaveProperty('cost');
				expect(quote).toHaveProperty('signed');
				return(shouldAcceptQuote);
			}
		}
	});

	await server.start();
	const url = server.url;

	/* First, get a quote */
	const quoteResponse = await fetch(`${url}/api/getQuote`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				from: token1.publicKeyString.get(),
				to: token2.publicKeyString.get(),
				amount: '100',
				affinity: 'from'
			}
		})
	});

	expect(quoteResponse.status).toBe(200);
	const quoteData: unknown = await quoteResponse.json();
	expect(quoteData).toHaveProperty('ok', true);
	expect(quoteData).toHaveProperty('quote');

	if (typeof quoteData !== 'object' || quoteData === null || !('quote' in quoteData)) {
		throw(new Error('Invalid quote response'));
	}

	const quote = quoteData.quote;

	/* Test that the quote is rejected when validateQuote returns false */
	validateQuoteCalled = false;
	shouldAcceptQuote = false;

	const fakeBlock = await (async () => {
		const builder = client.initBuilder();

		if (typeof quote !== 'object' || quote === null || !('account' in quote) || typeof quote.account !== 'string') {
			throw(new Error('invalid quote'));
		}

		builder.send(KeetaNet.lib.Account.fromPublicKeyString(quote.account), 100n, token1);
		const computed = await builder.computeBlocks();
		const block = computed.blocks[0];
		if (!block) {
			throw(new Error('invariant, should have computed a block'));
		}

		return(block);
	})();

	{
		shouldAcceptQuote = true;

		const exchangeResponseRejected = await fetch(`${url}/api/createExchange`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				request: {
					request: {
						from: token1.publicKeyString.get(),
						to: token2.publicKeyString.get(),
						amount: '100',
						affinity: 'from'
					},
					block: Buffer.from(fakeBlock.toBytes()).toString('base64')
				}
			})
		});

		expect(exchangeResponseRejected.status).toBe(400);
		const errorData: unknown = await exchangeResponseRejected.json();
		expect(errorData).toHaveProperty('ok', false);
		expect(errorData).toHaveProperty('error');
		/* Verify we got the correct error type */
		if (typeof errorData === 'object' && errorData !== null && 'name' in errorData) {
			expect(errorData.name).toBe('KeetaFXAnchorQuoteRequiredError');
		} else {
			expect(false).toEqual(true);
		}
	}

	{
		shouldAcceptQuote = false;
		validateQuoteCalled = false;

		const exchangeResponseRejected = await fetch(`${url}/api/createExchange`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				request: {
					quote: quote,
					block: Buffer.from(fakeBlock.toBytes()).toString('base64')
				}
			})
		});

		/* The validation callback should have been called */
		expect(validateQuoteCalled).toBe(true);
		/* And since it returned false, the server should reject the request */
		expect(exchangeResponseRejected.status).toBe(400);
		const errorData: unknown = await exchangeResponseRejected.json();
		expect(errorData).toHaveProperty('ok', false);
		expect(errorData).toHaveProperty('error');
		/* Verify we got the correct error type */
		if (typeof errorData === 'object' && errorData !== null && 'name' in errorData) {
			expect(errorData.name).toBe('KeetaFXAnchorQuoteValidationFailedError');
		} else {
			expect(false).toEqual(true);
		}

	}
});

test('FX Server Constructor Variation Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const quoteSigner = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const client = {
		client: new KeetaNet.Client([]),
		network: 0n,
		networkAlias: 'test' as const
	};

	const invalidChecks: Partial<ConstructorParameters<typeof KeetaNetFXAnchorHTTPServer>[0]>[] = [{
		/** Invalid - Must supply signer when accounts is supplied */
		accounts: new KeetaNet.lib.Account.Set([account])
	}, {
		/** Invalid - Must supply only one of account or accounts */
		account: account,
		accounts: new KeetaNet.lib.Account.Set([account])
	}, {
		/** Invalid -- neither account nor accounts+signer is supplied */
	}]

	const validChecks: Partial<ConstructorParameters<typeof KeetaNetFXAnchorHTTPServer>[0]>[] = [{
		accounts: new KeetaNet.lib.Account.Set([account]),
		signer: account
	}, {
		account: account
	}]

	const performCheck = async function(config: Partial<ConstructorParameters<typeof KeetaNetFXAnchorHTTPServer>[0]>) {
		await using server = new KeetaNetFXAnchorHTTPServer({
			...config,
			logger: TestLogger,
			client: client,
			quoteSigner: quoteSigner,
			fx: {
				getConversionRateAndFee: async function() {
					return({
						account: account,
						convertedAmount: 1000n,
						cost: {
							token: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
							amount: 0n
						}
					});
				}
			}
		});
		return(server);
	};

	for (const invalidCheck of invalidChecks) {
		await expect(async function() {
			return(await performCheck(invalidCheck));
		}).rejects.toThrow();
	}

	for (const validCheck of validChecks) {
		await expect(performCheck(validCheck)).resolves.toBeInstanceOf(KeetaNetFXAnchorHTTPServer);
	}
});

test('FX Server autoRun Concurrent Request Tests', async function() {
	/*
	 * Create multiple accounts to avoid block chain conflicts when
	 * submitting concurrent exchanges
	 */
	const accounts = [
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0)
	];

	const serverAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(serverAccount);
	const serverClient = nodeAndClient.userClient;

	// Create tokens and set default permissions
	const { account: token1 } = await serverClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: token2 } = await serverClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	if (!token1.isToken() || !token2.isToken()) {
		throw(new Error('Tokens are not tokens'));
	}

	// Set default permissions to ACCESS so all accounts can look up info
	await serverClient.setInfo({
		name: '',
		description: '',
		metadata: '',
		defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], [])
	}, { account: token1 });
	await serverClient.setInfo({
		name: '',
		description: '',
		metadata: '',
		defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], [])
	}, { account: token2 });

	// Fund the server account with token2 so it can send converted tokens
	await serverClient.modTokenSupplyAndBalance(100000n, token2);

	/*
	 * Create clients for each account and fund them
	 */
	const clients: InstanceType<typeof KeetaNet.UserClient>[] = [];
	for (const account of accounts) {
		// Fund the account with token1
		await serverClient.modTokenSupplyAndBalance(1000n, token1);
		await serverClient.send(account, 1000n, token1);

		// Create a client using the same connection
		clients.push(new KeetaNet.UserClient({
			client: serverClient.client,
			signer: account,
			usePublishAid: false,
			network: serverClient.network,
			networkAlias: 'test'
		}));
	}

	let processingCount = 0;
	const delayMs = 50;

	await using server = new KeetaNetFXAnchorHTTPServer({
		logger: TestLogger,
		account: serverAccount,
		client: serverClient,
		quoteSigner: serverAccount,
		fx: {
			from: [{
				currencyCodes: [token1.publicKeyString.get()],
				to: [token2.publicKeyString.get()]
			}],
			getConversionRateAndFee: async function() {
				processingCount++;
				await asleep(delayMs);
				return({
					account: serverAccount,
					convertedAmount: 1000n,
					cost: {
						amount: 0n,
						token: token1
					}
				});
			}
		}
	});

	await server.start();
	const url = server.url;

	const getQuote = () => getQuoteFromServer(url, token1.publicKeyString.get(), token2.publicKeyString.get(), '100');
	const createExchange = (quote: unknown, clientIndex: number) => {
		const client = clients[clientIndex];
		if (!client) {
			throw(new Error(`Invalid client index: ${clientIndex}`));
		}
		return(createExchangeOnServer(url, quote, client, token1, 100n));
	};

	/*
	 * Test: Multiple concurrent createExchange requests to the same autoRun-enabled server
	 * This tests the mutex (autoRunRunning flag) to ensure only one autoRun loop
	 * executes at a time, preventing race conditions in queue processing
	 */
	const numConcurrentRequests = 5;
	const quotes = await Promise.all(
		Array(numConcurrentRequests).fill(0).map(() => getQuote())
	);

	const exchanges = await Promise.all(
		quotes.map((quote, index) => createExchange(quote, index))
	);

	expect(exchanges.length).toBe(numConcurrentRequests);

	/*
	 * All exchanges should succeed despite concurrent requests
	 */
	for (const exchange of exchanges) {
		expect(exchange).toHaveProperty('ok', true);
	}

	/*
	 * Verify all items were processed (processingCount includes both
	 * quote generation and exchange processing)
	 */
	expect(processingCount).toBeGreaterThanOrEqual(numConcurrentRequests);

	/*
	 * Validate that all exchanges complete successfully
	 */
	const completionResults = await Promise.all(
		exchanges.map(exchange => waitForExchangeCompletion(url, extractExchangeID(exchange), 10000))
	);

	for (const result of completionResults) {
		expect(result).toHaveProperty('status', 'completed');
	}
}, 30000);

test('FX Server autoRun Multiple Servers Same Queue Tests', async function() {
	/*
	 * Create multiple accounts to avoid block chain conflicts when
	 * submitting concurrent exchanges
	 */
	const accounts = [
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0),
		KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0)
	];

	const serverAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	await using nodeAndClient = await createNodeAndClient(serverAccount);
	const serverClient = nodeAndClient.userClient;

	// Create tokens and set default permissions
	const { account: token1 } = await serverClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: token2 } = await serverClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	if (!token1.isToken() || !token2.isToken()) {
		throw(new Error('Tokens are not tokens'));
	}

	// Set default permissions to ACCESS so all accounts can look up info
	await serverClient.setInfo({
		name: '',
		description: '',
		metadata: '',
		defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], [])
	}, { account: token1 });
	await serverClient.setInfo({
		name: '',
		description: '',
		metadata: '',
		defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], [])
	}, { account: token2 });

	// Fund the server account with token2 so it can send converted tokens
	await serverClient.modTokenSupplyAndBalance(100000n, token2);

	/*
	 * Create clients for each account and fund them
	 */
	const clients: InstanceType<typeof KeetaNet.UserClient>[] = [];
	for (const account of accounts) {
		// Fund the account with token1
		await serverClient.modTokenSupplyAndBalance(1000n, token1);
		await serverClient.send(account, 1000n, token1);

		// Create a client using the same connection
		clients.push(new KeetaNet.UserClient({
			client: serverClient.client,
			signer: account,
			usePublishAid: false,
			network: serverClient.network,
			networkAlias: 'test'
		}));
	}

	/*
	 * Create a shared storage backend that both servers will use
	 */
	const sharedStorage = new KeetaAnchorQueueStorageDriverMemory();

	const createServer = async function() {
		const server = new KeetaNetFXAnchorHTTPServer({
			logger: TestLogger,
			account: serverAccount,
			client: serverClient,
			quoteSigner: serverAccount,
			storage: {
				queue: sharedStorage,
				autoRun: true
			},
			fx: {
				from: [{
					currencyCodes: [token1.publicKeyString.get()],
					to: [token2.publicKeyString.get()]
				}],
				getConversionRateAndFee: async function() {
					await asleep(30);
					return({
						account: serverAccount,
						convertedAmount: 1000n,
						cost: {
							amount: 0n,
							token: token1
						}
					});
				}
			}
		});

		await server.start();
		return(server);
	};

	await using server1 = await createServer();
	await using server2 = await createServer();

	const url1 = server1.url;
	const url2 = server2.url;

	const getQuote = (serverURL: string) => getQuoteFromServer(serverURL, token1.publicKeyString.get(), token2.publicKeyString.get(), '100');
	const createExchange = (serverURL: string, quote: unknown, clientIndex: number) => {
		const client = clients[clientIndex];
		if (!client) {
			throw(new Error(`Invalid client index: ${clientIndex}`));
		}
		return(createExchangeOnServer(serverURL, quote, client, token1, 100n));
	};

	/*
	 * Test: Multiple servers using the same queue with concurrent requests
	 * This verifies that the queue's internal locking prevents race conditions
	 * when multiple server instances with autoRun enabled share the same queue.
	 * The runner lock ensures requests are serialized even when submitted concurrently.
	 */
	const quote1 = await getQuote(url1);
	const quote2 = await getQuote(url2);
	const quote3 = await getQuote(url1);
	const quote4 = await getQuote(url2);

	const [exchange1, exchange2, exchange3, exchange4] = await Promise.all([
		createExchange(url1, quote1, 0),
		createExchange(url2, quote2, 1),
		createExchange(url1, quote3, 2),
		createExchange(url2, quote4, 3)
	]);

	/*
	 * All exchanges should succeed - this confirms that multiple servers
	 * can share the same queue and handle concurrent requests without
	 * race conditions or deadlocks
	 */
	expect(exchange1).toHaveProperty('ok', true);
	expect(exchange2).toHaveProperty('ok', true);
	expect(exchange3).toHaveProperty('ok', true);
	expect(exchange4).toHaveProperty('ok', true);

	/*
	 * Validate that the items finish processing by checking their status
	 */
	const exchangeID1 = extractExchangeID(exchange1);
	const exchangeID2 = extractExchangeID(exchange2);
	const exchangeID3 = extractExchangeID(exchange3);
	const exchangeID4 = extractExchangeID(exchange4);

	/*
	 * Wait for all exchanges to complete - they should all process
	 * successfully despite using the same shared queue with autoRun
	 */
	const [status1, status2, status3, status4] = await Promise.all([
		waitForExchangeCompletion(url1, exchangeID1),
		waitForExchangeCompletion(url2, exchangeID2),
		waitForExchangeCompletion(url1, exchangeID3),
		waitForExchangeCompletion(url2, exchangeID4)
	]);

	expect(status1).toHaveProperty('status', 'completed');
	expect(status2).toHaveProperty('status', 'completed');
	expect(status3).toHaveProperty('status', 'completed');
	expect(status4).toHaveProperty('status', 'completed');
}, 60000);
