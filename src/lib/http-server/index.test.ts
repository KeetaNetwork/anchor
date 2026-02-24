import { expect, test } from 'vitest';
import * as HTTPServer from './index.js';
import { KeetaAnchorUserError } from '../error.js';
import crypto from 'crypto';

function hashData(data: Buffer): Buffer {
	const hash = crypto.createHash('sha256');
	hash.update(data);
	return(hash.digest());
}

async function testHTTPRequest(serverURL: string, path: string, method: 'GET' | 'POST', body?: string): Promise<{ code: number; body: unknown }> {
	const fullURL = new URL(path, serverURL);

	const options: RequestInit = {
		method: method,
		headers: {
			'Accept': 'application/json'
		}
	};

	if (method === 'POST' && body !== undefined) {
		options.headers = {
			...options.headers,
			'Content-Type': 'application/json'
		};
		options.body = body;
	}

	const response = await fetch(fullURL, options);

	let responseBody: unknown;
	if (response.headers.get('Content-Type')?.includes('application/json')) {
		responseBody = await response.json();
	} else if (response.headers.get('Content-Type')?.includes('application/octet-stream')) {
		responseBody = await response.arrayBuffer();
	} else {
		responseBody = await response.text();
	}

	return({
		code: response.status,
		body: responseBody
	});
}

test('Basic Functionality', async function() {
	/*
	 * Test that the HTTP Server provides the routes defined
	 */
	{
		type ConfigWithAttr = HTTPServer.KeetaAnchorHTTPServerConfig & { attr: string; };

		await using server = new (class extends HTTPServer.KeetaNetAnchorHTTPServer<ConfigWithAttr> {
			protected async initRoutes(config: ConfigWithAttr): Promise<HTTPServer.Routes> {
				expect(config.attr).toBeDefined();

				const routes: HTTPServer.Routes = {};

				routes['GET /api/1'] = async function() {
					return({
						output: JSON.stringify({ message: 'GET /api/1 route works!' }),
						statusCode: 200
					});
				};

				routes['GET /api/2/:id'] = async function(params) {
					return({
						output: JSON.stringify({
							message: `GET /api/2 route works!`,
							params: [...params.entries()]
						}),
						statusCode: 200
					});
				};

				routes['POST /api/3/:id'] = routes['POST /api/3'] = async function(params, body) {
					return({
						output: JSON.stringify({
							message: `POST /api/3 route works!`,
							body: body,
							params: [...params.entries()]
						}),
						statusCode: 200
					});
				};

				routes['GET /binary-data'] = async function() {
					return({
						output: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
						statusCode: 200,
						contentType: 'application/octet-stream'
					});
				};

				routes['GET /api/internal-server-error'] = async function() {
					throw(new Error(`Internal error ${crypto.randomUUID()}`));
				};

				routes['GET /api/user-error'] = async function() {
					throw(new KeetaAnchorUserError('This is a user error'));
				};

				routes['POST /api/test-raw/:hash'] = {
					bodyType: 'raw',
					handler: async function(params, body) {
						const hashParam = params.get('hash');
						if (typeof hashParam !== 'string') {
							throw(new Error('Missing hash parameter'));
						}

						const gotHash = hashData(body);
						const expectedHash = Buffer.from(hashParam, 'hex');

						const equals = gotHash.compare(expectedHash) === 0;

						if (!equals) {
							throw(new Error('Hash does not match'));
						}

						return({ output: 'true' });
					}
				};

				// Wildcard route - captures variable-depth paths
				routes['GET /api/files/**'] = async function(params) {
					const wildcardPath = params.get('**');
					return({
						output: JSON.stringify({
							message: 'Wildcard route works!',
							path: wildcardPath
						}),
						statusCode: 200
					});
				};

				// Exact route that should take priority over wildcard
				routes['GET /api/files/special'] = async function() {
					return({
						output: JSON.stringify({
							message: 'Exact route takes priority!'
						}),
						statusCode: 200
					});
				};

				// Wildcard with path parameter (defined before /api/** for priority)
				routes['GET /api/users/:id/**'] = async function(params) {
					const userId = params.get('id');
					const wildcardPath = params.get('**');
					return({
						output: JSON.stringify({
							message: 'Wildcard with param!',
							id: userId,
							path: wildcardPath
						}),
						statusCode: 200
					});
				};

				// Fallback wildcard
				routes['GET /api/**'] = async function(params) {
					const wildcardPath = params.get('**');
					return({
						output: JSON.stringify({
							message: 'Less specific wildcard!',
							path: wildcardPath
						}),
						statusCode: 200
					});
				};

				return(routes);
			}
		})({ port: 0, attr: 'test-attribute' });

		/*
		 * Start the server to ensure that the routes are initialized and available.
		 */
		await server.start();

		/*
		 * After starting the server, we expect that the URL is
		 * defined and accessible.
		 */
		expect(server.url).toBeDefined();

		const testRawPostBody = JSON.stringify({ test: 'data' });
		const testRawPostHash = hashData(Buffer.from(testRawPostBody)).toString('hex');

		/*
		 * Make some requests to the server to verify that the routes
		 * work as expected.
		*/
		const checks = [{
			method: 'GET',
			path: '/api/1',
			responseMatch: {
				message: 'GET /api/1 route works!'
			}
		}, {
			method: 'GET',
			path: '/api/2/123',
			responseMatch: {
				message: 'GET /api/2 route works!',
				params: [['id', '123']]
			}
		}, {
			method: 'POST',
			path: '/api/3',
			body: {
				data: 'test-data'
			},
			responseMatch: {
				message: 'POST /api/3 route works!',
				body: {
					data: 'test-data'
				},
				params: []
			}
		}, {
			method: 'POST',
			path: '/api/3/456',
			body: {
				data: 'test-data'
			},
			responseMatch: {
				message: 'POST /api/3 route works!',
				body: {
					data: 'test-data'
				},
				params: [['id', '456']]
			}
		}, {
			method: 'GET',
			path: '/api/does-not-exist',
			responseMatch: {
				message: 'Less specific wildcard!',
				path: 'does-not-exist'
			}
		}, {
			method: 'GET',
			path: '/other/does-not-exist',
			statusCode: 404
		}, {
			method: 'GET',
			path: '/api/internal-server-error',
			statusCode: 500,
			responseMatch: {
				ok: false,
				error: 'Internal Server Error'
			}
		}, {
			method: 'GET',
			path: '/api/user-error',
			statusCode: 400,
			responseMatch: {
				ok: false,
				error: 'This is a user error'
			}
		}, {
			method: 'GET',
			path: '/binary-data',
			statusCode: 200,
			responseMatchBinary: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
		}, {
			method: 'POST',
			path: `/api/test-raw/${testRawPostHash}`,
			body: testRawPostBody,
			statusCode: 200
		},
		{
			method: 'POST',
			path: `/api/test-raw/${testRawPostHash}`,
			body: `${testRawPostBody} `,
			statusCode: 500
		},
		// Wildcard route tests
		{
			method: 'GET',
			path: '/api/files/user/abc123/documents/report.pdf',
			responseMatch: {
				message: 'Wildcard route works!',
				path: 'user/abc123/documents/report.pdf'
			}
		},
		{
			method: 'GET',
			path: '/api/files/simple.txt',
			responseMatch: {
				message: 'Wildcard route works!',
				path: 'simple.txt'
			}
		},
		// Exact route takes priority over wildcard
		{
			method: 'GET',
			path: '/api/files/special',
			responseMatch: {
				message: 'Exact route takes priority!'
			}
		},
		// Trailing slash falls through to /api/*
		{
			method: 'GET',
			path: '/api/files/',
			responseMatch: {
				message: 'Less specific wildcard!',
				path: 'files'
			}
		},
		// Multiple trailing slashes fall through to /api/*
		{
			method: 'GET',
			path: '/api/files///',
			responseMatch: {
				message: 'Less specific wildcard!',
				path: 'files'
			}
		},
		// Trailing slash after content is stripped
		{
			method: 'GET',
			path: '/api/files/folder/',
			responseMatch: {
				message: 'Wildcard route works!',
				path: 'folder'
			}
		},
		// Falls through to /api/*
		{
			method: 'GET',
			path: '/api/other/something',
			responseMatch: {
				message: 'Less specific wildcard!',
				path: 'other/something'
			}
		},
		// More specific wildcard takes priority
		{
			method: 'GET',
			path: '/api/files/doc.txt',
			responseMatch: {
				message: 'Wildcard route works!',
				path: 'doc.txt'
			}
		},
		// Wildcard with path parameter
		{
			method: 'GET',
			path: '/api/users/abc123/documents/report.pdf',
			responseMatch: {
				message: 'Wildcard with param!',
				id: 'abc123',
				path: 'documents/report.pdf'
			}
		},
		// Wildcard with path parameter (single segment)
		{
			method: 'GET',
			path: '/api/users/user42/file.txt',
			responseMatch: {
				message: 'Wildcard with param!',
				id: 'user42',
				path: 'file.txt'
			}
		}] as const;

		for (const check of checks) {
			let body;
			if ('body' in check) {
				if (typeof check.body === 'string') {
					body = check.body;
				} else {
					body = JSON.stringify(check.body);
				}
			}

			const response = await testHTTPRequest(server.url, check.path, check.method, body);

			if ('statusCode' in check) {
				expect(response.code).toBe(check.statusCode);
			} else {
				expect(response.code).toBe(200);
			}

			if ('responseMatchBinary' in check) {
				expect(response.body).toBeInstanceOf(ArrayBuffer);
				if (!(response.body instanceof ArrayBuffer)) {
					throw(new Error('Unexpected non-ArrayBuffer response body'));
				}
				const responseBuffer = Buffer.from(response.body);
				expect(responseBuffer.toString('base64')).toEqual(check.responseMatchBinary.toString('base64'));
			} else if ('responseMatch' in check) {
				expect(response.body).toMatchObject(check.responseMatch);
			}
		}

		/*
		 * Ensure we can update the URL
		 */
		const urlChecks: {
			in: string | URL | undefined | ((serverObj: typeof server | InstanceType<typeof HTTPServer.KeetaNetAnchorHTTPServer>) => string);
			out: string | ((serverObj: { port: number }) => string);
		}[] = [
			{ in: 'http://example.com/foo', out: 'http://example.com/' },
			{ in: 'https://example.com:8080/bar/baz', out: 'https://example.com:8080/' },
			{ in: 'https://example.com:8080/bar/baz?a=b', out: 'https://example.com:8080/' },
			{ in: new URL('http://localhost:3000/some/path'), out: 'http://localhost:3000/' },
			{ in: undefined, out: function(serverObj) { return(`http://localhost:${serverObj.port}/`); } },
			{
				in: function(serverObj: typeof server | InstanceType<typeof HTTPServer.KeetaNetAnchorHTTPServer>) {
					return('http://localhost:' + String(serverObj.port) + '/some/other/path');
				},
				out: function(serverObj) {
					return('http://localhost:' + String(serverObj.port) + '/');
				}
			}
		];
		for (const urlCheck of urlChecks) {
			server.url = urlCheck.in;

			let outCheck: string;
			if (typeof urlCheck.out === 'function') {
				outCheck = urlCheck.out(server);
			} else {
				outCheck = urlCheck.out;
			}

			expect(server.url).toBe(outCheck);
		}

		/*
		 * Same URL checks, plus some more supported by the
		 * constructor configuration `url` option
		 */
		const constructionURLChecks: {
			in: ConstructorParameters<typeof HTTPServer.KeetaNetAnchorHTTPServer<ConfigWithAttr>>[0]['url'];
			out: string | ((serverObj: { port: number }) => string);
		}[] = [
			...urlChecks,
			{
				in: {
					hostname: 'example.com'
				},
				out: function(serverObj) {
					return('http://example.com:' + String(serverObj.port) + '/');
				}
			}, {
				in: {
					protocol: 'https:',
					port: 443
				},
				out: 'https://localhost/'
			}
		];

		for (const urlCheck of constructionURLChecks) {
			await using tempServer = new (class extends HTTPServer.KeetaNetAnchorHTTPServer<ConfigWithAttr> {
				protected async initRoutes(_ignore_config: ConfigWithAttr): Promise<HTTPServer.Routes> {
					const routes: HTTPServer.Routes = {};
					return(routes);
				}
			})({
				url: urlCheck.in,
				attr: 'test'
			});

			await tempServer.start();

			let outCheck: string;
			if (typeof urlCheck.out === 'function') {
				outCheck = urlCheck.out(tempServer);
			} else {
				outCheck = urlCheck.out;
			}

			expect(tempServer.url).toBe(outCheck);
		}

		/*
		 * We call stop manually here to verify that it works,
		 * but if we did not call it, the server would be stopped
		 * automatically when the test function exits due to the
		 * use of `await using`.
		 */
		await server.stop();

		/*
		 * After stopping the server, we expect that accessing the URL will throw an error.
		 */
		expect(function() {
			return(server.url);
		}).toThrow();
	}
}, 90000);

test('Wildcard specificity: most specific route wins regardless of definition order', async function() {
	// Define routes in reverse specificity order
	const server = new (class extends HTTPServer.KeetaNetAnchorHTTPServer<HTTPServer.KeetaAnchorHTTPServerConfig> {
		protected async initRoutes(): Promise<HTTPServer.Routes> {
			const routes: HTTPServer.Routes = {};

			routes['GET /api/**'] = async function(params) {
				return({
					output: JSON.stringify({ handler: 'catch-all', path: params.get('**') }),
					statusCode: 200
				});
			};

			routes['GET /api/files/**'] = async function(params) {
				return({
					output: JSON.stringify({ handler: 'files', path: params.get('**') }),
					statusCode: 200
				});
			};

			routes['GET /api/files/images/**'] = async function(params) {
				return({
					output: JSON.stringify({ handler: 'images', path: params.get('**') }),
					statusCode: 200
				});
			};

			return(routes);
		}
	})({ port: 0 });

	await server.start();

	const cases = [
		{ path: '/api/other/thing', expectedHandler: 'catch-all' },
		{ path: '/api/files/doc.txt', expectedHandler: 'files' },
		{ path: '/api/files/images/photo.png', expectedHandler: 'images' },
		{ path: '/api/files/images/vacation/beach.jpg', expectedHandler: 'images' }
	];

	for (const testCase of cases) {
		const response = await testHTTPRequest(server.url, testCase.path, 'GET');
		expect(response.code).toBe(200);
		expect(response.body).toMatchObject({ handler: testCase.expectedHandler });
	}

	await server.stop();
}, 30000);
