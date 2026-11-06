/**
 * The contract sequencer: an anchor service that runs CosmWasm-compatible
 * contracts and publishes their effects on Keeta.
 *
 * Each state-changing call (instantiate, execute, migrate) runs to
 * completion before the next starts:
 *
 * 1. finish any call a crash left staged ({@link ContractStateBackend});
 * 2. execute it in the engine against the sequencer's state and the ledger;
 * 3. sign the blocks the sequencer owns, and seal them;
 * 4. stage the state changes, publish the staple (the caller's funding
 *    block, the contract accounts' blocks, the commitments, the refund);
 * 5. commit the changes once the staple has landed.
 *
 * The sequencer is custodial in this phase: it holds the keys that move
 * contract funds.
 */
import { randomUUID } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import type { KeetaAnchorMetadataServerConfig } from '../../lib/anchor-metadata-server.js';
import { KeetaAnchorMetadataServer } from '../../lib/anchor-metadata-server.js';
import type { ServiceMetadata, ServiceMetadataAuthenticationType } from '../../lib/resolver.ts';
import type { Routes } from '../../lib/http-server/index.ts';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import { verifyBodyAuth } from '../../lib/http-server/common.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import type { ContractStateBackend } from './state.js';
import type {
	ContractCall,
	ContractEngineBinding,
	ContractEngineConfig,
	ContractEngineInstance,
	ContractExecution,
	ContractStapleBlock,
	ContractStorageProof,
	ContractStoredCode
} from './engine.js';
import {
	ContractEngineCallError,
	KeetaNetChainReader,
	createHostCallback,
	loadContractEngine,
	unwrapOutcome
} from './engine.js';
import type { KeetaContractsAnchorCallResult } from './common.js';
import {
	Errors,
	getContractExecuteSignable,
	getContractInstantiateSignable,
	getContractMigrateSignable,
	getContractUploadSignable
} from './common.js';
import {
	assertKeetaContractsAnchorExecuteRequestJSON,
	assertKeetaContractsAnchorInstantiateRequestJSON,
	assertKeetaContractsAnchorMigrateRequestJSON,
	assertKeetaContractsAnchorProveRequestJSON,
	assertKeetaContractsAnchorQueryRequestJSON,
	assertKeetaContractsAnchorSimulateRequestJSON,
	assertKeetaContractsAnchorUploadRequestJSON
} from './common.server.generated.js';
import { Buffer } from '../../lib/utils/buffer.js';

type ContractsServiceMetadata = NonNullable<ServiceMetadata['services']['contracts']>[string];
type KeetaNetAccount = InstanceType<typeof KeetaNet.lib.Account>;

/** Largest accepted Wasm upload by default (CosmWasm's own default limit). */
const DEFAULT_MAX_WASM_SIZE = 3 * 1024 * 1024;

/** How long a request nonce is remembered, to refuse replays. */
const NONCE_WINDOW_MS = 15 * 60 * 1000;

export interface KeetaAnchorContractsServerConfig extends KeetaAnchorMetadataServerConfig {
	/**
	 * The sequencer account, with its private key. It owns every contract
	 * and contract-created token account, signs their blocks and collects
	 * fees.
	 */
	sequencer: KeetaNetAccount;
	/** Reads the ledger and publishes staples. */
	client: KeetaNet.UserClient;
	/** Where the sequencer's own state lives. */
	state: ContractStateBackend;
	/**
	 * Gas price, in base units of the network's base token: a call costs
	 * `gas × numerator / denominator`, rounded up. Omit for free calls.
	 */
	gasPrice?: { numerator: bigint; denominator: bigint; };
	/** The engine addon; loaded from `@keetanetwork/contract-engine` by default. */
	engine?: ContractEngineBinding;
	/** Directory for compiled contract code, private to the sequencer. */
	cacheDir?: string;
	/** `env.block.chain_id` as contracts see it. */
	chainId?: string;
	/** Largest Wasm upload accepted, in bytes. */
	maxWasmSize?: number;
	routes?: Routes;
}

function json(output: unknown): { output: string; contentType: string; } {
	return({
		output: JSON.stringify(output, function(_key, value: unknown) {
			return(typeof value === 'bigint' ? value.toString() : value);
		}),
		contentType: 'application/json'
	});
}

function lastHeads(blocks: ContractStapleBlock[]): { account: string; hash: string; }[] {
	const heads = new Map<string, string>();
	for (const block of blocks) {
		heads.set(block.account, block.hash);
	}

	return([...heads].map(([account, hash]) => ({ account, hash })));
}

export class KeetaNetContractsAnchorHTTPServer extends KeetaAnchorMetadataServer<ContractsServiceMetadata, KeetaAnchorContractsServerConfig> {
	readonly sequencer: KeetaNetAccount;
	readonly state: ContractStateBackend;
	readonly routes: Routes;
	readonly #client: KeetaNet.UserClient;
	readonly #config: KeetaAnchorContractsServerConfig;
	readonly #maxWasmSize: number;
	#engines: Promise<{ binding: ContractEngineBinding; engine: ContractEngineInstance; simulator: ContractEngineInstance; }> | null = null;
	/** State-changing calls, one at a time */
	#queue: Promise<unknown> = Promise.resolve();
	readonly #nonces = new Map<string, number>();

	constructor(config: KeetaAnchorContractsServerConfig) {
		super(config);

		if (!config.sequencer.hasPrivateKey) {
			throw(new Error('The sequencer account must hold its private key'));
		}

		this.sequencer = config.sequencer;
		this.state = config.state;
		this.routes = config.routes ?? {};
		this.#client = config.client;
		this.#config = config;
		this.#maxWasmSize = config.maxWasmSize ?? DEFAULT_MAX_WASM_SIZE;
	}

	get #sequencerAddress(): string {
		return(this.sequencer.publicKeyString.get());
	}

	get #gasPrice(): ContractEngineConfig['gasPrice'] {
		const price = this.#config.gasPrice;
		if (price === undefined) {
			return(undefined);
		}

		return({
			token: this.#client.baseToken.publicKeyString.get(),
			numerator: price.numerator.toString(),
			denominator: price.denominator.toString()
		});
	}

	/** The engine (and a fee-free twin for simulation), created on first use. */
	async #engine(): Promise<{ binding: ContractEngineBinding; engine: ContractEngineInstance; simulator: ContractEngineInstance; }> {
		this.#engines ??= (async () => {
			const binding = this.#config.engine ?? await loadContractEngine();
			const host = createHostCallback(this.state, new KeetaNetChainReader(this.#client.client));
			const base: ContractEngineConfig = {
				network: this.#client.network.toString(),
				sequencer: this.#sequencerAddress,
				...(this.#config.chainId !== undefined ? { chainId: this.#config.chainId } : {})
			};
			const gasPrice = this.#gasPrice;
			const engine = new binding.ContractEngine(JSON.stringify({
				...base,
				...(this.#config.cacheDir !== undefined ? { cacheDir: this.#config.cacheDir } : {}),
				...(gasPrice !== undefined ? { gasPrice } : {})
			}), host);
			const simulator = new binding.ContractEngine(JSON.stringify(base), host);
			return({ binding, engine, simulator });
		})();

		return(await this.#engines);
	}

	/** Run state-changing work after everything queued before it. */
	async #serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(work);
		this.#queue = result.catch(function() {
			/* The caller sees the error; the queue moves on */
		});

		return(await result);
	}

	/** Refuse a request nonce seen before. */
	#claimNonce(signed: HTTPSignedField): void {
		const now = Date.now();
		for (const [nonce, expiry] of this.#nonces) {
			if (expiry < now) {
				this.#nonces.delete(nonce);
			}
		}
		if (this.#nonces.has(signed.nonce)) {
			throw(new KeetaAnchorUserError('This request was already submitted'));
		}

		this.#nonces.set(signed.nonce, now + NONCE_WINDOW_MS);
	}

	/** Whether every account in the staple ends at the expected block. */
	async #landed(expectedHeads: { account: string; hash: string; }[]): Promise<boolean> {
		const reader = new KeetaNetChainReader(this.#client.client);
		for (const { account, hash } of expectedHeads) {
			if (await reader.head(account) !== hash.toLowerCase()) {
				return(false);
			}
		}

		return(true);
	}

	/** Finish a call a crash left between publishing and committing. */
	async #recover(): Promise<void> {
		const pending = await this.state.pending();
		if (pending === null) {
			return;
		}

		// A staple voted on but never published holds the sequencer's chain.
		if (await this.#client.client.getPendingBlock(this.sequencer) !== null) {
			await this.#client.client.recoverAccount(this.sequencer, true, this.#publishOptions());
		}

		if (await this.#landed(pending.expectedHeads)) {
			await this.state.commit(pending.id);
		} else {
			await this.state.discard(pending.id);
		}
	}

	#publishOptions(): Parameters<KeetaNet.Client['transmit']>[1] {
		const options: Parameters<KeetaNet.Client['transmit']>[1] = {};
		if (this.#client.config.generateFeeBlock !== undefined) {
			options.generateFeeBlock = this.#client.config.generateFeeBlock;
		}

		return(options);
	}

	/** Sign the sequencer's blocks and turn the staple into KeetaNet blocks. */
	async #sign(binding: ContractEngineBinding, blocks: ContractStapleBlock[]): Promise<InstanceType<typeof KeetaNet.lib.Block>[]> {
		const signed = [];
		for (const block of blocks) {
			const bytes = Buffer.from(block.bytes, 'base64');
			if (block.signed) {
				signed.push(new KeetaNet.lib.Block(bytes));
				continue;
			}

			if (block.signers.length !== 1 || block.signers[0] !== this.#sequencerAddress) {
				throw(new Error(`The engine produced a block for ${block.account} that the sequencer cannot sign`));
			}

			const hash = Buffer.from(block.hash, 'hex');
			const signature = await this.sequencer.sign(hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength));
			signed.push(new KeetaNet.lib.Block(binding.sealBlock(bytes, [signature.getBuffer()])));
		}

		return(signed);
	}

	/** Execute, publish and commit one state-changing call. */
	async #call(sender: string, options: { fundingBlock?: string | undefined; gasLimit?: string | undefined; }, run: (engine: ContractEngineInstance, call: string) => Promise<string>): Promise<KeetaContractsAnchorCallResult> {
		return(await this.#serial(async () => {
			await this.#recover();
			const { binding, engine } = await this.#engine();
			const height = await this.state.height() + 1n;
			const call: ContractCall = {
				sender,
				height: height.toString(),
				timeMillis: Date.now(),
				...(options.fundingBlock !== undefined ? { fundingBlock: options.fundingBlock } : {}),
				...(options.gasLimit !== undefined ? { gasLimit: options.gasLimit } : {})
			};

			let execution: ContractExecution;
			try {
				execution = unwrapOutcome<ContractExecution>(await run(engine, JSON.stringify(call)));
			} catch (error) {
				if (error instanceof ContractEngineCallError && error.kind !== 'host') {
					throw(new Errors.CallFailed({ kind: error.kind }, error.message));
				}
				throw(error);
			}

			const blocks = await this.#sign(binding, execution.blocks);
			const id = randomUUID();
			const expectedHeads = lastHeads(execution.blocks);
			await this.state.stage({ id, height: height.toString(), changes: execution.changes, expectedHeads });

			let published = blocks.length === 0;
			if (!published) {
				try {
					published = (await this.#client.client.transmit(blocks, this.#publishOptions())).publish;
				} catch (error) {
					// The staple may have landed even though the reply was lost.
					if (!await this.#landed(expectedHeads)) {
						await this.state.discard(id);
						throw(error);
					}
					published = true;
				}
			}
			if (!published) {
				await this.state.discard(id);
				throw(new KeetaAnchorUserError('The network did not accept the call'));
			}

			await this.state.commit(id);
			return({
				contract: execution.contract,
				data: execution.data,
				events: execution.events,
				gasUsed: execution.gasUsed,
				fee: execution.fee,
				refund: execution.refund,
				blocks: execution.blocks.map((block) => block.hash),
				commitments: execution.commitments
			});
		}));
	}

	#assertSender(account: KeetaNetAccount, claimed: string): string {
		const sender = account.publicKeyString.get();
		if (sender !== claimed) {
			throw(new KeetaAnchorUserError('The signed account does not match the request'));
		}

		return(sender);
	}

	protected async initRoutes(config: KeetaAnchorContractsServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = {
			...(await super.initRoutes(config)),
			...this.routes
		};
		const chain = this.resolvedCertificateChainRequirement;

		routes['POST /api/upload'] = {
			bodyType: 'parsed',
			// Base64 plus the envelope
			maxBodySize: Math.ceil(this.#maxWasmSize * 4 / 3) + 64 * 1024,
			handler: async (_params, body) => {
				const raw = assertKeetaContractsAnchorUploadRequestJSON(body);
				const account = await verifyBodyAuth(raw, getContractUploadSignable, chain);
				this.#claimNonce(raw.signed);
				const wasm = Buffer.from(raw.wasm, 'base64');
				if (wasm.length > this.#maxWasmSize) {
					throw(new KeetaAnchorUserError(`Code is larger than ${this.#maxWasmSize} bytes`));
				}

				const { engine } = await this.#engine();
				let stored: ContractStoredCode;
				try {
					stored = unwrapOutcome<ContractStoredCode>(await engine.storeCode(wasm));
				} catch (error) {
					if (error instanceof ContractEngineCallError) {
						throw(new Errors.CallFailed({ kind: error.kind }, error.message));
					}
					throw(error);
				}
				const codeId = await this.state.addCode(stored.checksum, account.publicKeyString.get(), wasm);
				return(json({ ok: true, codeId: codeId.toString(), checksum: stored.checksum, requiredCapabilities: stored.requiredCapabilities }));
			}
		};

		routes['POST /api/instantiate'] = async (_params, body) => {
			const raw = assertKeetaContractsAnchorInstantiateRequestJSON(body);
			const account = await verifyBodyAuth(raw, getContractInstantiateSignable, chain);
			this.#claimNonce(raw.signed);
			const sender = this.#assertSender(account, raw.account);
			const result = await this.#call(sender, raw, async (engine, call) => {
				return(await engine.instantiate(call, raw.codeId, raw.msg, raw.label, raw.admin ?? null));
			});
			return(json({ ok: true, ...result }));
		};

		routes['POST /api/execute'] = async (_params, body) => {
			const raw = assertKeetaContractsAnchorExecuteRequestJSON(body);
			const account = await verifyBodyAuth(raw, getContractExecuteSignable, chain);
			this.#claimNonce(raw.signed);
			const sender = this.#assertSender(account, raw.account);
			const result = await this.#call(sender, raw, async (engine, call) => {
				return(await engine.execute(call, raw.contract, raw.msg));
			});
			return(json({ ok: true, ...result }));
		};

		routes['POST /api/migrate'] = async (_params, body) => {
			const raw = assertKeetaContractsAnchorMigrateRequestJSON(body);
			const account = await verifyBodyAuth(raw, getContractMigrateSignable, chain);
			this.#claimNonce(raw.signed);
			const sender = this.#assertSender(account, raw.account);
			const result = await this.#call(sender, raw, async (engine, call) => {
				return(await engine.migrate(call, raw.contract, raw.newCodeId, raw.msg));
			});
			return(json({ ok: true, ...result }));
		};

		routes['POST /api/query'] = async (_params, body) => {
			const raw = assertKeetaContractsAnchorQueryRequestJSON(body);
			const { engine } = await this.#engine();
			const block = JSON.stringify({ height: (await this.state.height()).toString(), timeMillis: Date.now() });
			try {
				const result = unwrapOutcome<string>(await engine.query(block, raw.contract, raw.msg));
				return(json({ ok: true, result }));
			} catch (error) {
				if (error instanceof ContractEngineCallError) {
					throw(new Errors.CallFailed({ kind: error.kind }, error.message));
				}
				throw(error);
			}
		};

		routes['GET /api/contract/:address'] = async (params) => {
			const address = params.get('address');
			const contract = address ? await this.state.contract(address) : null;
			if (contract === null) {
				throw(new Errors.CallFailed({ kind: 'unknownContract' }, `No contract at ${address ?? ''}`));
			}

			return(json({ ok: true, contract }));
		};

		routes['POST /api/prove'] = async (_params, body) => {
			const raw = assertKeetaContractsAnchorProveRequestJSON(body);
			const { engine } = await this.#engine();
			try {
				const proof = unwrapOutcome<ContractStorageProof>(await engine.prove(raw.contract, Buffer.from(raw.key, 'base64')));
				return(json({ ok: true, proof }));
			} catch (error) {
				if (error instanceof ContractEngineCallError) {
					throw(new Errors.CallFailed({ kind: error.kind }, error.message));
				}
				throw(error);
			}
		};

		routes['POST /api/simulate'] = async (_params, body) => {
			const raw = assertKeetaContractsAnchorSimulateRequestJSON(body);
			const { simulator } = await this.#engine();
			const call = JSON.stringify({
				sender: raw.account,
				height: ((await this.state.height()) + 1n).toString(),
				timeMillis: Date.now(),
				funds: raw.funds ?? [],
				...(raw.gasLimit !== undefined ? { gasLimit: raw.gasLimit } : {})
			});

			let execution: ContractExecution;
			try {
				const outcome = raw.kind === 'instantiate'
					? await simulator.instantiate(call, raw.codeId, raw.msg, raw.label, null)
					: await simulator.execute(call, raw.contract, raw.msg);
				execution = unwrapOutcome<ContractExecution>(outcome);
			} catch (error) {
				if (error instanceof ContractEngineCallError) {
					throw(new Errors.CallFailed({ kind: error.kind }, error.message));
				}
				throw(error);
			}

			const price = this.#config.gasPrice;
			const gasUsed = BigInt(execution.gasUsed);
			const fee = price === undefined ? 0n : (gasUsed * price.numerator + price.denominator - 1n) / price.denominator;
			return(json({ ok: true, gasUsed: execution.gasUsed, fee: fee.toString(), events: execution.events, data: execution.data }));
		};

		return(routes);
	}

	protected async buildServiceMetadata(): Promise<ContractsServiceMetadata> {
		const acceptedIssuerDNs = this.acceptedIssuerDNs();
		const authentication: ServiceMetadataAuthenticationType = { method: 'keeta-account', type: 'required' };
		const url = (path: string) => (new URL(path, this.url)).toString();
		const gasPrice = this.#gasPrice;

		return({
			sequencer: this.#sequencerAddress,
			...(gasPrice !== undefined ? { gasPrice } : {}),
			operations: {
				upload: { url: url('/api/upload'), options: { authentication }},
				instantiate: { url: url('/api/instantiate'), options: { authentication }},
				execute: { url: url('/api/execute'), options: { authentication }},
				migrate: { url: url('/api/migrate'), options: { authentication }},
				query: url('/api/query'),
				contract: url('/api/contract') + '/{address}',
				prove: url('/api/prove'),
				simulate: url('/api/simulate')
			},
			...(acceptedIssuerDNs !== undefined && { acceptedIssuerDNs })
		});
	}
}
