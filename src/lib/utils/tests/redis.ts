/**
 * Connection settings for the Redis server the tests run against, from
 * the ANCHOR_TESTING_REDIS_* environment variables, or null when they
 * are not set (the Redis tests are then skipped)
 */
export function getTestingRedisConfig(): { host: string; port: number; password: string | undefined; } | null {
	const host = process.env['ANCHOR_TESTING_REDIS_HOST'];
	const portStr = process.env['ANCHOR_TESTING_REDIS_PORT'];

	if (!host || !portStr) {
		return(null);
	}

	const password = process.env['ANCHOR_TESTING_REDIS_SECRET'];

	const port = Number(portStr);
	if (isNaN(port) || port <= 0 || port >= 65536) {
		return(null);
	}

	return({ host: host, port: port, password: password });
}
