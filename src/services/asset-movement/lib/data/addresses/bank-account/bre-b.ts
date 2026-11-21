import type { Schema } from '../../json-schema.js';
import { sharedSchemaReferences, type AccountAddressSchema } from '../../types.js';
import { colombiaIdentityProperties } from './co.js';

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
				breBKey: {
					type: 'string',
					description: 'Bre-B key: a phone, an email, an ID number, or an alias that starts with @',
					minLength: 5,
					maxLength: 92,
					pattern: String.raw`^\S{5,92}$`
				},
				accountAddress: sharedSchemaReferences.PhysicalAddress,
				...colombiaIdentityProperties
			},
			required: [ 'breBKeyType', 'breBKey' ]
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
