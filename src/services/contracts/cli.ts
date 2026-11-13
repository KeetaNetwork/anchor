/**
 * `keeta-contract`: build and deploy Keeta contracts (sBPF programs), call
 * them through a sequencer and read their state.
 *
 * ```text
 * keeta-contract build [--manifest-path <Cargo.toml>] [--package <name>]... [--out-dir <dir>]
 * keeta-contract deploy <file.so> [--admin <account>]
 * keeta-contract call <instruction-json> [--funds <token>=<amount>,...] [--gas-limit <gas>]
 * keeta-contract account <contract> <id-hex>
 * keeta-contract accounts <contract> [--start-after <id-hex>] [--limit <n>]
 * keeta-contract info <contract>
 * keeta-contract build --verifiable --package <name> [--source <dir>] [--manifest-path <Cargo.toml>] [--out-dir <dir>]
 * keeta-contract interface --package <name> [--source <dir>] [--manifest-path <Cargo.toml>]
 * keeta-contract verify <contract> --package <name> (--repository <url> --commit <hash> | --source <dir>) [--manifest-path <Cargo.toml>]
 * keeta-contract serve [--port <port>] [--fee-per-call <amount>] [--fee-per-gas <amount>]
 * keeta-contract verifier [--port <port>] [--data <dir>] [--allow-local-sources]
 * ```
 *
 * An instruction is JSON: `{ "contract": "keeta_...", "accounts": [{ "owner":
 * "keeta_...", "id": "<64 hex digits>", "writable": true }], "data": "<base64>" }`.
 * `build` runs Anza's `cargo-build-sbf` (`$CARGO_BUILD_SBF`, or on the PATH).
 * Representatives check the code when it is deployed, and run the calls;
 * the sequencer orders them, and is named when the contract is deployed.
 *
 * Commands that talk to the network read their account and network from
 * the environment: `KEETA_SEED` (hex seed, required), `KEETA_ACCOUNT_INDEX`
 * (default 0), `KEETA_NETWORK` (default `test`) and `KEETA_SEQUENCER` (the
 * provider ID, needed only if the resolver lists more than one). Output is
 * JSON on stdout. `KEETA_TEST_REPS` (a JSON list of `{ key, api, p2p }`, as
 * the node's `utils/local-network.mjs` prints it) points the test network
 * at other representatives, such as a local network. `KEETA_SEQUENCER_URL`
 * reaches a sequencer at that URL instead of through the resolver.
 *
 * `build --verifiable` builds in a pinned Docker image (./build-image.ts),
 * so anyone building the same source gets the same program: deploy that
 * build, and its source can be verified. `--source` is the directory that
 * holds everything the build needs (the repository, usually; the current
 * directory by default), and `--manifest-path` is relative to it.
 * `interface` prints a contract's interface (its `contract_interface()`).
 * `verify` checks source against a deployed contract: it builds it the same
 * way and compares the program's SHA-256 with the contract's code hash.
 * `verifier` runs that as a service for explorers (./verifier.ts).
 *
 * `serve` runs a sequencer for the account `KEETA_SEED` names, until
 * stopped: contracts deployed naming that account have their calls ordered
 * by it. It prints its URL and account. Each call pays it a fee, in the
 * block carrying the call, so that no call is free: 0.001 of the base token
 * per call plus 10^-8 per unit of gas limit by default (in atomic units at
 * 18 decimal places, --fee-per-call 1000000000000000 and --fee-per-gas
 * 10000000000). A call its contract refuses still pays. Pass 0 for both to
 * charge nothing.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import type { ContractInstruction } from './common.js';
import type { KeetaContractsAnchorFund } from './client.js';
import KeetaContractsAnchorClient, { KeetaContractsAnchorProvider } from './client.js';
import type { CommandRunner, ContractSource } from './verify.js';
import { checkout, exportInterface, runCommand, verifiableBuild, verifyContract } from './verify.js';

/** What `serve` charges for each call unless told otherwise: 0.001 of the base token, plus 10^-8 per unit of gas limit. */
const DEFAULT_FEE = { perCall: 1_000_000_000_000_000n, perGas: 10_000_000_000n };

/** Where `build` puts programs unless told otherwise. */
const DEFAULT_OUT_DIR = 'target/deploy';

/** A contracts client, and the sequencer it uses. */
export interface ContractsConnection {
	contracts: KeetaContractsAnchorClient;
	provider: KeetaContractsAnchorProvider;
}

export interface ContractsCliDeps {
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	env?: { [name: string]: string | undefined; };
	/** The client and sequencer to use; built from the environment by default */
	connect?: () => Promise<ContractsConnection>;
	/** Runs `cargo-build-sbf` for `build`; returns its exit code */
	buildSbf?: (args: string[]) => Promise<number>;
	/** Lists a directory, for `build`'s output */
	listDir?: (path: string) => Promise<string[]>;
	/** Runs Docker and git, for verifiable builds and verification */
	run?: CommandRunner;
}

class UsageError extends Error {}

interface Parsed {
	positional: string[];
	options: Map<string, string[]>;
}

const FLAGS = new Set(['manifest-path', 'package', 'out-dir', 'admin', 'funds', 'gas-limit', 'start-after', 'limit', 'port', 'fee-per-call', 'fee-per-gas', 'source', 'repository', 'commit', 'data']);
/** Options that take no value */
const SWITCHES = new Set(['verifiable', 'allow-local-sources']);

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
		if (SWITCHES.has(name) && inline === undefined) {
			options.set(name, ['true']);
			continue;
		}
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

function isInstruction(value: unknown): value is ContractInstruction {
	if (typeof value !== 'object' || value === null) {
		return(false);
	}
	const contract: unknown = Reflect.get(value, 'contract');
	const data: unknown = Reflect.get(value, 'data');
	const accounts: unknown = Reflect.get(value, 'accounts');
	return(typeof contract === 'string' && typeof data === 'string' && Array.isArray(accounts) && accounts.every(function(account: unknown) {
		return(typeof account === 'object' && account !== null && typeof Reflect.get(account, 'owner') === 'string' && typeof Reflect.get(account, 'id') === 'string' && typeof Reflect.get(account, 'writable') === 'boolean');
	}));
}

function instructionArgument(text: string): ContractInstruction {
	const value = jsonArgument(text, 'the instruction');
	if (!isInstruction(value)) {
		throw(new UsageError('the instruction looks like {"contract", "accounts": [{"owner", "id", "writable"}], "data"}'));
	}

	return(value);
}

function toJSON(value: unknown): string {
	return(JSON.stringify(value, function(_key, item: unknown) {
		return(typeof item === 'bigint' ? item.toString() : item);
	}, 2));
}

async function runBuildSbf(args: string[]): Promise<number> {
	return(await new Promise(function(resolve, reject) {
		const child = spawn(process.env['CARGO_BUILD_SBF'] ?? 'cargo-build-sbf', args, { stdio: ['ignore', 'inherit', 'inherit'] });
		child.on('error', reject);
		child.on('close', function(code) {
			resolve(code ?? 1);
		});
	}));
}

/** A client for `network`, or for the test network's ID on the representatives `testReps` names (JSON), if any. */
function userClientFor(network: Networks, account: ReturnType<InstanceType<typeof KeetaNet.lib.Account>['assertAccount']>, testReps: string | undefined): KeetaNet.UserClient {
	if (network !== 'test' || testReps === undefined || testReps === '') {
		return(KeetaNet.UserClient.fromNetwork(network, account));
	}
	const parsed: unknown = jsonArgument(testReps, 'KEETA_TEST_REPS');
	if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((rep: unknown) => typeof rep === 'object' && rep !== null && typeof Reflect.get(rep, 'key') === 'string' && typeof Reflect.get(rep, 'api') === 'string' && typeof Reflect.get(rep, 'p2p') === 'string')) {
		throw(new UsageError('KEETA_TEST_REPS is a JSON list of {"key", "api", "p2p"}'));
	}
	const reps = parsed.map((rep: unknown) => ({
		key: KeetaNet.lib.Account.fromPublicKeyString(String(Reflect.get(Object(rep), 'key'))).assertAccount(),
		endpoints: { api: String(Reflect.get(Object(rep), 'api')), p2p: String(Reflect.get(Object(rep), 'p2p')) }
	}));
	return(new KeetaNet.UserClient({ client: new KeetaNet.Client(reps), signer: account, network: KeetaNet.Client.Config.NetworkIDs.test, networkAlias: 'test', usePublishAid: false }));
}

/** The sequencer serving at `url`, from the metadata it publishes. */
async function providerAt(url: string, contracts: KeetaContractsAnchorClient): Promise<KeetaContractsAnchorProvider> {
	const response = await fetch(new URL('/serviceMetadata', url));
	const metadata: unknown = await response.json();
	const sequencer: unknown = typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'sequencer') : undefined;
	const operations: unknown = typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'operations') : undefined;
	const submit: unknown = typeof operations === 'object' && operations !== null ? Reflect.get(operations, 'submit') : undefined;
	if (typeof sequencer !== 'string' || typeof submit !== 'string') {
		throw(new Error(`No contract sequencer at ${url}`));
	}

	const fee: unknown = typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'fee') : undefined;
	const schedule = typeof fee === 'object' && fee !== null && ['token', 'perCall', 'perGas'].every((name) => typeof Reflect.get(fee, name) === 'string')
		? { token: String(Reflect.get(fee, 'token')), perCall: String(Reflect.get(fee, 'perCall')), perGas: String(Reflect.get(fee, 'perGas')) }
		: undefined;

	return(new KeetaContractsAnchorProvider(url, { sequencer, fee: schedule, operations: { submit }}, contracts));
}

/** Run a sequencer for the environment's account until the process is stopped. */
async function serve(env: { [name: string]: string | undefined; }, port: number | undefined, fee: { perCall: bigint; perGas: bigint; } | undefined, stdout: (text: string) => void): Promise<number> {
	const seed = env['KEETA_SEED'];
	if (seed === undefined || seed === '') {
		throw(new UsageError('set KEETA_SEED to the hex seed of the sequencer account'));
	}
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const network = (env['KEETA_NETWORK'] ?? 'test') as Networks;
	const sequencer = KeetaNet.lib.Account.fromSeed(seed, Number(env['KEETA_ACCOUNT_INDEX'] ?? '0')).assertAccount();
	// Loaded only here: the server's modules reach the package's client index, which imports the client this CLI is loaded with.
	const { KeetaNetContractsAnchorHTTPServer } = await import('./server.js');
	const server = new KeetaNetContractsAnchorHTTPServer({
		sequencer,
		client: userClientFor(network, sequencer, env['KEETA_TEST_REPS']),
		serviceMetadataEndpoint: { expose: true },
		...(port !== undefined ? { port } : {}),
		...(fee !== undefined ? { fee } : {})
	});
	await server.start();
	stdout(toJSON({ url: server.url, sequencer: sequencer.publicKeyString.get() }));

	return(await new Promise((resolve) => {
		const stop = () => {
			void server[Symbol.asyncDispose]().then(() => resolve(0));
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	}));
}

/** The source a verifiable build or a verification uses: `--source` (or `dir`), `--manifest-path` in it, and `--package`. */
function sourceOf(parsed: Parsed, dir?: string): ContractSource {
	const name = option(parsed, 'package');
	if (name === undefined) {
		throw(new UsageError('--package names the contract\'s Cargo package'));
	}
	const manifestPath = option(parsed, 'manifest-path');
	return({ dir: dir ?? option(parsed, 'source') ?? process.cwd(), package: name, ...(manifestPath !== undefined ? { manifestPath } : {}) });
}

/** A contracts client for the account and network named by the environment. */
function contractsFromEnv(env: { [name: string]: string | undefined; }): KeetaContractsAnchorClient {
	const seed = env['KEETA_SEED'];
	if (seed === undefined || seed === '') {
		throw(new UsageError('set KEETA_SEED to the hex seed of the account to use'));
	}
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const network = (env['KEETA_NETWORK'] ?? 'test') as Networks;
	const account = KeetaNet.lib.Account.fromSeed(seed, Number(env['KEETA_ACCOUNT_INDEX'] ?? '0')).assertAccount();
	return(new KeetaContractsAnchorClient(userClientFor(network, account, env['KEETA_TEST_REPS'])));
}

/** The account, network and sequencer named by the environment. */
async function connectFromEnv(env: { [name: string]: string | undefined; }): Promise<ContractsConnection> {
	const contracts = contractsFromEnv(env);

	const direct = env['KEETA_SEQUENCER_URL'];
	if (direct !== undefined && direct !== '') {
		return({ contracts, provider: await providerAt(direct, contracts) });
	}

	const providers = await contracts.getProviders();

	const wanted = env['KEETA_SEQUENCER'];
	const matching = wanted === undefined ? providers : providers.filter((provider) => provider.providerID === wanted);
	const [provider] = matching;
	if (provider === undefined) {
		throw(new Error(wanted === undefined ? 'the resolver lists no contract sequencer' : `no contract sequencer ${wanted}`));
	}
	if (matching.length > 1) {
		throw(new UsageError(`several sequencers found (${matching.map((p) => p.providerID).join(', ')}); set KEETA_SEQUENCER`));
	}

	return({ contracts, provider });
}

/** Run one CLI invocation. Returns the exit code. */
export async function runContractsCli(argv: string[], deps: ContractsCliDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`); });
	const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`); });
	const env = deps.env ?? process.env;
	const connect = deps.connect ?? (async () => await connectFromEnv(env));
	// Commands that only read the network need no sequencer.
	const connected = deps.connect;
	const reader = connected !== undefined ? async () => (await connected()).contracts : async () => await Promise.resolve(contractsFromEnv(env));

	const [command, ...rest] = argv;
	try {
		const parsed = parseArgs(rest);
		switch (command) {
			case 'build': {
				const outDir = option(parsed, 'out-dir') ?? DEFAULT_OUT_DIR;
				if (option(parsed, 'verifiable') !== undefined) {
					const source = sourceOf(parsed);
					const built = await verifiableBuild(source, deps.run ?? runCommand);
					await mkdir(outDir, { recursive: true });
					const program = join(outDir, `${source.package.replace(/-/gu, '_')}.so`);
					await writeFile(program, built.program);
					stdout(toJSON({ program, sha256: built.sha256, builder: built.builder }));
					return(0);
				}
				const args = ['--arch', 'v3', '--sbf-out-dir', outDir];
				const manifest = option(parsed, 'manifest-path');
				if (manifest !== undefined) {
					args.push('--manifest-path', manifest);
				}
				const packages = parsed.options.get('package') ?? [];
				if (packages.length > 0) {
					args.push('--', ...packages.flatMap((name) => ['--package', name]));
				}

				if (await (deps.buildSbf ?? runBuildSbf)(args) !== 0) {
					stderr('cargo-build-sbf failed');
					return(1);
				}
				const files = await (deps.listDir ?? readdir)(outDir);
				const programs = files.filter((name) => name.endsWith('.so')).sort().map((name) => join(outDir, name));
				stdout(toJSON({ programs }));
				return(0);
			}
			case 'deploy': {
				const code = await readFile(positional(parsed, 0, 'the .so file'));
				const admin = option(parsed, 'admin');
				const { contracts, provider } = await connect();
				stdout(toJSON(await contracts.deploy({ code, sequencer: provider, ...(admin !== undefined ? { admin } : {}) })));
				return(0);
			}
			case 'call': {
				const gasLimit = bigintOption(parsed, 'gas-limit');
				const input = {
					instruction: instructionArgument(positional(parsed, 0, 'the instruction')),
					funds: funds(parsed),
					...(gasLimit !== undefined ? { gasLimit } : {})
				};
				const result = await (await connect()).provider.call(input);
				stdout(toJSON({ ...result, returnData: result.returnData.toString('base64') }));
				return(0);
			}
			case 'account': {
				const state = await (await reader()).getState(positional(parsed, 0, 'the contract'), positional(parsed, 1, 'the account id'));
				stdout(toJSON({ version: state.version, data: state.data === null ? null : state.data.toString('base64') }));
				return(0);
			}
			case 'accounts': {
				const startAfter = option(parsed, 'start-after');
				const limit = bigintOption(parsed, 'limit');
				const accounts = await (await reader()).listState(positional(parsed, 0, 'the contract'), {
					...(startAfter !== undefined ? { startAfter } : {}),
					...(limit !== undefined ? { limit: Number(limit) } : {})
				});
				stdout(toJSON(accounts.map((entry) => ({ id: entry.id, version: entry.version, data: entry.data.toString('base64') }))));
				return(0);
			}
			case 'interface': {
				stdout(toJSON(await exportInterface(sourceOf(parsed), deps.run ?? runCommand)));
				return(0);
			}
			case 'verify': {
				const contract = positional(parsed, 0, 'the contract');
				const repository = option(parsed, 'repository');
				const commit = option(parsed, 'commit');
				if ((repository === undefined) === (option(parsed, 'source') === undefined)) {
					throw(new UsageError('verify takes --repository with --commit, or --source'));
				}
				const record = await (await reader()).getContract(contract);
				if (record === null) {
					throw(new Error(`${contract} is not a contract`));
				}
				const run = deps.run ?? runCommand;
				const dir = repository === undefined ? undefined : await checkout(repository, commit ?? '', run);
				try {
					const source = sourceOf(parsed, dir);
					const verification = await verifyContract({
						contract,
						codeHash: record.codeHash,
						source,
						origin: repository === undefined ? { local: source.dir } : { repository, commit: commit ?? '' },
						run
					});
					stdout(toJSON({
						...verification,
						files: verification.files.map((file) => file.path),
						libraries: verification.libraries.map((library) => ({ ...library, files: library.files.map((file) => file.path) }))
					}));
					return(verification.verified ? 0 : 1);
				} finally {
					if (dir !== undefined) {
						await rm(dir, { recursive: true, force: true });
					}
				}
			}
			case 'verifier': {
				const port = bigintOption(parsed, 'port');
				const contracts = await reader();
				const { ContractVerifier } = await import('./verifier.js');
				const verifier = new ContractVerifier({
					dataDir: option(parsed, 'data') ?? '.keeta-contract-verifier',
					codeHashOf: async (contract) => (await contracts.getContract(contract))?.codeHash ?? null,
					allowLocalSources: option(parsed, 'allow-local-sources') !== undefined,
					...(port !== undefined ? { port: Number(port) } : {}),
					...(deps.run !== undefined ? { run: deps.run } : {}),
					log: (message) => stderr(message)
				});
				stdout(toJSON({ url: await verifier.start() }));
				return(await new Promise((resolve) => {
					const stop = () => {
						void verifier.stop().then(() => resolve(0));
					};
					process.once('SIGINT', stop);
					process.once('SIGTERM', stop);
				}));
			}
			case 'serve': {
				const port = bigintOption(parsed, 'port');
				const perCall = bigintOption(parsed, 'fee-per-call') ?? DEFAULT_FEE.perCall;
				const perGas = bigintOption(parsed, 'fee-per-gas') ?? DEFAULT_FEE.perGas;
				const fee = perCall === 0n && perGas === 0n ? undefined : { perCall, perGas };
				return(await serve(env, port === undefined ? undefined : Number(port), fee, stdout));
			}
			case 'info': {
				const contract = positional(parsed, 0, 'the contract');
				stdout(toJSON(await (await reader()).getContract(contract)));
				return(0);
			}
			default:
				throw(new UsageError(command === undefined ? 'missing command' : `unknown command ${command}`));
		}
	} catch (error) {
		if (error instanceof UsageError) {
			stderr(`keeta-contract: ${error.message}\nCommands: build, interface, deploy, call, account, accounts, info, verify, serve, verifier`);
			return(2);
		}
		stderr(`keeta-contract: ${error instanceof Error ? error.message : String(error)}`);
		return(1);
	}
}
