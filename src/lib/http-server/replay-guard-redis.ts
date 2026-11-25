// cspell:ignore PXAT

import type { RedisClientType } from 'redis';
import type { KeetaAnchorReplayGuard } from './replay-guard.js';

/**
 * Options for {@link RedisReplayGuard}
 */
export interface RedisReplayGuardOptions {
	/**
	 * Returns a connected Redis client. Every instance of a server must
	 * reach the same Redis database.
	 */
	redis: () => Promise<RedisClientType>;

	/**
	 * Prefix for the keys the guard writes, so several servers can share
	 * one database. Defaults to `replay-guard`.
	 */
	keyPrefix?: string | undefined;
}

/**
 * {@link KeetaAnchorReplayGuard} shared through Redis, for servers that
 * run several instances behind one URL. Each claim is one `SET NX` that
 * Redis expires at the claim's expiry, so a nonce spent at one instance
 * is refused at every other.
 */
export class RedisReplayGuard implements KeetaAnchorReplayGuard {
	readonly #redis: RedisReplayGuardOptions['redis'];
	readonly #keyPrefix: string;

	constructor(options: RedisReplayGuardOptions) {
		this.#redis = options.redis;
		this.#keyPrefix = options.keyPrefix ?? 'replay-guard';
	}

	async claim(key: string, expiresAt: Date): Promise<boolean> {
		const redis = await this.#redis();
		const result = await redis.set(`${this.#keyPrefix}:${key}`, '1', {
			NX: true,
			PXAT: expiresAt.valueOf()
		});

		return(result === 'OK');
	}
}
