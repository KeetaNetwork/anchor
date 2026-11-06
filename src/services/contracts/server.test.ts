import { expect } from 'vitest';
import { Errors } from './common.js';
import { Buffer } from '../../lib/utils/buffer.js';
import type { Account } from './test-utils.js';
import { contractTest, engine, newAccount, onChainInfo, setup, wasm } from './test-utils.js';

contractTest('runs unmodified cw20 through the sequencer, with each change committed on chain', async () => {
	await using world = await setup();
	const alice = newAccount();
	const bob = newAccount();
	const provider = await world.providerFor(alice);
	expect(provider.sequencer).toBe(world.sequencer.publicKeyString.get());
	expect(provider.gasPrice).toBeUndefined();

	const { codeId, requiredCapabilities } = await provider.upload(wasm('cw20_token'));
	expect(codeId).toBe(1n);
	expect(requiredCapabilities).toEqual(['iterator']);

	const created = await provider.instantiate({
		codeId,
		msg: { name: 'Keeta Coin', symbol: 'KCN', decimals: 6, initial_balances: [{ address: alice.publicKeyString.get(), amount: '1000' }] },
		label: 'cw20',
		admin: alice
	});
	const token = created.contract;

	const transfer = await provider.execute({ contract: token, msg: { transfer: { recipient: bob.publicKeyString.get(), amount: '250' }}});
	expect(transfer.events.some((event) => event.attributes.some(([key, value]) => key === 'action' && value === 'transfer'))).toBe(true);
	expect(await provider.query(token, { balance: { address: alice.publicKeyString.get() }})).toEqual({ balance: '750' });
	expect(await provider.query(token, { balance: { address: bob.publicKeyString.get() }})).toEqual({ balance: '250' });

	// The network accepted the sequencer's blocks: the contract account
	// exists, and its metadata is the latest commitment.
	const record = await provider.getContract(token);
	expect(record.sequence).toBe('2');
	const published: unknown = JSON.parse(engine().decodeCommitment(token, (await onChainInfo(world.client, token)).metadata));
	expect(published).toEqual(transfer.commitments[0]);
	expect(transfer.commitments[0]?.stateRoot).toBe(record.stateRoot);

	// Stored keys prove against the published root; forgeries do not.
	const first = await world.state.storageNext(token, null, null, 'ascending');
	if (first === null) {
		throw(new Error('cw20 stored nothing'));
	}
	const proof = await provider.prove(token, first.key);
	expect(proof.value).toBe(first.value.toString('base64'));
	expect(engine().verifyProof(record.stateRoot, first.key, first.value, Buffer.from(proof.proof, 'base64'))).toBe(true);
	expect(engine().verifyProof(record.stateRoot, first.key, Buffer.from('forged'), Buffer.from(proof.proof, 'base64'))).toBe(false);
}, 120_000);

contractTest('callers fund calls and pay for gas with their own signed block', async () => {
	await using world = await setup({ gasPrice: { numerator: 1n, denominator: 1_000_000_000n }});
	const baseToken = world.client.baseToken;
	const sequencer = world.sequencer.publicKeyString.get();
	const [alice, bob, carol] = [newAccount(), newAccount(), newAccount()];
	await world.give(alice, 10_000n);
	await world.give(carol, 1_000n);
	const balance = async (account: Account | string) => await world.client.client.getBalance(account, baseToken);
	// The test node starts the sequencer with a balance of its own.
	const sequencerStart = await balance(sequencer);

	const aliceProvider = await world.providerFor(alice);
	expect(aliceProvider.gasPrice?.token).toBe(baseToken.publicKeyString.get());
	const { codeId } = await aliceProvider.upload(wasm('keeta_escrow'));

	// Alice funds a new escrow with 400 and prepays the estimated fee.
	const expiresAt = BigInt(Date.now() + 3_600_000) * 1_000_000n;
	const created = await aliceProvider.instantiate({
		codeId,
		msg: { arbiter: carol.publicKeyString.get(), recipient: bob.publicKeyString.get(), expires_at: expiresAt.toString() },
		label: 'escrow',
		funds: [{ token: baseToken, amount: 400n }]
	});
	const escrow = created.contract;
	expect(BigInt(created.fee)).toBeGreaterThan(0n);
	expect(BigInt(created.refund)).toBeGreaterThan(0n);
	expect(await balance(escrow)).toBe(400n);
	expect(await balance(alice)).toBe(10_000n - 400n - BigInt(created.fee));
	expect(await balance(sequencer)).toBe(sequencerStart + BigInt(created.fee));

	// Carol, the arbiter, releases it to bob, paying her own fee.
	const approved = await (await world.providerFor(carol)).execute({ contract: escrow, msg: { approve: { memo: 'INVOICE 42' }}});
	expect(await balance(bob)).toBe(400n);
	expect(await balance(escrow)).toBe(0n);
	expect(await balance(carol)).toBe(1_000n - BigInt(approved.fee));
	expect(await balance(sequencer)).toBe(sequencerStart + BigInt(created.fee) + BigInt(approved.fee));
}, 120_000);

contractTest('refused calls change nothing and report why', async () => {
	await using world = await setup();
	const alice = newAccount();
	const provider = await world.providerFor(alice);
	const { codeId } = await provider.upload(wasm('cw20_token'));
	const token = (await provider.instantiate({
		codeId,
		msg: { name: 'Keeta Coin', symbol: 'KCN', decimals: 6, initial_balances: [{ address: alice.publicKeyString.get(), amount: '10' }] },
		label: 'cw20'
	})).contract;
	const before = await provider.getContract(token);

	const overdraw = provider.execute({ contract: token, msg: { transfer: { recipient: newAccount().publicKeyString.get(), amount: '5000' }}});
	await expect(overdraw).rejects.toSatisfy((error) => Errors.CallFailed.isInstance(error) && error.kind === 'contract');
	expect(await provider.getContract(token)).toEqual(before);
	expect(await world.state.height()).toBe(1n);

	await expect(provider.getContract(world.sequencer)).rejects.toSatisfy((error) => Errors.CallFailed.isInstance(error) && error.kind === 'unknownContract');
}, 120_000);

contractTest('a call staged by a crashed sequencer is resolved before the next one', async () => {
	await using world = await setup();
	const alice = newAccount();
	const provider = await world.providerFor(alice);
	const { codeId } = await provider.upload(wasm('cw20_token'));

	// A crash after staging a call whose staple never landed.
	await world.state.stage({
		id: 'lost',
		height: '1',
		changes: { contracts: [], storage: [], treeNodes: [], staleTreeNodes: [], tokens: [] },
		expectedHeads: [{ account: world.sequencer.publicKeyString.get(), hash: '00'.repeat(32) }]
	});

	const created = await provider.instantiate({
		codeId,
		msg: { name: 'Keeta Coin', symbol: 'KCN', decimals: 6, initial_balances: [] },
		label: 'cw20'
	});
	expect(await world.state.pending()).toBeNull();
	expect(await world.state.height()).toBe(1n);
	expect((await provider.getContract(created.contract)).sequence).toBe('1');
}, 120_000);
