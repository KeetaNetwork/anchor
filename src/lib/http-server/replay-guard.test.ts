import { expect, test } from 'vitest';
import { MemoryReplayGuard } from './replay-guard.js';

test('MemoryReplayGuard accepts a key once until its claim expires', async function() {
	const guard = new MemoryReplayGuard();
	const future = new Date(Date.now() + 60_000);

	expect(await guard.claim('a', future)).toBe(true);
	expect(await guard.claim('a', future)).toBe(false);
	expect(await guard.claim('b', future)).toBe(true);

	const past = new Date(Date.now() - 1);
	expect(await guard.claim('c', past)).toBe(true);
	expect(await guard.claim('c', future)).toBe(true);
});

test('MemoryReplayGuard evicts the oldest claim when full instead of refusing new ones', async function() {
	const guard = new MemoryReplayGuard({ maxEntries: 2 });
	const future = new Date(Date.now() + 60_000);

	expect(await guard.claim('first', future)).toBe(true);
	expect(await guard.claim('second', future)).toBe(true);
	expect(await guard.claim('third', future)).toBe(true);

	/* The oldest claim was evicted, the newer ones are still held */
	expect(await guard.claim('second', future)).toBe(false);
	expect(await guard.claim('third', future)).toBe(false);
	expect(await guard.claim('first', future)).toBe(true);
});
