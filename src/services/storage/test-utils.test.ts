import { expect, test, describe } from 'vitest';
import { MemoryStorageBackend } from './test-utils.js';
import { Buffer } from '../../lib/utils/buffer.js';

describe('MemoryStorageBackend', function() {
	test('CRUD operations', async function() {
		const backend = new MemoryStorageBackend();
		const owner = 'test-owner-pubkey';
		const path = `/user/${owner}/test.txt`;

		// Initially empty
		expect(backend.size).toBe(0);

		// PUT
		const putResult = await backend.put(path, Buffer.from('hello world'), {
			owner,
			tags: ['test', 'example'],
			visibility: 'private'
		});
		expect(putResult.path).toBe(path);
		expect(putResult.owner).toBe(owner);
		expect(putResult.tags).toEqual(['test', 'example']);
		expect(putResult.size).toBe('11');
		expect(backend.size).toBe(1);

		// GET
		const getResult = await backend.get(path);
		expect(getResult).not.toBeNull();
		expect(getResult?.data.toString()).toBe('hello world');
		expect(getResult?.metadata.path).toBe(path);

		// GET non-existent
		expect(await backend.get('/user/other/missing.txt')).toBeNull();

		// DELETE
		expect(await backend.delete(path)).toBe(true);
		expect(backend.size).toBe(0);
		expect(await backend.delete(path)).toBe(false);
	});

	test('search by path prefix', async function() {
		const backend = new MemoryStorageBackend();
		const owner = 'test-owner';

		await backend.put(`/user/${owner}/a.txt`, Buffer.from('a'), { owner, tags: [], visibility: 'private' });
		await backend.put(`/user/${owner}/b.txt`, Buffer.from('b'), { owner, tags: [], visibility: 'private' });
		await backend.put('/user/other/c.txt', Buffer.from('c'), { owner: 'other', tags: [], visibility: 'private' });

		const results = await backend.search({ pathPrefix: `/user/${owner}/` }, { limit: 10 });
		expect(results.results).toHaveLength(2);
	});

	test('search by tags', async function() {
		const backend = new MemoryStorageBackend();
		const owner = 'test-owner';

		await backend.put('/user/x/a.txt', Buffer.from('a'), { owner, tags: ['foo'], visibility: 'private' });
		await backend.put('/user/x/b.txt', Buffer.from('b'), { owner, tags: ['bar'], visibility: 'private' });
		await backend.put('/user/x/c.txt', Buffer.from('c'), { owner, tags: ['foo', 'bar'], visibility: 'private' });

		const fooResults = await backend.search({ tags: ['foo'] }, { limit: 10 });
		expect(fooResults.results).toHaveLength(2);

		const barResults = await backend.search({ tags: ['bar'] }, { limit: 10 });
		expect(barResults.results).toHaveLength(2);
	});

	test('quota tracking', async function() {
		const backend = new MemoryStorageBackend();
		const owner = 'quota-test-owner';
		const path = `/user/${owner}/file.txt`;

		// Initial state
		const initialQuota = await backend.getQuotaStatus(owner);
		expect(initialQuota.objectCount).toBe(0);
		expect(initialQuota.totalSize).toBe(0);

		// After first put
		await backend.put(path, Buffer.from('12345'), { owner, tags: [], visibility: 'private' });
		const afterPut = await backend.getQuotaStatus(owner);
		expect(afterPut.objectCount).toBe(1);
		expect(afterPut.totalSize).toBe(5);

		// Update same path - object count stays same, size changes
		await backend.put(path, Buffer.from('1234567890'), { owner, tags: [], visibility: 'private' });
		const afterUpdate = await backend.getQuotaStatus(owner);
		expect(afterUpdate.objectCount).toBe(1);
		expect(afterUpdate.totalSize).toBe(10);

		// Shrink object - size decreases
		await backend.put(path, Buffer.from('xy'), { owner, tags: [], visibility: 'private' });
		const afterShrink = await backend.getQuotaStatus(owner);
		expect(afterShrink.objectCount).toBe(1);
		expect(afterShrink.totalSize).toBe(2);
	});

	describe('upload reservations', function() {
		const reservationCases = [
			{
				name: 'reserves quota and reflects in status',
				reserveSize: 100,
				commitAfterPut: false,
				releaseAfterReserve: false,
				expectedDuringCount: 1,
				expectedDuringSize: 100,
				expectedAfterCount: 1,
				expectedAfterSize: 100
			},
			{
				name: 'commit after put reflects actual storage',
				reserveSize: 9, // 'test data'.length
				commitAfterPut: true,
				releaseAfterReserve: false,
				expectedDuringCount: 1,
				expectedDuringSize: 9,
				expectedAfterCount: 1,
				expectedAfterSize: 9,
				putData: 'test data'
			},
			{
				name: 'release frees reserved quota',
				reserveSize: 1000,
				commitAfterPut: false,
				releaseAfterReserve: true,
				expectedDuringCount: 1,
				expectedDuringSize: 1000,
				expectedAfterCount: 0,
				expectedAfterSize: 0
			}
		];

		for (const testCase of reservationCases) {
			test(testCase.name, async function() {
				const backend = new MemoryStorageBackend();
				const owner = 'reservation-test-owner';
				const path = `/user/${owner}/file.txt`;

				// Reserve quota
				const reservation = await backend.reserveUpload(owner, path, testCase.reserveSize);
				expect(reservation.id).toBeDefined();
				expect(reservation.owner).toBe(owner);

				// Check quota during reservation
				const duringQuota = await backend.getQuotaStatus(owner);
				expect(duringQuota.objectCount).toBe(testCase.expectedDuringCount);
				expect(duringQuota.totalSize).toBe(testCase.expectedDuringSize);

				// Perform action
				if (testCase.commitAfterPut && testCase.putData) {
					const data = Buffer.from(testCase.putData);
					await backend.put(path, data, { owner, tags: [], visibility: 'private' });
					await backend.commitUpload(reservation.id);
				} else if (testCase.releaseAfterReserve) {
					await backend.releaseUpload(reservation.id);
				}

				// Check final quota
				const afterQuota = await backend.getQuotaStatus(owner);
				expect(afterQuota.objectCount).toBe(testCase.expectedAfterCount);
				expect(afterQuota.totalSize).toBe(testCase.expectedAfterSize);
			});
		}

		test('throws when quota exceeded', async function() {
			const backend = new MemoryStorageBackend();
			await expect(backend.reserveUpload('x', '/user/x/big.bin', 200 * 1024 * 1024))
				.rejects.toThrow('quota');
		});

		test('concurrent reservations accumulate', async function() {
			const backend = new MemoryStorageBackend();
			const owner = 'concurrent-owner';
			const sizes = [100, 200, 300];

			// Create reservations
			const reservations = await Promise.all(
				sizes.map(function(size, i) {
					return(backend.reserveUpload(owner, `/user/${owner}/file${i}.txt`, size));
				})
			);

			// Verify accumulated quota
			const quota = await backend.getQuotaStatus(owner);
			expect(quota.objectCount).toBe(3);
			expect(quota.totalSize).toBe(600);

			// Release middle reservation
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			await backend.releaseUpload(reservations[1]!.id);

			const afterRelease = await backend.getQuotaStatus(owner);
			expect(afterRelease.objectCount).toBe(2);
			expect(afterRelease.totalSize).toBe(400);
		});
	});
});
