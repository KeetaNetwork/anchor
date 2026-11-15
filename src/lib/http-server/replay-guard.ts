/**
 * Records each signed request nonce so the same signature is accepted
 * only once while its timestamp is still within the allowed skew.
 *
 * Servers that run several instances behind one URL must share one
 * guard, such as one backed by Redis or SQL, or a signature can be
 * replayed against another instance.
 */
export interface KeetaAnchorReplayGuard {
	/**
	 * Claim `key` until `expiresAt`. Resolves `true` the first time a key
	 * is claimed, and `false` while an earlier claim on it has not expired.
	 */
	claim(key: string, expiresAt: Date): Promise<boolean>;
}

/**
 * Default number of live claims {@link MemoryReplayGuard} holds.
 */
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * Process-local {@link KeetaAnchorReplayGuard}. When it holds the maximum
 * number of live claims, it refuses new ones rather than forgetting an
 * earlier claim, so a flood of signed requests cannot make a spent nonce
 * usable again.
 */
export class MemoryReplayGuard implements KeetaAnchorReplayGuard {
	readonly #expiries = new Map<string, number>();
	readonly #maxEntries: number;

	constructor(options?: { maxEntries?: number }) {
		this.#maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
	}

	async claim(key: string, expiresAt: Date): Promise<boolean> {
		const now = Date.now();
		this.#dropExpired(now);

		const existing = this.#expiries.get(key);
		if (existing !== undefined && existing > now) {
			return(false);
		}

		if (existing === undefined && this.#expiries.size >= this.#maxEntries) {
			return(false);
		}

		this.#expiries.delete(key);
		this.#expiries.set(key, expiresAt.valueOf());

		return(true);
	}

	/**
	 * Drop expired claims from the front of the insertion order. Claims
	 * are inserted roughly in expiry order, so this stays cheap.
	 */
	#dropExpired(now: number): void {
		for (const [ key, expiry ] of this.#expiries) {
			if (expiry > now) {
				return;
			}

			this.#expiries.delete(key);
		}
	}
}
