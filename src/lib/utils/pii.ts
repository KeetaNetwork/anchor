import type * as KeetaNetClient from '@keetanetwork/keetanet-client';
import type { CertificateAttributeValueMap, CertificateAttributeValue } from '../../services/kyc/iso20022.generated.js';
import type { CertificateBuilder, Certificate } from '../certificates.js';
import { SensitiveAttribute, SensitiveAttributeBuilder } from '../certificates.js';
import { KeetaAnchorError } from '../error.js';

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

	readonly attributeName: PIIAttributeNames;

	constructor(attributeName: PIIAttributeNames) {
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
	readonly #attributes = new Map<PIIAttributeNames, StoredAttribute>();
	readonly #subjectKey: KeetaNetAccount;

	/**
	 * Create a new PIIStore
	 *
	 * @param subjectKey - The account to encrypt sensitive attributes for.
	 */
	constructor(subjectKey: KeetaNetAccount) {
		this.#subjectKey = subjectKey;

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
	 * @param subjectKey - The subject's key (used for new PIIStore context)
	 *
	 * @returns A new PIIStore populated with the certificate's attributes
	 */
	static fromCertificate(
		certificate: Certificate,
		subjectKey: KeetaNetAccount
	): PIIStore {
		const store = new PIIStore(subjectKey);

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
	 * Set an attribute value in the store
	 *
	 * @param name - The attribute name
	 * @param value - The value to store
	 * @param sensitive - Whether the attribute is sensitive (default: true)
	 */
	setAttribute<K extends PIIAttributeNames>(name: K, value: CertificateAttributeValue<K>, sensitive = true): void {
		this.#attributes.set(name, { value, sensitive });
	}

	/**
	 * Check if an attribute exists in the store
	 *
	 * @param name - The attribute name to check
	 * @returns True if the attribute is set, false otherwise
	 */
	hasAttribute(name: PIIAttributeNames): boolean {
		return(this.#attributes.has(name));
	}

	/**
	 * Get all attribute names currently stored
	 *
	 * @returns Array of attribute names
	 */
	getAttributeNames(): PIIAttributeNames[] {
		return(Array.from(this.#attributes.keys()));
	}

	/**
	 * Get or create a SensitiveAttribute from a stored PII value
	 *
	 * @param name - The attribute name to convert
	 * @returns A SensitiveAttribute containing the encrypted value
	 *
	 * @throws PIIAttributeNotFoundError if the attribute is not set
	 */
	async toSensitiveAttribute<K extends PIIAttributeNames>(
		name: K
	): Promise<SensitiveAttribute<CertificateAttributeValue<K>>> {
		if (!this.hasAttribute(name)) {
			throw(new PIIAttributeNotFoundError(name));
		}

		const stored = this.#attributes.get(name);
		const storedValue = stored?.value;
		if (SensitiveAttribute.isInstance(storedValue)) {
            // If already a SensitiveAttribute, return it directly
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			return(storedValue as SensitiveAttribute<CertificateAttributeValue<K>>);
		}

		// Otherwise, encrypt the plain value
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const value = storedValue as CertificateAttributeValue<K>;
		return(await new SensitiveAttributeBuilder(this.#subjectKey)
			.set(name, value)
			.build());
	}

	/**
	 * Apply all stored attributes to a CertificateBuilder
	 *
	 * @param builder - The certificate builder to apply attributes to
	 *
	 * @returns The certificate builder with the attributes applied
	 */
	toCertificateBuilder(builder: CertificateBuilder): CertificateBuilder {
		for (const [name, attr] of this.#attributes.entries()) {
			if (attr.value !== undefined && attr.value !== null) {
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
	 * Prevent JSON serialization of PII data
	 */
	toJSON(): { type: string; message: string } {
		return({ type: 'PIIStore', message: 'REDACTED' });
	}
}

