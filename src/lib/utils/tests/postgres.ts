/**
 * Connection settings for the Postgres server the tests run against,
 * from the ANCHOR_TESTING_POSTGRES_* environment variables, or null
 * when they are not set (the Postgres tests are then skipped)
 */
export function getTestingPostgresConfig(): { host: string; port: number; user: string; password: string; } | null {
	const host = process.env['ANCHOR_TESTING_POSTGRES_HOST'];
	const portStr = process.env['ANCHOR_TESTING_POSTGRES_PORT'];
	const user = process.env['ANCHOR_TESTING_POSTGRES_USER'];
	const password = process.env['ANCHOR_TESTING_POSTGRES_PASS'];

	if (!host || !portStr || !user || !password) {
		return(null);
	}

	const port = Number(portStr);
	if (Number.isNaN(port) || port <= 0 || port >= 65536) {
		return(null);
	}

	return({ host: host, port: port, user: user, password: password });
}
