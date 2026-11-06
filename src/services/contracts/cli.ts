/**
 * `keeta-contract`: build, check and deploy Keeta contracts.
 *
 * ```text
 * keeta-contract build [--manifest-path <Cargo.toml>] [--package <name>]…
 * keeta-contract check <file.wasm>
 * keeta-contract upload <file.wasm>
 * keeta-contract instantiate <codeId> <msg-json> --label <label> [--admin <account>] [--funds <token>=<amount>,…] [--fee <amount>] [--gas-limit <gas>]
 * keeta-contract execute <contract> <msg-json> [--funds <token>=<amount>,…] [--fee <amount>] [--gas-limit <gas>]
 * keeta-contract migrate <contract> <newCodeId> <msg-json> [--fee <amount>]
 * keeta-contract query <contract> <msg-json>
 * keeta-contract info <contract>
 * ```
 *
 * Commands that talk to a sequencer read their account and network from
 * the environment: `KEETA_SEED` (hex seed, required), `KEETA_ACCOUNT_INDEX`
 * (default 0), `KEETA_NETWORK` (default `test`) and `KEETA_SEQUENCER` (the
 * provider ID, needed only if the resolver lists more than one). Output is
 * JSON on stdout.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import { Buffer } from '../../lib/utils/buffer.js';
import type { ContractEngineBinding, ContractStoredCode } from './engine.js';
import { loadContractEngine, unwrapOutcome } from './engine.js';
import type { KeetaContractsAnchorFund, KeetaContractsAnchorProvider } from './client.js';
import KeetaContractsAnchorClient from './client.js';

/** Rust 1.96+ links Wasm without `--allow-undefined`; cosmwasm-std 2.x needs it. */
const WASM_RUSTFLAGS = 'target.wasm32-unknown-unknown.rustflags=["-C", "link-arg=--allow-undefined"]';

export interface ContractsCliDeps {
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	env?: { [name: string]: string | undefined; };
	/** The sequencer to talk to; built from the environment by default */
	provider?: () => Promise<KeetaContractsAnchorProvider>;
	/** The engine, for `check`; loaded from the addon by default */
	engine?: () => Promise<ContractEngineBinding>;
	/** Runs cargo for `build`; returns its JSON message lines and exit code */
	cargo?: (args: string[]) => Promise<{ code: number; lines: string[]; }>;
}

class UsageError extends Error {}

interface Parsed {
	positional: string[];
	options: Map<string, string[]>;
}

const FLAGS = new Set(['manifest-path', 'package', 'label', 'admin', 'funds', 'fee', 'gas-limit']);

function parseArgs(argv: string[]): Parsed {
	const positional: string[] = [];
	const options = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? '';
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}

		const [name = '', inline] = arg.slice(2).split(/=(.*)/s, 2);
		if (!FLAGS.has(name)) {
			throw(new UsageError(`unknown option --${name}`));
		}
		const value = inline ?? argv[++index];
		if (value === undefined) {
			throw(new UsageError(`--${name} needs a value`));
		}
		options.set(name, [...(options.get(name) ?? []), value]);
	}

	return({ positional, options });
}

function option(parsed: Parsed, name: string): string | undefined {
	return(parsed.options.get(name)?.at(-1));
}

function bigintOption(parsed: Parsed, name: string): bigint | undefined {
	const value = option(parsed, name);
	if (value === undefined) {
		return(undefined);
	}
	if (!/^\d+$/.test(value)) {
		throw(new UsageError(`--${name} must be a whole number`));
	}

	return(BigInt(value));
}

function funds(parsed: Parsed): KeetaContractsAnchorFund[] {
	return((parsed.options.get('funds') ?? []).flatMap((list) => list.split(',')).filter((entry) => entry !== '').map(function(entry) {
		const match = /^([^=]+)=(\d+)$/.exec(entry);
		if (match?.[1] === undefined || match[2] === undefined) {
			throw(new UsageError(`--funds entries look like <token>=<amount>, got ${entry}`));
		}

		return({ token: match[1], amount: BigInt(match[2]) });
	}));
}

function positional(parsed: Parsed, index: number, what: string): string {
	const value = parsed.positional[index];
	if (value === undefined) {
		throw(new UsageError(`missing ${what}`));
	}

	return(value);
}

function jsonArgument(text: string, what: string): unknown {
	try {
		const value: unknown = JSON.parse(text);
		return(value);
	} catch {
		throw(new UsageError(`${what} must be JSON`));
	}
}

function toJSON(value: unknown): string {
	return(JSON.stringify(value, function(_key, item: unknown) {
		return(typeof item === 'bigint' ? item.toString() : item);
	}, 2));
}

async function runCargo(args: string[]): Promise<{ code: number; lines: string[]; }> {
	return(await new Promise(function(resolve, reject) {
		const child = spawn(process.env['CARGO'] ?? 'cargo', args, { stdio: ['ignore', 'pipe', 'inherit'] });
		const chunks: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', reject);
		child.on('close', function(code) {
			resolve({ code: code ?? 1, lines: Buffer.concat(chunks).toString('utf-8').split('\n') });
		});
	}));
}

/** The sequencer named by the environment. */
async function providerFromEnv(env: { [name: string]: string | undefined; }): Promise<KeetaContractsAnchorProvider> {
	const seed = env['KEETA_SEED'];
	if (seed === undefined || seed === '') {
		throw(new UsageError('set KEETA_SEED to the hex seed of the account to use'));
	}
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const network = (env['KEETA_NETWORK'] ?? 'test') as Networks;
	const account = KeetaNet.lib.Account.fromSeed(seed, Number(env['KEETA_ACCOUNT_INDEX'] ?? '0'));
	const userClient = KeetaNet.UserClient.fromNetwork(network, account);
	const providers = await new KeetaContractsAnchorClient(userClient).getProviders();

	const wanted = env['KEETA_SEQUENCER'];
	const matching = wanted === undefined ? providers : providers.filter((provider) => provider.providerID === wanted);
	const [provider] = matching;
	if (provider === undefined) {
		throw(new Error(wanted === undefined ? 'the resolver lists no contract sequencer' : `no contract sequencer ${wanted}`));
	}
	if (matching.length > 1) {
		throw(new UsageError(`several sequencers found (${matching.map((p) => p.providerID).join(', ')}); set KEETA_SEQUENCER`));
	}

	return(provider);
}

/** Run one CLI invocation. Returns the exit code. */
export async function runContractsCli(argv: string[], deps: ContractsCliDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`); });
	const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`); });
	const env = deps.env ?? process.env;
	const provider = deps.provider ?? (async () => await providerFromEnv(env));

	const [command, ...rest] = argv;
	try {
		const parsed = parseArgs(rest);
		switch (command) {
			case 'build': {
				const args = ['build', '--release', '--target', 'wasm32-unknown-unknown', '--message-format=json-render-diagnostics', '--config', WASM_RUSTFLAGS];
				const manifest = option(parsed, 'manifest-path');
				if (manifest !== undefined) {
					args.push('--manifest-path', manifest);
				}
				for (const name of parsed.options.get('package') ?? []) {
					args.push('--package', name);
				}

				const { code, lines } = await (deps.cargo ?? runCargo)(args);
				if (code !== 0) {
					stderr('cargo build failed');
					return(1);
				}
				const wasm = lines.flatMap(function(line) {
					try {
						const message: unknown = JSON.parse(line);
						if (typeof message === 'object' && message !== null && 'reason' in message && message.reason === 'compiler-artifact' && 'filenames' in message && Array.isArray(message.filenames)) {
							return(message.filenames.filter((name): name is string => typeof name === 'string' && name.endsWith('.wasm')));
						}
					} catch {
						/* Not a cargo message */
					}
					return([]);
				});
				stdout(toJSON({ wasm }));
				return(0);
			}
			case 'check': {
				const wasm = await readFile(positional(parsed, 0, 'the .wasm file'));
				const binding = await (deps.engine ?? loadContractEngine)();
				const sequencer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0).publicKeyString.get();
				const engine = new binding.ContractEngine(JSON.stringify({ network: '0', sequencer }), async function() {
					throw(new Error('check does not read state'));
				});
				try {
					stdout(toJSON(unwrapOutcome<ContractStoredCode>(await engine.storeCode(wasm))));
				} catch (error) {
					stderr(`rejected: ${error instanceof Error ? error.message : String(error)}`);
					return(1);
				}
				return(0);
			}
			case 'upload': {
				const wasm = await readFile(positional(parsed, 0, 'the .wasm file'));
				stdout(toJSON(await (await provider()).upload(wasm)));
				return(0);
			}
			case 'instantiate': {
				const label = option(parsed, 'label');
				if (label === undefined) {
					throw(new UsageError('instantiate needs --label'));
				}
				const admin = option(parsed, 'admin');
				const fee = bigintOption(parsed, 'fee');
				const gasLimit = bigintOption(parsed, 'gas-limit');
				const input = {
					codeId: BigInt(positional(parsed, 0, 'the code id')),
					msg: jsonArgument(positional(parsed, 1, 'the instantiate message'), 'the instantiate message'),
					label,
					funds: funds(parsed),
					...(admin !== undefined ? { admin } : {}),
					...(fee !== undefined ? { fee } : {}),
					...(gasLimit !== undefined ? { gasLimit } : {})
				};
				stdout(toJSON(await (await provider()).instantiate(input)));
				return(0);
			}
			case 'execute': {
				const fee = bigintOption(parsed, 'fee');
				const gasLimit = bigintOption(parsed, 'gas-limit');
				const input = {
					contract: positional(parsed, 0, 'the contract'),
					msg: jsonArgument(positional(parsed, 1, 'the execute message'), 'the execute message'),
					funds: funds(parsed),
					...(fee !== undefined ? { fee } : {}),
					...(gasLimit !== undefined ? { gasLimit } : {})
				};
				stdout(toJSON(await (await provider()).execute(input)));
				return(0);
			}
			case 'migrate': {
				const fee = bigintOption(parsed, 'fee');
				const input = {
					contract: positional(parsed, 0, 'the contract'),
					newCodeId: BigInt(positional(parsed, 1, 'the new code id')),
					msg: jsonArgument(positional(parsed, 2, 'the migrate message'), 'the migrate message'),
					...(fee !== undefined ? { fee } : {})
				};
				stdout(toJSON(await (await provider()).migrate(input)));
				return(0);
			}
			case 'query': {
				const contract = positional(parsed, 0, 'the contract');
				const msg = jsonArgument(positional(parsed, 1, 'the query message'), 'the query message');
				stdout(toJSON(await (await provider()).query(contract, msg)));
				return(0);
			}
			case 'info': {
				const contract = positional(parsed, 0, 'the contract');
				stdout(toJSON(await (await provider()).getContract(contract)));
				return(0);
			}
			default:
				throw(new UsageError(command === undefined ? 'missing command' : `unknown command ${command}`));
		}
	} catch (error) {
		if (error instanceof UsageError) {
			stderr(`keeta-contract: ${error.message}\nCommands: build, check, upload, instantiate, execute, migrate, query, info`);
			return(2);
		}
		stderr(`keeta-contract: ${error instanceof Error ? error.message : String(error)}`);
		return(1);
	}
}
