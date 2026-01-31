import { Country } from "@keetanetwork/currency-info";
import type { ObjectSchema, Schema } from "./json-schema.js";

export interface BankAccountAddressSchema {
	type: 'bank-account';

	includeFields: {
		accountOwner: boolean;
		bankName: boolean;
		accountNumberEnding: boolean;
	}

	additionalProperties: {
		resolved: ObjectSchema;
		obfuscated: ObjectSchema;
	}
}

export const sharedSchemaReferences: { [K in keyof typeof sharedJSONSchemaTypes]: { $ref: string }} = {
	ISOCountryCode: { $ref: '#/definitions/ISOCountryCode' },
	PhysicalAddress: { $ref: '#/definitions/PhysicalAddress' },
	ResolvedAccountOwner: { $ref: '#/definitions/ResolvedAccountOwner' },
	ObfuscatedAccountOwner: { $ref: '#/definitions/ObfuscatedAccountOwner' },
	PhoneNumber: { $ref: '#/definitions/PhoneNumber' }
}

export const sharedJSONSchemaTypes: {
	[K in 'ISOCountryCode' | 'PhysicalAddress' | 'ResolvedAccountOwner' | 'ObfuscatedAccountOwner' | 'PhoneNumber']: Schema;
} = {
	ResolvedAccountOwner: {
		$id: 'ResolvedAccountOwner',
		oneOf: [
			{
				type: 'object',
				properties: {
					accountOwner: {
						type: 'object',
						properties: {
							type: { type: 'string', const: 'individual' },
							firstName: { type: 'string' },
							lastName: { type: 'string' }
						},
						required: ['type', 'firstName', 'lastName']
					}
				},
				required: ['accountOwner']
			},
			{
				type: 'object',
				properties: {
					accountOwner: {
						type: 'object',
						properties: {
							type: { type: 'string', const: 'business' },
							businessName: { type: 'string' }
						},
						required: ['type', 'businessName']
					}
				},
				required: ['accountOwner']
			},
			{
				type: 'object',
				properties: {
					accountOwner: {
						type: 'object',
						properties: {
							type: { type: 'string', const: 'unknown' },
							beneficiaryName: { type: 'string' }
						},
						required: ['type', 'beneficiaryName']
					}
				},
				required: ['accountOwner']
			}
		]
	},
	ObfuscatedAccountOwner: {
		$id: 'ObfuscatedAccountOwner',
		type: 'object',
		properties: {
			accountOwner: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['individual', 'business'] },
					name: { type: 'string' },
					businessName: { type: 'string' }
				}
			}
		},
		required: ['accountOwner']
	},
	ISOCountryCode: { $id: 'ISOCountryCode', type: "string", enum: Country.allCountryCodes },
	PhysicalAddress: {
		$id: 'PhysicalAddress',
		type: "object",
		properties: {
			line1: { type: "string" },
			line2: { type: "string" },
			country: sharedSchemaReferences.ISOCountryCode,
			postalCode: { type: "string" },
			subdivision: { type: "string" },
			city: { type: "string" }
		},
		required: ['line1', 'country', 'postalCode', 'subdivision', 'city']
	},
	PhoneNumber: {
		$id: 'PhoneNumber',
		type: "string",
		maxLength: 80,
		minLength: 1,
		pattern: "^\\d{1,80}$"
	}
};
