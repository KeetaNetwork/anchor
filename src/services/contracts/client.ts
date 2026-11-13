/**
 * Client for contracts on Keeta: deploys contracts, builds and signs blocks
 * calling them, submits those to a sequencer (found through the resolver)
 * for ordering, and reads contract state from the network.
 *
 * Representatives run the calls; the sequencer only orders them.
 */
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';
import { getDefaultResolver } from '../../config.js';
import type { Logger } from '../../lib/log/index.ts';
import Resolver from '../../lib/resolver.js';
import type { ServiceMetadata, SharedLookupCriteria } from '../../lib/resolver.ts';
import { KeetaAnchorError } from '../../lib/error.js';
import type { ContractInstruction, Hex, KeetaContractsAnchorCallOutcome, KeetaContractsAnchorSubmitResult } from './common.js';
import { Errors, feeFor, isKeetaContractsAnchorSubmitResponseJSON } from './common.js';
import { Buffer } from '../../lib/utils/buffer.js';
import type { BlockJSONOperations } from '@keetanetwork/keetanet-client/lib/block/operations.js';

type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
type KeetaNetBlock = InstanceType<typeof KeetaNetLib.Block>;
/** A block's previous: the head's hash, or none for an account's first block */
type Previous = KeetaNetBlock['hash'] | typeof KeetaNetLib.Block.NO_PREVIOUS;
type ContractsServiceMetadata = NonNullable<ServiceMetadata['services']['contracts']>[string];
type Operation = keyof ContractsServiceMetadata['operations'];

const OperationType = KeetaNetLib.Block.OperationType;

/** Gas a call may use unless told otherwise. */
export const DEFAULT_GAS_LIMIT = 1_400_000n;

export type KeetaContractsAnchorClientConfig = {
	id?: string;
	logger?: Logger | undefined;
	resolver?: Resolver;
	/** Signs blocks; defaults to the user client's account */
	account?: KeetaNetAccount;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

/** Tokens to send to the called contract, in the same block, before the call. */
export interface KeetaContractsAnchorFund {
	token: KeetaNetAccount | string;
	amount: bigint;
}

export interface KeetaContractsAnchorCallInput {
	instruction: ContractInstruction;
	/** The call's funds: the contract sees them as sent with the call */
	funds?: KeetaContractsAnchorFund[];
	gasLimit?: bigint;
	/** The sequencer's fee for ordering the call, sent to it in the same block (`KeetaContractsAnchorProvider.call` adds it) */
	fee?: { sequencer: KeetaNetAccount | string; token: KeetaNetAccount | string; amount: bigint; };
}

/** What a call did: the representatives' outcome, decoded. */
export interface KeetaContractsAnchorCallResult {
	/** Hashes of the published staple's blocks, in order */
	blocks: Hex[];
	/** The block carrying the call */
	block: Hex;
	gasUsed: bigint;
	returnData: Buffer;
	writes: { owner: string; id: Hex; version: bigint; }[];
}

export interface KeetaContractsAnchorDeployInput {
	/** An sBPF v3 ELF file */
	code: Uint8Array;
	/** The sequencer that will order the contract's calls; it cannot be changed later */
	sequencer: KeetaContractsAnchorProvider | KeetaNetAccount | string;
	/** Account allowed to upgrade the contract */
	admin?: KeetaNetAccount | string;
}

function address(account: KeetaNetAccount | string): string {
	return(typeof account === 'string' ? account : account.publicKeyString.get());
}

function toAccount(account: KeetaNetAccount | string): KeetaNetAccount {
	return(typeof account === 'string' ? KeetaNetLib.Account.fromPublicKeyString(account) : account);
}

/** One sequencer. */
export class KeetaContractsAnchorProvider {
	readonly providerID: string;
	readonly sequencer: string;
	/** What the sequencer charges per call; `undefined` if nothing */
	readonly fee: { token: string; perCall: bigint; perGas: bigint; } | undefined;
	readonly #operations: { [name in Operation]?: string; };
	readonly #parent: KeetaContractsAnchorClient;

	constructor(providerID: string, info: { sequencer: string; fee?: { token: string; perCall: string; perGas: string; } | undefined; operations: { [name in Operation]?: string; }; }, parent: KeetaContractsAnchorClient) {
		this.providerID = providerID;
		this.sequencer = info.sequencer;
		this.fee = info.fee === undefined ? undefined : { token: info.fee.token, perCall: BigInt(info.fee.perCall), perGas: BigInt(info.fee.perGas) };
		this.#operations = info.operations;
		this.#parent = parent;
	}

	/** The fee this sequencer charges for one call with this gas limit, and the token it is in; `undefined` if nothing. */
	feeFor(gasLimit: bigint = DEFAULT_GAS_LIMIT): { sequencer: string; token: string; amount: bigint; } | undefined {
		if (this.fee === undefined) {
			return(undefined);
		}
		return({ sequencer: this.sequencer, token: this.fee.token, amount: feeFor(this.fee, [gasLimit]) });
	}

	#url(operation: Operation): string {
		const url = this.#operations[operation];
		if (url === undefined) {
			throw(new Error(`Contract sequencer ${this.providerID} does not support ${operation}`));
		}

		return(url);
	}

	/**
	 * Submit signed blocks carrying contract calls. The sequencer orders
	 * them, and returns once the network has published them, with the
	 * outcome of their calls.
	 */
	async submit(blocks: KeetaNetBlock[]): Promise<KeetaContractsAnchorSubmitResult> {
		const response = await fetch(this.#url('submit'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ blocks: blocks.map((block) => Buffer.from(block.toBytes()).toString('base64')) })
		});

		let data: unknown;
		try {
			data = await response.json();
		} catch (error) {
			throw(new Error(`Contract sequencer submit returned invalid JSON: ${String(error)}`));
		}

		if (typeof data === 'object' && data !== null && 'ok' in data && data.ok === false) {
			let error: Error;
			try {
				error = await KeetaAnchorError.fromJSON(data);
			} catch {
				error = new Error('error' in data && typeof data.error === 'string' ? data.error : 'Contract sequencer submit failed');
			}
			throw(error);
		}

		if (!isKeetaContractsAnchorSubmitResponseJSON(data) || !data.ok) {
			throw(new Error('Contract sequencer submit returned an unexpected response'));
		}

		return({ blocks: data.blocks, calls: data.calls });
	}

	/** Call a contract: sign a block with the call (and its funds) and have it ordered. */
	async call(input: KeetaContractsAnchorCallInput): Promise<KeetaContractsAnchorCallResult> {
		return(await this.#parent.serial(async () => {
			const fee = input.fee ?? this.feeFor(input.gasLimit ?? DEFAULT_GAS_LIMIT);
			const block = await this.#parent.callBlock({ ...input, ...(fee !== undefined ? { fee } : {}) });
			const result = await this.submit([block]);
			this.#parent.published(block);
			const outcome = result.calls.find((call: KeetaContractsAnchorCallOutcome) => call.block === block.hash.toString().toLowerCase());
			if (outcome === undefined) {
				throw(new Error('The sequencer did not report the call\'s outcome'));
			}
			if (outcome.failure !== undefined) {
				throw(new Errors.CallFailed({ kind: 'reverted' }, `The contract refused the call (${outcome.failure.kind}): ${outcome.failure.message}. It still landed in block ${outcome.block} and paid its fee and gas; it changed nothing.`));
			}

			return({
				blocks: result.blocks,
				block: outcome.block,
				gasUsed: BigInt(outcome.gasUsed),
				returnData: Buffer.from(outcome.returnData, 'base64'),
				writes: outcome.writes.map((write) => ({ ...write, version: BigInt(write.version) }))
			});
		}));
	}
}

/** Contracts on Keeta, and the sequencers that order their calls. */
export class KeetaContractsAnchorClient {
	readonly client: KeetaNetUserClient;
	readonly resolver: Resolver;
	readonly id: string;
	readonly logger?: Logger | undefined;
	readonly account: KeetaNetAccount;
	/** This account's head, once it has published through this client */
	#head: InstanceType<typeof KeetaNetLib.Block>['hash'] | null = null;
	/** Blocks from this account, one at a time, each extending the last */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(client: KeetaNetUserClient, config: KeetaContractsAnchorClientConfig = {}) {
		this.client = client;
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
		this.logger = config.logger;
		this.account = config.account ?? client.account;
	}

	/** @internal Run work that publishes from this account after everything queued before it. */
	async serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(work);
		this.#queue = result.catch(() => {
			// A failed block was not published: read the head again next time.
			this.#head = null;
		});

		return(await result);
	}

	/** @internal Record a block from this account as published. */
	published(block: KeetaNetBlock): void {
		this.#head = block.hash;
	}

	async #previous(): Promise<Previous> {
		return(this.#head ?? (await this.client.client.getHeadBlock(this.account))?.hash ?? KeetaNetLib.Block.NO_PREVIOUS);
	}

	async #sign(operations: BlockJSONOperations[]): Promise<KeetaNetBlock> {
		return(await new KeetaNetLib.Block.Builder({
			account: this.account,
			signer: this.account.assertAccount(),
			previous: await this.#previous(),
			network: this.client.network,
			operations
		}).seal());
	}

	/**
	 * A block from this account calling a contract, signed but not
	 * published: its `SEND`s fund the call (and pay the sequencer's fee, if
	 * `fee` is given), and then the call itself.
	 */
	async callBlock(input: KeetaContractsAnchorCallInput): Promise<KeetaNetBlock> {
		const { instruction, fee } = input;
		const contract = toAccount(instruction.contract);
		const feeOperations: BlockJSONOperations[] = fee === undefined || fee.amount === 0n ? [] : [{
			type: OperationType.SEND,
			to: toAccount(fee.sequencer),
			token: toAccount(fee.token).assertKeyType(KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN),
			amount: fee.amount
		}];
		return(await this.#sign([
			...feeOperations,
			...(input.funds ?? []).map((fund): BlockJSONOperations => ({
				type: OperationType.SEND,
				to: contract,
				token: toAccount(fund.token).assertKeyType(KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN),
				amount: fund.amount
			})),
			{
				type: OperationType.CONTRACT_CALL,
				contract,
				accounts: instruction.accounts.map((account) => ({ owner: toAccount(account.owner), id: Buffer.from(account.id, 'hex'), writable: account.writable })),
				data: Buffer.from(instruction.data, 'base64'),
				gasLimit: input.gasLimit ?? DEFAULT_GAS_LIMIT
			}
		]));
	}

	/**
	 * Deploy a contract. No code runs: set it up with a call of its own.
	 * Deploying needs no sequencer, but names the one that will order the
	 * contract's calls.
	 */
	async deploy(input: KeetaContractsAnchorDeployInput): Promise<{ contract: string; block: Hex; }> {
		const sequencer = input.sequencer instanceof KeetaContractsAnchorProvider ? input.sequencer.sequencer : address(input.sequencer);
		return(await this.serial(async () => {
			const previous = await this.#previous();
			const contract = this.account.generateIdentifier(KeetaNetLib.Account.AccountKeyAlgorithm.STORAGE, previous, 0);
			const block = await this.#sign([{
				type: OperationType.CONTRACT_DEPLOY,
				contract,
				code: Buffer.from(input.code),
				sequencer: toAccount(sequencer),
				...(input.admin !== undefined ? { admin: toAccount(input.admin) } : {})
			}]);
			const published = await this.client.client.transmit([block], this.client.config.generateFeeBlock !== undefined ? { generateFeeBlock: this.client.config.generateFeeBlock } : {});
			if (!published.publish) {
				throw(new Error('The network did not accept the deploy'));
			}
			// When the network charges for votes, the staple ends with this account's fee block: that is its head.
			const ours = published.voteStaple.blocks.filter((entry) => entry.account.comparePublicKey(this.account));
			this.published(ours.at(-1) ?? block);

			return({ contract: contract.publicKeyString.get(), block: block.hash.toString().toLowerCase() });
		}));
	}

	/**
	 * Run a call read-only on a representative, against the state as it is
	 * now: a view, or an estimate of a call. Nothing it writes is kept, and
	 * no block is signed; the contract sees this client's account as its
	 * caller unless `caller` is given. Throws if the contract refuses.
	 */
	async simulate(input: KeetaContractsAnchorCallInput & { caller?: KeetaNetAccount | string; }): Promise<{ gasUsed: bigint; returnData: Buffer; writes: { owner: string; id: Hex; version: bigint; }[]; }> {
		const { instruction } = input;
		const result = await this.client.client.simulateContractCall(instruction.contract, {
			caller: address(input.caller ?? this.account),
			accounts: instruction.accounts,
			data: Buffer.from(instruction.data, 'base64'),
			...(input.funds === undefined ? {} : { funds: input.funds.map((fund) => ({ token: address(fund.token), amount: fund.amount })) }),
			...(input.gasLimit === undefined ? {} : { gasLimit: input.gasLimit })
		});

		return({
			gasUsed: result.gasUsed,
			returnData: Buffer.from(result.returnData),
			writes: result.writes.map((write) => ({ owner: write.owner.publicKeyString.get(), id: write.id.toString('hex'), version: write.version }))
		});
	}

	/** A deployed contract: its code hash, admin, creator and sequencer; `null` if the account is not a contract. */
	async getContract(contract: KeetaNetAccount | string): Promise<{ codeHash: Hex; admin: string | null; creator: string; sequencer: string; } | null> {
		const record = await this.client.client.getContract(address(contract));
		if (record === null) {
			return(null);
		}

		return({
			codeHash: record.codeHash,
			admin: record.admin?.publicKeyString.get() ?? null,
			creator: record.creator.publicKeyString.get(),
			sequencer: record.sequencer.publicKeyString.get()
		});
	}

	/** One of a contract's state accounts, as published: version 0 and no data if it was never written. */
	async getState(contract: KeetaNetAccount | string, id: Hex | Buffer): Promise<{ version: bigint; data: Buffer | null; }> {
		return(await this.client.client.getContractState(address(contract), id));
	}

	/** A page of a contract's existing state accounts in id order, after `startAfter`. */
	async listState(contract: KeetaNetAccount | string, options: { startAfter?: Hex | Buffer; limit?: number; } = {}): Promise<{ id: Hex; version: bigint; data: Buffer; }[]> {
		const states = await this.client.client.listContractState(address(contract), options);
		return(states.map((state) => ({ id: state.id.toString('hex'), version: state.version, data: state.data })));
	}

	/** Every sequencer the resolver knows. */
	async getProviders(shared?: SharedLookupCriteria): Promise<KeetaContractsAnchorProvider[]> {
		const services = await this.resolver.lookup('contracts', {}, shared);
		if (services === undefined) {
			return([]);
		}

		const providers = await Promise.all(Object.entries(services).map(async ([id, service]) => {
			try {
				const info = await Resolver.Metadata.fullyResolveValuizable(service);
				if (typeof info !== 'object' || info === null || !('sequencer' in info) || typeof info.sequencer !== 'string' || !('operations' in info) || typeof info.operations !== 'object' || info.operations === null) {
					return(null);
				}

				const operations: { [name in Operation]?: string; } = {};
				for (const [name, endpoint] of Object.entries(info.operations)) {
					const url: unknown = typeof endpoint === 'object' && endpoint !== null && 'url' in endpoint ? endpoint.url : endpoint;
					if (typeof url === 'string') {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						operations[name as Operation] = url;
					}
				}

				const fee = 'fee' in info && typeof info.fee === 'object' && info.fee !== null && 'token' in info.fee && 'perCall' in info.fee && 'perGas' in info.fee && typeof info.fee.token === 'string' && typeof info.fee.perCall === 'string' && typeof info.fee.perGas === 'string'
					? { token: info.fee.token, perCall: info.fee.perCall, perGas: info.fee.perGas }
					: undefined;

				return(new KeetaContractsAnchorProvider(id, { sequencer: info.sequencer, fee, operations }, this));
			} catch (error) {
				this.logger?.debug('ContractsAnchor', 'Ignoring contract sequencer', id, error);
				return(null);
			}
		}));

		return(providers.filter((provider) => provider !== null));
	}

	async getProvider(providerID: string, shared?: SharedLookupCriteria): Promise<KeetaContractsAnchorProvider | null> {
		return((await this.getProviders(shared)).find((provider) => provider.providerID === providerID) ?? null);
	}
}

export default KeetaContractsAnchorClient;
