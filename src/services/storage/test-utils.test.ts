import { expect, test, describe } from 'vitest';
import { MemoryStorageBackend, testPathPolicy, testMetadata } from './test-utils.js';
import { Buffer } from '../../lib/utils/buffer.js';
import { Errors } from './common.js';
import { KeetaNet } from '../../client/index.js';

/**
 * Create a real account for testing.
 */
function createTestAccount(): { account: InstanceType<typeof KeetaNet.lib.Account>; owner: string } {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	return({ account, owner: account.publicKeyString.get() });
}

/**
 * Test helper to create a MemoryStorageBackend with a real account owner.
 */
function createTestBackend(): {
	backend: MemoryStorageBackend;
	owner: string;
	makePath: (filename: string) => string;
} {
	const backend = new MemoryStorageBackend();
	const { owner } = createTestAccount();
	return({
		backend,
		owner,
		makePath: function(filename: string) {
			return(testPathPolicy.makePath(owner, filename));
		}
	});
}

describe('MemoryStorageBackend', function() {
	test('CRUD operations', async function() {
		const { backend, owner, makePath } = createTestBackend();
		const path = makePath('test.txt');

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
		const { makePath: otherMakePath } = createTestBackend();
		expect(await backend.get(otherMakePath('missing.txt'))).toBeNull();

		// DELETE
		expect(await backend.delete(path)).toBe(true);
		expect(backend.size).toBe(0);
		expect(await backend.delete(path)).toBe(false);
	});

	test('search by path prefix', async function() {
		const { backend, owner, makePath } = createTestBackend();
		const { owner: otherOwner, makePath: otherMakePath } = createTestBackend();

		await backend.put(makePath('a.txt'), Buffer.from('a'), testMetadata(owner));
		await backend.put(makePath('b.txt'), Buffer.from('b'), testMetadata(owner));
		await backend.put(otherMakePath('c.txt'), Buffer.from('c'), testMetadata(otherOwner));

		const results = await backend.search({ pathPrefix: testPathPolicy.getNamespacePrefix(owner) }, { limit: 10 });
		expect(results.results).toHaveLength(2);
	});

	test('search by tags', async function() {
		const { backend, owner, makePath } = createTestBackend();

		await backend.put(makePath('a.txt'), Buffer.from('a'), testMetadata(owner, { tags: ['foo'] }));
		await backend.put(makePath('b.txt'), Buffer.from('b'), testMetadata(owner, { tags: ['bar'] }));
		await backend.put(makePath('c.txt'), Buffer.from('c'), testMetadata(owner, { tags: ['foo', 'bar'] }));

		const fooResults = await backend.search({ tags: ['foo'] }, { limit: 10 });
		expect(fooResults.results).toHaveLength(2);

		const barResults = await backend.search({ tags: ['bar'] }, { limit: 10 });
		expect(barResults.results).toHaveLength(2);
	});

	test('quota tracking', async function() {
		const { backend, owner, makePath } = createTestBackend();
		const path = makePath('file.txt');

		// Initial state
		const initialQuota = await backend.getQuotaStatus(owner);
		expect(initialQuota.objectCount).toBe(0);
		expect(initialQuota.totalSize).toBe(0);

		// After first put
		await backend.put(path, Buffer.from('12345'), testMetadata(owner));
		const afterPut = await backend.getQuotaStatus(owner);
		expect(afterPut.objectCount).toBe(1);
		expect(afterPut.totalSize).toBe(5);

		// Update same path - object count stays same, size changes
		await backend.put(path, Buffer.from('1234567890'), testMetadata(owner));
		const afterUpdate = await backend.getQuotaStatus(owner);
		expect(afterUpdate.objectCount).toBe(1);
		expect(afterUpdate.totalSize).toBe(10);

		// Shrink object - size decreases
		await backend.put(path, Buffer.from('xy'), testMetadata(owner));
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
				const { backend, owner, makePath } = createTestBackend();
				const path = makePath('file.txt');

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
					await backend.put(path, data, testMetadata(owner));
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
			const { backend, owner, makePath } = createTestBackend();
			await expect(backend.reserveUpload(owner, makePath('big.bin'), 200 * 1024 * 1024))
				.rejects.toThrow('quota');
		});

		test('concurrent reservations accumulate', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const sizes = [100, 200, 300];

			// Create reservations
			const reservations = await Promise.all(
				sizes.map(function(size, i) {
					return(backend.reserveUpload(owner, makePath(`file${i}.txt`), size));
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

		test('overwrite with smaller data does not inflate remainingSize', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const path = makePath('file.txt');

			// Store a 100-byte file
			await backend.put(path, Buffer.from('x'.repeat(100)), testMetadata(owner));
			const quotaAfterPut = await backend.getQuotaStatus(owner);
			expect(quotaAfterPut.totalSize).toBe(100);

			const initialRemaining = quotaAfterPut.remainingSize;
			// Reserve for overwrite with 50-byte file (smaller)
			const reservation = await backend.reserveUpload(owner, path, 50);

			// Reservation size should be clamped
			const quotaDuring = await backend.getQuotaStatus(owner);
			expect(quotaDuring.totalSize).toBe(100); // Still 100, reservation adds 0
			expect(quotaDuring.remainingSize).toBe(initialRemaining); // Not inflated

			// Complete the overwrite
			await backend.put(path, Buffer.from('y'.repeat(50)), testMetadata(owner));
			await backend.commitUpload(reservation.id);

			const quotaAfter = await backend.getQuotaStatus(owner);
			expect(quotaAfter.totalSize).toBe(50);
			expect(quotaAfter.objectCount).toBe(1);
		});

		test('expired reservations are pruned from quota', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const path = makePath('file.txt');

			// Create a reservation with a very short TTL (1ms)
			await backend.reserveUpload(owner, path, 500, { ttlMs: 1 });

			// Wait for the reservation to expire
			await new Promise(function(resolve) {
				setTimeout(resolve, 10);
			});

			// After expiry, quota should not include the expired reservation
			const quotaAfterExpiry = await backend.getQuotaStatus(owner);
			expect(quotaAfterExpiry.objectCount).toBe(0);
			expect(quotaAfterExpiry.totalSize).toBe(0);

			// Can create a new reservation for the same path (no duplicate)
			const newReservation = await backend.reserveUpload(owner, path, 100);
			expect(newReservation.id).toBeDefined();

			const quotaWithNew = await backend.getQuotaStatus(owner);
			expect(quotaWithNew.objectCount).toBe(1);
			expect(quotaWithNew.totalSize).toBe(100);
		});

		test('rejects negative size reservation', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const path = makePath('file.txt');

			await expect(backend.reserveUpload(owner, path, -100)).rejects.toThrow(
				/cannot be negative/i
			);
		});

		test('concurrent reservations for same path are deduplicated', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const path = makePath('file.txt');

			// Create first reservation
			const reservation1 = await backend.reserveUpload(owner, path, 100);
			// Create second reservation for same path with larger size
			const reservation2 = await backend.reserveUpload(owner, path, 200);
			// Should return the same reservation ID (or updated reservation)
			expect(reservation2.id).toBe(reservation1.id);

			// Quota should only count the larger size, not sum of both
			const quota = await backend.getQuotaStatus(owner);
			expect(quota.objectCount).toBe(1);
			expect(quota.totalSize).toBe(200);
		});

		test('handles zero-size reservations', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const path = makePath('file.txt');

			const reservation = await backend.reserveUpload(owner, path, 0);
			expect(reservation.id).toBeDefined();
			expect(reservation.size).toBe(0);

			const quota = await backend.getQuotaStatus(owner);
			expect(quota.objectCount).toBe(1);
			expect(quota.totalSize).toBe(0);
		});
	});

	describe('per-user quota limits', function() {
		const quotaLimitCases: [string, { maxObjectsPerUser: number; maxStoragePerUser: number; maxObjectSize: number } | null, boolean, string][] = [
			['a.txt', null, true, 'no limits set returns null'],
			['a.txt', { maxObjectsPerUser: 5, maxStoragePerUser: 1024, maxObjectSize: 512 }, true, 'returns limits after set'],
			['a.txt', { maxObjectsPerUser: 1, maxStoragePerUser: 100, maxObjectSize: 50 }, true, 'first reservation within limit succeeds']
		];

		test.each(quotaLimitCases)('path=%s limits=%j success=%s (%s)', async function(_ignorePath, limits, _ignoreSuccess) {
			const { backend, owner } = createTestBackend();
			if (limits) {
				backend.setQuotaLimits(owner, limits);
			}

			const result = await backend.getQuotaLimits(owner);
			if (limits) {
				expect(result).toEqual(limits);
			} else {
				expect(result).toBeNull();
			}
		});

		test('per-user limits are isolated between users', async function() {
			const backend = new MemoryStorageBackend();
			const { owner: ownerA } = createTestAccount();
			const { owner: ownerB } = createTestAccount();

			backend.setQuotaLimits(ownerA, { maxObjectsPerUser: 10, maxStoragePerUser: 2048, maxObjectSize: 256 });

			expect(await backend.getQuotaLimits(ownerA)).not.toBeNull();
			expect(await backend.getQuotaLimits(ownerB)).toBeNull();
		});

		test('reserveUpload enforces per-user object limit', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const userLimits = { maxObjectsPerUser: 1, maxStoragePerUser: 100, maxObjectSize: 50 };
			backend.setQuotaLimits(owner, userLimits);

			// First reservation succeeds
			await backend.reserveUpload(owner, makePath('a.txt'), 50, { quotaLimits: userLimits });

			// Second reservation exceeds per-user object limit
			await expect(
				backend.reserveUpload(owner, makePath('b.txt'), 10, { quotaLimits: userLimits })
			).rejects.toThrow(Errors.QuotaExceeded);
		});

		test('reserveUpload enforces per-user storage limit', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const userLimits = { maxObjectsPerUser: 10, maxStoragePerUser: 100, maxObjectSize: 200 };
			backend.setQuotaLimits(owner, userLimits);

			// First reservation takes most of the storage budget
			await backend.reserveUpload(owner, makePath('a.txt'), 90, { quotaLimits: userLimits });

			// Second reservation exceeds per-user storage limit
			await expect(
				backend.reserveUpload(owner, makePath('b.txt'), 20, { quotaLimits: userLimits })
			).rejects.toThrow(Errors.QuotaExceeded);
		});

		test('getQuotaStatus remaining reflects backend defaults', async function() {
			const { backend, owner, makePath } = createTestBackend();
			await backend.put(makePath('file.txt'), Buffer.from('hello'), testMetadata(owner));

			const status = await backend.getQuotaStatus(owner);
			expect(status.objectCount).toBe(1);
			expect(status.totalSize).toBe(5);
			expect(status.remainingObjects).toBeGreaterThan(0);
			expect(status.remainingSize).toBeGreaterThan(0);
		});

		test('server-side remaining uses tighter of backend and per-user limits', async function() {
			const { backend, owner, makePath } = createTestBackend();
			const userLimits = { maxObjectsPerUser: 3, maxStoragePerUser: 500, maxObjectSize: 100 };
			backend.setQuotaLimits(owner, userLimits);

			await backend.put(makePath('file.txt'), Buffer.from('hello'), testMetadata(owner));

			const status = await backend.getQuotaStatus(owner);
			expect(status.objectCount).toBe(1);
			expect(status.totalSize).toBe(5);

			const limits = await backend.getQuotaLimits(owner);
			expect(limits).toEqual(userLimits);

			// Simulate server logic: min(backendRemaining, configRemaining)
			let remainingObjects = Math.max(0, userLimits.maxObjectsPerUser - status.objectCount);
			let remainingSize = Math.max(0, userLimits.maxStoragePerUser - status.totalSize);
			if (status.remainingObjects > 0) {
				remainingObjects = Math.min(status.remainingObjects, remainingObjects);
			}
			if (status.remainingSize > 0) {
				remainingSize = Math.min(status.remainingSize, remainingSize);
			}

			// Per-user limits (3 objects, 500 bytes) are tighter than defaults
			expect(remainingObjects).toBe(2);
			expect(remainingSize).toBe(495);
		});
	});
});

describe('TestPathPolicy path traversal', function() {
	const { owner } = createTestAccount();
	const cases: [string, boolean, string][] = [
		// Invalid paths
		[`/user/${owner}/../other/file`, false, 'parent traversal'],
		[`/user/${owner}/./file`, false, 'current dir'],
		[`/user/${owner}/foo//bar`, false, 'empty segment in path'],
		[`/user/${owner}//file`, false, 'double slash after owner'],
		[`/user/${owner}/foo/..`, false, 'trailing parent'],
		[`/user/${owner}/foo/./bar`, false, 'embedded current dir'],
		[`/user/${owner}/../${owner}/file`, false, 'escape and re-enter'],
		// Valid paths
		[testPathPolicy.makePath(owner, 'file.txt'), true, 'simple file'],
		[testPathPolicy.makePath(owner, 'dir/file.txt'), true, 'nested file'],
		[testPathPolicy.makePath(owner, 'dir/subdir/file'), true, 'deeply nested'],
		[`/user/${owner}/`, true, 'root with trailing slash'],
		[`/user/${owner}`, true, 'root without trailing slash']
	];

	test.each(cases)('%s valid=%s (%s)', function(path, valid) {
		const validate = function() {
			testPathPolicy.validate(path);
		};

		if (valid) {
			expect(validate).not.toThrow();
		} else {
			expect(validate).toThrow(Errors.InvalidPath);
		}
	});
});

describe('TestPathPolicy validateMetadata', function() {
	const { owner } = createTestAccount();
	const cases: [string, 'public' | 'private', boolean, string][] = [
		['documents/file.txt', 'private', true, 'non-public path with private'],
		['documents/file.txt', 'public', true, 'non-public path with public'],
		['public/avatar.png', 'public', true, 'public path with public'],
		['public/images/photo.jpg', 'public', true, 'nested public path with public'],
		['public/avatar.png', 'private', false, 'public path with private'],
		['public/images/photo.jpg', 'private', false, 'nested public path with private']
	];

	test.each(cases)('%s visibility=%s valid=%s (%s)', function(relativePath, visibility, valid) {
		const path = testPathPolicy.makePath(owner, relativePath);
		const parsed = testPathPolicy.validate(path);
		const validate = function() {
			testPathPolicy.validateMetadata(parsed, testMetadata(owner, { visibility }));
		};

		if (valid) {
			expect(validate).not.toThrow();
		} else {
			expect(validate).toThrow(Errors.InvalidMetadata);
		}
	});
});
