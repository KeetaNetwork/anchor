/**
 * Shared setup for the contract sequencer tests: a test node, a sequencer
 * on it registered with the resolver, and the native engine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import Resolver from '../../lib/resolver.js';
import { KeetaNetContractsAnchorHTTPServer } from './server.js';
import KeetaContractsAnchorClient from './client.js';
import type { KeetaContractsAnchorProvider } from './client.js';
import { MemoryContractStateBackend } from './state.js';
import type { ContractEngineBinding } from './engine.js';
import { loadContractEngine } from './engine.js';
import type { Buffer } from '../../lib/utils/buffer.js';

/*
 * These tests need the native engine (`@keetanetwork/contract-engine`) and
 * the example contracts from node-rs. Point KEETA_CONTRACTS_WASM_DIR at the
 * compiled contracts if node-rs is not checked out next to this repository.
 */
const wasmDir = process.env['KEETA_CONTRACTS_WASM_DIR'] ?? join(import.meta.dirname, '../../../../node-rs/keetanetwork-contract-engine/tests/contracts/target/wasm32-unknown-unknown/release');
let binding: ContractEngineBinding | null = null;
try {
	binding = await loadContractEngine();
} catch {
	binding = null;
}
export const available: boolean = binding !== null && existsSync(join(wasmDir, 'cw20_token.wasm'));

/** A test that needs the native engine and the example contracts; skipped without them. */
export function contractTest(name: string, body: () => Promise<void>, timeout?: number): void {
	(available ? test : test.skip)(name, body, timeout);
}

const DEBUG = process.env['DEBUG_CONTRACTS'] === '1';
export const logger: Console | undefined = DEBUG ? console : undefined;
export type Account = InstanceType<typeof KeetaNet.lib.Account>;
/** An account with its own key, able to sign. */
export type KeyPairAccount = NonNullable<ConstructorParameters<typeof KeetaNet.UserClient>[0]['signer']>;

export function newAccount(): KeyPairAccount {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

export function wasm(name: string): Buffer {
	return(readFileSync(join(wasmDir, `${name}.wasm`)));
}

export function engine(): ContractEngineBinding {
	if (binding === null) {
		throw(new Error('engine not loaded'));
	}

	return(binding);
}

/** A test node with a sequencer on it, registered with the resolver. */
export interface ContractsTestWorld {
	sequencer: KeyPairAccount;
	client: InstanceType<typeof KeetaNet.UserClient>;
	state: MemoryContractStateBackend;
	server: KeetaNetContractsAnchorHTTPServer;
	/** The sequencer as `account` sees it through the resolver */
	providerFor(account: KeyPairAccount): Promise<KeetaContractsAnchorProvider>;
	give(account: Account, amount: bigint): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

export async function setup(options: { gasPrice?: { numerator: bigint; denominator: bigint; }; } = {}): Promise<ContractsTestWorld> {
	const sequencer = newAccount();
	const nodeAndClient = await createNodeAndClient(sequencer);
	nodeAndClient.fees.disable();
	const client = nodeAndClient.userClient;
	const state = new MemoryContractStateBackend();
	const server = new KeetaNetContractsAnchorHTTPServer({
		logger,
		sequencer,
		client,
		state,
		engine: engine(),
		...(options.gasPrice !== undefined ? { gasPrice: options.gasPrice } : {})
	});
	await server.start();

	const providerID = 'test-sequencer';
	await client.setInfo({
		name: '',
		description: '',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: { contracts: { [providerID]: await server.serviceMetadata() }}
		})
	});

	async function providerFor(account: KeyPairAccount): Promise<KeetaContractsAnchorProvider> {
		const userClient = new KeetaNet.UserClient({
			client: client.client,
			signer: account,
			usePublishAid: false,
			network: client.network,
			networkAlias: 'test'
		});
		const provider = await new KeetaContractsAnchorClient(userClient, { root: sequencer, account, logger }).getProvider(providerID);
		if (provider === null) {
			throw(new Error('sequencer not found through the resolver'));
		}

		return(provider);
	}

	return({
		sequencer,
		client,
		state,
		server,
		providerFor,
		give: nodeAndClient.give,
		async [Symbol.asyncDispose]() {
			await server[Symbol.asyncDispose]();
			await nodeAndClient[Symbol.asyncDispose]();
		}
	});
}

export async function onChainInfo(client: InstanceType<typeof KeetaNet.UserClient>, account: string): Promise<{ metadata: string; name: string; }> {
	const info = (await client.client.getAccountsInfo([account]))[account]?.info;
	const metadata = info !== undefined && 'metadata' in info && typeof info.metadata === 'string' ? info.metadata : '';
	const name = info !== undefined && 'name' in info && typeof info.name === 'string' ? info.name : '';
	return({ metadata, name });
}
