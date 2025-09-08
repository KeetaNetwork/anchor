import { expect, test } from 'vitest';
import * as HTTPServer from './http-server.js';
import { KeetaAnchorUserError } from './error.js';

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

				routes['GET /api/internal-server-error'] = async function() {
					throw(new Error(`Internal error ${crypto.randomUUID()}`));
				};

				routes['GET /api/user-error'] = async function() {
					throw(new KeetaAnchorUserError('This is a user error'));
				};

				routes['ERROR'] = async function(_ignored_params, body) {
					const errorInfo = HTTPServer.AssertHTTPErrorData(body);

					return({
						output: errorInfo.error,
						statusCode: errorInfo.statusCode ?? 500,
						contentType: errorInfo.contentType ?? 'application/json'
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
		}] as const;

		for (const check of checks) {
			let body;
			if ('body' in check) {
				body = JSON.stringify(check.body);
			}

			const response = await testHTTPRequest(server.url, check.path, check.method, body);

			if ('statusCode' in check) {
				expect(response.code).toBe(check.statusCode);
			} else {
				expect(response.code).toBe(200);
			}

			if ('responseMatch' in check) {
				expect(response.body).toMatchObject(check.responseMatch);
			}
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
