import type * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { CertificateAttributeOIDDB, type CertificateAttributeValueMap, type CertificateAttributeValue } from '../../services/kyc/iso20022.generated.js';
import type { CertificateBuilder, Certificate } from '../certificates.js';
import { SensitiveAttribute, SensitiveAttributeBuilder } from '../certificates.js';
import { KeetaAnchorError } from '../error.js';
import { Buffer } from '../utils/buffer.js';

type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/**
 * Type alias for certificate attribute names
 */
export type PIIAttributeNames = keyof CertificateAttributeValueMap;

/**
 * Redacted message shown when attempting to log or serialize PIIStore
 */
const REDACTED = '[PII: REDACTED]';

/**
 * Error thrown when attempting to access an attribute that does not exist
 */
export class PIIAttributeNotFoundError extends KeetaAnchorError {
	static override readonly name: string = 'PIIAttributeNotFoundError';
	private readonly PIIAttributeNotFoundErrorObjectTypeID!: string;
	private static readonly PIIAttributeNotFoundErrorObjectTypeID = 'b8e3c7a1-5d2f-4e6b-9a1c-3f8d2e7b4c5a';

	readonly attributeName: string;

	constructor(attributeName: string) {
		super(`Attribute '${attributeName}' not found in PIIStore`);

		Object.defineProperty(this, 'PIIAttributeNotFoundErrorObjectTypeID', {
			value: PIIAttributeNotFoundError.PIIAttributeNotFoundErrorObjectTypeID,
			enumerable: false
		});

		this.attributeName = attributeName;
	}

	static isInstance(input: unknown): input is PIIAttributeNotFoundError {
		return(this.hasPropWithValue(input, 'PIIAttributeNotFoundErrorObjectTypeID', PIIAttributeNotFoundError.PIIAttributeNotFoundErrorObjectTypeID));
	}
}

type StoredAttribute = {
	value: unknown;
	sensitive: boolean;
};

/**
 * PIIStore is a secure container for Personally Identifiable Information (PII).
 *
 * It encapsulates sensitive data and prevents accidental logging or serialization
 * by overriding common output methods to return redacted placeholders.
 *
 * @example
 * ```typescript
 * const store = new PIIStore();
 * store.setAttribute('firstName', 'John');
 * store.setAttribute('lastName', 'Doe');
 *
 * console.log(store); // '[PIIStore: REDACTED]'
 * JSON.stringify(store); // '{"type":"PIIStore","message":"REDACTED"}'
 * ```
 */
export class PIIStore {
	readonly #attributes = new Map<string, StoredAttribute>();

	constructor() {
		// Define Node.js util.inspect custom formatter to prevent PII exposure
		Object.defineProperty(this, Symbol.for('nodejs.util.inspect.custom'), {
			value: () => REDACTED,
			enumerable: false,
			writable: false,
			configurable: false
		});
	}

	/**
	 * Create a PIIStore from a Certificate, extracting all attributes
	 *
	 * @param certificate - The certificate to extract attributes from
	 *
	 * @returns A new PIIStore populated with the certificate's attributes
	 */
	static fromCertificate(certificate: Certificate): PIIStore {
		const store = new PIIStore();

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const attributeNames = Object.keys(certificate.attributes) as PIIAttributeNames[];
		for (const name of attributeNames) {
			const attr = certificate.attributes[name];
			if (attr) {
				store.#attributes.set(name, {
					value: attr.value,
					sensitive: attr.sensitive
				});
			}
		}

		return(store);
	}

	/**
	 * Set a known certificate attribute
	 *
	 * @param name - The attribute name
	 * @param value - The value to store
	 * @param sensitive - Whether the attribute is sensitive (default: true)
	 */
	setAttribute<K extends PIIAttributeNames>(name: K, value: CertificateAttributeValue<K>, sensitive?: boolean): void;
	setAttribute<T>(name: string, value: T, sensitive?: boolean): void;
	setAttribute(name: string, value: unknown, sensitive = true): void {
		this.#attributes.set(name, { value, sensitive });
	}

	/**
	 * Check if an attribute exists in the store
	 */
	hasAttribute(name: string): boolean {
		return(this.#attributes.has(name));
	}

	/**
	 * Get all attribute names currently stored
	 */
	getAttributeNames(): string[] {
		return(Array.from(this.#attributes.keys()));
	}

	#isKnownAttribute(name: string): name is PIIAttributeNames {
		return(name in CertificateAttributeOIDDB);
	}

	/**
	 * Create a SensitiveAttribute
	 *
	 * @param name - The attribute name to convert
	 * @param subjectKey - The account to encrypt the attribute for
	 * @returns A SensitiveAttribute containing the encrypted value
	 *
	 * @throws PIIAttributeNotFoundError if the attribute is not set
	 */
	async toSensitiveAttribute<K extends PIIAttributeNames>(name: K,subjectKey: KeetaNetAccount): Promise<SensitiveAttribute<CertificateAttributeValue<K>>>;
	async toSensitiveAttribute<T>(name: string, subjectKey: KeetaNetAccount): Promise<SensitiveAttribute<T>>;
	async toSensitiveAttribute(name: string, subjectKey: KeetaNetAccount): Promise<SensitiveAttribute<unknown>> {
		if (!this.#attributes.has(name)) {
			throw(new PIIAttributeNotFoundError(name));
		}

		const stored = this.#attributes.get(name);
		const storedValue = stored?.value;
		if (SensitiveAttribute.isInstance(storedValue)) {
			// If already a SensitiveAttribute, return it directly
			return(storedValue);
		}

		// Known attributes use schema-aware encoding
		if (this.#isKnownAttribute(name)) {
			const builder = new SensitiveAttributeBuilder(subjectKey);
			// @ts-expect-error storedValue type is validated at setAttribute time
			builder.set(name, storedValue);
			return(await builder.build());
		} else {
			// External attributes are JSON-serialized
			const jsonBytes = Buffer.from(JSON.stringify(storedValue), 'utf-8');
			return(await new SensitiveAttributeBuilder(subjectKey)
				.set(jsonBytes)
				.build());
		}
	}

	/**
	 * Apply known attributes to a CertificateBuilder
	 *
	 * External attributes are not included in the certificate.
	 *
	 * @param builder - The certificate builder to apply attributes to
	 * @returns The certificate builder with the attributes applied
	 */
	toCertificateBuilder(builder: CertificateBuilder): CertificateBuilder {
		for (const [name, attr] of this.#attributes.entries()) {
			if (this.#isKnownAttribute(name) && attr.value !== undefined && attr.value !== null) {
				builder.setAttribute(name, attr.sensitive, attr.value);
			}
		}

		return(builder);
	}

	/**
	 * Prevent logging of PII data via string coercion
	 */
	toString(): string {
		return(REDACTED);
	}

	/**
	 * Serialize to JSON with redacted values
	 *
	 * Shows attribute names for debugging, but all values are redacted.
	 */
	toJSON(): { type: string; attributes: { [key: string]: string }} {
		const attributes: { [key: string]: string } = {};
		for (const name of this.#attributes.keys()) {
			attributes[name] = '[REDACTED]';
		}

		return({ type: 'PIIStore', attributes });
	}
}

