import { describe, expect, test } from 'vitest';
import { createIs } from 'typia';

import { definitions as bankAccountDefinitions } from './bank-account/index.generated.js';
import type { BankAccountAddressResolved } from './types.generated.js';

const isBankAccountAddressResolved = createIs<BankAccountAddressResolved>();

const breBAddress = {
	type: 'bank-account',
	accountType: 'bre-b',
	breBKeyType: 'alias',
	breBKey: '@ana.gomez',
	accountOwner: { type: 'individual', firstName: 'Ana', lastName: 'Gomez' }
} as const;

describe('bank account addresses', function() {
	test('declares every required field of a resolved address as a property', function() {
		for (const [ name, schema ] of Object.entries(bankAccountDefinitions)) {
			const resolved = schema.additionalProperties.resolved;
			for (const field of resolved?.required ?? []) {
				expect(resolved?.properties, `${name} requires ${field}`).toHaveProperty(field);
			}
		}
	});

	test('takes a Bre-B address with a key, its type, and a Colombian document', function() {
		expect(isBankAccountAddressResolved(breBAddress)).toBe(true);
		expect(isBankAccountAddressResolved({ ...breBAddress, idType: 'Citizenship Card', idName: '1004922993' })).toBe(true);
	});

	test.each([
		[ 'without a key', { ...breBAddress, breBKey: undefined }],
		[ 'without a key type', { ...breBAddress, breBKeyType: undefined }],
		[ 'with an unknown key type', { ...breBAddress, breBKeyType: 'iban' }],
		[ 'with a document type of another country', { ...breBAddress, idType: 'cpf' }]
	])('refuses a Bre-B address %s', function(_name, address) {
		expect(isBankAccountAddressResolved(address)).toBe(false);
	});
});
