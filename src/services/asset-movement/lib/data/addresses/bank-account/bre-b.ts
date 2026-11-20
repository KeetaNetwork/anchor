import type { Schema } from '../../json-schema.js';
import { sharedSchemaReferences, type AccountAddressSchema } from '../../types.js';

const breBKeyType = { type: 'string', enum: [ 'mobile', 'email', 'id', 'alias' ] } satisfies Schema;

const breBSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true,
		bankName: false,
		accountNumberEnding: true
	},

	additionalProperties: {
		resolved: {
			type: 'object',
			properties: {
				breBKeyType: breBKeyType,
				breBKey: { type: 'string' },
				accountAddress: sharedSchemaReferences.PhysicalAddress,
				document: {
					type: 'object',
					properties: {
						type: { type: 'string', enum: [ 'cc', 'nit', 'ce', 'pass', 'pep' ] },
						number: { type: 'string' }
					},
					required: [ 'number' ]
				}
			},
			required: []
		},
		obfuscated: {
			type: 'object',
			properties: {
				accountAddress: {
					oneOf: [
						{ type: 'string' },
						sharedSchemaReferences.PhysicalAddress
					]
				}
			}
		}
	}
}

export default breBSchema;
