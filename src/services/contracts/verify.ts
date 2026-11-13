/**
 * Verifying a contract's source: rebuild it in the pinned build image
 * (./build-image.ts) and compare the program's SHA-256 with the code hash
 * the network recorded when the contract was deployed. A match means that
 * source is what runs. The same build also exports the contract's
 * interface (its `contract_interface()`; see the contract SDK's
 * `interface` module), so explorers can decode its calls and state.
 *
 * Everything runs in Docker: the source, and the crates it fetches, are
 * code that the build runs (build scripts, macros), so a verifier keeps it
 * away from its own machine. Only the program, the interface and the
 * source files come out.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Buffer } from '../../lib/utils/buffer.js';
import { AGAVE_VERSION, BUILD_DOCKERFILE, BUILD_PLATFORM, BUILD_SOURCE_DIR, PLATFORM_TOOLS_VERSION, buildImageTag } from './build-image.js';

/** Runs a command, as `child_process.spawn` would; replaceable for tests. */
export type CommandRunner = (command: string, args: string[], options?: { cwd?: string; }) => Promise<{ code: number; stdout: string; stderr: string; }>;

export const runCommand: CommandRunner = async function(command, args, options = {}) {
	return(await new Promise(function(resolvePromise, reject) {
		const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('error', reject);
		child.on('close', (code) => {
			resolvePromise({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf-8'), stderr: Buffer.concat(stderr).toString('utf-8') });
		});
	}));
};

/** What builds a contract: the image, and the tools in it. */
export interface BuilderInfo {
	image: string;
	dockerfileSha256: string;
	agave: string;
	platformTools: string;
	platform: string;
}

export function builderInfo(): BuilderInfo {
	return({
		image: buildImageTag(),
		dockerfileSha256: createHash('sha256').update(BUILD_DOCKERFILE).digest('hex'),
		agave: AGAVE_VERSION,
		platformTools: PLATFORM_TOOLS_VERSION,
		platform: BUILD_PLATFORM
	});
}

/** A contract's source: a directory, the manifest of the workspace or package in it, and the package. */
export interface ContractSource {
	dir: string;
	/** Relative to `dir`; `Cargo.toml` by default */
	manifestPath?: string | undefined;
	package: string;
}

async function check(run: CommandRunner, command: string, args: string[], what: string): Promise<string> {
	const result = await run(command, args);
	if (result.code !== 0) {
		throw(new Error(`${what} failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-12).join('\n')}`));
	}
	return(result.stdout);
}

/** Build the image unless it is there already. Returns its tag. */
export async function ensureBuildImage(run: CommandRunner = runCommand): Promise<string> {
	const tag = buildImageTag();
	if ((await run('docker', ['image', 'inspect', tag])).code === 0) {
		return(tag);
	}
	const context = await mkdtemp(join(tmpdir(), 'keeta-contract-image-'));
	try {
		await writeFile(join(context, 'Dockerfile'), BUILD_DOCKERFILE);
		await check(run, 'docker', ['build', '--platform', BUILD_PLATFORM, '-t', tag, context], 'Building the build image');
	} finally {
		await rm(context, { recursive: true, force: true });
	}
	return(tag);
}

function manifestOf(source: ContractSource): string {
	const manifest = source.manifestPath ?? 'Cargo.toml';
	if (manifest.startsWith('/') || manifest.split(/[\\/]/u).includes('..')) {
		throw(new Error('The manifest path must be inside the source'));
	}
	return(manifest);
}

/** Longest a step in the build image may take, in seconds: a build that never ends would hold up a verifier for good. */
const IN_IMAGE_TIMEOUT_SECONDS = 3_600;

/**
 * What a step in the build image may use. Builds run the source's own code
 * (build scripts, procedural macros, the interface exporter), so a source
 * must not be able to starve the machine that checks it.
 */
const IN_IMAGE_LIMITS = ['--memory', '4g', '--memory-swap', '4g', '--cpus', '2', '--pids-limit', '1024'];

/** Where cargo keeps downloaded crates and git dependencies in the build image. */
const CARGO_DEPENDENCY_DIRS = ['/usr/local/cargo/registry', '/usr/local/cargo/git'];

/** How a step in the build image runs. */
interface StepOptions {
	/**
	 * Whether it may reach the network. Only steps that run none of the
	 * source's code do: they fetch what the steps that do then use offline.
	 */
	network: boolean;
	/** A host directory for cargo's downloads, so a step that fetches them leaves them for the next */
	dependencies?: string | undefined;
}

/**
 * The user the build image's steps run as: this process's own, so a step
 * reads and writes the directories mounted for it (and nothing else of the
 * host's) as their owner, without privileges, and leaves files this process
 * can remove.
 */
function stepUser(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	return(uid === undefined || gid === undefined ? '1000:1000' : `${uid}:${gid}`);
}

/**
 * Run a shell script in the build image, with the source copied to the
 * build path (it is mounted read-only) and `out` mounted at /out. The step
 * runs as an unprivileged user (see `stepUser`), with no capabilities and
 * its resources limited.
 */
async function inImage(run: CommandRunner, source: ContractSource, out: string, script: string, what: string, options: StepOptions): Promise<string> {
	const image = await ensureBuildImage(run);
	const dependencyMounts = options.dependencies === undefined ? [] : CARGO_DEPENDENCY_DIRS.map((dir) => ['-v', `${join(resolve(options.dependencies ?? ''), dir.split('/').pop() ?? '')}:${dir}`]).flat();
	/*
	 * Copied entry by entry, not as ".", which would have tar set the mode
	 * of the build path (the image's, not this user's). Without build output
	 * or git's data: a working tree's target
	 * directories are not source. Nor Cargo's configuration (`.cargo`),
	 * which can change the build (flags, a linker or rustc wrapper, crates
	 * replaced by copies in the source) without being part of the source a
	 * verification shows.
	 *
	 * Every step uses the platform tools' Rust, the one the build compiles
	 * with, as the image's rustup knows it: a toolchain the image pins, which
	 * a source's `rust-toolchain.toml` cannot swap for another one fetched at
	 * run time (rustup gives `RUSTUP_TOOLCHAIN` precedence over that file).
	 */
	const step = `export RUSTUP_TOOLCHAIN="$(rustup toolchain list | sed -n 's/^\\([^ ]*-sbpf-solana-${PLATFORM_TOOLS_VERSION}\\).*/\\1/p' | head -n 1)" && test -n "$RUSTUP_TOOLCHAIN" && cd /src && find . -mindepth 1 -maxdepth 1 ! -name .git ! -name target ! -name .cargo -print0 | tar -cf - --null --exclude=target --exclude=.cargo -T - | tar -C ${BUILD_SOURCE_DIR} --no-same-owner -xf - && cd ${BUILD_SOURCE_DIR} && ${script}`;
	return(await check(run, 'docker', [
		'run', '--rm', '--init', '--platform', BUILD_PLATFORM,
		...(options.network ? [] : ['--network', 'none']),
		...IN_IMAGE_LIMITS,
		// The toolchain is found under root's home, which the image lets any user read.
		'--user', stepUser(), '-e', 'HOME=/root',
		'--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
		'-v', `${resolve(source.dir)}:/src:ro`,
		'-v', `${resolve(out)}:/out`,
		...dependencyMounts,
		'-e', `KEETA_STEP=${step}`,
		image,
		'timeout', '-k', '10', String(IN_IMAGE_TIMEOUT_SECONDS), 'sh', '-ec', 'eval "$KEETA_STEP"'
	], what));
}

/** A fresh host directory for cargo's downloads, made for one build and removed with it. */
async function dependencyDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'keeta-contract-deps-'));
	for (const sub of CARGO_DEPENDENCY_DIRS) {
		await mkdir(join(dir, sub.split('/').pop() ?? ''));
	}
	return(dir);
}

function shellQuote(text: string): string {
	return(`'${text.replace(/'/gu, '\'\\\'\'')}'`);
}

const PACKAGE_NAME = /^[A-Za-z0-9_-]+$/u;

/** The directory of `name`'s manifest, from `cargo metadata` output. */
export function packageDirIn(metadata: string, name: string): string {
	const parsed: unknown = JSON.parse(metadata);
	const packages: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'packages') : undefined;
	const list: unknown[] = Array.isArray(packages) ? packages : [];
	const found = list.find((entry) => typeof entry === 'object' && entry !== null && Reflect.get(entry, 'name') === name);
	const manifest: unknown = typeof found === 'object' && found !== null ? Reflect.get(found, 'manifest_path') : undefined;
	if (typeof manifest !== 'string') {
		throw(new Error(`No package ${name} in the source`));
	}
	return(manifest.replace(/[\\/]Cargo\.toml$/u, ''));
}

/** The package's directory, relative to the source's root, as `cargo metadata` finds it in the build image. */
export async function packageDirOf(source: ContractSource, run: CommandRunner = runCommand): Promise<string> {
	const out = await mkdtemp(join(tmpdir(), 'keeta-contract-metadata-'));
	try {
		const metadata = await inImage(run, source, out, `cargo metadata --no-deps --format-version 1 --manifest-path ${shellQuote(manifestOf(source))}`, 'Reading the source\'s packages', { network: false });
		const dir = packageDirIn(metadata, source.package);
		const inside = relative(BUILD_SOURCE_DIR, dir);
		if (inside.startsWith('..') || inside.startsWith('/')) {
			throw(new Error(`${source.package} is outside the source`));
		}
		return(inside.split(sep).join('/'));
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}

/** A local package the build compiles. */
export interface LocalPackage {
	name: string;
	version: string;
	/** Its directory, relative to the source's root */
	dir: string;
}

/**
 * Every local package the build compiles: the package and its path
 * dependencies, such as the contract SDK. These are what a verification
 * shows as the source; registry crates are pinned by the lock file instead.
 */
export async function localPackagesOf(source: ContractSource, run: CommandRunner = runCommand): Promise<{ packages: LocalPackage[]; workspaceDir: string | undefined; }> {
	const out = await mkdtemp(join(tmpdir(), 'keeta-contract-metadata-'));
	try {
		// Resolving downloads the dependencies' manifests, and runs none of their code.
		const metadata: unknown = JSON.parse(await inImage(run, source, out, `cargo metadata --format-version 1 --locked --manifest-path ${shellQuote(manifestOf(source))}`, 'Reading the source\'s dependencies', { network: true }));
		const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined);
		const packagesField = field(metadata, 'packages');
		const packages: unknown[] = Array.isArray(packagesField) ? packagesField : [];
		const nodesField = field(field(metadata, 'resolve'), 'nodes');
		const nodes: unknown[] = Array.isArray(nodesField) ? nodesField : [];

		// The package and everything it depends on: not the workspace's other members.
		const dependencies = new Map<string, string[]>();
		for (const node of nodes) {
			const id = field(node, 'id');
			const on = field(node, 'dependencies');
			if (typeof id === 'string') {
				dependencies.set(id, Array.isArray(on) ? on.filter((entry): entry is string => typeof entry === 'string') : []);
			}
		}
		const start = packages.find((entry) => field(entry, 'name') === source.package);
		const startId = field(start, 'id');
		const reached = new Set<string>();
		for (let pending = typeof startId === 'string' ? [startId] : []; pending.length > 0;) {
			const id = pending.pop() ?? '';
			if (!reached.has(id)) {
				reached.add(id);
				pending = [...pending, ...(dependencies.get(id) ?? [])];
			}
		}

		const found = new Map<string, LocalPackage>();
		for (const entry of packages) {
			const id = field(entry, 'id');
			const name = field(entry, 'name');
			const version = field(entry, 'version');
			const manifest = field(entry, 'manifest_path');
			const origin = field(entry, 'source');
			if (typeof id !== 'string' || !reached.has(id) || typeof name !== 'string' || typeof manifest !== 'string' || (origin !== null && origin !== undefined)) {
				continue;
			}
			const inside = relative(BUILD_SOURCE_DIR, manifest.replace(/[\\/]Cargo\.toml$/u, ''));
			if (!inside.startsWith('..') && !inside.startsWith('/')) {
				const dir = inside.split(sep).join('/');
				found.set(dir, { name, version: typeof version === 'string' ? version : '', dir });
			}
		}
		// The workspace's root holds the manifest whose profiles and patches the build uses, and the lock file.
		const workspaceRoot = field(metadata, 'workspace_root');
		const workspaceDir = typeof workspaceRoot === 'string' ? relative(BUILD_SOURCE_DIR, workspaceRoot) : undefined;
		return({
			packages: [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir)),
			workspaceDir: workspaceDir === undefined || workspaceDir.startsWith('..') || isAbsolute(workspaceDir) ? undefined : workspaceDir.split(sep).join('/')
		});
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}

/** Build `source.package` in the build image: the program, and its SHA-256. */
export async function verifiableBuild(source: ContractSource, run: CommandRunner = runCommand): Promise<{ program: Buffer; sha256: string; builder: BuilderInfo; }> {
	if (!PACKAGE_NAME.test(source.package)) {
		throw(new Error(`Not a package name: ${source.package}`));
	}
	// The package's own manifest: given a workspace's, cargo-build-sbf looks for every member's program.
	const packageManifest = `${await packageDirOf(source, run)}/Cargo.toml`;
	const out = await mkdtemp(join(tmpdir(), 'keeta-contract-build-'));
	const dependencies = await dependencyDir();
	try {
		await inImage(run, source, out, `cargo fetch --locked --manifest-path ${shellQuote(packageManifest)}`, `Fetching ${source.package}'s dependencies`, { network: true, dependencies });
		// The build runs the source's build scripts and macros: offline, with what was fetched.
		await inImage(run, source, out, `cargo-build-sbf --arch v3 --tools-version ${PLATFORM_TOOLS_VERSION} --manifest-path ${shellQuote(packageManifest)} --sbf-out-dir /out -- --locked --offline`, `Building ${source.package}`, { network: false, dependencies });
		const path = join(out, `${source.package.replace(/-/gu, '_')}.so`);
		// The build wrote it, so it is not trusted: a link would read a file of this machine's instead.
		if ((await lstat(path).catch(() => null))?.isFile() !== true) {
			throw(new Error(`The build of ${source.package} made no program`));
		}
		const program = await readFile(path);
		return({ program, sha256: createHash('sha256').update(program).digest('hex'), builder: builderInfo() });
	} finally {
		await rm(out, { recursive: true, force: true });
		await rm(dependencies, { recursive: true, force: true });
	}
}

/** The crate that prints a contract's interface: it calls the package's `contract_interface()`. */
export function interfaceExporter(packageDir: string, crateName: string): { manifest: string; main: string; } {
	return({
		manifest: [
			'[package]',
			'name = "keeta-contract-interface-export"',
			'version = "0.0.0"',
			'edition = "2021"',
			'publish = false',
			'',
			'[dependencies]',
			`contract = { package = ${JSON.stringify(crateName)}, path = ${JSON.stringify(packageDir)} }`,
			'',
			'[workspace]',
			''
		].join('\n'),
		main: 'fn main() {\n\tprint!("{}", contract::contract_interface().to_json());\n}\n'
	});
}

/** The contract's interface (JSON), exported in the build image from `source`. */
export async function exportInterface(source: ContractSource, run: CommandRunner = runCommand): Promise<unknown> {
	if (!PACKAGE_NAME.test(source.package)) {
		throw(new Error(`Not a package name: ${source.package}`));
	}
	const out = await mkdtemp(join(tmpdir(), 'keeta-contract-interface-'));
	const dependencies = await dependencyDir();
	try {
		const exporter = interfaceExporter(`${BUILD_SOURCE_DIR}/${await packageDirOf(source, run)}`, source.package);
		await writeFile(join(out, 'Cargo.toml'), exporter.manifest);
		await mkdir(join(out, 'src'));
		await writeFile(join(out, 'src', 'main.rs'), exporter.main);
		// Fetch, keeping the lock file it resolves; then build and run the exporter, which runs the source's code, offline.
		await inImage(run, source, out, 'cp -a /out /tmp/export && cargo fetch --manifest-path /tmp/export/Cargo.toml && cp /tmp/export/Cargo.lock /out/Cargo.lock', `Fetching ${source.package}'s interface exporter`, { network: true, dependencies });
		const printed = await inImage(run, source, out, 'cp -a /out /tmp/export && cargo run --quiet --offline --locked --manifest-path /tmp/export/Cargo.toml', `Exporting ${source.package}'s interface`, { network: false, dependencies });
		const parsed: unknown = JSON.parse(printed);
		return(parsed);
	} finally {
		await rm(out, { recursive: true, force: true });
		await rm(dependencies, { recursive: true, force: true });
	}
}

/** Most bytes of source files a verification keeps, in all, and for one file. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const SOURCE_FILE = /\.(?:rs|toml|lock|md)$/u;

type SourceFile = { path: string; content: string; };

/** Whether `path` is `dir` or inside it. */
function isInside(dir: string, path: string): boolean {
	const inside = relative(dir, path);
	return(inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)));
}

/** Reads source files within the size limits, shared by everything one verification keeps. */
class SourceReader {
	#total = 0;
	/** The source's root, its links resolved: no file outside it is read */
	readonly #source: string;

	constructor(source: string) {
		this.#source = source;
	}

	/**
	 * The file at `path`, its path given relative to `root`; `null` if
	 * missing, over the limits, or not a plain file inside the source. The
	 * source is not trusted: a link in it could point anywhere on this
	 * machine, and what it points to would be served as verified source.
	 */
	async file(root: string, path: string): Promise<SourceFile | null> {
		const info = await lstat(path).catch(() => null);
		if (info === null || !info.isFile() || info.size > MAX_FILE_BYTES || this.#total + info.size > MAX_SOURCE_BYTES) {
			return(null);
		}
		const real = await realpath(path).catch(() => null);
		if (real === null || !isInside(this.#source, real)) {
			return(null);
		}
		this.#total += info.size;
		return({ path: relative(root, path).split(sep).join('/'), content: await readFile(path, 'utf-8') });
	}

	/** A package's source files, under `dir`, with paths relative to `root`. */
	async package(root: string, dir: string): Promise<SourceFile[]> {
		const files: SourceFile[] = [];
		const walk = async (at: string): Promise<void> => {
			for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name === 'target' || entry.name.startsWith('.')) {
					continue;
				}
				const path = join(at, entry.name);
				if (entry.isDirectory()) {
					await walk(path);
				} else if (SOURCE_FILE.test(entry.name)) {
					const file = await this.file(root, path);
					if (file !== null) {
						files.push(file);
					}
				}
			}
		};
		await walk(dir);
		return(files);
	}
}

/**
 * A local package a contract builds with besides its own, such as the
 * contract SDK. Many contracts share one, so a verification names it by
 * the hash of its source instead of listing its files with the contract's.
 */
export interface ContractLibrary {
	name: string;
	version: string;
	/** Its directory, relative to the source's root */
	dir: string;
	/**
	 * The SHA-256 of its files (`libraryHash`), with their paths taken from
	 * its own directory: the same source has the same hash in any repository
	 */
	sha256: string;
	/** Its files, relative to its directory */
	files: SourceFile[];
}

/** The SHA-256 a library is known by: of each file's path, length and content, in path order. */
export function libraryHash(files: SourceFile[]): string {
	const hash = createHash('sha256');
	for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const content = Buffer.from(file.content, 'utf-8');
		hash.update(`${file.path}\n${content.length}\n`);
		hash.update(content);
	}
	return(hash.digest('hex'));
}

/**
 * The source a verification shows: the contract's own files (its
 * package, and the workspace's manifest and lock file, which pin every
 * dependency), and the other local packages it builds with as libraries.
 */
export async function sourceFiles(source: ContractSource, packages: LocalPackage[], workspaceDir?: string): Promise<{ files: SourceFile[]; libraries: ContractLibrary[]; }> {
	const root = resolve(source.dir);
	const reader = new SourceReader(await realpath(root));
	const files: SourceFile[] = [];
	const own = packages.find((entry) => entry.name === source.package);
	const manifestDir = resolve(root, manifestOf(source), '..');
	// The manifest given, and the workspace's root above it: its manifest's profiles and patches, and its lock file, shape the build.
	const workspace = workspaceDir === undefined ? manifestDir : resolve(root, workspaceDir);
	for (const dir of new Set([workspace, manifestDir])) {
		if (own !== undefined && resolve(root, own.dir) === dir) {
			continue;
		}
		for (const name of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']) {
			const file = await reader.file(root, join(dir, name));
			if (file !== null) {
				files.push(file);
			}
		}
	}
	if (own !== undefined) {
		files.push(...await reader.package(root, join(root, own.dir)));
	}

	const libraries: ContractLibrary[] = [];
	for (const library of packages.filter((entry) => entry !== own)) {
		const dir = join(root, library.dir);
		const libraryFiles = await reader.package(dir, dir);
		libraries.push({ ...library, sha256: libraryHash(libraryFiles), files: libraryFiles });
	}
	return({ files, libraries });
}

/** A check of a contract's source against the code the network runs. */
export interface ContractVerification {
	format: 'keeta-contract-verification/v1';
	contract: string;
	/** The SHA-256 of the contract's code, as the network records it */
	codeHash: string;
	/** The SHA-256 of the program built from the source */
	builtHash: string;
	/** Whether they match: the source is what runs */
	verified: boolean;
	source: { repository: string; commit: string; } | { local: string; };
	package: string;
	manifestPath: string;
	builder: BuilderInfo;
	/** The contract's interface, from `contract_interface()`; `null` if it has none */
	interface: unknown;
	/** The contract's own source files, relative to the source's root */
	files: SourceFile[];
	/** The other local packages it builds with, such as the contract SDK */
	libraries: ContractLibrary[];
	verifiedAt: string;
}

const COMMIT = /^[0-9a-f]{40}$/u;

/** A repository at an exact commit, checked out into a new directory. */
export async function checkout(repository: string, commit: string, run: CommandRunner = runCommand): Promise<string> {
	if (!COMMIT.test(commit)) {
		throw(new Error('The commit must be a full 40-character commit hash, so the source cannot move'));
	}
	const dir = await mkdtemp(join(tmpdir(), 'keeta-contract-source-'));
	try {
		// A server that stops sending would otherwise hold the clone, and a verifier's queue, for good.
		await check(run, 'git', ['clone', '--quiet', '--no-checkout', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', '--', repository, dir], `Cloning ${repository}`);
		await check(run, 'git', ['-C', dir, 'checkout', '--quiet', '--detach', commit], `Checking out ${commit}`);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw(error);
	}
	return(dir);
}

/**
 * Verify `source` against a contract whose code has `codeHash`: build it,
 * compare, and export its interface and files.
 */
export async function verifyContract(input: {
	contract: string;
	codeHash: string;
	source: ContractSource;
	origin: ContractVerification['source'];
	run?: CommandRunner;
}): Promise<ContractVerification> {
	const run = input.run ?? runCommand;
	const built = await verifiableBuild(input.source, run);
	const { packages, workspaceDir } = await localPackagesOf(input.source, run);
	let contractInterface: unknown = null;
	try {
		contractInterface = await exportInterface(input.source, run);
	} catch {
		/* A contract need not describe its interface */
	}
	return({
		format: 'keeta-contract-verification/v1',
		contract: input.contract,
		codeHash: input.codeHash.toLowerCase(),
		builtHash: built.sha256,
		verified: built.sha256 === input.codeHash.toLowerCase(),
		source: input.origin,
		package: input.source.package,
		manifestPath: manifestOf(input.source),
		builder: built.builder,
		interface: contractInterface,
		...await sourceFiles(input.source, packages, workspaceDir),
		verifiedAt: new Date().toISOString()
	});
}
