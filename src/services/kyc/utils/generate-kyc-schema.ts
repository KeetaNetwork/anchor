#! /usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as typia from 'typia';

type oidSchemaContents = {
	algorithms: {
		[key: string]: number[]
	};
	attributes: {
		[key: string]: {
			oid: number[];
			type?: string;
			token?: string;
			description: string;
			reference: string;
			fields?: {
				[key: string]: {
					type: string;
					optional?: boolean;
				};
			};
			choices?: {
				[key: string]: {
					type: string;
				};
			};
			field_order?: string[];
		};
	};
	iso20022_types: {
		primitives: {
			[key: string]: {
				oid: number[];
				type: string;
				description: string;
			};
		};
		enumerations: {
			[key: string]: {
				oid: number[];
				values: string[];
				description: string;
			};
		};
		choices: {
			[key: string]: {
				oid: number[];
				choices: {
					[key: string]: {
						type: string;
					};
				};
				description: string;
			};
		};
		sequences: {
			[key: string]: {
				oid: number[];
				fields: {
					[key: string]: {
						type: string;
						optional?: boolean;
					};
				};
				field_order?: string[];
				description: string;
			};
		};
	};
	extensions: {
		[key: string]: {
			oid: number[];
			type?: string;
			description: string;
			reference: string;
		};
	};
};
/*
 * Populated in `main` function
 */
//let oidSchema: oidSchemaContents;

// --- Utility Functions ---
function oidArrayToString(oid: (string | number)[]): string {
	return(oid.join('.'));
}
function toConstantCase(str: string): string {
	return(str.replace(/[A-Z]/g, function(part) {
		return(`_${part}`);
	}).toUpperCase());
}
function toPascalCase(str: string): string {
	return(str.split(/[_-]/).map(function(part) {
		return(part.charAt(0).toUpperCase() + part.slice(1));
	}).join(''));
}
function toSnakeCase(str: string): string {
	return(str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''));
}

// --- Type Resolution ---
//function resolveTypeReference(typeName: string): string {
//	if (typeName.startsWith('SEQUENCE OF ')) {
//		return(`${resolveTypeReference(typeName.substring('SEQUENCE OF '.length).trim())}[]`);
//	}
//	switch (typeName.trim()) {
//		case 'UTF8String':
//		case 'Utf8String':
//			return('string');
//		case 'GeneralizedTime':
//			return('Date');
//		case 'ENUMERATED':
//			return('string');
//		default:
//			return(toPascalCase(typeName));
//	}
//}
//
//function resolveToBaseType(typeName: string): string {
//	typeName = typeName.trim();
//
//	// Check if it's a primitive type first
//	if (/^(UTF8String|Utf8String|GeneralizedTime)$/i.test(typeName)) {
//		return(typeName);
//	}
//
//	// Check if it's defined as a sensitive attribute
//	const sensitiveAttr = oidSchema.attributes[typeName] ?? Object.values(oidSchema.attributes).find(function(attr) {
//		return(attr.token === typeName);
//	});
//
//	if (sensitiveAttr && !sensitiveAttr.fields && !sensitiveAttr.choices) {
//		if (sensitiveAttr.type === undefined) {
//			throw(new Error(`Sensitive attribute ${typeName} has no defined type.`));
//		}
//		return(resolveToBaseType(sensitiveAttr.type));
//	}
//
//	// Check if it's an ISO20022 primitive
//	const primitive = oidSchema.iso20022_types.primitives[typeName];
//	if (primitive) {
//		return(resolveToBaseType(primitive.type));
//	}
//
//	// Otherwise return as-is
//	return(typeName);
//}
//
//function isSequenceOfChoice(config: { fields: { [key: string]: { optional?: boolean }}}): boolean {
//	const hasFields = config.fields && Object.keys(config.fields).length > 0;
//	const allOptional = hasFields && Object.values(config.fields).every(function(field) {
//		return(field.optional);
//	});
//	return(allOptional);
//}
//
//// eslint-disable-next-line @typescript-eslint/no-unused-vars
//function _ignore_getPrimitiveType(type: string): 'string' | 'date' {
//	if (type === 'UTF8String' || type === 'Utf8String') {
//		return('string');
//	}
//	if (type === 'GeneralizedTime') {
//		return('date');
//	}
//	return('string');
//}

// --- Output Generators ---
function genHeader(comment: string) {
	return([
		'/* eslint-disable */',
		'/**',
		` * ${comment}`,
		' * This file is auto-generated from oids.json.',
		' */',
		''
	].join('\n'));
}

//function genTypeAlias(name: string, type: string, description: string, oid: string): string {
//	return(`/** ${description} */\n/** OID: ${oid} */\nexport type ${name} = ${type};\n`);
//}
//
//function genEnumType(name: string, values: string[], description: string, oid: string): string {
//	return(`/** ${description} */\n/** OID: ${oid} */\nexport type ${name} = ${values.map(function(value) {
//		return(`'${value}'`);
//	}).join(' | ')};\n`);
//}
//
//function genInterface(name: string, fields: { [key: string]: { type: string; optional?: boolean }}, description: string, oid: string): string {
//	const fieldLines = Object.entries(fields).map(function([fieldName, fieldConfig]) {
//		return(`\t${fieldName}${fieldConfig.optional ? '?' : ''}: ${resolveTypeReference(fieldConfig.type)};`);
//	});
//	return(`/** ${description} */\n/** OID: ${oid} */\nexport interface ${name} {\n${fieldLines.join('\n')}\n}\n`);
//}
//
//function genSequenceOfChoice(name: string, config: { fields: { [key: string]: { type: string; optional?: boolean }}; field_order?: string[] }): string {
//	const typeName = toPascalCase(name);
//	const fieldOrder = config.field_order ?? Object.keys(config.fields);
//	const choiceEntries = fieldOrder.map(function(fieldName): [string, { type: string; optional?: boolean }] {
//		if (!(fieldName in config.fields) || config.fields[fieldName] === undefined) {
//			throw(new Error(`Field ${fieldName} not found in sequence of choice ${name}`));
//		}
//		return([fieldName, config.fields[fieldName]]);
//	});
//	const choiceTypes = choiceEntries.map(function([fieldName, fieldConfig], index) {
//		if (fieldConfig === undefined) {
//			throw(new Error(`Field ${fieldName} not found in sequence of choice ${name}`));
//		}
//		const fieldType = resolveTypeReference(fieldConfig.type);
//		const choiceTypeName = `${typeName}${toPascalCase(fieldName)}Choice`;
//		return({
//			code: `export interface ${choiceTypeName} {\n\ttag: ${index};\n\tname: '${fieldName}';\n\tvalue: ${fieldType};\n}\n`,
//			name: choiceTypeName
//		});
//	});
//
//	let out = '';
//	// Individual choice interfaces
//	out += choiceTypes.map(function(choiceInfo) {
//		return(choiceInfo.code);
//	}).join('\n');
//
//	// Union type
//	out += `export type ${typeName}Choice =\n\t| ${choiceTypes.map(function(choiceInfo) {
//		return(choiceInfo.name);
//	}).join('\n\t| ')};\n\n`;
//
//	// Main type is array of choices
//	out += `export type ${typeName} = ${typeName}Choice[];\n\n`;
//
//	// ASN.1 schema
//	out += `export const ${typeName}Schema: ASN1.Schema = {\n\tsequenceOf: {\n\t\tchoice: [\n`;
//	out += choiceEntries.map(function([_ignore_fieldName, _ignore_fieldConfig], index) {
//		return(`\t\t\t{ type: 'context', kind: 'explicit', value: ${index}, contains: { type: 'string', kind: 'utf8' }}`);
//	}).join(',\n');
//	out += `\n\t\t]\n\t}\n} as const satisfies ASN1.Schema;\n\n`;
//
//	// Field names array
//	out += `export const ${typeName}Fields = [\n${fieldOrder.map(function(fieldName){
//		return(`\t'${fieldName}'`);
//	}).join(',\n')}\n] as const;\n\n`;
//
//	return(out);
//}

function deleteLastCommaIfFoundGenerator(lines: string[]) {
	return(function deleteLastCommaIfFound() {
		let lastLine = lines.pop();
		if (lastLine === undefined) {
			return;
		}
		if (lastLine.endsWith(',')) {
			lastLine = lastLine.slice(0, -1);
		}
		lines.push(lastLine);
	});
}


// --- Main Generation ---
function generateOidConstants(oidSchema: oidSchemaContents): string {
	const lines = [genHeader('Generated OID Constants')];
	const deleteLastCommaIfFound = deleteLastCommaIfFoundGenerator(lines);

	// Algorithm OID constants
	lines.push('// Algorithm OID constants');
	for (const [name, oid] of Object.entries(oidSchema.algorithms)) {
		lines.push(`export const ${toConstantCase(name.replace(/-/g, '_'))} = '${oidArrayToString(oid)}';`);
	}
	lines.push('');

	// Plain attribute OID constants
	lines.push('// Plain attribute OID constants');
	for (const [name, config] of Object.entries(oidSchema.attributes)) {
		lines.push(`/** ${config.description} */`);
		lines.push(`/** @see ${config.reference} */`);
		lines.push(`export const ${toConstantCase(name)} = '${oidArrayToString(config.oid)}';`);
	}
	lines.push('');

	// Keeta namespace for sensitive attributes
	lines.push('// Keeta-specific OID constants');
	lines.push('// eslint-disable-next-line @typescript-eslint/no-namespace');
	lines.push('export namespace keeta {');
	for (const [name, config] of Object.entries(oidSchema.extensions)) {
		lines.push(`\t/** ${config.description} */`);
		lines.push(`\t/** @see ${config.reference} */`);
		lines.push(`\texport const ${toConstantCase(name)} = '${oidArrayToString(config.oid)}';`);
	}
	for (const [name, config] of Object.entries(oidSchema.attributes)) {
		lines.push(`\t/** ${config.description} */`);
		lines.push(`\t/** @see ${config.reference} */`);
		lines.push(`\texport const ${toConstantCase(name)} = '${oidArrayToString(config.oid)}';`);
	}
	lines.push('}');
	lines.push('');

	// Lookup maps
	lines.push('// OID to name lookup maps');
	lines.push('export const OID_TO_NAME: { [key: string]: string } = {');
	for (const [name, config] of Object.entries(oidSchema.attributes)) {
		lines.push(`\t'${oidArrayToString(config.oid)}': '${name}',`);
	}
	deleteLastCommaIfFound();
	lines.push('};');
	lines.push('');
	lines.push('export const NAME_TO_OID: { [key: string]: string } = {');
	for (const [name, config] of Object.entries(oidSchema.attributes)) {
		lines.push(`\t'${name}': '${oidArrayToString(config.oid)}',`);
	}
	deleteLastCommaIfFound();
	lines.push('};');
	lines.push('');

	return(lines.join('\n'));
}

//function genSequenceSchema(typeName: string, fields: { [key: string]: { type: string; optional?: boolean }}, config: { field_order?: string[] }) {
//	const fieldOrder = config?.field_order ?? Object.keys(fields);
//	const schemaFields = fieldOrder.map(function(fname, index) {
//		const fcfg = fields[fname];
//		if (!fcfg) {return(null);}
//
//		// Resolve to base type to handle aliases
//		const baseType = resolveToBaseType(fcfg.type);
//		// Check if field type is GeneralizedTime (date)
//		if (baseType === 'GeneralizedTime') {
//			if (fcfg.optional) {
//				return(`{ optional: { type: 'context', kind: 'explicit', value: ${index}, contains: ASN1.ValidateASN1.IsDate }}`);
//			} else {
//				return(`{ type: 'context', kind: 'explicit', value: ${index}, contains: ASN1.ValidateASN1.IsDate }`);
//			}
//		}
//
//		// Strip SEQUENCE OF prefix and [] suffix to get the base type
//		let fieldType = fcfg.type.trim();
//		if (fieldType.startsWith('SEQUENCE OF ')) {
//			fieldType = fieldType.substring('SEQUENCE OF '.length).trim();
//		}
//
//		fieldType = fieldType.replace(/\[\]$/, '');
//
//		const fieldTypePascal = toPascalCase(fieldType);
//		const fieldTypeSnake = toSnakeCase(fieldType);
//
//		// Check if this is a COMPLEX type (not a primitive)
//		const isChoice = oidSchema.iso20022_types.choices[fieldTypeSnake] ??  oidSchema.iso20022_types.choices[fieldType];
//		const isSequence = oidSchema.iso20022_types.sequences[fieldTypeSnake] ??  oidSchema.iso20022_types.sequences[fieldType];
//		const isSensitiveSequence = oidSchema.attributes[fieldTypeSnake]?.fields;
//		const isSensitiveChoice = oidSchema.attributes[fieldTypeSnake]?.choices;
//
//		const hasSchema = isChoice ?? isSequence ?? isSensitiveSequence ?? isSensitiveChoice;
//
//		let contains;
//		if (hasSchema) {
//			contains = `${fieldTypePascal}Schema `;
//		} else {
//			// Primitive type - use inline string schema
//			contains = `{ type: 'string', kind: 'utf8' }`;
//		}
//
//		if (fcfg.optional) {
//			return(`{ optional: { type: 'context', kind: 'explicit', value: ${index}, contains: ${contains}}}`);
//		} else {
//			return(`{ type: 'context', kind: 'explicit', value: ${index}, contains: ${contains}}`);
//		}
//	}).filter(Boolean);
//
//	return(`export const ${typeName}Schema: ASN1.Schema = [\n\t${schemaFields.join(',\n\t')}\n] as const satisfies ASN1.Schema;`);
//}
//
//function generateISO20022Types() {
//	const lines = [genHeader('Generated ISO20022 Type Definitions'), "import * as ASN1 from '../../lib/utils/asn1.js';", ''];
//	const deleteLastCommaIfFound = deleteLastCommaIfFoundGenerator(lines);
//
//	// Primitives
//	lines.push('// ISO20022 Primitive Types');
//	for (const [name, config] of Object.entries(oidSchema.iso20022_types.primitives)) {
//		lines.push(genTypeAlias(toPascalCase(name), resolveTypeReference(config.type), config.description, oidArrayToString(config.oid)));
//	}
//
//	// Enumerations
//	lines.push('// ISO20022 Enumeration Types');
//	for (const [name, config] of Object.entries(oidSchema.iso20022_types.enumerations)) {
//		lines.push(genEnumType(toPascalCase(name), config.values, config.description, oidArrayToString(config.oid)));
//	}
//
//	// Choices
//	lines.push('// ISO20022 Choice Types');
//	for (const [name, config] of Object.entries(oidSchema.iso20022_types.choices)) {
//		const typeName = toPascalCase(name);
//		const choices = Object.entries(config.choices ?? {});
//		const hasComplexTypes = choices.some(function([_ignore_choiceName, choiceConfig]) {
//			const choiceType = choiceConfig.type.trim();
//			return(choiceType !== 'UTF8String' && choiceType !== 'string');
//		});
//		if (hasComplexTypes) {
//			const unionTypes = choices.map(function([_ignore_choiceName, choiceConfig]) {
//				return(toPascalCase(choiceConfig.type.trim()));
//			});
//			lines.push(genTypeAlias(typeName, unionTypes.join(' | '), config.description, oidArrayToString(config.oid)));
//		} else {
//			lines.push(genTypeAlias(typeName, 'string', config.description, oidArrayToString(config.oid)));
//		}
//	}
//
//	// ISO20022 Sequences and Sequence-of-Choice Types
//	lines.push('// ISO20022 Sequence Types');
//	for (const [name, config] of Object.entries(oidSchema.iso20022_types.sequences)) {
//		if (isSequenceOfChoice(config)) {
//			lines.push(genSequenceOfChoice(name, config));
//		} else {
//			lines.push(genInterface(toPascalCase(name), config.fields, config.description, oidArrayToString(config.oid)));
//		}
//	}
//	lines.push('');
//
//	// --- Choice Type Schemas ---
//	lines.push('// Generated ASN.1 schemas for ISO 20022 choice types');
//	// eslint-disable-next-line @typescript-eslint/no-unused-vars
//	for (const [name, _ignore_config] of Object.entries(oidSchema.iso20022_types.choices)) {
//		const typeName = toPascalCase(name);
//		lines.push(`/** ASN.1 schema for ${typeName} */`);
//		lines.push(`export const ${typeName}Schema: ASN1.Schema = { type: 'string', kind: 'utf8' };`);
//		lines.push('');
//	}
//
//	// --- Sequence Type Schemas ---
//	lines.push('// Generated ASN.1 schemas for ISO 20022 sequence types');
//	for (const [name, config] of Object.entries(oidSchema.iso20022_types.sequences)) {
//		const typeName = toPascalCase(name);
//		if (config.fields && !isSequenceOfChoice(config)) {
//			lines.push(`/** ASN.1 schema for ${typeName} */`);
//			lines.push(genSequenceSchema(typeName, config.fields, config));
//			lines.push('');
//		}
//	}
//
//	// --- Choice-Type Sensitive Attribute Schemas ---
//	lines.push('// Generated ASN.1 schemas for choice-type sensitive attributes');
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		const typeName = toPascalCase(name);
//		if (config.choices) {
//			const choiceSchemas = Object.values(config.choices).map(function(choice) {
//				const choiceTypeName = toPascalCase(choice.type.trim());
//				return(`${choiceTypeName}Schema`);
//			});
//			lines.push(`/** ASN.1 schema for ${typeName} */`);
//			lines.push(`export const ${typeName}Schema: ASN1.Schema = {`);
//			lines.push(`\tchoice: [`);
//			lines.push(`\t\t${choiceSchemas.join(',\n\t\t')}`);
//			lines.push(`\t]`);
//			lines.push(`} as const satisfies ASN1.Schema;`);
//			lines.push('');
//		}
//	}
//
//	// Sensitive Attribute Types
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		const typeName = toPascalCase(name);
//		if (!config.fields && !config.choices) {
//			// Primitive type
//			let baseType;
//			if (config.type === 'UTF8String' || config.type === 'Utf8String') {
//				baseType = 'string';
//			} else if (config.type === 'GeneralizedTime') {
//				baseType = 'Date';
//			} else {
//				if (config.type === undefined) {
//					throw(new Error(`Sensitive attribute ${name} has no defined type.`));
//				}
//				baseType = toPascalCase(config.type);
//			}
//			lines.push(`/** ${config.description} */`);
//			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
//			lines.push(`export type ${typeName} = ${baseType};`);
//			lines.push('');
//		} else if (config.fields) {
//			// Sequence type
//			lines.push(`/** ${config.description} */`);
//			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
//			lines.push(`export interface ${typeName} {`);
//			for (const [fieldName, fieldConfig] of Object.entries(config.fields)) {
//				const optional = fieldConfig.optional ? '?' : '';
//				const resolvedType = resolveTypeReference(fieldConfig.type);
//				lines.push(`\t${fieldName}${optional}: ${resolvedType};`);
//			}
//			lines.push('}');
//			lines.push('');
//		} else if (config.choices) {
//			// Choice type
//			lines.push(`/** ${config.description} */`);
//			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
//			const hasComplexTypes = Object.values(config.choices).some(function(choice) {
//				const choiceType = choice.type.trim();
//				return(choiceType !== 'UTF8String' && choiceType !== 'string');
//			});
//			if (hasComplexTypes) {
//				const unionTypes = Object.values(config.choices).map(function(choice) {
//					return(toPascalCase(choice.type.trim()));
//				});
//				lines.push(`export type ${typeName} = ${unionTypes.join(' | ')};`);
//			} else {
//				lines.push(`export type ${typeName} = string;`);
//			}
//			lines.push('');
//		}
//	}
//
//	// Token aliases for sensitive attributes
//	lines.push('// Token aliases for sensitive attributes');
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		if (config.token && config.token !== toPascalCase(name)) {
//			const typeName = toPascalCase(name);
//			const tokenName = config.token;
//			lines.push(`/** Alias for ${typeName} */`);
//			lines.push(`export type ${tokenName} = ${typeName};`);
//			lines.push('');
//		}
//	}
//
//	// Union type, value map, helper generic
//	lines.push('/** Union type of all sensitive attribute types */');
//	lines.push('export type SensitiveAttributeType =');
//	lines.push(Object.keys(oidSchema.attributes).map(function(name) {
//		return(`\t| ${toPascalCase(name)}`);
//	}).join('\n') + ';');
//	lines.push('');
//	lines.push('/** Map of attribute name to acceptable input type for CertificateBuilder.setAttribute */');
//	lines.push('export interface CertificateAttributeValueMap {');
//	for (const [name] of Object.entries(oidSchema.attributes)) {
//		lines.push(`\t'${name}': ${toPascalCase(name)};`);
//	}
//	lines.push('}');
//	lines.push('');
//	lines.push('/** Helper generic to get attribute value type by name */');
//	lines.push('export type CertificateAttributeValue<Name extends keyof CertificateAttributeValueMap> = CertificateAttributeValueMap[Name];');
//	lines.push('');
//
//	// Field arrays and schemas for sequence types
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		const typeName = toPascalCase(name);
//		if (config.fields) {
//			const fieldOrder = config.field_order ?? Object.keys(config.fields);
//			lines.push(`export const ${typeName}Fields = [${fieldOrder.map(function(field) {
//				return(`'${field}'`);
//			}).join(', ')}] as const;`);
//			lines.push(genSequenceSchema(typeName, config.fields, config));
//		}
//	}
//
//	// OID DB
//	lines.push('export const CertificateAttributeOIDDB = {');
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		lines.push(`\t'${name}': '${oidArrayToString(config.oid)}',`);
//	}
//	deleteLastCommaIfFound();
//	lines.push('} as const;');
//	lines.push('');
//
//	// Sensitive attribute list
//	lines.push('export const SENSITIVE_CERTIFICATE_ATTRIBUTES = [');
//	for (const name of Object.keys(oidSchema.attributes)) {
//		lines.push(`\t'${name}',`);
//	}
//	deleteLastCommaIfFound();
//	lines.push('] as const;');
//	lines.push('');
//
//	lines.push('export type SensitiveCertificateAttributeNames = typeof SENSITIVE_CERTIFICATE_ATTRIBUTES[number];');
//	lines.push('');
//
//	// PascalCase names
//	lines.push('export const SensitiveCertificateAttributeNames = [');
//	for (const name of Object.keys(oidSchema.attributes)) {
//		lines.push(`\t'${toPascalCase(name)}',`);
//	}
//	deleteLastCommaIfFound();
//	lines.push('] as const;');
//	lines.push('');
//
//	// Field name mapping
//	lines.push('export const CertificateAttributeFieldNames: { readonly [K in keyof typeof CertificateAttributeOIDDB]?: readonly string[] } = {');
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		if (config.fields) {
//			const typeName = toPascalCase(name);
//			lines.push(`\t'${name}': ${typeName}Fields,`);
//		}
//	}
//	deleteLastCommaIfFound();
//	lines.push('} as const;');
//	lines.push('');
//
//	// Complete schema mapping (ONCE, at the end)
//	lines.push('export const CertificateAttributeSchema: { readonly [K in keyof typeof CertificateAttributeOIDDB]: ASN1.Schema } = {');
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		const typeName = toPascalCase(name);
//		let schemaRef;
//		if (config.fields) {
//			schemaRef = `${typeName}Schema`;
//		} else if (config.choices) {
//			schemaRef = `${typeName}Schema`;
//		} else {
//			if (config.type === undefined) {
//				throw(new Error(`Sensitive attribute ${name} has no defined type.`));
//			}
//			const baseType = resolveToBaseType(config.type);
//			if (baseType === 'GeneralizedTime') {
//				schemaRef = 'ASN1.ValidateASN1.IsDate';
//			} else {
//				schemaRef = `{ type: 'string', kind: 'utf8' }`;
//			}
//		}
//		lines.push(`\t'${name}': ${schemaRef},`);
//	}
//	deleteLastCommaIfFound();
//	lines.push('} as const;');
//	lines.push('');
//
//	return(lines.join('\n'));
//}

type Schema = {
	type: 'struct' | 'choice' | 'enum' | 'primitive' | 'array';
	config: {
		type?: string;
		description?: string;
		optional?: boolean;
		field_order?: string[];
		fields?: { [key: string]: Schema };
		choices?: { [key: string]: Schema };
	};
}

function lookupTypeFromASN1Type(attrConfig: { type?: string; description: string; }): 'struct' | 'choice' | 'primitive' {
	switch (attrConfig.type) {
		case 'SEQUENCE':
			return('struct');
		case 'CHOICE':
			return('choice');
		case 'UTF8String':
		case 'Utf8String':
		case 'GeneralizedTime':
			return('primitive');
		default:
			throw(new Error(`Unsupported attribute type for schema generation: ${attrConfig.type}`));
	}
}

/**
 * Resolve references to types within "attributes" from "iso20022_types"
 */
function processSchemaAttributes(input: oidSchemaContents): { [key: string]: Schema } {
	const iso20022Primitives = input.iso20022_types.primitives;
	const iso20022Structs = input.iso20022_types.sequences;
	const iso20022Choices = input.iso20022_types.choices;
	const iso20022Enums = input.iso20022_types.enumerations;
	const attributeTypes = Object.fromEntries(Object.values(input.attributes).map(function(attributeInfo): [string, Schema] | false {
		if (attributeInfo.token) {
			if (attributeInfo.type === undefined) {
				throw(new Error(`Attribute ${attributeInfo.token} has no defined type.`));
			}
			return([attributeInfo.token, {
				type: lookupTypeFromASN1Type(attributeInfo),
				config: {
					type: attributeInfo.type,
					description: attributeInfo.description
				}
			}]);
		}
		return(false);
	}).filter(function(item): item is [string, Schema] {
		return(!!item);
	}));

	const resolvedAttributes: { [key: string]: Schema } = {};

	for (const [attrName, attrConfig] of Object.entries(input.attributes)) {
		const type = lookupTypeFromASN1Type(attrConfig);

		const typeSpecificConfig = (function() {
			switch (type) {
				case 'struct':
					return({
						field_order: attrConfig.field_order ?? Object.keys(attrConfig.fields ?? {}),
						fields: Object.fromEntries(Object.entries((attrConfig.fields ?? {})).map(function([fieldName, fieldConfig]) {
							const { type: fieldType, config: fieldConfigResolved } = (function() {
								if (fieldConfig.type in iso20022Structs) {
									return({ type: 'struct', config: iso20022Structs[fieldConfig.type] });
								} else if (fieldConfig.type in iso20022Choices) {
									return({ type: 'choice', config: iso20022Choices[fieldConfig.type] });
								} else if (fieldConfig.type in iso20022Enums) {
									return({ type: 'enum', config: iso20022Enums[fieldConfig.type] });
								} else if (fieldConfig.type in iso20022Primitives) {
									return({ type: 'primitive', config: iso20022Primitives[fieldConfig.type] });
								} else if (fieldConfig.type in attributeTypes) {
									return({ type: attributeTypes[fieldConfig.type]!.type, config: attributeTypes[fieldConfig.type]!.config });
								} else if (fieldConfig.type?.startsWith('SEQUENCE OF ')) {
									return({ type: 'array', config: {
										type: fieldConfig.type.substring('SEQUENCE OF '.length).trim()
									}});
								} else {
									throw(new Error(`Unsupported field type for schema generation: ${fieldConfig.type}`));
								}
							})();

							return([fieldName, {
								type: fieldType,
								config: {
									// @ts-ignore
									type: fieldConfigResolved.type,
									optional: fieldConfig.optional ?? false,
									// @ts-ignore
									...(fieldConfigResolved.description ? { description: fieldConfigResolved.description } : {})
								}
							}]);
						}))
					});
				case 'choice':
					return({
					});
				case 'primitive':
					return(undefined);
			}
		})();

		resolvedAttributes[attrName] = {
			type: type,
			// @ts-ignore
			config: {
				type: attrConfig.type,
				description: attrConfig.description,
				optional: false,
				...typeSpecificConfig
			}
		}
	}

	return(resolvedAttributes);
}

/**
 * Generate ASN.1 schema from the given input schema definition
 */
function generateSchema(input: Schema): string {
	/*
	 * If the input type is something other than primitive, struct, or choice,
	 * then it must be referring to the ISO20022 types, we need to resolve that
	 * type and generate the schema accordingly.
	 */
	if (input.type !== 'primitive' && input.type !== 'struct' && input.type !== 'choice') {
	}

	switch (input.type) {
		case 'primitive':
			switch (input.config.type) {
				case 'UTF8String':
				case 'Utf8String':
					return(`{ type: 'string', kind: 'utf8' }`);
				case 'GeneralizedTime':
					return(`{ type: 'date', kind: 'generalized' }`);
				default:
					throw(new Error(`Unsupported primitive type for schema generation: ${input.config.type}`));
			}
		case 'struct': {
			const fieldOrder = input.config.field_order ?? Object.keys(input.config.fields ?? {});
			const subLines: string[] = [];
			subLines.push('[');
			for (const fieldName of fieldOrder) {
				const fieldConfig = input.config.fields?.[fieldName];
				if (fieldConfig === undefined) {
					throw(new Error(`Field ${fieldName} not found in struct attribute ${name}`));
				}

				const fieldSchema = `{ type: 'context', kind: 'explicit', value: ${subLines.length - 1}, contains: ${generateSchema(fieldConfig)} }`;
				if ('optional' in fieldConfig && fieldConfig.optional) {
					subLines.push(`\t{ optional: ${fieldSchema} },`);
				} else {
					subLines.push(`\t${fieldSchema},`);
				}

console.log(util.inspect({ fieldName, fieldConfig }, { depth: 30, colors: true }));

			}
			subLines.push(']');
			return(subLines.join('\n'));
		}
		case 'choice': { return('TBD'); }
		default:
			throw(new Error(`Unsupported attribute type for schema generation: ${input.type}`));
	}
}

//function generateISO20022TypesNew(oidSchema: oidSchemaContents): string {
//	const lines: string[] = [genHeader('Generated ISO20022 Type Definitions'), "import * as ASN1 from '../../lib/utils/asn1.js';", ''];
//	const deleteLastCommaIfFound = deleteLastCommaIfFoundGenerator(lines);
//
//	/**
//	 * Create an array of all attribute names, as well as a type
//	 * that corresponds to any of those names.
//	 */
//	lines.push('export const AttributeNames = [');
//	lines.push(...Object.entries(oidSchema.attributes).map(function([name, config]) {
//		return(
//			`\t/** ${config.description} */\n` +
//			`\t'${name}',`
//		);
//	}));
//	deleteLastCommaIfFound();
//	lines.push('] as const;');
//	lines.push('export type AttributeName = typeof AttributeNames[number];');
//	lines.push('');
//
//	lines.push('export const AttributeSchema = {');
//	for (const [name, config] of Object.entries(oidSchema.attributes)) {
//		const schema = generateSchema({ type: type, config: config });
//		lines.push(`\t'${name}': {`);
//		lines.push(`\t\ttype: ${JSON.stringify(type)},`);
//		if (type === 'struct') {
//			lines.push(`\t\tfields: ${JSON.stringify(config.field_order ?? Object.keys(config.fields ?? {}))},`);
//		}
//		lines.push(`\t\tschema: ${schema},`);
//		lines.push('\t},');
//	}
//	deleteLastCommaIfFound();
//	lines.push('} as const;');
//
//	return(lines.join('\n') + '\n');
//}
//
function parseArgs(argv: string[]): { oidsJSONPath: string; oidsOutputPath: string; iso20022OutputPath: string } {
	let oidsJSONPath: string | undefined = undefined;
	let oidsOutputPath: string | undefined = undefined;
	let iso20022OutputPath: string | undefined = undefined;
	for (const arg of argv) {
		if (arg.startsWith('--oids-json=')) {
			oidsJSONPath = arg.substring('--oids-json='.length);
		}
		if (arg.startsWith('--oids-output=')) {
			oidsOutputPath = arg.substring('--oids-output='.length);
		}
		if (arg.startsWith('--iso20022-output=')) {
			iso20022OutputPath = arg.substring('--iso20022-output='.length);
		}
	}

	if (oidsJSONPath === undefined) {
		throw(new Error('Missing required argument: --oids-json=path/to/oids.json'));
	}
	if (oidsOutputPath === undefined) {
		throw(new Error('Missing required argument: --oids-output=path/to/oids.generated.ts'));
	}
	if (iso20022OutputPath === undefined) {
		throw(new Error('Missing required argument: --iso20022-output=path/to/iso20022.generated.ts'));
	}
	if (!fs.existsSync(oidsJSONPath)) {
		throw(new Error(`OID JSON file not found: ${oidsJSONPath}`));
	}
	return({
		oidsJSONPath,
		oidsOutputPath,
		iso20022OutputPath
	});
}

// --- Main ---
function main(argv: string[]): void {
	const {
		oidsJSONPath,
		oidsOutputPath,
		iso20022OutputPath
	} = parseArgs(argv);

	fs.mkdirSync(path.dirname(oidsOutputPath), { recursive: true });
	fs.mkdirSync(path.dirname(iso20022OutputPath), { recursive: true });

	const oidSchema = typia.assert<oidSchemaContents>(JSON.parse(fs.readFileSync(oidsJSONPath, 'utf8')));
	const attributes = processSchemaAttributes(oidSchema);
console.log(util.inspect(attributes, { depth: 30, colors: true }));
	fs.writeFileSync(oidsOutputPath, generateOidConstants(oidSchema), 'utf8');
	return;
//
//	fs.writeFileSync(iso20022OutputPath, generateISO20022TypesNew(oidSchema), 'utf8');
}

main(process.argv.slice(2));
