/**
 * The sequencer's own state: stored code, contract records, contract
 * storage, the Merkle tree nodes committing to it, and contract-created
 * tokens. (Balances and everything else on chain is read from the ledger.)
 *
 * Calls run one at a time. A call's changes are staged before its staple is
 * published and committed once it has landed, so a crash in between can be
 * resolved by checking whether the staple reached the chain
 * ({@link ContractPendingCall.expectedHeads}).
 */
import type { ContractChanges, ContractCodeRecord, ContractRecord, ContractTokenRecord, Decimal, Hex } from './engine.js';
import { storageKeyHash } from './engine.js';
import { Buffer } from '../../lib/utils/buffer.js';

export interface ContractStorageBound {
	key: Buffer;
	inclusive: boolean;
}

export interface ContractPendingCall {
	id: string;
	/** Height the call executed at */
	height: Decimal;
	changes: ContractChanges;
	/**
	 * The last block of each account in the staple. The staple landed if
	 * (and only if) these are the accounts' heads.
	 */
	expectedHeads: { account: string; hash: Hex; }[];
}

export interface ContractStateBackend {
	/** Record stored code; returns its id (the existing id for known code). */
	addCode(checksum: Hex, creator: string, wasm: Buffer): Promise<bigint>;
	code(codeId: bigint): Promise<ContractCodeRecord | null>;
	wasm(checksum: Hex): Promise<Buffer | null>;
	contract(address: string): Promise<ContractRecord | null>;
	storageGet(contract: string, key: Buffer): Promise<Buffer | null>;
	/** The first record in range: smallest key for ascending, largest for descending. */
	storageNext(contract: string, lower: ContractStorageBound | null, upper: ContractStorageBound | null, order: 'ascending' | 'descending'): Promise<{ key: Buffer; value: Buffer; } | null>;
	storageByHash(contract: string, keyHash: Hex): Promise<Buffer | null>;
	treeNode(contract: string, nodeKey: Buffer): Promise<Buffer | null>;
	token(creator: string, subdenom: string): Promise<string | null>;
	tokenRecord(token: string): Promise<ContractTokenRecord | null>;
	/** Height of the last committed call (0 before the first). */
	height(): Promise<bigint>;
	/** Stage a call's changes. Only one call may be staged at a time. */
	stage(call: ContractPendingCall): Promise<void>;
	pending(): Promise<ContractPendingCall | null>;
	/** Apply the staged call's changes and its height, atomically. */
	commit(id: string): Promise<void>;
	discard(id: string): Promise<void>;
}

function compareKeys(a: Buffer, b: Buffer): number {
	return(Buffer.compare(a, b));
}

function inRange(key: Buffer, lower: ContractStorageBound | null, upper: ContractStorageBound | null): boolean {
	if (lower !== null) {
		const order = compareKeys(key, lower.key);
		if (order < 0 || (order === 0 && !lower.inclusive)) {
			return(false);
		}
	}
	if (upper !== null) {
		const order = compareKeys(key, upper.key);
		if (order > 0 || (order === 0 && !upper.inclusive)) {
			return(false);
		}
	}

	return(true);
}

/** Everything in memory: for tests and local development. */
export class MemoryContractStateBackend implements ContractStateBackend {
	readonly #codes: { record: ContractCodeRecord; wasm: Buffer; }[] = [];
	readonly #contracts = new Map<string, ContractRecord>();
	/** contract → hex key → value */
	readonly #storage = new Map<string, Map<string, Buffer>>();
	readonly #treeNodes = new Map<string, Buffer>();
	readonly #tokens = new Map<string, ContractTokenRecord>();
	#height = 0n;
	#pending: ContractPendingCall | null = null;

	#contractStorage(contract: string): Map<string, Buffer> {
		let storage = this.#storage.get(contract);
		if (storage === undefined) {
			storage = new Map();
			this.#storage.set(contract, storage);
		}

		return(storage);
	}

	async addCode(checksum: Hex, creator: string, wasm: Buffer): Promise<bigint> {
		const existing = this.#codes.findIndex((code) => code.record.checksum === checksum);
		if (existing !== -1) {
			return(BigInt(existing + 1));
		}

		this.#codes.push({ record: { checksum, creator }, wasm });
		return(BigInt(this.#codes.length));
	}

	async code(codeId: bigint): Promise<ContractCodeRecord | null> {
		return(this.#codes[Number(codeId) - 1]?.record ?? null);
	}

	async wasm(checksum: Hex): Promise<Buffer | null> {
		return(this.#codes.find((code) => code.record.checksum === checksum)?.wasm ?? null);
	}

	async contract(address: string): Promise<ContractRecord | null> {
		return(this.#contracts.get(address) ?? null);
	}

	async storageGet(contract: string, key: Buffer): Promise<Buffer | null> {
		return(this.#contractStorage(contract).get(key.toString('hex')) ?? null);
	}

	async storageNext(contract: string, lower: ContractStorageBound | null, upper: ContractStorageBound | null, order: 'ascending' | 'descending'): Promise<{ key: Buffer; value: Buffer; } | null> {
		let best: { key: Buffer; value: Buffer; } | null = null;
		for (const [hexKey, value] of this.#contractStorage(contract)) {
			const key = Buffer.from(hexKey, 'hex');
			if (!inRange(key, lower, upper)) {
				continue;
			}
			const better = best === null || (order === 'ascending' ? compareKeys(key, best.key) < 0 : compareKeys(key, best.key) > 0);
			if (better) {
				best = { key, value };
			}
		}

		return(best);
	}

	async storageByHash(contract: string, keyHash: Hex): Promise<Buffer | null> {
		for (const [hexKey, value] of this.#contractStorage(contract)) {
			if (storageKeyHash(Buffer.from(hexKey, 'hex')) === keyHash) {
				return(value);
			}
		}

		return(null);
	}

	async treeNode(contract: string, nodeKey: Buffer): Promise<Buffer | null> {
		return(this.#treeNodes.get(`${contract}/${nodeKey.toString('hex')}`) ?? null);
	}

	async token(creator: string, subdenom: string): Promise<string | null> {
		for (const record of this.#tokens.values()) {
			if (record.creator === creator && record.subdenom === subdenom) {
				return(record.token);
			}
		}

		return(null);
	}

	async tokenRecord(token: string): Promise<ContractTokenRecord | null> {
		return(this.#tokens.get(token) ?? null);
	}

	async height(): Promise<bigint> {
		return(this.#height);
	}

	async stage(call: ContractPendingCall): Promise<void> {
		if (this.#pending !== null) {
			throw(new Error(`call ${this.#pending.id} is still staged`));
		}

		this.#pending = structuredClone(call);
	}

	async pending(): Promise<ContractPendingCall | null> {
		return(this.#pending === null ? null : structuredClone(this.#pending));
	}

	async commit(id: string): Promise<void> {
		const pending = this.#takePending(id);
		const { changes } = pending;
		for (const record of changes.contracts) {
			this.#contracts.set(record.address, record);
		}
		for (const write of changes.storage) {
			const storage = this.#contractStorage(write.contract);
			const hexKey = Buffer.from(write.key, 'base64').toString('hex');
			if (write.value === null) {
				storage.delete(hexKey);
			} else {
				storage.set(hexKey, Buffer.from(write.value, 'base64'));
			}
		}
		for (const node of changes.treeNodes) {
			this.#treeNodes.set(`${node.contract}/${Buffer.from(node.key, 'base64').toString('hex')}`, Buffer.from(node.node, 'base64'));
		}
		for (const token of changes.tokens) {
			this.#tokens.set(token.token, token);
		}
		this.#height = BigInt(pending.height);
	}

	async discard(id: string): Promise<void> {
		this.#takePending(id);
	}

	#takePending(id: string): ContractPendingCall {
		if (this.#pending === null || this.#pending.id !== id) {
			throw(new Error(`call ${id} is not staged`));
		}
		const pending = this.#pending;
		this.#pending = null;
		return(pending);
	}
}

// #region Postgres

type Row = { [column: string]: unknown; };

/** The parts of a `pg` pool client this backend uses. */
export interface ContractPostgresClient {
	query(text: string, values?: unknown[]): Promise<{ rows: Row[]; }>;
	release(): void;
}

/** The parts of a `pg` pool this backend uses. */
export interface ContractPostgresPool {
	query(text: string, values?: unknown[]): Promise<{ rows: Row[]; }>;
	connect(): Promise<ContractPostgresClient>;
}

function asBuffer(value: unknown): Buffer | null {
	return(Buffer.isBuffer(value) ? value : null);
}

function asText(value: unknown): string {
	if (typeof value !== 'string') {
		throw(new Error('unexpected column value'));
	}

	return(value);
}

/**
 * Postgres-backed state. Tables are created on first use, named with
 * `tablePrefix` (default `contracts_`).
 */
export class PostgresContractStateBackend implements ContractStateBackend {
	readonly #pool: () => Promise<ContractPostgresPool>;
	readonly #prefix: string;
	#ready: Promise<ContractPostgresPool> | null = null;

	constructor(config: { pool: () => Promise<ContractPostgresPool>; tablePrefix?: string; }) {
		this.#pool = config.pool;
		this.#prefix = config.tablePrefix ?? 'contracts_';
		if (!/^[a-z_][a-z0-9_]*$/.test(this.#prefix)) {
			throw(new Error('tablePrefix may only contain lowercase letters, digits and underscores'));
		}
	}

	#table(name: string): string {
		return(`${this.#prefix}${name}`);
	}

	async #db(): Promise<ContractPostgresPool> {
		this.#ready ??= (async () => {
			const pool = await this.#pool();
			const t = (name: string) => this.#table(name);
			await pool.query(`
				CREATE TABLE IF NOT EXISTS ${t('codes')} (id BIGINT PRIMARY KEY, checksum TEXT UNIQUE NOT NULL, creator TEXT NOT NULL, wasm BYTEA NOT NULL);
				CREATE TABLE IF NOT EXISTS ${t('contracts')} (address TEXT PRIMARY KEY, record JSONB NOT NULL);
				CREATE TABLE IF NOT EXISTS ${t('storage')} (contract TEXT NOT NULL, key BYTEA NOT NULL, key_hash TEXT NOT NULL, value BYTEA NOT NULL, PRIMARY KEY (contract, key));
				CREATE INDEX IF NOT EXISTS ${t('storage_hash')} ON ${t('storage')} (contract, key_hash);
				CREATE TABLE IF NOT EXISTS ${t('tree_nodes')} (contract TEXT NOT NULL, node_key BYTEA NOT NULL, node BYTEA NOT NULL, PRIMARY KEY (contract, node_key));
				CREATE TABLE IF NOT EXISTS ${t('tokens')} (token TEXT PRIMARY KEY, creator TEXT NOT NULL, subdenom TEXT NOT NULL, UNIQUE (creator, subdenom));
				CREATE TABLE IF NOT EXISTS ${t('meta')} (name TEXT PRIMARY KEY, value JSONB NOT NULL);
			`);
			return(pool);
		})();

		return(await this.#ready);
	}

	async #one(text: string, values: unknown[]): Promise<Row | null> {
		const result = await (await this.#db()).query(text, values);
		return(result.rows[0] ?? null);
	}

	async addCode(checksum: Hex, creator: string, wasm: Buffer): Promise<bigint> {
		const codes = this.#table('codes');
		await this.#one(`INSERT INTO ${codes} (id, checksum, creator, wasm) SELECT COALESCE(MAX(id), 0) + 1, $1, $2, $3 FROM ${codes} ON CONFLICT (checksum) DO NOTHING`, [checksum, creator, wasm]);
		const row = await this.#one(`SELECT id FROM ${codes} WHERE checksum = $1`, [checksum]);
		return(BigInt(asText(String(row?.['id']))));
	}

	async code(codeId: bigint): Promise<ContractCodeRecord | null> {
		const row = await this.#one(`SELECT checksum, creator FROM ${this.#table('codes')} WHERE id = $1`, [codeId.toString()]);
		return(row === null ? null : { checksum: asText(row['checksum']), creator: asText(row['creator']) });
	}

	async wasm(checksum: Hex): Promise<Buffer | null> {
		const row = await this.#one(`SELECT wasm FROM ${this.#table('codes')} WHERE checksum = $1`, [checksum]);
		return(asBuffer(row?.['wasm']));
	}

	async contract(address: string): Promise<ContractRecord | null> {
		const row = await this.#one(`SELECT record FROM ${this.#table('contracts')} WHERE address = $1`, [address]);
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(row === null ? null : row['record'] as ContractRecord);
	}

	async storageGet(contract: string, key: Buffer): Promise<Buffer | null> {
		const row = await this.#one(`SELECT value FROM ${this.#table('storage')} WHERE contract = $1 AND key = $2`, [contract, key]);
		return(asBuffer(row?.['value']));
	}

	async storageNext(contract: string, lower: ContractStorageBound | null, upper: ContractStorageBound | null, order: 'ascending' | 'descending'): Promise<{ key: Buffer; value: Buffer; } | null> {
		const conditions = ['contract = $1'];
		const values: unknown[] = [contract];
		if (lower !== null) {
			values.push(lower.key);
			conditions.push(`key ${lower.inclusive ? '>=' : '>'} $${values.length}`);
		}
		if (upper !== null) {
			values.push(upper.key);
			conditions.push(`key ${upper.inclusive ? '<=' : '<'} $${values.length}`);
		}
		const direction = order === 'ascending' ? 'ASC' : 'DESC';
		const row = await this.#one(`SELECT key, value FROM ${this.#table('storage')} WHERE ${conditions.join(' AND ')} ORDER BY key ${direction} LIMIT 1`, values);
		const key = asBuffer(row?.['key']);
		const value = asBuffer(row?.['value']);
		return(key === null || value === null ? null : { key, value });
	}

	async storageByHash(contract: string, keyHash: Hex): Promise<Buffer | null> {
		const row = await this.#one(`SELECT value FROM ${this.#table('storage')} WHERE contract = $1 AND key_hash = $2`, [contract, keyHash]);
		return(asBuffer(row?.['value']));
	}

	async treeNode(contract: string, nodeKey: Buffer): Promise<Buffer | null> {
		const row = await this.#one(`SELECT node FROM ${this.#table('tree_nodes')} WHERE contract = $1 AND node_key = $2`, [contract, nodeKey]);
		return(asBuffer(row?.['node']));
	}

	async token(creator: string, subdenom: string): Promise<string | null> {
		const row = await this.#one(`SELECT token FROM ${this.#table('tokens')} WHERE creator = $1 AND subdenom = $2`, [creator, subdenom]);
		return(row === null ? null : asText(row['token']));
	}

	async tokenRecord(token: string): Promise<ContractTokenRecord | null> {
		const row = await this.#one(`SELECT token, creator, subdenom FROM ${this.#table('tokens')} WHERE token = $1`, [token]);
		return(row === null ? null : { token: asText(row['token']), creator: asText(row['creator']), subdenom: asText(row['subdenom']) });
	}

	async #meta(name: string): Promise<unknown> {
		const row = await this.#one(`SELECT value FROM ${this.#table('meta')} WHERE name = $1`, [name]);
		return(row === null ? null : row['value']);
	}

	async height(): Promise<bigint> {
		const height = await this.#meta('height');
		return(typeof height === 'string' ? BigInt(height) : 0n);
	}

	async stage(call: ContractPendingCall): Promise<void> {
		const inserted = await this.#one(`INSERT INTO ${this.#table('meta')} (name, value) VALUES ('pending', $1) ON CONFLICT (name) DO NOTHING RETURNING name`, [JSON.stringify(call)]);
		if (inserted === null) {
			throw(new Error('another call is still staged'));
		}
	}

	async pending(): Promise<ContractPendingCall | null> {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(await this.#meta('pending') as ContractPendingCall | null);
	}

	async commit(id: string): Promise<void> {
		await this.#inTransaction(async (client) => {
			const pending = await this.#takePending(client, id);
			const t = (name: string) => this.#table(name);
			const { changes } = pending;
			for (const record of changes.contracts) {
				await client.query(`INSERT INTO ${t('contracts')} (address, record) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET record = EXCLUDED.record`, [record.address, JSON.stringify(record)]);
			}
			for (const write of changes.storage) {
				const key = Buffer.from(write.key, 'base64');
				if (write.value === null) {
					await client.query(`DELETE FROM ${t('storage')} WHERE contract = $1 AND key = $2`, [write.contract, key]);
				} else {
					await client.query(`INSERT INTO ${t('storage')} (contract, key, key_hash, value) VALUES ($1, $2, $3, $4) ON CONFLICT (contract, key) DO UPDATE SET value = EXCLUDED.value`, [write.contract, key, storageKeyHash(key), Buffer.from(write.value, 'base64')]);
				}
			}
			for (const node of changes.treeNodes) {
				await client.query(`INSERT INTO ${t('tree_nodes')} (contract, node_key, node) VALUES ($1, $2, $3) ON CONFLICT (contract, node_key) DO NOTHING`, [node.contract, Buffer.from(node.key, 'base64'), Buffer.from(node.node, 'base64')]);
			}
			for (const token of changes.tokens) {
				await client.query(`INSERT INTO ${t('tokens')} (token, creator, subdenom) VALUES ($1, $2, $3) ON CONFLICT (token) DO NOTHING`, [token.token, token.creator, token.subdenom]);
			}
			await client.query(`INSERT INTO ${t('meta')} (name, value) VALUES ('height', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(pending.height)]);
		});
	}

	async discard(id: string): Promise<void> {
		await this.#inTransaction(async (client) => {
			await this.#takePending(client, id);
		});
	}

	async #takePending(client: ContractPostgresClient, id: string): Promise<ContractPendingCall> {
		const result = await client.query(`DELETE FROM ${this.#table('meta')} WHERE name = 'pending' AND value->>'id' = $1 RETURNING value`, [id]);
		const row = result.rows[0];
		if (row === undefined) {
			throw(new Error(`call ${id} is not staged`));
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(row['value'] as ContractPendingCall);
	}

	async #inTransaction(work: (client: ContractPostgresClient) => Promise<void>): Promise<void> {
		const client = await (await this.#db()).connect();
		try {
			await client.query('BEGIN');
			await work(client);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			throw(error);
		} finally {
			client.release();
		}
	}
}

// #endregion
