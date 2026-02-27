import { test, expect, describe } from 'vitest';
import { KeetaNet } from '../../../client/index.js';
import { createNodeAndClient, setResolverInfo } from '../../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../../lib/resolver.js';
import { KeetaNetStorageAnchorHTTPServer } from '../server.js';
import KeetaStorageAnchorClient from '../client.js';
import { MemoryStorageBackend, testPathPolicy } from '../test-utils.js';
import type { Contact, ContactAddress } from './contacts.js';
import { StorageContactsClient } from './contacts.js';
import { Errors } from '../common.js';

// #region Test Harness

type Account = InstanceType<typeof KeetaNet.lib.Account>;

function randomSeed() {
	return(KeetaNet.lib.Account.generateRandomSeed());
}

interface ContactsTestContext {
	contactsClient: StorageContactsClient;
	account: Account;
	storageClient: KeetaStorageAnchorClient;
}

async function withContacts(
	seed: string | ArrayBuffer,
	testFunction: (ctx: ContactsTestContext) => Promise<void>
): Promise<void> {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	const anchorAccount = KeetaNet.lib.Account.fromSeed(seed, 50);

	await using nodeAndClient = await createNodeAndClient(account);

	const userClient = nodeAndClient.userClient;
	nodeAndClient.fees.disable();

	const backend = new MemoryStorageBackend();

	await using server = new KeetaNetStorageAnchorHTTPServer({
		backend,
		anchorAccount,
		pathPolicies: [testPathPolicy]
	});

	await server.start();

	const rootAccount = KeetaNet.lib.Account.fromSeed(seed, 100);
	const serviceMetadata = await server.serviceMetadata();

	await setResolverInfo(rootAccount, userClient, {
		version: 1,
		currencyMap: {},
		services: {
			storage: {
				'test-provider': serviceMetadata
			}
		}
	});

	const resolver = new KeetaAnchorResolver({
		root: rootAccount,
		client: userClient,
		trustedCAs: []
	});

	const storageClient = new KeetaStorageAnchorClient(userClient, { resolver });
	const maybeProvider = await storageClient.getProviderByID('test-provider');
	if (!maybeProvider) {
		throw(new Error('Provider not found'));
	}

	const pubkey = account.publicKeyString.get();
	const contactsClient = maybeProvider.getContactsClient({ account, basePath: `/user/${pubkey}/contacts/` });
	await testFunction({ contactsClient, account, storageClient });
}

// #endregion

// #region Test Fixtures

const keetaSendAddress: ContactAddress = {
	type: 'KEETA_SEND',
	location: 'chain:keeta:1',
	sendToAddress: 'keeta1a2b3c',
	tokenAddress: '0x1a2b3c4d'
};

const evmSendAddress: ContactAddress = {
	type: 'EVM_SEND',
	location: 'chain:evm:1',
	sendToAddress: '0x4d5e6f7a8b9c',
	tokenAddress: '0x1a2b3c4d'
};

const wireAddress: ContactAddress = {
	type: 'WIRE',
	account: {
		type: 'bank-account',
		accountType: 'us',
		accountNumber: '123456789',
		routingNumber: '021000021',
		accountTypeDetail: 'checking',
		accountOwner: { type: 'individual', firstName: 'Alice', lastName: 'Smith' }
	}
};

const bitcoinSendAddress: ContactAddress = {
	type: 'BITCOIN_SEND',
	location: 'chain:bitcoin:f9beb4d9',
	sendToAddress: 'bc1q0a1b2c3d4e5f'
};

const solanaSendAddress: ContactAddress = {
	type: 'SOLANA_SEND',
	location: 'chain:solana:1',
	sendToAddress: '9a8b7c6d5e4f'
};

const tronSendAddress: ContactAddress = {
	type: 'TRON_SEND',
	location: 'chain:tron:mainnet',
	sendToAddress: 'T1a2b3c4d5e6'
};

const evmCallAddress: ContactAddress = {
	type: 'EVM_CALL',
	location: 'chain:evm:1',
	contractAddress: '0x9c0d1e2f',
	contractMethodName: 'deposit(uint256)',
	contractMethodArgs: ['1000']
};

const achAddress: ContactAddress = {
	type: 'ACH',
	account: {
		type: 'bank-account',
		accountType: 'us',
		accountNumber: '987654321',
		routingNumber: '021000021',
		accountTypeDetail: 'checking',
		accountOwner: { type: 'individual', firstName: 'Bob', lastName: 'Jones' }
	}
};

const sepaPushAddress: ContactAddress = {
	type: 'SEPA_PUSH',
	account: {
		type: 'bank-account',
		accountType: 'iban-swift',
		iban: 'DE89370400440532013000',
		bic: 'COBADEFFXXX', // cspell:disable-line
		accountOwner: { type: 'individual', firstName: 'Hans', lastName: 'Mueller' }
	}
};

const sampleAddresses: { type: ContactAddress['type']; address: ContactAddress }[] = [
	{ type: 'KEETA_SEND', address: keetaSendAddress },
	{ type: 'EVM_SEND', address: evmSendAddress },
	{ type: 'EVM_CALL', address: evmCallAddress },
	{ type: 'WIRE', address: wireAddress },
	{ type: 'ACH', address: achAddress },
	{ type: 'SEPA_PUSH', address: sepaPushAddress },
	{ type: 'BITCOIN_SEND', address: bitcoinSendAddress },
	{ type: 'SOLANA_SEND', address: solanaSendAddress },
	{ type: 'TRON_SEND', address: tronSendAddress }
];

const updateCases: {
	name: string;
	initial: { label: string; address: ContactAddress };
	update: { label?: string; address?: ContactAddress };
	expected: { label: string; address: ContactAddress };
	changesId: boolean;
}[] = [
	{
		name: 'label only preserves address and id',
		initial: { label: 'Original', address: keetaSendAddress },
		update: { label: 'Renamed' },
		expected: { label: 'Renamed', address: keetaSendAddress },
		changesId: false
	},
	{
		name: 'address only preserves label and changes id',
		initial: { label: 'Keep This', address: keetaSendAddress },
		update: { address: bitcoinSendAddress },
		expected: { label: 'Keep This', address: bitcoinSendAddress },
		changesId: true
	},
	{
		name: 'both label and address changes id',
		initial: { label: 'Old', address: keetaSendAddress },
		update: { label: 'New', address: evmSendAddress },
		expected: { label: 'New', address: evmSendAddress },
		changesId: true
	}
];

// #endregion

// #region Tests

describe('Contacts Client - CRUD per address type', function() {
	test.each(sampleAddresses)('create and get contact with $type address', function({ address }) {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const created = await contactsClient.create({ label: 'Test Contact', address });
			expect(created.id).toBe(contactsClient.deriveId(address));
			expect(created.label).toBe('Test Contact');
			expect(created.address).toEqual(address);

			const retrieved = await contactsClient.get(created.id);
			expect(retrieved).toEqual(created);
		}));
	});
});

describe('Contacts Client - Update', function() {
	test.each(updateCases)('update $name', function({ initial, update, expected, changesId }) {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const created = await contactsClient.create(initial);
			const updated = await contactsClient.update(created.id, update);

			expect(updated.id).toBe(contactsClient.deriveId(expected.address));
			expect(updated.label).toBe(expected.label);
			expect(updated.address).toEqual(expected.address);

			const retrieved = await contactsClient.get(updated.id);
			expect(retrieved).toEqual(updated);

			if (changesId) {
				const oldRetrieved = await contactsClient.get(created.id);
				expect(oldRetrieved).toBeNull();
			}
		}));
	});

	test('update non-existent contact throws DocumentNotFound', function() {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			await expect(contactsClient.update('no-such-id', { label: 'X' }))
				.rejects.toSatisfy(function(e: unknown) { return(Errors.DocumentNotFound.isInstance(e)); });
		}));
	});
});

describe('Contacts Client - Delete', function() {
	test('delete existing contact returns true', function() {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const created = await contactsClient.create({
				label: 'To Delete',
				address: keetaSendAddress
			});

			const deleted = await contactsClient.delete(created.id);
			expect(deleted).toBe(true);

			const retrieved = await contactsClient.get(created.id);
			expect(retrieved).toBeNull();
		}));
	});

	test('delete non-existent contact returns false', function() {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const deleted = await contactsClient.delete('non-existent-id');
			expect(deleted).toBe(false);
		}));
	});
});

describe('Contacts Client - List', function() {
	test('list returns all created contacts', function() {
		const sortById = function(a: Contact, b: Contact) { return(a.id.localeCompare(b.id)); };

		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const created: Contact[] = [];
			for (const { address } of sampleAddresses) {
				created.push(await contactsClient.create({ label: `Contact ${address.type}`, address }));
			}

			const listed = await contactsClient.list();
			expect(listed).toHaveLength(sampleAddresses.length);
			expect(listed.sort(sortById)).toEqual(created.sort(sortById));
		}));
	});

	test('list filtered by type returns only matching contacts', function() {
		const fixtures: { type: ContactAddress['type']; address: ContactAddress }[] = [
			{ type: 'WIRE', address: wireAddress },
			{ type: 'ACH', address: achAddress },
			{ type: 'BITCOIN_SEND', address: bitcoinSendAddress }
		];

		return(withContacts(randomSeed(), async function({ contactsClient }) {
			for (const { type, address } of fixtures) {
				await contactsClient.create({ label: `${type} Contact`, address });
			}

			for (const { type } of fixtures) {
				const filtered = await contactsClient.list({ type });
				expect(filtered).toHaveLength(1);
				expect(filtered[0]?.address.type).toBe(type);
			}
		}));
	});
});

describe('Contacts Client - Edge Cases', function() {
	test('get non-existent id returns null', function() {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const result = await contactsClient.get('does-not-exist');
			expect(result).toBeNull();
		}));
	});

	test('creating the same address twice is idempotent and updates the label', function() {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const first = await contactsClient.create({ label: 'First', address: keetaSendAddress });
			const second = await contactsClient.create({ label: 'Second', address: keetaSendAddress });
			expect(second.id).toBe(first.id);
			expect(second.label).toBe('Second');

			const retrieved = await contactsClient.get(first.id);
			expect(retrieved).toEqual(second);

			const listed = await contactsClient.list();
			expect(listed).toHaveLength(1);
		}));
	});

	test('deriveId is deterministic across client instances', function() {
		return(withContacts(randomSeed(), async function({ contactsClient, storageClient, account }) {
			const pubkey = account.publicKeyString.get();
			const otherClient = (await storageClient.getProviderByID('test-provider'))!.getContactsClient({ account, basePath: `/user/${pubkey}/contacts/` }); // eslint-disable-line @typescript-eslint/no-non-null-assertion
			for (const { address } of sampleAddresses) {
				expect(contactsClient.deriveId(address)).toBe(otherClient.deriveId(address));
			}
		}));
	});

	test('deriveId is stable regardless of key order', function() {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			const reordered: ContactAddress = {
				tokenAddress: '0x1a2b3c4d',
				sendToAddress: '0x4d5e6f7a8b9c',
				type: 'EVM_SEND',
				location: 'chain:evm:1'
			};
			expect(contactsClient.deriveId(evmSendAddress)).toBe(contactsClient.deriveId(reordered));
		}));
	});

	test('deriveId ignores undefined optional fields', function() {
		return(withContacts(randomSeed(), async function({ contactsClient }) {
			// Simulates runtime scenario where an optional field is explicitly set to undefined
			const withUndefined = {
				...wireAddress,
				depositMessage: undefined
			};
			expect(contactsClient.deriveId(withUndefined as unknown as ContactAddress)).toBe(contactsClient.deriveId(wireAddress)); // eslint-disable-line @typescript-eslint/consistent-type-assertions
		}));
	});
});

describe('Contacts Client - Factory Methods', function() {
	test('getContactsClient via storage client resolves provider', function() {
		return(withContacts(randomSeed(), async function({ storageClient, account }) {
			const pubkey = account.publicKeyString.get();
			const contactsClient = await storageClient.getContactsClient({ account, basePath: `/user/${pubkey}/contacts/` });
			expect(contactsClient).toBeInstanceOf(StorageContactsClient);
		}));
	});
});

// #endregion
