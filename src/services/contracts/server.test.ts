import { expect } from 'vitest';
import { Errors, stateId } from './common.js';
import { Buffer } from '../../lib/utils/buffer.js';
import { KeetaNet } from '../../client/index.js';
import type { KeyPairAccount } from './test-utils.js';
import { contractTest, escrow, instruction, newAccount, probe, program, setup } from './test-utils.js';

contractTest('the sequencer orders calls, and representatives run them and publish their outcome', async () => {
	await using world = await setup();
	const alice = newAccount();
	const { contracts, provider } = await world.as(alice);
	expect(provider.sequencer).toBe(world.sequencer.publicKeyString.get());

	// Deploying goes straight to the network, naming the sequencer.
	const { contract } = await contracts.deploy({ code: program('keeta_probe'), sequencer: provider, admin: alice });
	expect(await contracts.getContract(contract)).toMatchObject({ sequencer: provider.sequencer, admin: alice.publicKeyString.get(), creator: alice.publicKeyString.get() });

	const counter = instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0));
	const first = await provider.call({ instruction: counter });
	expect(first.writes).toEqual([{ owner: contract, id: stateId('counter').toString('hex'), version: 1n }]);
	expect(first.gasUsed).toBeGreaterThan(0n);
	// The staple: alice's block, then the sequencer's ordering on the contract's chain.
	expect(first.blocks).toHaveLength(2);
	expect(first.blocks[0]).toBe(first.block);
	expect((await world.client.client.getHeadBlock(contract))?.hash.toString().toLowerCase()).toBe(first.blocks[1]);

	// A simulation runs the call against the published state, and keeps nothing.
	const estimate = await contracts.simulate({ instruction: counter });
	expect(estimate.writes).toEqual([{ owner: contract, id: stateId('counter').toString('hex'), version: 2n }]);
	expect((await contracts.getState(contract, stateId('counter'))).version).toBe(1n);

	await provider.call({ instruction: counter });
	const state = await contracts.getState(contract, stateId('counter'));
	expect(state.version).toBe(2n);
	expect(state.data?.readBigUInt64LE()).toBe(2n);
	expect(await contracts.listState(contract)).toEqual([{ id: stateId('counter').toString('hex'), version: 2n, data: state.data }]);
}, 120_000);

contractTest('when the network charges for votes, a deploy pays them, and the deployer\'s next block follows its fee block', async () => {
	await using world = await setup();
	const alice = newAccount();
	await world.give(alice, 1_000n);
	await world.give(world.sequencer, 1_000n);
	world.fees.enable();
	const { contracts, provider } = await world.as(alice);

	const { contract } = await contracts.deploy({ code: program('keeta_probe'), sequencer: provider });
	// The deploy's staple ended with alice's fee block; her call block must follow it, not the deploy.
	const counter = instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0));
	await provider.call({ instruction: counter });
	expect((await contracts.getState(contract, stateId('counter'))).version).toBe(1n);
}, 120_000);

contractTest('concurrent callers share one staple, in the order they arrived', async () => {
	await using world = await setup({ batchWindowMs: 200 });
	const [alice, bob, carol] = [newAccount(), newAccount(), newAccount()];
	const { contracts } = await world.as(alice);
	const { contract } = await contracts.deploy({ code: program('keeta_probe'), sequencer: world.sequencer });
	const counter = instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0));

	const providers = await Promise.all([alice, bob, carol].map(async (account) => (await world.as(account)).provider));
	const results = await Promise.all(providers.map(async (provider) => await provider.call({ instruction: counter })));

	const [staple] = results.map((result) => result.blocks);
	for (const result of results) {
		expect(result.blocks).toEqual(staple);
	}
	// Three callers' blocks and one ordering.
	expect(staple).toHaveLength(4);
	expect(results.map((result) => result.writes[0]?.version).sort()).toEqual([1n, 2n, 3n]);
	expect((await contracts.getState(contract, stateId('counter'))).data?.readBigUInt64LE()).toBe(3n);
}, 120_000);

contractTest('a call its contract refuses lands as a failed call, without holding up the calls batched with it', async () => {
	await using world = await setup({ batchWindowMs: 200 });
	const [alice, bob] = [newAccount(), newAccount()];
	const { contracts, provider: aliceProvider } = await world.as(alice);
	const { provider: bobProvider } = await world.as(bob);
	const { contract } = await contracts.deploy({ code: program('keeta_probe'), sequencer: world.sequencer });

	const [good, bad] = await Promise.allSettled([
		aliceProvider.call({ instruction: instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0)) }),
		bobProvider.call({ instruction: instruction(contract, [], probe.fail('no thanks')) })
	]);
	expect(good.status).toBe('fulfilled');
	expect(bad.status).toBe('rejected');
	if (bad.status === 'rejected') {
		expect(Errors.CallFailed.isInstance(bad.reason) && bad.reason.kind === 'reverted').toBe(true);
		expect(String(bad.reason)).toMatch(/no thanks/u);
	}

	// Bob's failed call landed, and moved his chain on; his next call follows it.
	const next = await bobProvider.call({ instruction: instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0)) });
	expect(next.writes[0]?.version).toBe(2n);

	// A block already published is refused at once, not voted on again.
	const replayed = await bobProvider.submit([new KeetaNet.lib.Block(Buffer.from((await world.client.client.getBlock(next.block))?.toBytes() ?? new ArrayBuffer(0)))]).catch((error: unknown) => error);
	expect(Errors.CallFailed.isInstance(replayed) && replayed.kind === 'invalidBlock' && replayed.message.includes('already published')).toBe(true);
}, 120_000);

contractTest('calls carry their funds, and contracts pay out on their own authority', async () => {
	await using world = await setup();
	const [alice, bob, carol] = [newAccount(), newAccount(), newAccount()];
	await world.give(alice, 1_000n);
	const { contracts, provider } = await world.as(alice);
	const { contract } = await contracts.deploy({ code: program('keeta_escrow'), sequencer: provider });

	// Alice opens an escrow for bob with 400, which carol arbitrates.
	const baseToken = world.client.baseToken;
	const open = instruction(contract, [{ name: 'escrow', writable: true }], escrow.open(carol, bob, BigInt(Date.now() + 3_600_000)));
	await provider.call({ instruction: open, funds: [{ token: baseToken, amount: 400n }] });
	expect(await world.balance(contract)).toBe(400n);
	expect(await world.balance(alice)).toBe(600n);

	// Only the arbiter can release it.
	const approve = instruction(contract, [{ name: 'escrow', writable: true }], escrow.approve('thanks'));
	await expect((await world.as(bob)).provider.call({ instruction: approve })).rejects.toThrow(/only the arbiter/u);
	await (await world.as(carol)).provider.call({ instruction: approve });
	expect(await world.balance(contract)).toBe(0n);
	expect(await world.balance(bob)).toBe(400n);
}, 120_000);

contractTest('contracts call each other atomically when they share a sequencer', async () => {
	await using world = await setup();
	const alice = newAccount();
	const { contracts, provider } = await world.as(alice);
	const { contract: outer } = await contracts.deploy({ code: program('keeta_probe'), sequencer: provider });
	const { contract: inner } = await contracts.deploy({ code: program('keeta_probe'), sequencer: provider });

	// The outer probe increments the inner probe's counter, and reports it.
	const call = instruction(outer, [{ name: 'counter', writable: true, owner: inner }], probe.invoke(inner, [[0, true]], probe.increment(0), 0));
	const result = await provider.call({ instruction: call });
	expect(result.writes).toEqual([{ owner: inner, id: stateId('counter').toString('hex'), version: 1n }]);
	// Both contract chains are in the staple: the inner one with an empty ordering.
	expect(result.blocks).toHaveLength(3);
	expect((await contracts.getState(inner, stateId('counter'))).data?.readBigUInt64LE()).toBe(1n);
}, 120_000);

contractTest('the sequencer refuses calls to contracts it does not order', async () => {
	await using world = await setup();
	const alice = newAccount();
	const { contracts, provider } = await world.as(alice);
	const elsewhere: KeyPairAccount = newAccount();
	const { contract } = await contracts.deploy({ code: program('keeta_probe'), sequencer: elsewhere });

	await expect(provider.call({ instruction: instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0)) })).rejects.toSatisfy((error: unknown) => Errors.CallFailed.isInstance(error) && error.kind === 'notSequenced');
	await expect(provider.call({ instruction: instruction(alice.publicKeyString.get(), [], Buffer.alloc(0)) })).rejects.toThrow();
}, 120_000);

contractTest('every call pays the sequencer\'s fee, so none is free', async () => {
	await using world = await setup({ fee: { perCall: 1_000n, perGas: 1n }});
	const alice = newAccount();
	await world.give(alice, 10_000_000n);
	const { contracts, provider } = await world.as(alice);
	expect(provider.fee).toEqual({ token: world.client.baseToken.publicKeyString.get(), perCall: 1_000n, perGas: 1n });
	const { contract } = await contracts.deploy({ code: program('keeta_probe'), sequencer: provider });
	const counter = instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0));

	// The provider adds the fee to the caller's block: 1000 for the call, 1 per unit of its gas limit.
	const sequencerBefore = await world.balance(world.sequencer);
	const aliceBefore = await world.balance(alice);
	await provider.call({ instruction: counter, gasLimit: 50_000n });
	expect(await world.balance(world.sequencer) - sequencerBefore).toBe(51_000n);
	expect(aliceBefore - await world.balance(alice)).toBe(51_000n);

	// A call its contract refuses still pays: it lands, failed, and changes nothing.
	const failingBefore = await world.balance(world.sequencer);
	await expect(provider.call({ instruction: instruction(contract, [], probe.fail('nope')), gasLimit: 50_000n })).rejects.toSatisfy((error: unknown) => Errors.CallFailed.isInstance(error) && error.kind === 'reverted');
	expect(await world.balance(world.sequencer) - failingBefore).toBe(51_000n);

	// A block that does not pay, or pays too little, is refused before it is voted on.
	for (const fee of [undefined, { sequencer: provider.sequencer, token: world.client.baseToken, amount: 50_999n }]) {
		const block = await contracts.callBlock({ instruction: counter, gasLimit: 50_000n, ...(fee !== undefined ? { fee } : {}) });
		const refused = await provider.submit([block]).catch((error: unknown) => error);
		expect(Errors.CallFailed.isInstance(refused) && refused.kind === 'fee').toBe(true);
	}
	expect((await contracts.getState(contract, stateId('counter'))).version).toBe(1n);
}, 120_000);

