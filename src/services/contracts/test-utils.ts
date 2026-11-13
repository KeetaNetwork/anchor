/**
 * Shared setup for the contract sequencer tests: a test node (a
 * representative that runs contracts), a sequencer registered with the
 * resolver, and encoders for the example contracts.
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
import type { ContractInstruction } from './common.js';
import { contractAddress, stateId } from './common.js';
import { Buffer } from '../../lib/utils/buffer.js';

/*
 * These tests need a KeetaNet node that runs contracts (the node's
 * `feat/contract-execution` branch, with the contract engine addon linked
 * into it) and the example contracts from node-rs, built with
 * `cargo build-sbf --arch v3`. Point KEETA_CONTRACTS_SBF_DIR at the
 * compiled contracts if node-rs is not checked out next to this repository.
 */
const programDir = process.env['KEETA_CONTRACTS_SBF_DIR'] ?? join(import.meta.dirname, '../../../../node-rs/keetanetwork-contract-engine/tests/contracts/target/deploy');
const nodeRunsContracts = 'Contract' in KeetaNet.lib;
export const available: boolean = nodeRunsContracts && existsSync(join(programDir, 'keeta_probe.so')) && existsSync(join(programDir, 'keeta_escrow.so'));

/** A test that needs a node running contracts and the example contracts; skipped without them. */
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

/** An example contract's ELF file, e.g. `program('keeta_probe')`. */
export function program(name: string): Buffer {
	return(readFileSync(join(programDir, `${name}.so`)));
}

/** borsh: a `u32` length, then the bytes. */
function borshBytes(bytes: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32LE(bytes.length);
	return(Buffer.concat([length, bytes]));
}

function borshString(text: string): Buffer {
	return(borshBytes(Buffer.from(text, 'utf-8')));
}

function address(account: Account | string): Buffer {
	return(contractAddress(typeof account === 'string' ? KeetaNet.lib.Account.fromPublicKeyString(account) : account));
}

/** The keeta-probe contract's instructions, borsh-encoded (see node-rs tests/contracts/keeta-probe). */
export const probe = {
	increment: (index: number): Buffer => Buffer.from([0, index]),
	/** Invoke `target`, passing on accounts (index, writable), then report account `report`'s data */
	invoke: (target: Account | string, accounts: [number, boolean][], data: Buffer, report?: number): Buffer => {
		const count = Buffer.alloc(4);
		count.writeUInt32LE(accounts.length);
		return(Buffer.concat([
			Buffer.from([4]),
			address(target),
			count,
			...accounts.map(([index, writable]) => Buffer.from([index, writable ? 1 : 0])),
			borshBytes(data),
			report === undefined ? Buffer.from([0]) : Buffer.from([1, report])
		]));
	},
	fail: (message: string): Buffer => Buffer.concat([Buffer.from([8]), borshString(message)])
};

/** The keeta-escrow contract's instructions (see node-rs tests/contracts/keeta-escrow). */
export const escrow = {
	open: (arbiter: Account | string, recipient: Account | string, expiresAtMillis: bigint): Buffer => {
		const expires = Buffer.alloc(8);
		expires.writeBigInt64LE(expiresAtMillis);
		return(Buffer.concat([Buffer.from([0]), address(arbiter), address(recipient), expires]));
	},
	approve: (memo: string): Buffer => Buffer.concat([Buffer.from([2, 1]), borshString(memo)])
};

/** An instruction for `contract`, over accounts named by `state_id([name])`, of `contract` unless an owner is given. */
export function instruction(contract: string, accounts: { name: string; writable: boolean; owner?: string; }[], data: Buffer): ContractInstruction {
	return({
		contract,
		accounts: accounts.map((account) => ({ owner: account.owner ?? contract, id: stateId(account.name).toString('hex'), writable: account.writable })),
		data: data.toString('base64')
	});
}

/** A test node with a sequencer on it, registered with the resolver. */
export interface ContractsTestWorld {
	sequencer: KeyPairAccount;
	client: InstanceType<typeof KeetaNet.UserClient>;
	server: KeetaNetContractsAnchorHTTPServer;
	/** The contracts client for `account`, and the sequencer as it sees it through the resolver */
	as(account: KeyPairAccount): Promise<{ contracts: KeetaContractsAnchorClient; provider: KeetaContractsAnchorProvider; }>;
	give(account: Account, amount: bigint): Promise<void>;
	balance(account: Account | string): Promise<bigint>;
	/** The representative's vote fees: off unless a test turns them on */
	fees: { enable(): void; disable(): void; };
	[Symbol.asyncDispose](): Promise<void>;
}

export async function setup(options: { batchWindowMs?: number; fee?: { perCall: bigint; perGas: bigint; }; } = {}): Promise<ContractsTestWorld> {
	const sequencer = newAccount();
	const nodeAndClient = await createNodeAndClient(sequencer);
	nodeAndClient.fees.disable();
	const client = nodeAndClient.userClient;
	const server = new KeetaNetContractsAnchorHTTPServer({
		logger,
		sequencer,
		client,
		...(options.batchWindowMs !== undefined ? { batchWindowMs: options.batchWindowMs } : {}),
		...(options.fee !== undefined ? { fee: options.fee } : {})
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

	async function as(account: KeyPairAccount): Promise<{ contracts: KeetaContractsAnchorClient; provider: KeetaContractsAnchorProvider; }> {
		const userClient = new KeetaNet.UserClient({
			client: client.client,
			signer: account,
			usePublishAid: false,
			network: client.network,
			networkAlias: 'test'
		});
		const contracts = new KeetaContractsAnchorClient(userClient, { root: sequencer, account, logger });
		const provider = await contracts.getProvider(providerID);
		if (provider === null) {
			throw(new Error('sequencer not found through the resolver'));
		}

		return({ contracts, provider });
	}

	return({
		sequencer,
		client,
		server,
		as,
		give: nodeAndClient.give,
		fees: nodeAndClient.fees,
		balance: async (account) => await client.client.getBalance(account, client.baseToken),
		async [Symbol.asyncDispose]() {
			await server[Symbol.asyncDispose]();
			await nodeAndClient[Symbol.asyncDispose]();
		}
	});
}
