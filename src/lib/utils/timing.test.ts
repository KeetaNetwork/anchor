import { afterEach, expect, test, vi } from 'vitest';
import { RequestTiming } from './timing.js';
import { NullLog } from '../log/index.js';

afterEach(function() {
	vi.useRealTimers();
});

function createTiming() {
	const timing = new RequestTiming();
	timing.log = NullLog();
	const logError = vi.spyOn(timing.log, 'error');

	return({ timing, logError });
}

test('Sections are listed in start order and numbered in end order', function() {
	vi.useFakeTimers();
	const { timing } = createTiming();

	const outer = timing.startTime('outer');
	vi.advanceTimersByTime(5);
	const inner = timing.startTime('inner');
	vi.advanceTimersByTime(10);
	inner.end();
	vi.advanceTimersByTime(20);
	outer.end();
	const sync = timing.startTime('sync');
	vi.advanceTimersByTime(1);
	timing.endTime(sync.id);

	expect(timing.getAllTiming()).toEqual({
		'outer-1': { name: 'outer', duration: 35 },
		'inner-0': { name: 'inner', duration: 10 },
		'sync-2': { name: 'sync', duration: 1 }
	});
	expect(Object.keys(timing.getAllTiming())).toEqual(['outer-1', 'inner-0', 'sync-2']);
});

test('Sections with the same name are kept apart', function() {
	vi.useFakeTimers();
	const { timing } = createTiming();

	const first = timing.startTime('db');
	const second = timing.startTime('db');
	vi.advanceTimersByTime(3);
	second.end();
	vi.advanceTimersByTime(4);
	first.end();

	expect(timing.getAllTiming()).toEqual({
		'db-1': { name: 'db', duration: 7 },
		'db-0': { name: 'db', duration: 3 }
	});
});

test('Unfinished sections are left out', function() {
	const { timing } = createTiming();

	timing.startTime('never-ended');
	timing.startTime('ended').end();

	expect(Object.keys(timing.getAllTiming())).toEqual(['ended-0']);
});

test('Disposing ends a section once', function() {
	vi.useFakeTimers();
	const { timing, logError } = createTiming();

	{
		using scoped = timing.startTime('scoped');
		expect(scoped.id.description).toBe('scoped');
		vi.advanceTimersByTime(2);
		expect(timing.getAllTiming()).toEqual({});
	}

	{
		using section = timing.startTime('ended-early');
		section.end();
	}

	expect(timing.getAllTiming()).toEqual({
		'scoped-0': { name: 'scoped', duration: 2 },
		'ended-early-1': { name: 'ended-early', duration: 0 }
	});
	expect(logError).not.toHaveBeenCalled();
});

test('Ending a section twice or ending an unknown section logs an error', function() {
	vi.useFakeTimers();
	const { timing, logError } = createTiming();

	const section = timing.startTime('twice');
	vi.advanceTimersByTime(4);
	section.end();
	vi.advanceTimersByTime(4);
	section.end();
	timing.endTime(Symbol('unknown'));
	timing.endTime(undefined);

	expect(timing.getAllTiming()).toEqual({
		'twice-0': { name: 'twice', duration: 4 }
	});
	expect(logError).toHaveBeenCalledTimes(2);
});

test('Errors are ignored when no logger is set', function() {
	const timing = new RequestTiming();
	const section = timing.startTime('twice');
	section.end();

	expect(function() {
		section.end();
		timing.endTime(Symbol('unknown'));
	}).not.toThrow();
	expect(Object.keys(timing.getAllTiming())).toEqual(['twice-0']);
});

test('runTimer times code and ends the section when the code throws', async function() {
	const { timing } = createTiming();

	await expect(timing.runTimer('ok', async function() {
		return(42);
	})).resolves.toBe(42);

	await expect(timing.runTimer('fails', async function() {
		throw(new Error('failure'));
	})).rejects.toThrow('failure');

	expect(Object.keys(timing.getAllTiming())).toEqual(['ok-0', 'fails-1']);
});

test('Static runTimer runs the code without timing when no timing object is given', async function() {
	const { timing } = createTiming();

	await expect(RequestTiming.runTimer('skipped', undefined, async function() {
		return('skipped');
	})).resolves.toBe('skipped');

	await expect(RequestTiming.runTimer('timed', timing, async function() {
		return('timed');
	})).resolves.toBe('timed');

	expect(Object.keys(timing.getAllTiming())).toEqual(['timed-0']);
});
