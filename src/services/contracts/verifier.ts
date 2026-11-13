/**
 * A contract verifier: a service that checks contracts' source against the
 * code the network runs, and publishes the results for explorers.
 *
 * ```text
 * POST /api/verify  { contract, repository, commit, package, manifestPath? }
 *     Queue a check: clone the repository at the commit (a full hash, so
 *     the source cannot move), build the package in the pinned build image,
 *     and compare with the contract's code hash. 202 { status: "queued" }.
 * GET  /api/verifications/:contract
 *     { status: "none" | "queued" | "running" | "done" | "failed", error?,
 *       verification?, lastAttempt? }. `verification` is the contract's
 *     verified source (files listed by path and size); `lastAttempt` is the
 *     latest check, when it did not verify.
 * GET  /api/verifications/:contract/files/<path>
 *     A verified source file, as text: the contract's own, or one of a
 *     library's (`<library dir>/<path>`).
 * ```
 *
 * A verification lists the contract's own files. The other local packages
 * it builds with, such as the contract SDK, are libraries: named by the
 * SHA-256 of their source and kept once (`libraries/<sha256>.json`), as
 * many contracts share them.
 *
 * Builds run one at a time, in Docker (./verify.ts). A check that does not
 * match never replaces a verified result, so nobody can undo a contract's
 * verification by submitting other source. Anyone can run a verifier and
 * repeat a check: the result is only a claim about a build anyone can
 * redo.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { CommandRunner, ContractLibrary, ContractVerification } from './verify.js';
import { checkout, runCommand, verifyContract } from './verify.js';
import { Buffer } from '../../lib/utils/buffer.js';

export interface ContractVerifierConfig {
	port?: number;
	host?: string;
	/** Where results are kept, one file per contract */
	dataDir: string;
	/** The SHA-256 of a contract's code, as the network records it; `null` if the account is not a contract */
	codeHashOf: (contract: string) => Promise<string | null>;
	/**
	 * Also accept a local directory as the repository, without a commit, to
	 * verify a working tree (development only: a published result should
	 * name a commit anyone can fetch).
	 */
	allowLocalSources?: boolean;
	run?: CommandRunner;
	log?: (message: string) => void;
}

interface Request {
	contract: string;
	repository: string;
	commit: string | undefined;
	package: string;
	manifestPath: string | undefined;
}

type FileListing = { path: string; size: number; };

/** A library, as a verification records it: its files listed, their content kept apart. */
type LibraryListing = Omit<ContractLibrary, 'files'> & { files: FileListing[]; };

/** A verification as it is kept: libraries listed, not included. */
type StoredVerification = Omit<ContractVerification, 'libraries'> & { libraries?: LibraryListing[]; };

interface Stored {
	verification?: StoredVerification;
	lastAttempt?: StoredVerification | { error: string; at: string; };
}

const SHA256 = /^[0-9a-f]{64}$/u;

type Status = 'none' | 'queued' | 'running' | 'done' | 'failed';

const CONTRACT = /^keeta_[a-z0-9]{50,70}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const PACKAGE = /^[A-Za-z0-9_-]+$/u;

function text(body: unknown, name: string): string | undefined {
	const value: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, name) : undefined;
	return(typeof value === 'string' && value !== '' ? value : undefined);
}

function listFiles(files: { path: string; content: string; }[]): FileListing[] {
	return(files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content) })));
}

/** The listing an API answer carries: files by path and size, not content. */
function listed(verification: StoredVerification): Omit<StoredVerification, 'files'> & { files: FileListing[]; libraries: LibraryListing[]; } {
	return({ ...verification, files: listFiles(verification.files), libraries: verification.libraries ?? [] });
}

export class ContractVerifier {
	readonly #config: ContractVerifierConfig;
	readonly #run: CommandRunner;
	readonly #queue: Request[] = [];
	readonly #status = new Map<string, { status: Status; error?: string; }>();
	#working: Promise<void> | null = null;
	#server: Server | null = null;

	constructor(config: ContractVerifierConfig) {
		this.#config = config;
		this.#run = config.run ?? runCommand;
	}

	#path(contract: string): string {
		return(join(this.#config.dataDir, `${contract}.json`));
	}

	async #stored(contract: string): Promise<Stored> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path(contract), 'utf-8'));
			return(typeof parsed === 'object' && parsed !== null ? parsed : {});
		} catch {
			return({});
		}
	}

	async #store(contract: string, stored: Stored): Promise<void> {
		await this.#write(this.#path(contract), stored);
	}

	async #write(path: string, value: unknown): Promise<void> {
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(`${path}.new`, JSON.stringify(value));
		await rename(`${path}.new`, path);
	}

	#libraryPath(sha256: string): string {
		return(join(this.#config.dataDir, 'libraries', `${sha256}.json`));
	}

	/** Keep a verification's libraries apart, once each, and list them in it. */
	async #storeLibraries(verification: ContractVerification): Promise<StoredVerification> {
		for (const library of verification.libraries) {
			const path = this.#libraryPath(library.sha256);
			if (await stat(path).catch(() => null) === null) {
				await this.#write(path, { name: library.name, version: library.version, files: library.files });
			}
		}
		return({ ...verification, libraries: verification.libraries.map((library) => ({ ...library, files: listFiles(library.files) })) });
	}

	/** Check a request and queue it. Throws a message for the caller when it is not one to run. */
	async submit(body: unknown): Promise<void> {
		const request: Request = {
			contract: text(body, 'contract') ?? '',
			repository: text(body, 'repository') ?? '',
			commit: text(body, 'commit'),
			package: text(body, 'package') ?? '',
			manifestPath: text(body, 'manifestPath')
		};
		if (!CONTRACT.test(request.contract)) {
			throw(new Error('contract must be a contract\'s keeta_ address'));
		}
		if (!PACKAGE.test(request.package)) {
			throw(new Error('package must be the contract\'s Cargo package name'));
		}
		const local = this.#config.allowLocalSources === true && isAbsolute(request.repository) && request.commit === undefined;
		if (!local) {
			if (!/^https:\/\/[^\s]+$/u.test(request.repository)) {
				throw(new Error('repository must be an https git URL'));
			}
			if (request.commit === undefined || !COMMIT.test(request.commit)) {
				throw(new Error('commit must be a full 40-character commit hash'));
			}
		}
		if (request.manifestPath !== undefined && (request.manifestPath.startsWith('/') || request.manifestPath.split('/').includes('..'))) {
			throw(new Error('manifestPath must be inside the repository'));
		}
		if (await this.#config.codeHashOf(request.contract) === null) {
			throw(new Error(`${request.contract} is not a contract`));
		}
		const current = this.#status.get(request.contract)?.status;
		if (current === 'queued' || current === 'running') {
			throw(new Error('That contract is being verified already'));
		}

		this.#queue.push(request);
		this.#status.set(request.contract, { status: 'queued' });
		this.#startWork();
	}

	/** Start working through the queue, unless that is under way. */
	#startWork(): void {
		if (this.#working !== null) {
			return;
		}
		this.#working = this.#work().catch((error: unknown) => {
			this.#config.log?.(`verifier: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			this.#working = null;
			// A request queued after the work last looked, but before it stopped, would otherwise never run.
			if (this.#queue.length > 0) {
				this.#startWork();
			}
		});
	}

	async #work(): Promise<void> {
		for (let request = this.#queue.shift(); request !== undefined; request = this.#queue.shift()) {
			this.#status.set(request.contract, { status: 'running' });
			this.#config.log?.(`verifying ${request.contract}: ${request.package} from ${request.repository}${request.commit === undefined ? '' : ` at ${request.commit}`}`);
			let dir: string | undefined;
			try {
				const codeHash = await this.#config.codeHashOf(request.contract);
				if (codeHash === null) {
					throw(new Error(`${request.contract} is not a contract`));
				}
				const local = request.commit === undefined;
				dir = local ? request.repository : await checkout(request.repository, request.commit ?? '', this.#run);
				const verification = await verifyContract({
					contract: request.contract,
					codeHash,
					source: { dir, package: request.package, manifestPath: request.manifestPath },
					origin: local ? { local: request.repository } : { repository: request.repository, commit: request.commit ?? '' },
					run: this.#run
				});
				const kept = await this.#storeLibraries(verification);
				const stored = await this.#stored(request.contract);
				// A check that does not match never replaces a verified result.
				await this.#store(request.contract, verification.verified ? { verification: kept } : { ...stored, lastAttempt: kept });
				this.#status.set(request.contract, { status: 'done' });
				this.#config.log?.(`${request.contract}: ${verification.verified ? 'verified' : `does not match (built ${verification.builtHash}, runs ${verification.codeHash})`}`);
				if (!local) {
					await rm(dir, { recursive: true, force: true });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.#status.set(request.contract, { status: 'failed', error: message });
				this.#config.log?.(`${request.contract}: ${message}`);
				try {
					const stored = await this.#stored(request.contract);
					await this.#store(request.contract, { ...stored, lastAttempt: { error: message, at: new Date().toISOString() }});
				} catch (storeError) {
					this.#config.log?.(`${request.contract}: could not record the failure: ${storeError instanceof Error ? storeError.message : String(storeError)}`);
				}
				if (dir !== undefined && request.commit !== undefined) {
					await rm(dir, { recursive: true, force: true }).catch(() => undefined);
				}
			}
		}
	}

	/** What is known about a contract's source. */
	async status(contract: string): Promise<{ [key: string]: unknown; }> {
		const stored = await this.#stored(contract);
		const running = this.#status.get(contract);
		const lastAttempt = stored.lastAttempt;
		return({
			status: running?.status ?? (stored.verification !== undefined || lastAttempt !== undefined ? 'done' : 'none'),
			...(running?.error !== undefined ? { error: running.error } : {}),
			...(stored.verification !== undefined ? { verification: listed(stored.verification) } : {}),
			...(lastAttempt !== undefined ? { lastAttempt: 'files' in lastAttempt ? listed(lastAttempt) : lastAttempt } : {})
		});
	}

	/** A verified source file, the contract's own or a library's, or `null`. */
	async file(contract: string, path: string): Promise<string | null> {
		const verification = (await this.#stored(contract)).verification;
		const own = verification?.files.find((file) => file.path === path);
		if (own !== undefined) {
			return(own.content);
		}
		for (const library of verification?.libraries ?? []) {
			if (!path.startsWith(`${library.dir}/`) || !SHA256.test(library.sha256)) {
				continue;
			}
			try {
				const kept: unknown = JSON.parse(await readFile(this.#libraryPath(library.sha256), 'utf-8'));
				const files: unknown = typeof kept === 'object' && kept !== null ? Reflect.get(kept, 'files') : undefined;
				const inside = path.slice(library.dir.length + 1);
				const found: unknown = Array.isArray(files) ? files.find((file: unknown) => typeof file === 'object' && file !== null && Reflect.get(file, 'path') === inside) : undefined;
				const content: unknown = typeof found === 'object' && found !== null ? Reflect.get(found, 'content') : undefined;
				if (typeof content === 'string') {
					return(content);
				}
			} catch {
				/* Not kept: no such file */
			}
		}
		return(null);
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', 'http://verifier');
		const reply = (status: number, body: unknown, type = 'application/json') => {
			response.writeHead(status, {
				'content-type': type,
				'access-control-allow-origin': '*',
				'access-control-allow-methods': 'GET, POST, OPTIONS',
				'access-control-allow-headers': 'content-type'
			});
			response.end(typeof body === 'string' && type !== 'application/json' ? body : JSON.stringify(body));
		};
		if (request.method === 'OPTIONS') {
			reply(204, '', 'text/plain');
			return;
		}

		if (request.method === 'POST' && url.pathname === '/api/verify') {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				const part: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
				size += part.length;
				if (size > 16 * 1024) {
					reply(413, { ok: false, error: 'The request is too large' });
					return;
				}
				chunks.push(part);
			}
			let body: unknown;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
			} catch {
				reply(400, { ok: false, error: 'The request is not JSON' });
				return;
			}
			try {
				await this.submit(body);
			} catch (error) {
				reply(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
				return;
			}
			reply(202, { ok: true, status: 'queued' });
			return;
		}

		const match = /^\/api\/verifications\/(keeta_[a-z0-9]+)(?:\/files\/(.+))?$/u.exec(url.pathname);
		if (request.method === 'GET' && match?.[1] !== undefined) {
			if (match[2] === undefined) {
				reply(200, { ok: true, ...(await this.status(match[1])) });
				return;
			}
			const content = await this.file(match[1], decodeURIComponent(match[2]));
			if (content === null) {
				reply(404, { ok: false, error: 'No such verified file' });
				return;
			}
			reply(200, content, 'text/plain; charset=utf-8');
			return;
		}

		reply(404, { ok: false, error: 'Not found' });
	}

	/** Listen; returns the URL. */
	async start(): Promise<string> {
		const server = createServer((request, response) => {
			this.#handle(request, response).catch((error: unknown) => {
				if (!response.headersSent) {
					response.writeHead(500, { 'content-type': 'application/json' });
				}
				response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			});
		});
		this.#server = server;
		const host = this.#config.host ?? 'localhost';
		await new Promise<void>((resolvePromise) => server.listen(this.#config.port ?? 0, host, resolvePromise));
		const address = server.address();
		const port = typeof address === 'object' && address !== null ? address.port : this.#config.port;
		return(`http://${host}:${port}/`);
	}

	async stop(): Promise<void> {
		const server = this.#server;
		if (server !== null) {
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
		await this.#working;
	}
}
