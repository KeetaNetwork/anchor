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

test('MemoryReplayGuard refuses new claims while it is full of live ones, and never forgets a live claim', async function() {
	const guard = new MemoryReplayGuard({ maxEntries: 2 });
	const future = new Date(Date.now() + 60_000);

	expect(await guard.claim('first', future)).toBe(true);
	expect(await guard.claim('second', future)).toBe(true);
	expect(await guard.claim('third', future)).toBe(false);

	/* The earlier claims are still held */
	expect(await guard.claim('first', future)).toBe(false);
	expect(await guard.claim('second', future)).toBe(false);
});

test('MemoryReplayGuard accepts new claims again once earlier ones expire', async function() {
	const guard = new MemoryReplayGuard({ maxEntries: 1 });

	expect(await guard.claim('short', new Date(Date.now() + 50))).toBe(true);
	expect(await guard.claim('next', new Date(Date.now() + 60_000))).toBe(false);

	await new Promise(function(resolve) {
		setTimeout(resolve, 100);
	});
	expect(await guard.claim('next', new Date(Date.now() + 60_000))).toBe(true);
});

test('MemoryReplayGuard counts only live claims toward its limit, even behind a longer claim', async function() {
	const guard = new MemoryReplayGuard({ maxEntries: 2 });

	/* The long claim is first in insertion order, so the expired one sits behind it */
	expect(await guard.claim('long', new Date(Date.now() + 60_000))).toBe(true);
	expect(await guard.claim('short', new Date(Date.now() + 50))).toBe(true);

	await new Promise(function(resolve) {
		setTimeout(resolve, 100);
	});
	expect(await guard.claim('next', new Date(Date.now() + 60_000))).toBe(true);
	expect(await guard.claim('long', new Date(Date.now() + 60_000))).toBe(false);
});
