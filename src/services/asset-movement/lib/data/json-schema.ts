/** JSON Schema subset: objects + unions + primitives (string/number) w/ validations */
export type Schema =
  | UnionSchema
  | ObjectSchema
  | StringSchema
  | NumberSchema
  | IntegerSchema
  | ArraySchema
  | ReferenceSchema;

/** Common metadata/annotations supported by JSON Schema (subset) */
export interface SchemaMeta {
	$id?: string;
	title?: string;
	description?: string;
}

// /** anyOf / oneOf unions */
export interface UnionSchema<InnerSchemas extends Schema[] = Schema[]> extends SchemaMeta {
	oneOf?: InnerSchemas;
}

export interface ReferenceSchema {
	$ref: string;
}

/** Object schema */
export interface ObjectSchema extends SchemaMeta {
	type: "object";

	/** Property schemas by key */
	properties?: { [key: string]: Schema };

	/**
   * Optional fields are those NOT listed in `required`.
   * If omitted/empty, all properties are optional.
   */
	required?: string[];
}

/** String schema + validations + literals */
export interface StringSchema extends SchemaMeta {
	type: "string";

	/** Literal / enum constraints */
	const?: string;
	enum?: string[];

	/** Validation keywords */
	minLength?: number;
	maxLength?: number;
	pattern?: string;
}

/** Base numeric validations used by number/integer */
export interface NumericValidation {
	/** Inclusive by default */
	minimum?: number;
	maximum?: number;
}

/** Number schema */
export interface NumberSchema extends SchemaMeta, NumericValidation {
	type: "number";

	/** Literal / enum constraints */
	const?: number;
	enum?: number[];
}

/** Integer schema (optional but common in JSON Schema) */
export interface IntegerSchema extends SchemaMeta, NumericValidation {
	type: "integer";

	const?: number;
	enum?: number[];
}

/** Array schema */
export interface ArraySchema extends SchemaMeta {
	type: "array";

	/** Item schema */
	items: Schema;
}
