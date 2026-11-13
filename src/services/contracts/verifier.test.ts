import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Buffer } from '../../lib/utils/buffer.js';
import type { CommandRunner } from './verify.js';
import { libraryHash } from './verify.js';
import { ContractVerifier } from './verifier.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) {
		await step();
	}
});

const CONTRACT = `keeta_${'a'.repeat(60)}`;
const COMMIT = 'c'.repeat(40);
const INTERFACE = { format: 'keeta-contract-interface', name: 'example', instruction: 'Instruction', accounts: [], views: [], types: {}};

/**
 * Docker and git, faked: `cargo metadata` names the package, the build
 * writes `program` to the mounted output, the interface export prints
 * INTERFACE, and a clone copies `repository`'s files.
 */
function fakeRunner(program: () => Buffer, calls: string[][]): CommandRunner {
	return(async (command, args) => {
		calls.push([command, ...args]);
		if (command === 'git') {
			if (args[0] === 'clone') {
				const dir = args.at(-1) ?? '';
				await mkdir(join(dir, 'example', 'src'), { recursive: true });
				await writeFile(join(dir, 'Cargo.toml'), '[workspace]\nmembers = ["example"]\n');
				await writeFile(join(dir, 'example', 'Cargo.toml'), '[package]\nname = "example"\n');
				await writeFile(join(dir, 'example', 'src', 'lib.rs'), 'pub fn contract_interface() {}\n');
				await mkdir(join(dir, 'sdk', 'src'), { recursive: true });
				await writeFile(join(dir, 'sdk', 'Cargo.toml'), '[package]\nname = "sdk"\n');
				await writeFile(join(dir, 'sdk', 'src', 'lib.rs'), '// the contract SDK\n');
				await mkdir(join(dir, 'other', 'src'), { recursive: true });
				await writeFile(join(dir, 'other', 'src', 'lib.rs'), '// not the example\n');
			}
			return({ code: 0, stdout: '', stderr: '' });
		}
		if (args[0] === 'image') {
			return({ code: 0, stdout: '', stderr: '' });
		}
		const script = args.at(-1) ?? '';
		if (script.includes('cargo metadata')) {
			// The workspace has another contract, which the example does not use: its files are not part of the verification.
			// The example builds with the SDK, a local package: a library, listed apart from the example's own files.
			const packages = [
				{ id: 'example 0.1.0', name: 'example', version: '0.1.0', manifest_path: '/build/example/Cargo.toml', source: null },
				{ id: 'sdk 0.2.0', name: 'sdk', version: '0.2.0', manifest_path: '/build/sdk/Cargo.toml', source: null },
				{ id: 'other 0.1.0', name: 'other', manifest_path: '/build/other/Cargo.toml', source: null },
				{ id: 'borsh 1.0.0', name: 'borsh', manifest_path: '/root/.cargo/registry/borsh/Cargo.toml', source: 'registry+https://github.com/rust-lang/crates.io-index' }
			];
			const resolve = { nodes: [{ id: 'example 0.1.0', dependencies: ['borsh 1.0.0', 'sdk 0.2.0'] }, { id: 'sdk 0.2.0', dependencies: [] }, { id: 'other 0.1.0', dependencies: [] }, { id: 'borsh 1.0.0', dependencies: [] }] };
			return({ code: 0, stdout: JSON.stringify({ packages, resolve }), stderr: '' });
		}
		if (script.includes('cargo-build-sbf')) {
			const mount = args[args.indexOf('-v', args.indexOf('-v') + 1) + 1] ?? '';
			await writeFile(join(mount.replace(/:\/out$/u, ''), 'example.so'), program());
			return({ code: 0, stdout: '', stderr: '' });
		}
		if (script.includes('cargo run')) {
			return({ code: 0, stdout: JSON.stringify(INTERFACE), stderr: '' });
		}
		return({ code: 1, stdout: '', stderr: `unexpected ${script}` });
	});
}

async function verifier(program: () => Buffer, codeHash: string) {
	const dataDir = await mkdtemp(join(tmpdir(), 'keeta-verifier-test-'));
	cleanup.push(async () => await rm(dataDir, { recursive: true, force: true }));
	const calls: string[][] = [];
	const service = new ContractVerifier({
		dataDir,
		codeHashOf: async (contract) => (contract === CONTRACT ? codeHash : null),
		run: fakeRunner(program, calls)
	});
	const url = await service.start();
	cleanup.push(async () => await service.stop());
	return({ url, calls });
}

async function until(url: string, contract: string, done: (status: { [key: string]: unknown; }) => boolean): Promise<{ [key: string]: unknown; }> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const status: unknown = await (await fetch(new URL(`api/verifications/${contract}`, url))).json();
		if (typeof status === 'object' && status !== null && done({ ...status })) {
			return({ ...status });
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw(new Error('the verification did not finish'));
}

const post = async (url: string, body: unknown) => await fetch(new URL('api/verify', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('verifies source whose build matches the contract\'s code, and keeps that over a later mismatch', async () => {
	let program = Buffer.from('the program');
	const { url, calls } = await verifier(() => program, createHash('sha256').update('the program').digest('hex'));
	const request = { contract: CONTRACT, repository: 'https://example.com/contracts.git', commit: COMMIT, package: 'example' };

	expect((await post(url, request)).status).toBe(202);
	const first = await until(url, CONTRACT, (status) => status['status'] === 'done');
	expect(first['verification']).toMatchObject({
		format: 'keeta-contract-verification/v1',
		contract: CONTRACT,
		verified: true,
		source: { repository: request.repository, commit: COMMIT },
		package: 'example',
		interface: INTERFACE,
		files: [{ path: 'Cargo.toml' }, { path: 'example/Cargo.toml' }, { path: 'example/src/lib.rs' }],
		libraries: [{
			name: 'sdk',
			version: '0.2.0',
			dir: 'sdk',
			sha256: libraryHash([{ path: 'Cargo.toml', content: '[package]\nname = "sdk"\n' }, { path: 'src/lib.rs', content: '// the contract SDK\n' }]),
			files: [{ path: 'Cargo.toml', size: 23 }, { path: 'src/lib.rs', size: 20 }]
		}]
	});
	// The repository was cloned at exactly the commit, and built in the pinned image.
	expect(calls.some((call) => call[0] === 'git' && call.includes('checkout') && call.includes(COMMIT))).toBe(true);
	expect(calls.some((call) => call.includes('--platform') && call.join(' ').includes('cargo-build-sbf --arch v3 --tools-version'))).toBe(true);

	// Verified files are served, for explorers to show (with CORS).
	const file = await fetch(new URL(`api/verifications/${CONTRACT}/files/example/src/lib.rs`, url));
	expect(file.headers.get('access-control-allow-origin')).toBe('*');
	expect(await file.text()).toBe('pub fn contract_interface() {}\n');
	// A library's files too, kept once under its hash.
	expect(await (await fetch(new URL(`api/verifications/${CONTRACT}/files/sdk/src/lib.rs`, url))).text()).toBe('// the contract SDK\n');

	// Other source that does not match is recorded as an attempt, and the verification stays.
	program = Buffer.from('another program');
	expect((await post(url, request)).status).toBe(202);
	const second = await until(url, CONTRACT, (status) => typeof status['lastAttempt'] === 'object');
	expect(second['verification']).toMatchObject({ verified: true });
	expect(second['lastAttempt']).toMatchObject({ verified: false });
});

test('refuses requests that could not be checked by anyone else, or that are not for a contract', async () => {
	const { url } = await verifier(() => Buffer.from('x'), 'f'.repeat(64));
	const good = { contract: CONTRACT, repository: 'https://example.com/contracts.git', commit: COMMIT, package: 'example' };
	for (const [change, error] of [
		[{ repository: '/Users/someone/contracts' }, /https/u],
		[{ commit: 'main' }, /40-character/u],
		[{ contract: `keeta_${'b'.repeat(60)}` }, /not a contract/u],
		[{ package: '../etc' }, /package/u],
		[{ manifestPath: '../Cargo.toml' }, /inside the repository/u]
	] as const) {
		const reply = await post(url, { ...good, ...change });
		expect(reply.status).toBe(400);
		const body: unknown = await reply.json();
		expect(typeof body === 'object' && body !== null ? String(Reflect.get(body, 'error')) : '').toMatch(error);
	}
	expect(await until(url, CONTRACT, () => true)).toMatchObject({ status: 'none' });
});
