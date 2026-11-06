import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runContractsCli } from './cli.js';
import type { ContractsCliDeps } from './cli.js';
import { contractTest, engine, newAccount, setup, wasm } from './test-utils.js';

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
	expect((await run(['query', 'keeta_x', '{}', '--color', 'red'])).code).toBe(2);
	expect((await run(['instantiate', '1', '{}'])).err).toContain('--label');
	expect((await run(['execute', 'keeta_x', 'not json'])).err).toContain('must be JSON');
	expect((await run(['upload', 'x.wasm'])).err).toContain('no such file');
	const noSeed = await run(['info', 'keeta_x']);
	expect(noSeed.code).toBe(2);
	expect(noSeed.err).toContain('KEETA_SEED');
});

test('build reports the Wasm cargo produced, with the link flag contracts need', async () => {
	let seen: string[] = [];
	const result = await run(['build', '--manifest-path', 'contracts/Cargo.toml', '--package', 'escrow'], {
		cargo: async (args) => {
			seen = args;
			return({
				code: 0,
				lines: [
					JSON.stringify({ reason: 'compiler-artifact', filenames: ['/t/release/escrow.wasm', '/t/release/escrow.d'] }),
					JSON.stringify({ reason: 'build-finished', success: true }),
					''
				]
			});
		}
	});
	expect(result).toEqual({ code: 0, out: { wasm: ['/t/release/escrow.wasm'] }, err: '' });
	expect(seen).toEqual(expect.arrayContaining(['--target', 'wasm32-unknown-unknown', '--manifest-path', 'contracts/Cargo.toml', '--package', 'escrow']));
	expect(seen.join(' ')).toContain('link-arg=--allow-undefined');

	expect((await run(['build'], { cargo: async () => ({ code: 101, lines: [] }) })).code).toBe(1);
});

contractTest('check validates code the way the sequencer will', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'keeta-contract-'));
	const cw20 = join(dir, 'cw20.wasm');
	await writeFile(cw20, wasm('cw20_token'));
	const checked = await run(['check', cw20], { engine: async () => engine() });
	expect(checked.code).toBe(0);
	expect(checked.out).toMatchObject({ requiredCapabilities: ['iterator'] });

	const junk = join(dir, 'junk.wasm');
	await writeFile(junk, 'not wasm');
	const rejected = await run(['check', junk], { engine: async () => engine() });
	expect(rejected.code).toBe(1);
	expect(rejected.err).toContain('rejected');
}, 60_000);

contractTest('deploys and drives a contract through a sequencer', async () => {
	await using world = await setup();
	const alice = newAccount();
	const provider = await world.providerFor(alice);
	const deps: ContractsCliDeps = { provider: async () => provider };
	const dir = await mkdtemp(join(tmpdir(), 'keeta-contract-'));
	const file = join(dir, 'cw20.wasm');
	await writeFile(file, wasm('cw20_token'));

	const uploaded = await run(['upload', file], deps);
	expect(uploaded.out).toMatchObject({ codeId: '1' });

	const holder = alice.publicKeyString.get();
	const msg = JSON.stringify({ name: 'Keeta Coin', symbol: 'KCN', decimals: 6, initial_balances: [{ address: holder, amount: '1000' }] });
	const created = await run(['instantiate', '1', msg, '--label', 'cw20', '--admin', holder], deps);
	expect(created.code).toBe(0);
	const contract: unknown = typeof created.out === 'object' && created.out !== null ? Reflect.get(created.out, 'contract') : undefined;
	if (typeof contract !== 'string') {
		throw(new Error('instantiate printed no contract'));
	}

	const recipient = newAccount().publicKeyString.get();
	const sent = await run(['execute', contract, JSON.stringify({ transfer: { recipient, amount: '250' }})], deps);
	expect(sent.code).toBe(0);

	expect((await run(['query', contract, JSON.stringify({ balance: { address: holder }})], deps)).out).toEqual({ balance: '750' });
	expect((await run(['info', contract], deps)).out).toMatchObject({ address: contract, label: 'cw20', admin: holder, sequence: '2' });

	const failed = await run(['execute', contract, JSON.stringify({ transfer: { recipient, amount: '5000' }})], deps);
	expect(failed.code).toBe(1);
}, 120_000);
