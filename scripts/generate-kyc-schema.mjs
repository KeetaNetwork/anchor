#!/usr/bin/env node

/**
 * KYC Schema Generator
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const ROOT_DIR = join(__dirname, '..');
const OIDS_JSON_PATH = join(ROOT_DIR, 'oids.json');
const GENERATED_DIR = join(ROOT_DIR, 'src', 'generated');
const OIDS_OUTPUT_PATH = join(GENERATED_DIR, 'oids.ts');
const ISO20022_OUTPUT_PATH = join(GENERATED_DIR, 'iso20022.ts');

// Ensure generated directory exists
mkdirSync(GENERATED_DIR, { recursive: true });

// Load OID schema
const oidSchema = JSON.parse(readFileSync(OIDS_JSON_PATH, 'utf8'));

/**
 * Convert OID array to dot-separated string
 */
function oidArrayToString(oid) {
	return oid.join('.');
}

/**
 * Convert snake_case to SCREAMING_SNAKE_CASE
 */
function toConstantCase(str) {
	return str.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase();
}

/**
 * Convert snake_case/camelCase to PascalCase
 */
function toPascalCase(str) {
	return str
		.split(/[_-]/)
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join('');
}

/**
 * Resolve a type to its underlying ASN.1 type, following aliases
 */
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

/**
 * Generate OID constants file (similar to oids.rs)
 */
function generateOidConstants() {
	const lines = [
		'/**',
		' * Generated OID Constants',
		' * ',
		' * This file is auto-generated from oids.json.',
		' * Do not edit manually - run `make schema` to regenerate.',
		' */',
		''
	];

	// Algorithm OID constants
	lines.push('// Algorithm OID constants');
	for (const [name, oid] of Object.entries(oidSchema.algorithms)) {
		const constName = toConstantCase(name.replace(/-/g, '_'));
		const oidString = oidArrayToString(oid);
		lines.push(`export const ${constName} = '${oidString}';`);
	}
	lines.push('');

	// Plain attribute OID constants
	lines.push('// Plain attribute OID constants');
	for (const [name, config] of Object.entries(oidSchema.plain_attributes)) {
		const constName = toConstantCase(name);
		const oidString = oidArrayToString(config.oid);
		lines.push(`/** ${config.description} */`);
		lines.push(`/** @see ${config.reference} */`);
		lines.push(`export const ${constName} = '${oidString}';`);
	}
	lines.push('');

	// Keeta namespace for sensitive attributes (similar to Rust's pub mod keeta)
	lines.push('// Keeta-specific OID constants');
	lines.push('export namespace keeta {');
	
	// Extension OIDs
	for (const [name, config] of Object.entries(oidSchema.extensions)) {
		const constName = toConstantCase(name);
		const oidString = oidArrayToString(config.oid);
		lines.push(`	/** ${config.description} */`);
		lines.push(`	/** @see ${config.reference} */`);
		lines.push(`	export const ${constName} = '${oidString}';`);
	}
	lines.push('');

	// Sensitive attribute OIDs
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		const constName = toConstantCase(name);
		const oidString = oidArrayToString(config.oid);
		lines.push(`	/** ${config.description} */`);
		lines.push(`	/** @see ${config.reference} */`);
		lines.push(`	export const ${constName} = '${oidString}';`);
	}
	
	lines.push('}');
	lines.push('');

	// Create lookup maps (similar to lazy_static in Rust)
	lines.push('// OID to name lookup maps');
	lines.push('export const OID_TO_NAME: Record<string, string> = {');
	
	for (const [name, config] of Object.entries(oidSchema.plain_attributes)) {
		lines.push(`	'${oidArrayToString(config.oid)}': '${name}',`);
	}
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		lines.push(`	'${oidArrayToString(config.oid)}': '${name}',`);
	}
	
	lines.push('};');
	lines.push('');

	lines.push('export const NAME_TO_OID: Record<string, string> = {');
	
	for (const [name, config] of Object.entries(oidSchema.plain_attributes)) {
		lines.push(`	'${name}': '${oidArrayToString(config.oid)}',`);
	}
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		lines.push(`	'${name}': '${oidArrayToString(config.oid)}',`);
	}
	
	lines.push('};');
	lines.push('');

	return lines.join('\n');
}

/**
 * Map ASN.1 primitive type to TypeScript type
 */
function mapAsnTypeToTs(asnType) {
	// Strip whitespace
	asnType = asnType.trim();
	
	switch (asnType) {
		case 'UTF8String':
		case 'Utf8String':
			return 'string';
		case 'GeneralizedTime':
			return 'Date';
		case 'SEQUENCE':
			return 'object';
		case 'CHOICE':
			return 'object';
		case 'ENUMERATED':
			return 'string';
		default:
			return null;
	}
}

/**
 * Map ASN.1 type to ASN1.ValidateASN1 validator
 */
function mapAsnTypeToValidator(asnType, config) {
	// Strip whitespace
	asnType = asnType.trim();
	
	switch (asnType) {
		case 'UTF8String':
		case 'Utf8String':
			return 'ASN1.ValidateASN1.IsString';
		case 'GeneralizedTime':
			return 'ASN1.ValidateASN1.IsDate';
		case 'SEQUENCE':
			// Check if it has fields - if not, treat as generic sequence
			if (config && config.fields) {
				// Complex sequence - not supported for simple mapping
				return null;
			}
			return null;
		case 'CHOICE':
			// Complex type - not supported
			return null;
		default:
			return null;
	}
}

/**
 * Resolve a type reference to its TypeScript type
 * Handles primitive types, generated types, and complex types like SEQUENCE OF
 */
function resolveTypeReference(typeName) {
	// Handle SEQUENCE OF patterns
	if (typeName.startsWith('SEQUENCE OF ')) {
		const elementType = typeName.substring('SEQUENCE OF '.length).trim();
		// Recursively resolve the element type
		return `${resolveTypeReference(elementType)}[]`;
	}
	
	// Check if it's a primitive ASN.1 type
	const primitiveType = mapAsnTypeToTs(typeName);
	if (primitiveType !== null) {
		return primitiveType;
	}
	
	// Otherwise assume it's a generated type and use PascalCase
	return toPascalCase(typeName);
}

/**
 * Generate ISO20022 type definitions (similar to iso20022.rs)
 */
function generateIso20022Types() {
	const lines = [
		'/**',
		' * Generated ISO20022 Type Definitions',
		' * ',
		' * This file is auto-generated from oids.json.',
		' * Do not edit manually - regenerate using the Makefile.',
		' */',
		'',
		'/* eslint-disable */',
		'',
		"import * as ASN1 from '../lib/utils/asn1.js';",
		''
	];

	// Generate primitive types as TypeScript types (simple aliases)
	lines.push('// ISO20022 Primitive Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.primitives)) {
		const typeName = toPascalCase(name);
		const resolvedType = resolveTypeReference(config.type);
		lines.push(`/** ${config.description} */`);
		lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
		lines.push(`export type ${typeName} = ${resolvedType};`);
		lines.push('');
	}

	// Generate enumeration types
	lines.push('// ISO20022 Enumeration Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.enumerations)) {
		const typeName = toPascalCase(name);
		lines.push(`/** ${config.description} */`);
		lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
		const values = config.values.map(v => `'${v}'`).join(' | ');
		lines.push(`export type ${typeName} = ${values};`);
		lines.push('');
	}

	// Generate choice types
	lines.push('// ISO20022 Choice Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.choices)) {
		const typeName = toPascalCase(name);
		const choices = Object.entries(config.choices || {});
		
		// Check if this is a complex choice (with different types) or simple choice (all strings)
		const hasComplexTypes = choices.some(([_, choice]) => {
			const choiceType = choice.type.trim();
			return choiceType !== 'UTF8String' && choiceType !== 'string';
		});
		
		if (hasComplexTypes) {
			// For complex choices like EntityType, use a union of the actual types
			const unionTypes = choices.map(([_, choice]) => {
				return toPascalCase(choice.type.trim());
			});
			lines.push(`/** ${config.description} */`);
			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
			lines.push(`export type ${typeName} = ${unionTypes.join(' | ')};`);
		} else {
			// For simple string choices, just use string
			lines.push(`/** ${config.description} */`);
			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
			lines.push(`export type ${typeName} = string;`);
		}
		lines.push('');
	}

	// Generate sequence types (interfaces)
	lines.push('// ISO20022 Sequence Types');
	for (const [name, config] of Object.entries(oidSchema.iso20022_types.sequences)) {
		const typeName = toPascalCase(name);
		lines.push(`/** ${config.description} */`);
		lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
		lines.push(`export interface ${typeName} {`);
		
		for (const [fieldName, fieldConfig] of Object.entries(config.fields)) {
			const optional = fieldConfig.optional ? '?' : '';
			const resolvedType = resolveTypeReference(fieldConfig.type);
			lines.push(`	${fieldName}${optional}: ${resolvedType};`);
		}
		
		lines.push('}');
		lines.push('');
	}

	// Generate main sensitive attribute types
	lines.push('// Sensitive Attribute Types');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		if (!config.fields && !config.choices) {
			// Simple type
			const typeName = toPascalCase(name);
			const baseType = mapAsnTypeToTs(config.type);
			lines.push(`/** ${config.description} */`);
			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
			lines.push(`export type ${typeName} = ${baseType};`);
			lines.push('');
		} else if (config.fields) {
			// Complex sequence type
			const typeName = toPascalCase(name);
			lines.push(`/** ${config.description} */`);
			lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
			lines.push(`export interface ${typeName} {`);
			
			for (const [fieldName, fieldConfig] of Object.entries(config.fields)) {
				const optional = fieldConfig.optional ? '?' : '';
				const resolvedType = resolveTypeReference(fieldConfig.type);
				lines.push(`	${fieldName}${optional}: ${resolvedType};`);
			}
			
			lines.push('}');
			lines.push('');
		} else if (config.choices) {
            // Choice type - generate as simple union
            const typeName = toPascalCase(name);
            lines.push(`/** ${config.description} */`);
            lines.push(`/** OID: ${oidArrayToString(config.oid)} */`);
            
            // Check if it has complex types
            const hasComplexTypes = Object.values(config.choices).some(choice => {
                const choiceType = choice.type.trim();
                return choiceType !== 'UTF8String' && choiceType !== 'string';
            });
            
            if (hasComplexTypes) {
                // Complex choice - use union of types
                const unionTypes = Object.values(config.choices).map(choice => {
                    return toPascalCase(choice.type.trim());
                });
                lines.push(`export type ${typeName} = ${unionTypes.join(' | ')};`);
            } else {
                // Simple choice - just string
                lines.push(`export type ${typeName} = string;`);
            }
            lines.push('');
        }
	}

	// Generate token aliases for sensitive attributes
	lines.push('// Token aliases for sensitive attributes');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		if (config.token) {
			const typeName = toPascalCase(name);
			const tokenName = config.token;
			if (tokenName !== typeName) {
				lines.push(`/** Alias for ${typeName} */`);
				lines.push(`export type ${tokenName} = ${typeName};`);
				lines.push('');
			}
		}
	}

	// Generate union type for all sensitive attributes
	lines.push('// Union type for all sensitive attributes');
	const sensitiveTypeNames = Object.keys(oidSchema.sensitive_attributes).map(name => toPascalCase(name));
	lines.push(`/** Union type of all sensitive attribute types */`);
	lines.push(`export type SensitiveAttributeType = `);
	lines.push(sensitiveTypeNames.map(name => `	| ${name}`).join('\n'));
	lines.push(';');
	lines.push('');

	// Generate CertificateAttributeValueMap for builder input typing.
	// Complex (sequence/choice) attributes now map to their exported interfaces/types.
	// Address retains legacy support for passing a raw string[] (will be deprecated) to avoid immediate test breakage.
	lines.push('// Certificate attribute value map (auto-generated).');
	lines.push('/** Map of attribute name to acceptable input type for CertificateBuilder.setAttribute */');
	lines.push('export interface CertificateAttributeValueMap {');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		const typeName = toPascalCase(name);
		let tsType = typeName; // default to exported type alias/interface
		if (!config.fields && !config.choices) {
			// primitive alias types already defined (e.g., FullName = string)
			tsType = typeName;
		} else if (config.fields || config.choices) {
			// sequence or choice -> interface or union type already exported
			tsType = typeName;
		}
		lines.push(`\t'${name}': ${tsType};`);
	}
	lines.push('}');
	lines.push('');
	lines.push('/** Helper generic to get attribute value type by name */');
	lines.push('export type CertificateAttributeValue<Name extends keyof CertificateAttributeValueMap> = CertificateAttributeValueMap[Name];');
	lines.push('');

    // Generate ASN.1 schemas for ISO 20022 choice types
    lines.push('// Generated ASN.1 schemas for ISO 20022 choice types');
    for (const [name, config] of Object.entries(oidSchema.iso20022_types.choices)) {
        const typeName = toPascalCase(name);
        
        // For simple string choices, just use IsString
        const choices = Object.entries(config.choices || {});
        const hasComplexTypes = choices.some(([_, choice]) => {
            const choiceType = choice.type.trim();
            return choiceType !== 'UTF8String' && choiceType !== 'string';
        });
        
        if (hasComplexTypes) {
            // Complex choice - use choice array
            lines.push(`/** ASN.1 schema for ${typeName} */`);
            lines.push(`export const ${typeName}Schema: ASN1.Schema = {`);
            lines.push(`\tchoice: [`);
            
            const choiceSchemas = choices.map(([_, choice]) => {
                const choiceType = toPascalCase(choice.type.trim());
                return `\t\t${choiceType}Schema`;
            });
            
            lines.push(choiceSchemas.join(',\n'));
            lines.push(`\t]`);
            lines.push(`} as const satisfies ASN1.Schema;`);
        } else {
            // Simple string choice
            lines.push(`/** ASN.1 schema for ${typeName} */`);
            lines.push(`export const ${typeName}Schema: ASN1.Schema = ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString;`);
        }
        lines.push('');
    }

	// Generate ASN.1 sequence schemas for sensitive attributes that are sequences
	lines.push('// Generated ASN.1 sequence schemas for sensitive attributes');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		if (config.fields) {
			const typeName = toPascalCase(name);

			lines.push(`/** ASN.1 schema for ${typeName} (sequence) */`);
			lines.push(`export const ${typeName}Schema: ASN1.Schema = [`);

			// Use field_order if specified, otherwise use Object.entries order
			const fieldOrder = config.field_order || Object.keys(config.fields);
			const fieldEntries = fieldOrder.map(fieldName => [fieldName, config.fields[fieldName]]);
			
			for (const [fieldName, fieldConfig] of fieldEntries) {
                let validator;
                const ft = fieldConfig.type.trim();
                // Resolve type aliases to base types
                const baseType = resolveToBaseType(ft);
                
                // Check if the type is inline "SEQUENCE OF SomeType"
				if (ft.startsWith('SEQUENCE OF ')) {
					const elementType = ft.substring('SEQUENCE OF '.length).trim();
					const isSequenceType = Object.keys(oidSchema.iso20022_types.sequences).some(key => 
						toPascalCase(key) === toPascalCase(elementType));
					
					if (/^UTF8String$/i.test(elementType)) {
						validator = `ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString`;
					} else if (isSequenceType) {
						const referencedType = toPascalCase(elementType);
						validator = `${referencedType}Schema`;
					} else {
						validator = `ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString`;
					}
				}
                // Check if this references a choice type
                else if (Object.keys(oidSchema.iso20022_types.choices).some(key => 
                    toPascalCase(key) === toPascalCase(ft))) {
                    const referencedType = toPascalCase(ft);
                    validator = `${referencedType}Schema`;
                }
                // Check if this references another sequence type (non-array)
                else if (Object.keys(oidSchema.iso20022_types.sequences).some(key => 
                    toPascalCase(key) === toPascalCase(ft)) ||
                         Object.keys(oidSchema.sensitive_attributes).some(key => 
                    toPascalCase(key) === toPascalCase(ft) && oidSchema.sensitive_attributes[key].fields)) {
                    const referencedType = toPascalCase(ft);
                    validator = `${referencedType}Schema`;
                }
                // Check if this references a primitive type
                else if (oidSchema.iso20022_types.primitives[ft]) {
                    const primitiveConfig = oidSchema.iso20022_types.primitives[ft];
					if (primitiveConfig.type.startsWith('SEQUENCE OF ')) {
						const elementType = primitiveConfig.type.substring('SEQUENCE OF '.length).trim();
						// Don't wrap in { sequenceOf: ... }
						if (elementType === 'UTF8String') {
							validator = 'ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString';
						} else {
							validator = `${toPascalCase(elementType)}Schema`;
						}
					} else {
						validator = mapAsnTypeToValidator(primitiveConfig.type, primitiveConfig) || 'ASN1.ValidateASN1.IsString';
						if (!validator.startsWith('{')) {
							validator = `${validator} as typeof ${validator}`;
						}
					}
                }
                // Primitive types - use resolved base type
                else if (/^GeneralizedTime$/i.test(baseType)) {
                    validator = 'ASN1.ValidateASN1.IsDate as typeof ASN1.ValidateASN1.IsDate';
                } else if (/^UTF8String$/i.test(baseType) || /^Utf8String$/i.test(baseType)) {
                    validator = 'ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString';
                } else {
                    validator = 'ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString';
                }
                    
                // Add to schema
				const fieldIndex = fieldOrder.indexOf(fieldName);
				const contextTag = `{ type: 'context', kind: 'explicit', value: ${fieldIndex}, contains: ${validator} }`;
				
				// Add to schema
				if (fieldConfig.optional) {
					lines.push(`\t{ optional: ${contextTag} }, // ${fieldName}`);
				} else {
					lines.push(`\t${contextTag}, // ${fieldName}`);
				}
            }
			
			lines.push('] as const satisfies ASN1.Schema;');
			lines.push('');
			
			// Generate field names array for runtime mapping
			lines.push(`/** Field names for ${typeName} in schema order */`);
			lines.push(`export const ${typeName}Fields = [`);
			const fieldNames = config.field_order || Object.keys(config.fields);
			for (const fieldName of fieldNames) {
				lines.push(`\t'${fieldName}',`);
			}
			lines.push('] as const;');
			lines.push('');
		}
	}

    // Generate ASN.1 schemas for ISO 20022 sequence types
    lines.push('// Generated ASN.1 schemas for ISO 20022 sequence types');
    for (const [name, config] of Object.entries(oidSchema.iso20022_types.sequences)) {
        const typeName = toPascalCase(name);
        lines.push(`/** ASN.1 schema for ${typeName} */`);
        lines.push(`export const ${typeName}Schema: ASN1.Schema = [`);
        
        // Use field_order if available, otherwise Object.keys
        const fieldOrder = config.field_order || Object.keys(config.fields);
        const fieldEntries = fieldOrder.map(fieldName => [fieldName, config.fields[fieldName]]);
        
		for (const [fieldName, fieldConfig] of fieldEntries) {
            let validator;
            const ft = fieldConfig.type.trim();
            // Resolve type aliases to base types
            const baseType = resolveToBaseType(ft);
            
            // Check if the type is inline "SEQUENCE OF SomeType"
			if (ft.startsWith('SEQUENCE OF ')) {
				const elementType = ft.substring('SEQUENCE OF '.length).trim();
				const isSequenceType = Object.keys(oidSchema.iso20022_types.sequences).some(key => 
					toPascalCase(key) === toPascalCase(elementType));
				
				if (/^UTF8String$/i.test(elementType)) {
					validator = `ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString`;
				} else if (isSequenceType) {
					const referencedType = toPascalCase(elementType);
					validator = `${referencedType}Schema`;
				} else {
					validator = `ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString`;
				}
			}
            // Check if this references a choice type
            else if (Object.keys(oidSchema.iso20022_types.choices).some(key => 
                toPascalCase(key) === toPascalCase(ft))) {
                const referencedType = toPascalCase(ft);
                validator = `${referencedType}Schema`;
            }
            // Check if this references another sequence type (non-array)
            else if (Object.keys(oidSchema.iso20022_types.sequences).some(key => 
                toPascalCase(key) === toPascalCase(ft)) ||
                     Object.keys(oidSchema.sensitive_attributes).some(key => 
                toPascalCase(key) === toPascalCase(ft) && oidSchema.sensitive_attributes[key].fields)) {
                const referencedType = toPascalCase(ft);
                validator = `${referencedType}Schema`;
            }
            // Check if this references a primitive type
            else if (oidSchema.iso20022_types.primitives[ft]) {
                const primitiveConfig = oidSchema.iso20022_types.primitives[ft];
				if (primitiveConfig.type.startsWith('SEQUENCE OF ')) {
					const elementType = primitiveConfig.type.substring('SEQUENCE OF '.length).trim();
					// Don't wrap in { sequenceOf: ... }
					if (elementType === 'UTF8String') {
						validator = 'ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString';
					} else {
						validator = `${toPascalCase(elementType)}Schema`;
					}
				} else {
					validator = mapAsnTypeToValidator(primitiveConfig.type, primitiveConfig) || 'ASN1.ValidateASN1.IsString';
					if (!validator.startsWith('{')) {
						validator = `${validator} as typeof ${validator}`;
					}
				}
            }
            // Primitive types - use resolved base type
            else if (/^GeneralizedTime$/i.test(baseType)) {
                validator = 'ASN1.ValidateASN1.IsDate as typeof ASN1.ValidateASN1.IsDate';
            } else if (/^UTF8String$/i.test(baseType) || /^Utf8String$/i.test(baseType)) {
                validator = 'ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString';
            } else {
                validator = 'ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString';
            }
            
			// Add context tag for ALL fields in sequences with optional fields
            const fieldIndex = fieldOrder.indexOf(fieldName);
            const contextTag = `{ type: 'context', kind: 'explicit', value: ${fieldIndex}, contains: ${validator} }`;
            
            // Add to schema
            if (fieldConfig.optional) {
                lines.push(`\t{ optional: ${contextTag} }, // ${fieldName}`);
            } else {
                lines.push(`\t${contextTag}, // ${fieldName}`);
            }
        }

        lines.push(`] as const satisfies ASN1.Schema;`);
        lines.push('');
    }

    // Generate ASN.1 schemas for choice-type sensitive attributes
    lines.push('// Generated ASN.1 schemas for choice-type sensitive attributes');
    for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		if (config.choices) {
            const typeName = toPascalCase(name);
            lines.push(`/** ASN.1 schema for ${typeName} */`);
            lines.push(`export const ${typeName}Schema: ASN1.Schema = {`);
            lines.push(`\tchoice: [`);
            
            const choiceSchemas = Object.values(config.choices).map(choice => {
                const choiceType = toPascalCase(choice.type.trim());
                return `\t\t${choiceType}Schema`;
            });
            
            lines.push(choiceSchemas.join(',\n'));
            lines.push(`\t]`);
            lines.push(`} as const satisfies ASN1.Schema;`);
            lines.push('');
        }
    }

	// Generate CertificateAttributeOIDDB constant
	lines.push('// Certificate attribute OID database');
	lines.push('/** Database of certificate attribute OIDs */');
	lines.push('export const CertificateAttributeOIDDB = {');
	
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		const oidString = oidArrayToString(config.oid);
		lines.push(`	'${name}': '${oidString}',`);
	}
	
	lines.push('} as const;');
	lines.push('');

	// Explicit list of attributes that are defined as sensitive in oids.json
	lines.push('// Explicit list of sensitive certificate attributes (auto-generated)');
	lines.push('/** Attribute names that must be encoded as sensitive values */');
	lines.push('export const SENSITIVE_CERTIFICATE_ATTRIBUTES = [');
	for (const name of Object.keys(oidSchema.sensitive_attributes)) {
		lines.push(`	'${name}',`);
	}
	lines.push('] as const;');
	lines.push('');
	lines.push('export type SensitiveCertificateAttributeNames = typeof SENSITIVE_CERTIFICATE_ATTRIBUTES[number];');
	lines.push('');

	// Generate CertificateAttributeFieldNames mapping
	lines.push('// Certificate attribute field name mapping');
	lines.push('/** Maps attribute names to their field name arrays */');
	lines.push('export const CertificateAttributeFieldNames: { readonly [K in keyof typeof CertificateAttributeOIDDB]?: readonly string[] } = {');
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
		if (config.fields) {
			const typeName = toPascalCase(name);
			lines.push(`\t'${name}': ${typeName}Fields,`);
		}
	}
	lines.push('} as const;');
	lines.push('');

	// Generate CertificateAttributeSchema constant
	lines.push('// Certificate attribute ASN.1 schema mapping');
	lines.push('/** ASN.1 schema for certificate attributes (requires ASN1 from @keetanetwork/keetanet-client) */');
	lines.push('export const CertificateAttributeSchema: { readonly [K in keyof typeof CertificateAttributeOIDDB]: ASN1.Schema } = {');
	
	for (const [name, config] of Object.entries(oidSchema.sensitive_attributes)) {
        const typeName = toPascalCase(name);
        
        if (config.fields) {
            // Sequence type - use generated schema
            lines.push(`\t'${name}': ${typeName}Schema,`);
        } else if (config.choices) {
            // Choice type - use generated schema
            lines.push(`\t'${name}': ${typeName}Schema,`);
        } else {
            // Primitive type - use validator
            let validator = mapAsnTypeToValidator(config.type, config);
            if (validator) {
                validator = `${validator} as typeof ${validator}`;
                lines.push(`\t'${name}': ${validator},`);
            } else {
                // Fallback for unknown types
                lines.push(`\t'${name}': ASN1.ValidateASN1.IsString as typeof ASN1.ValidateASN1.IsString,`);
            }
        }
    }
	
	lines.push('} as const;');
	lines.push('');

	return lines.join('\n');
}

/**
 * Main generation function
 */
function main() {
	console.log('Generating KYC schema from oids.json...');
	console.log('');

	// Generate OID constants
	console.log('Generating OID constants...');
	const oidsContent = generateOidConstants();
	writeFileSync(OIDS_OUTPUT_PATH, oidsContent, 'utf8');
	console.log(`✓ Generated ${OIDS_OUTPUT_PATH}`);

	// Generate ISO20022 types
	console.log('Generating ISO20022 types...');
	const iso20022Content = generateIso20022Types();
	writeFileSync(ISO20022_OUTPUT_PATH, iso20022Content, 'utf8');
	console.log(`✓ Generated ${ISO20022_OUTPUT_PATH}`);

	console.log('');
	console.log('✓ KYC schema generation complete!');
}

// Run the generator
main();
