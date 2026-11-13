import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Buffer } from '../../lib/utils/buffer.js';
import { runContractsCli } from './cli.js';
import type { ContractsCliDeps } from './cli.js';
import { contractTest, instruction, newAccount, probe, program, setup } from './test-utils.js';

async function run(argv: string[], deps: ContractsCliDeps = {}): Promise<{ code: number; out: unknown; err: string; }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runContractsCli(argv, {
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		env: {},
		...deps
	});
	const text = out.join('\n');
	const parsed: unknown = text === '' ? null : JSON.parse(text);
	return({ code, out: parsed, err: err.join('\n') });
}

test('reports usage errors', async () => {
	expect((await run([])).code).toBe(2);
	expect((await run(['explode'])).err).toContain('unknown command explode');
	expect((await run(['call', '{}', '--color', 'red'])).code).toBe(2);
	expect((await run(['execute', '{}'])).err).toContain('unknown command execute');
	expect((await run(['call', 'not json'])).err).toContain('must be JSON');
	expect((await run(['call', '{"contract":"keeta_x"}'])).err).toContain('"accounts"');
	expect((await run(['deploy', 'x.so'])).err).toContain('no such file');
	const noSeed = await run(['info', 'keeta_x']);
	expect(noSeed.code).toBe(2);
	expect(noSeed.err).toContain('KEETA_SEED');
});

test('build runs cargo-build-sbf for sBPF v3 and reports the programs', async () => {
	let seen: string[] = [];
	const result = await run(['build', '--manifest-path', 'contracts/Cargo.toml', '--package', 'escrow', '--out-dir', 'out'], {
		buildSbf: async (args) => {
			seen = args;
			return(0);
		},
		listDir: async () => ['escrow.so', 'escrow-keypair.json', 'pet.so']
	});
	expect(result).toEqual({ code: 0, out: { programs: [join('out', 'escrow.so'), join('out', 'pet.so')] }, err: '' });
	expect(seen).toEqual(['--arch', 'v3', '--sbf-out-dir', 'out', '--manifest-path', 'contracts/Cargo.toml', '--', '--package', 'escrow']);

	expect((await run(['build'], { buildSbf: async () => 101 })).code).toBe(1);
});

contractTest('deploys a contract, calls it through a sequencer and reads its state', async () => {
	await using world = await setup();
	const alice = newAccount();
	const connection = await world.as(alice);
	const deps: ContractsCliDeps = { connect: async () => connection };
	const dir = await mkdtemp(join(tmpdir(), 'keeta-contract-'));
	const file = join(dir, 'probe.so');
	await writeFile(file, program('keeta_probe'));

	const holder = alice.publicKeyString.get();
	const created = await run(['deploy', file, '--admin', holder], deps);
	expect(created.code).toBe(0);
	const contract: unknown = typeof created.out === 'object' && created.out !== null ? Reflect.get(created.out, 'contract') : undefined;
	if (typeof contract !== 'string') {
		throw(new Error('deploy printed no contract'));
	}

	const increment = instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0));
	const called = await run(['call', JSON.stringify(increment)], deps);
	expect(called.code).toBe(0);
	const id = increment.accounts[0]?.id ?? '';
	expect(called.out).toMatchObject({ writes: [{ owner: contract, id, version: '1' }] });
	const one = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
	expect((await run(['account', contract, id], deps)).out).toEqual({ version: '1', data: one });
	expect((await run(['accounts', contract], deps)).out).toEqual([{ id, version: '1', data: one }]);
	expect((await run(['info', contract], deps)).out).toMatchObject({ admin: holder, creator: holder, sequencer: world.sequencer.publicKeyString.get() });

	const failed = await run(['call', JSON.stringify(instruction(contract, [], probe.fail('nope')))], deps);
	expect(failed.code).toBe(1);
	expect(failed.err).toContain('nope');
}, 120_000);
