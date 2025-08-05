import { test, expect } from 'vitest';
import { getDefaultResolver } from './config.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';

test('Config', async function() {
	const client = KeetaNet.Client.fromNetwork('test');

	/*
	 * This should fail because we gave it a Client
	 * without telling it what network to use.
	 */
	await expect(async function() {
		return(getDefaultResolver(client));
	}).rejects.toThrow();

	/*
	 * This should fail because we gave it a Client
	 * with invalid networks
	 */
	await expect(async function() {
		return(getDefaultResolver(client, {
			network: 'invalid-network'
		}));
	}).rejects.toThrow();

	const validResolver1 = getDefaultResolver(client, {
		network: 'test'
	});
	expect(validResolver1).toBeDefined();

	const validResolver2 = getDefaultResolver(client, {
		network: 0n
	});
	expect(validResolver2).toBeDefined();
});
