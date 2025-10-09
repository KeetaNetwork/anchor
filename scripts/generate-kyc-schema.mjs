#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..');
const OIDS_JSON_PATH = join(ROOT_DIR, 'oids.json');
const GENERATED_DIR = join(ROOT_DIR, 'src', 'generated');
const OIDS_OUTPUT_PATH = join(GENERATED_DIR, 'oids.ts');
const ISO20022_OUTPUT_PATH = join(GENERATED_DIR, 'iso20022.ts');

mkdirSync(GENERATED_DIR, { recursive: true });
const oidSchema = JSON.parse(readFileSync(OIDS_JSON_PATH, 'utf8'));

// --- Utility Functions ---
const oidArrayToString = oid => oid.join('.');
const toConstantCase = str => str.replace(/[A-Z]/g, l => `_${l}`).toUpperCase();
const toPascalCase = str => str.split(/[_-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const toSnakeCase = str => str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');

// --- Type Resolution ---
function resolveTypeReference(typeName) {
	if (typeName.startsWith('SEQUENCE OF ')) {
		return `${resolveTypeReference(typeName.substring('SEQUENCE OF '.length).trim())}[]`;
	}
	switch (typeName.trim()) {
		case 'UTF8String':
		case 'Utf8String': return 'string';
		case 'GeneralizedTime': return 'Date';
		case 'ENUMERATED': return 'string';
		default: return toPascalCase(typeName);
	}
}

function resolveToBaseType(typeName) {
	typeName = typeName.trim();

	// Check if it's a primitive type first
	if (/^(UTF8String|Utf8String|GeneralizedTime)$/i.test(typeName)) {
		return typeName;
	}

	// Check if it's defined as a sensitive attribute
	const sensitiveAttr = oidSchema.sensitive_attributes[typeName] ||
		Object.values(oidSchema.sensitive_attributes).find(attr =>
			attr.token === typeName);
	if (sensitiveAttr && !sensitiveAttr.fields && !sensitiveAttr.choices) {
		return resolveToBaseType(sensitiveAttr.type);
	}

	// Check if it's an ISO20022 primitive
	const primitive = oidSchema.iso20022_types.primitives[typeName];
	if (primitive) {
		return resolveToBaseType(primitive.type);
	}

	// Otherwise return as-is
	return typeName;
}

function isSequenceOfChoice(config) {
	return Object.values(config.fields).every(f => f.optional) && Object.keys(config.fields).length > 0;
}

function getPrimitiveType(type) {
	if (type === 'UTF8String' || type === 'Utf8String') return 'string';
	if (type === 'GeneralizedTime') return 'date';
	return 'string';
}

// --- Output Generators ---
function genHeader(comment) {
	return [
		'/**',
		` * ${comment}`,
		' * This file is auto-generated from oids.json.',
		' */',
		''
	].join('\n');
}

function genTypeAlias(name, type, description, oid) {
	return `/** ${description} */\n/** OID: ${oid} */\nexport type ${name} = ${type};\n`;
}

function genEnumType(name, values, description, oid) {
	return `/** ${description} */\n/** OID: ${oid} */\nexport type ${name} = ${values.map(v => `'${v}'`).join(' | ')};\n`;
}

function genInterface(name, fields, description, oid) {
	const fieldLines = Object.entries(fields).map(([fname, fcfg]) =>
		`    ${fname}${fcfg.optional ? '?' : ''}: ${resolveTypeReference(fcfg.type)};`
	);
	return `/** ${description} */\n/** OID: ${oid} */\nexport interface ${name} {\n${fieldLines.join('\n')}\n}\n`;
}

function genSequenceOfChoice(name, config) {
	const typeName = toPascalCase(name);
	const fieldOrder = config.field_order || Object.keys(config.fields);
	const choiceEntries = fieldOrder.map(fieldName => [fieldName, config.fields[fieldName]]);
	const choiceTypes = choiceEntries.map(([fieldName, fieldConfig], idx) => {
		const fieldType = resolveTypeReference(fieldConfig.type);
		const choiceTypeName = `${typeName}${toPascalCase(fieldName)}Choice`;
		return {
			code: `export interface ${choiceTypeName} {\n\ttag: ${idx};\n\tname: '${fieldName}';\n\tvalue: ${fieldType};\n}\n`,
			name: choiceTypeName
		};
	});

	let out = '';
	// Individual choice interfaces
	out += choiceTypes.map(t => t.code).join('\n');
	// Union type
	out += `export type ${typeName}Choice =\n\t| ${choiceTypes.map(t => t.name).join('\n\t| ')};\n\n`;
	// Main type is array of choices
	out += `export type ${typeName} = ${typeName}Choice[];\n\n`;
	// ASN.1 schema
	out += `export const ${typeName}Schema: ASN1.Schema = {\n\tsequenceOf: {\n\t\tchoice: [\n`;
	out += choiceEntries.map(([fieldName, fieldConfig], idx) => {
		// You may want to improve validator resolution here
		return `\t\t\t{ type: 'context', kind: 'explicit', value: ${idx}, contains: { type: 'string', kind: 'utf8' } }`;
	}).join(',\n');
	out += `\n\t\t]\n\t}\n} as const satisfies ASN1.Schema;\n\n`;
	// Field names array
	out += `export const ${typeName}Fields = [\n${fieldOrder.map(f => `\t'${f}'`).join(',\n')}\n] as const;\n\n`;
	return out;
}

// --- Main Generation ---
function generateOidConstants() {
	const lines = [genHeader('Generated OID Constants')];

	// Algorithm OID constants
	lines.push('// Algorithm OID constants');
	for (const [name, oid] of Object.entries(oidSchema.algorithms)) {
		lines.push(`export const ${toConstantCase(name.replace(/-/g, '_'))} = '${oidArrayToString(oid)}';`);
	}
	lines.push('');

	// Plain attribute OID constants
	lines.push('// Plain attribute OID constants');
	for (const [name, config] of Object.entries(oidSchema.plain_attributes)) {
		lines.push(`/** ${config.description} */`);
		lines.push(`/** @see ${config.reference} */`);
		lines.push(`export const ${toConstantCase(name)} = '${oidArrayToString(config.oid)}';`);
	}
	lines.push('');

	// Keeta namespace for sensitive attributes
	lines.push('// Keeta-specific OID constants');
	lines.push('export namespace keeta {');
	for (const [name, config] of Object.entries(oidSchema.extensions)) {
		lines.push(`    /** ${config.description} */`);
		lines.push(`    /** @see ${config.reference} */`);
		lines.push(`    export const ${toConstantCase(name)} = '${oidArrayToString(config.oid)}';`);
	}
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		lines.push(`    /** ${config.description} */`);
		lines.push(`    /** @see ${config.reference} */`);
		lines.push(`    export const ${toConstantCase(name)} = '${oidArrayToString(config.oid)}';`);
	}
	lines.push('}');
	lines.push('');

	// Lookup maps
	lines.push('// OID to name lookup maps');
	lines.push('export const OID_TO_NAME: Record<string, string> = {');
	for (const [name, config] of Object.entries(oidSchema.plain_attributes)) {
		lines.push(`    '${oidArrayToString(config.oid)}': '${name}',`);
	}
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		lines.push(`    '${oidArrayToString(config.oid)}': '${name}',`);
	}
	lines.push('};');
	lines.push('');
	lines.push('export const NAME_TO_OID: Record<string, string> = {');
	for (const [name, config] of Object.entries(oidSchema.plain_attributes)) {
		lines.push(`    '${name}': '${oidArrayToString(config.oid)}',`);
	}
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		lines.push(`    '${name}': '${oidArrayToString(config.oid)}',`);
	}
	lines.push('};');
	lines.push('');

	return lines.join('\n');
}

function genSequenceSchema(typeName, fields, config) {
	const fieldOrder = config?.field_order || Object.keys(fields);
	const schemaFields = fieldOrder.map((fname, idx) => {
		const fcfg = fields[fname];
		if (!fcfg) return null;

		// Resolve to base type to handle aliases
		const baseType = resolveToBaseType(fcfg.type);

		// Check if field type is GeneralizedTime (date)
		if (baseType === 'GeneralizedTime') {
			if (fcfg.optional) {
				return `{ optional: { type: 'context', kind: 'explicit', value: ${idx}, contains: ASN1.ValidateASN1.IsDate } }`;
			} else {
				return `{ type: 'context', kind: 'explicit', value: ${idx}, contains: ASN1.ValidateASN1.IsDate }`;
			}
		}

		// Strip SEQUENCE OF prefix and [] suffix to get the base type
		let fieldType = fcfg.type.trim();
		if (fieldType.startsWith('SEQUENCE OF ')) {
			fieldType = fieldType.substring('SEQUENCE OF '.length).trim();
		}
		fieldType = fieldType.replace(/\[\]$/, '');

		const fieldTypePascal = toPascalCase(fieldType);
		const fieldTypeSnake = toSnakeCase(fieldType);

		// Check if this is a COMPLEX type (not a primitive)
		const isChoice = oidSchema.iso20022_types.choices[fieldTypeSnake] ||
			oidSchema.iso20022_types.choices[fieldType];
		const isSequence = oidSchema.iso20022_types.sequences[fieldTypeSnake] ||
			oidSchema.iso20022_types.sequences[fieldType];
		const isSensitiveSequence = oidSchema.sensitive_attributes[fieldTypeSnake] &&
			oidSchema.sensitive_attributes[fieldTypeSnake].fields;
		const isSensitiveChoice = oidSchema.sensitive_attributes[fieldTypeSnake] &&
			oidSchema.sensitive_attributes[fieldTypeSnake].choices;

		const hasSchema = isChoice || isSequence || isSensitiveSequence || isSensitiveChoice;

		let contains;
		if (hasSchema) {
			contains = `${fieldTypePascal}Schema`;
		} else {
			// Primitive type - use inline string schema
			contains = `{ type: 'string', kind: 'utf8' }`;
		}

		if (fcfg.optional) {
			return `{ optional: { type: 'context', kind: 'explicit', value: ${idx}, contains: ${contains} } }`;
		} else {
			return `{ type: 'context', kind: 'explicit', value: ${idx}, contains: ${contains} }`;
		}
	}).filter(Boolean);

	return `export const ${typeName}Schema: ASN1.Schema = [\n    ${schemaFields.join(',\n    ')}\n] as const satisfies ASN1.Schema;`;
}

function generateIso20022Types() {
	const lines = [genHeader('Generated ISO20022 Type Definitions'), "import * as ASN1 from '../lib/utils/asn1.js';", ''];

	// Primitives
	lines.push('// ISO20022 Primitive Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.primitives)) {
		lines.push(genTypeAlias(toPascalCase(name), resolveTypeReference(config.type), config.description, oidArrayToString(config.oid)));
	}

	// Enumerations
	lines.push('// ISO20022 Enumeration Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.enumerations)) {
		lines.push(genEnumType(toPascalCase(name), config.values, config.description, oidArrayToString(config.oid)));
	}

	// Choices
	lines.push('// ISO20022 Choice Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.choices)) {
		const typeName = toPascalCase(name);
		const choices = Object.entries(config.choices || {});
		const hasComplexTypes = choices.some(([_, choice]) => {
			const choiceType = choice.type.trim();
			return choiceType !== 'UTF8String' && choiceType !== 'string';
		});
		if (hasComplexTypes) {
			const unionTypes = choices.map(([_, choice]) => toPascalCase(choice.type.trim()));
			lines.push(genTypeAlias(typeName, unionTypes.join(' | '), config.description, oidArrayToString(config.oid)));
		} else {
			lines.push(genTypeAlias(typeName, 'string', config.description, oidArrayToString(config.oid)));
		}
	}

	// ISO20022 Sequences and Sequence-of-Choice Types
	lines.push('// ISO20022 Sequence Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.sequences)) {
		if (isSequenceOfChoice(config)) {
			lines.push(genSequenceOfChoice(name, config));
		} else {
			lines.push(genInterface(toPascalCase(name), config.fields, config.description, oidArrayToString(config.oid)));
		}
	}
	lines.push('');

	// --- Choice Type Schemas ---
	lines.push('// Generated ASN.1 schemas for ISO 20022 choice types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.choices)) {
		const typeName = toPascalCase(name);
		lines.push(`/** ASN.1 schema for ${typeName} */`);
		lines.push(`export const ${typeName}Schema: ASN1.Schema = { type: 'string', kind: 'utf8' };`);
		lines.push('');
	}

	// --- Sequence Type Schemas ---
	lines.push('// Generated ASN.1 schemas for ISO 20022 sequence types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.sequences)) {
		const typeName = toPascalCase(name);
		if (config.fields && !isSequenceOfChoice(config)) {
			lines.push(`/** ASN.1 schema for ${typeName} */`);
			lines.push(genSequenceSchema(typeName, config.fields, config));
			lines.push('');
		}
	}

	// --- Choice-Type Sensitive Attribute Schemas ---
	lines.push('// Generated ASN.1 schemas for choice-type sensitive attributes');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		const typeName = toPascalCase(name);
		if (config.choices) {
			const choiceSchemas = Object.values(config.choices).map(choice => {
				const choiceTypeName = toPascalCase(choice.type.trim());
				return `${choiceTypeName}Schema`;
			});
			lines.push(`/** ASN.1 schema for ${typeName} */`);
			lines.push(`export const ${typeName}Schema: ASN1.Schema = {`);
			lines.push(`\tchoice: [`);
			lines.push(`\t\t${choiceSchemas.join(',\n\t\t')}`);
			lines.push(`\t]`);
			lines.push(`} as const satisfies ASN1.Schema;`);
			lines.push('');
		}
	}

	// Sensitive Attribute Types
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		const typeName = toPascalCase(name);
		if (!config.fields && !config.choices) {
			// Primitive type
			let baseType;
			if (config.type === 'UTF8String' || config.type === 'Utf8String') baseType = 'string';
			else if (config.type === 'GeneralizedTime') baseType = 'Date';
			else baseType = toPascalCase(config.type);
			lines.push(`/** ${config.description} */`);
			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
			lines.push(`export type ${typeName} = ${baseType};`);
			lines.push('');
		} else if (config.fields) {
			// Sequence type
			lines.push(`/** ${config.description} */`);
			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
			lines.push(`export interface ${typeName} {`);
			for (const [fieldName, fieldConfig] of Object.entries(config.fields)) {
				const optional = fieldConfig.optional ? '?' : '';
				const resolvedType = resolveTypeReference(fieldConfig.type);
				lines.push(`    ${fieldName}${optional}: ${resolvedType};`);
			}
			lines.push('}');
			lines.push('');
		} else if (config.choices) {
			// Choice type
			lines.push(`/** ${config.description} */`);
			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
			const hasComplexTypes = Object.values(config.choices).some(choice => {
				const choiceType = choice.type.trim();
				return choiceType !== 'UTF8String' && choiceType !== 'string';
			});
			if (hasComplexTypes) {
				const unionTypes = Object.values(config.choices).map(choice => toPascalCase(choice.type.trim()));
				lines.push(`export type ${typeName} = ${unionTypes.join(' | ')};`);
			} else {
				lines.push(`export type ${typeName} = string;`);
			}
			lines.push('');
		}
	}

	// Token aliases for sensitive attributes
	lines.push('// Token aliases for sensitive attributes');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		if (config.token && config.token !== toPascalCase(name)) {
			const typeName = toPascalCase(name);
			const tokenName = config.token;
			lines.push(`/** Alias for ${typeName} */`);
			lines.push(`export type ${tokenName} = ${typeName};`);
			lines.push('');
		}
	}

	// Union type, value map, helper generic
	lines.push('/** Union type of all sensitive attribute types */');
	lines.push('export type SensitiveAttributeType =');
	lines.push(Object.keys(oidSchema.sensitive_attributes).map(name => `    | ${toPascalCase(name)}`).join('\n') + ';');
	lines.push('');
	lines.push('/** Map of attribute name to acceptable input type for CertificateBuilder.setAttribute */');
	lines.push('export interface CertificateAttributeValueMap {');
	for (const [name] of Object.entries(oidSchema.sensitive_attributes)) {
		lines.push(`    '${name}': ${toPascalCase(name)};`);
	}
	lines.push('}');
	lines.push('');
	lines.push('/** Helper generic to get attribute value type by name */');
	lines.push('export type CertificateAttributeValue<Name extends keyof CertificateAttributeValueMap> = CertificateAttributeValueMap[Name];');
	lines.push('');

	// Field arrays and schemas for sequence types
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		const typeName = toPascalCase(name);
		if (config.fields) {
			const fieldOrder = config.field_order || Object.keys(config.fields);
			lines.push(`export const ${typeName}Fields = [${fieldOrder.map(f => `'${f}'`).join(', ')}] as const;`);
			lines.push(genSequenceSchema(typeName, config.fields, config));
		}
	}

	// OID DB
	lines.push('export const CertificateAttributeOIDDB = {');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		lines.push(`    '${name}': '${oidArrayToString(config.oid)}',`);
	}
	lines.push('} as const;');
	lines.push('');

	// Sensitive attribute list
	lines.push('export const SENSITIVE_CERTIFICATE_ATTRIBUTES = [');
	for (const name of Object.keys(oidSchema.sensitive_attributes)) {
		lines.push(`    '${name}',`);
	}
	lines.push('] as const;');
	lines.push('');

	lines.push('export type SensitiveCertificateAttributeNames = typeof SENSITIVE_CERTIFICATE_ATTRIBUTES[number];');
	lines.push('');

	// PascalCase names
	lines.push('export const SensitiveCertificateAttributeNames = [');
	for (const name of Object.keys(oidSchema.sensitive_attributes)) {
		lines.push(`    '${toPascalCase(name)}',`);
	}
	lines.push('] as const;');
	lines.push('');

	// Field name mapping
	lines.push('export const CertificateAttributeFieldNames: { readonly [K in keyof typeof CertificateAttributeOIDDB]?: readonly string[] } = {');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		if (config.fields) {
			const typeName = toPascalCase(name);
			lines.push(`    '${name}': ${typeName}Fields,`);
		}
	}
	lines.push('} as const;');
	lines.push('');

	// Complete schema mapping (ONCE, at the end)
	lines.push('export const CertificateAttributeSchema: { readonly [K in keyof typeof CertificateAttributeOIDDB]: ASN1.Schema } = {');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		const typeName = toPascalCase(name);
		let schemaRef;
		if (config.fields) {
			schemaRef = `${typeName}Schema`;
		} else if (config.choices) {
			schemaRef = `${typeName}Schema`;
		} else {
			const baseType = resolveToBaseType(config.type);
			if (baseType === 'GeneralizedTime') {
				schemaRef = 'ASN1.ValidateASN1.IsDate';
			} else {
				schemaRef = `{ type: 'string', kind: 'utf8' }`;
			}
		}
		lines.push(`    '${name}': ${schemaRef},`);
	}
	lines.push('} as const;');

	return lines.join('\n');
}

// --- Main ---
function main() {
	console.log('Generating KYC schema from oids.json...');
	writeFileSync(OIDS_OUTPUT_PATH, generateOidConstants(), 'utf8');
	writeFileSync(ISO20022_OUTPUT_PATH, generateIso20022Types(), 'utf8');
	console.log('✓ KYC schema generation complete!');
}

main();
