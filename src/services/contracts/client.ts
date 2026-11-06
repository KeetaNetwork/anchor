/**
 * Client for contract sequencers: finds them through the resolver, builds
 * and signs the caller's funding block, and calls them.
 */
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';
import { getDefaultResolver } from '../../config.js';
import type { Logger } from '../../lib/log/index.ts';
import Resolver from '../../lib/resolver.js';
import type { ServiceMetadata, SharedLookupCriteria } from '../../lib/resolver.ts';
import { KeetaAnchorError } from '../../lib/error.js';
import { SignData } from '../../lib/utils/signing.js';
import type { Signable } from '../../lib/utils/signing.js';
import type { ContractRecord, ContractStorageProof } from './engine.js';
import type { KeetaContractsAnchorCallResult } from './common.js';
import {
	getContractExecuteSignable,
	getContractInstantiateSignable,
	getContractMigrateSignable,
	getContractUploadSignable,
	isKeetaContractsAnchorCallResponseJSON,
	isKeetaContractsAnchorContractResponseJSON,
	isKeetaContractsAnchorProveResponseJSON,
	isKeetaContractsAnchorQueryResponseJSON,
	isKeetaContractsAnchorSimulateResponseJSON,
	isKeetaContractsAnchorUploadResponseJSON
} from './common.js';
import { Buffer } from '../../lib/utils/buffer.js';

type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
type ContractsServiceMetadata = NonNullable<ServiceMetadata['services']['contracts']>[string];
type Operation = keyof ContractsServiceMetadata['operations'];

export type KeetaContractsAnchorClientConfig = {
	id?: string;
	logger?: Logger | undefined;
	resolver?: Resolver;
	/** Signs requests and funding blocks; defaults to the user client's account */
	account?: KeetaNetAccount;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

/** Tokens to attach to a call. */
export interface KeetaContractsAnchorFund {
	token: KeetaNetAccount | string;
	amount: bigint;
}

interface CallInput {
	funds?: KeetaContractsAnchorFund[];
	/**
	 * Fee to prepay, in the sequencer's gas price token; unused gas is
	 * refunded. Estimated (with a 20% margin) when omitted.
	 */
	fee?: bigint;
	gasLimit?: bigint;
}

export interface KeetaContractsAnchorInstantiateInput extends CallInput {
	codeId: bigint;
	msg: unknown;
	label: string;
	admin?: KeetaNetAccount | string;
}

export interface KeetaContractsAnchorExecuteInput extends CallInput {
	contract: KeetaNetAccount | string;
	msg: unknown;
}

export interface KeetaContractsAnchorMigrateInput extends Omit<CallInput, 'funds'> {
	contract: KeetaNetAccount | string;
	newCodeId: bigint;
	msg: unknown;
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
	readonly gasPrice: { token: string; numerator: bigint; denominator: bigint; } | undefined;
	readonly #operations: { [name in Operation]?: string; };
	readonly #parent: KeetaContractsAnchorClient;

	constructor(providerID: string, info: { sequencer: string; gasPrice?: { token: string; numerator: string; denominator: string; } | undefined; operations: { [name in Operation]?: string; }; }, parent: KeetaContractsAnchorClient) {
		this.providerID = providerID;
		this.sequencer = info.sequencer;
		this.gasPrice = info.gasPrice === undefined ? undefined : {
			token: info.gasPrice.token,
			numerator: BigInt(info.gasPrice.numerator),
			denominator: BigInt(info.gasPrice.denominator)
		};
		this.#operations = info.operations;
		this.#parent = parent;
	}

	#url(operation: Operation, params: { [key: string]: string; } = {}): string {
		let url = this.#operations[operation];
		if (url === undefined) {
			throw(new Error(`Contract sequencer ${this.providerID} does not support ${operation}`));
		}
		for (const [key, value] of Object.entries(params)) {
			url = url.replace(`{${key}}`, encodeURIComponent(value));
		}

		return(url);
	}

	async #request<T extends { ok: boolean; }>(operation: Operation, body: unknown, check: (input: unknown) => input is T, params?: { [key: string]: string; }): Promise<Extract<T, { ok: true; }>> {
		const response = await fetch(this.#url(operation, params), body === undefined ? {
			headers: { 'Accept': 'application/json' }
		} : {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify(body)
		});

		let data: unknown;
		try {
			data = await response.json();
		} catch (error) {
			throw(new Error(`Contract sequencer ${operation} returned invalid JSON: ${String(error)}`));
		}

		if (typeof data === 'object' && data !== null && 'ok' in data && data.ok === false) {
			let error: Error;
			try {
				error = await KeetaAnchorError.fromJSON(data);
			} catch {
				error = new Error('error' in data && typeof data.error === 'string' ? data.error : `Contract sequencer ${operation} failed`);
			}
			throw(error);
		}

		if (!check(data)) {
			throw(new Error(`Contract sequencer ${operation} returned an unexpected response`));
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(data as Extract<T, { ok: true; }>);
	}

	async #signed(signable: Signable): Promise<{ account: string; signed: Awaited<ReturnType<typeof SignData>>; }> {
		const account = this.#parent.account;
		return({ account: account.publicKeyString.get(), signed: await SignData(account.assertAccount(), signable) });
	}

	/** Upload Wasm code. Returns its code id. */
	async upload(wasm: Uint8Array): Promise<{ codeId: bigint; checksum: string; requiredCapabilities: string[]; }> {
		const encoded = Buffer.from(wasm).toString('base64');
		const auth = await this.#signed(getContractUploadSignable({ wasm: encoded }));
		const response = await this.#request('upload', { ...auth, wasm: encoded }, isKeetaContractsAnchorUploadResponseJSON);
		return({ codeId: BigInt(response.codeId), checksum: response.checksum, requiredCapabilities: response.requiredCapabilities });
	}

	/**
	 * The address the next contract created by this sequencer will get, so a
	 * caller can fund an instantiation. Only valid until the sequencer
	 * publishes something else.
	 */
	async nextContractAddress(): Promise<string> {
		const head = await this.#parent.client.client.getHeadBlock(this.sequencer);
		const sequencer = KeetaNetLib.Account.fromPublicKeyString(this.sequencer);
		return(sequencer.generateIdentifier(KeetaNetLib.Account.AccountKeyAlgorithm.STORAGE, head?.hash, 0).publicKeyString.get());
	}

	/** Dry-run a call: the gas it uses and the fee that costs. */
	async simulate(input: ({ kind: 'instantiate'; codeId: bigint; msg: unknown; label: string; } | { kind: 'execute'; contract: KeetaNetAccount | string; msg: unknown; }) & { funds?: KeetaContractsAnchorFund[]; gasLimit?: bigint; }): Promise<{ gasUsed: bigint; fee: bigint; }> {
		const common = {
			account: this.#parent.account.publicKeyString.get(),
			msg: JSON.stringify(input.msg),
			...(input.funds !== undefined ? { funds: input.funds.map((fund) => ({ token: address(fund.token), amount: fund.amount.toString() })) } : {}),
			...(input.gasLimit !== undefined ? { gasLimit: input.gasLimit.toString() } : {})
		};
		const body = input.kind === 'instantiate'
			? { ...common, kind: input.kind, codeId: input.codeId.toString(), label: input.label }
			: { ...common, kind: input.kind, contract: address(input.contract) };
		const response = await this.#request('simulate', body, isKeetaContractsAnchorSimulateResponseJSON);
		return({ gasUsed: BigInt(response.gasUsed), fee: BigInt(response.fee) });
	}

	/** The caller's signed block moving `funds` to `contract` and `fee` to the sequencer. */
	async #fundingBlock(contract: string, funds: KeetaContractsAnchorFund[], fee: bigint): Promise<string | undefined> {
		if (funds.length === 0 && fee === 0n) {
			return(undefined);
		}

		const builder = this.#parent.client.initBuilder({ account: this.#parent.account });
		for (const fund of funds) {
			builder.send(toAccount(contract), fund.amount, toAccount(fund.token).assertKeyType(KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN));
		}
		if (fee > 0n) {
			if (this.gasPrice === undefined) {
				throw(new Error('This sequencer charges no fee'));
			}
			builder.send(toAccount(this.sequencer), fee, toAccount(this.gasPrice.token).assertKeyType(KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN));
		}

		const { blocks } = await builder.computeBlocks();
		const [block] = blocks;
		if (block === undefined || blocks.length !== 1) {
			throw(new Error(`Expected one funding block, got ${blocks.length}`));
		}

		return(Buffer.from(block.toBytes()).toString('base64'));
	}

	async #fee(input: CallInput, simulate: () => Promise<{ fee: bigint; }>): Promise<bigint> {
		if (input.fee !== undefined) {
			return(input.fee);
		}
		if (this.gasPrice === undefined) {
			return(0n);
		}

		const { fee } = await simulate();
		return(fee + fee / 5n + 1n);
	}

	#parse(response: KeetaContractsAnchorCallResult): KeetaContractsAnchorCallResult {
		return(response);
	}

	/** Create a contract from uploaded code. */
	async instantiate(input: KeetaContractsAnchorInstantiateInput): Promise<KeetaContractsAnchorCallResult> {
		const funds = input.funds ?? [];
		const fee = await this.#fee(input, async () => await this.simulate({ kind: 'instantiate', codeId: input.codeId, msg: input.msg, label: input.label, funds }));
		const contract = funds.length > 0 ? await this.nextContractAddress() : this.sequencer;
		const fundingBlock = await this.#fundingBlock(contract, funds, fee);
		const request = {
			codeId: input.codeId.toString(),
			msg: JSON.stringify(input.msg),
			label: input.label,
			...(input.admin !== undefined ? { admin: address(input.admin) } : {}),
			...(fundingBlock !== undefined ? { fundingBlock } : {}),
			...(input.gasLimit !== undefined ? { gasLimit: input.gasLimit.toString() } : {})
		};
		const auth = await this.#signed(getContractInstantiateSignable(request));
		return(this.#parse(await this.#request('instantiate', { ...request, ...auth }, isKeetaContractsAnchorCallResponseJSON)));
	}

	/** Call a contract's `execute`. */
	async execute(input: KeetaContractsAnchorExecuteInput): Promise<KeetaContractsAnchorCallResult> {
		const contract = address(input.contract);
		const funds = input.funds ?? [];
		const fee = await this.#fee(input, async () => await this.simulate({ kind: 'execute', contract, msg: input.msg, funds }));
		const fundingBlock = await this.#fundingBlock(contract, funds, fee);
		const request = {
			contract,
			msg: JSON.stringify(input.msg),
			...(fundingBlock !== undefined ? { fundingBlock } : {}),
			...(input.gasLimit !== undefined ? { gasLimit: input.gasLimit.toString() } : {})
		};
		const auth = await this.#signed(getContractExecuteSignable(request));
		return(this.#parse(await this.#request('execute', { ...request, ...auth }, isKeetaContractsAnchorCallResponseJSON)));
	}

	/** Move a contract to new code (admin only). */
	async migrate(input: KeetaContractsAnchorMigrateInput): Promise<KeetaContractsAnchorCallResult> {
		const contract = address(input.contract);
		const fee = input.fee ?? (this.gasPrice === undefined ? 0n : undefined);
		if (fee === undefined) {
			throw(new Error('Pass a fee for migrations on a sequencer that charges for gas'));
		}
		const fundingBlock = await this.#fundingBlock(contract, [], fee);
		const request = {
			contract,
			newCodeId: input.newCodeId.toString(),
			msg: JSON.stringify(input.msg),
			...(fundingBlock !== undefined ? { fundingBlock } : {}),
			...(input.gasLimit !== undefined ? { gasLimit: input.gasLimit.toString() } : {})
		};
		const auth = await this.#signed(getContractMigrateSignable(request));
		return(this.#parse(await this.#request('migrate', { ...request, ...auth }, isKeetaContractsAnchorCallResponseJSON)));
	}

	/** Call a contract's `query`; returns its parsed JSON response. */
	async query(contract: KeetaNetAccount | string, msg: unknown): Promise<unknown> {
		const response = await this.#request('query', { contract: address(contract), msg: JSON.stringify(msg) }, isKeetaContractsAnchorQueryResponseJSON);
		const parsed: unknown = JSON.parse(Buffer.from(response.result, 'base64').toString('utf-8'));
		return(parsed);
	}

	/** The sequencer's record of a contract. */
	async getContract(contract: KeetaNetAccount | string): Promise<ContractRecord> {
		const response = await this.#request('contract', undefined, isKeetaContractsAnchorContractResponseJSON, { address: address(contract) });
		return(response.contract);
	}

	/** A storage value with a proof against the contract's committed state root. */
	async prove(contract: KeetaNetAccount | string, key: Uint8Array): Promise<ContractStorageProof> {
		const response = await this.#request('prove', { contract: address(contract), key: Buffer.from(key).toString('base64') }, isKeetaContractsAnchorProveResponseJSON);
		return(response.proof);
	}
}

/** Finds contract sequencers through the resolver. */
export class KeetaContractsAnchorClient {
	readonly client: KeetaNetUserClient;
	readonly resolver: Resolver;
	readonly id: string;
	readonly logger?: Logger | undefined;
	readonly account: KeetaNetAccount;

	constructor(client: KeetaNetUserClient, config: KeetaContractsAnchorClientConfig = {}) {
		this.client = client;
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
		this.logger = config.logger;
		this.account = config.account ?? client.account;
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

				const gasPrice = 'gasPrice' in info && typeof info.gasPrice === 'object' && info.gasPrice !== null && 'token' in info.gasPrice && 'numerator' in info.gasPrice && 'denominator' in info.gasPrice && typeof info.gasPrice.token === 'string' && typeof info.gasPrice.numerator === 'string' && typeof info.gasPrice.denominator === 'string'
					? { token: info.gasPrice.token, numerator: info.gasPrice.numerator, denominator: info.gasPrice.denominator }
					: undefined;

				return(new KeetaContractsAnchorProvider(id, { sequencer: info.sequencer, gasPrice, operations }, this));
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
