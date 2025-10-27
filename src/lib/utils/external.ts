// XXX:TODO We need a webpack fallback for crypto in browser environments
import crypto from './crypto.js';
import type { Reference, ExternalReference, DigestInfo } from '../../services/kyc/iso20022.generated.js';
import type { ASN1OID } from './asn1.js';
import type { Buffer } from './buffer.js';

/**
 * Builder for Reference structures
 *
 * Creates a Reference containing:
 * - ExternalReference: URL and content type
 * - DigestInfo: Hash algorithm OID and digest
 * - Encryption algorithm OID
 */
export class ExternalReferenceBuilder {
	#url: string;
	#contentType: string;
	#digestAlgorithm = 'sha3-256';
	#encryptionAlgorithm = 'KeetaEncryptedContainerV1';

	/**
	 * Create a new ExternalReferenceBuilder
	 *
	 * @param url - The URL where the document can be accessed
	 * @param contentType - MIME type of the document (e.g., 'image/jpeg', 'application/pdf')
	 */
	constructor(url: string, contentType: string) {
		this.#url = url;
		this.#contentType = contentType;
	}

	/**
	 * Set the digest algorithm (default: 'sha3-256')
	 *
	 * @param algorithm - Hash algorithm name (e.g., 'sha256', 'sha3-256')
	 * @returns this builder for chaining
	 */
	withDigestAlgorithm(algorithm: string): this {
		this.#digestAlgorithm = algorithm;
		return(this);
	}

	/**
	 * Set the encryption algorithm (default: 'KeetaEncryptedContainerV1')
	 *
	 * @param algorithm - Encryption algorithm name
	 * @returns this builder for chaining
	 */
	withEncryptionAlgorithm(algorithm: string): this {
		this.#encryptionAlgorithm = algorithm;
		return(this);
	}

	/**
	 * Build the Reference structure
	 *
	 * @param documentContent - The actual document content to hash
	 * @returns The Reference structure
	 */
	build(documentContent: Buffer): Reference {
		// Create the ExternalReference structure
		const externalReference: ExternalReference = {
			url: this.#url,
			contentType: this.#contentType
		};

		// Compute the digest of the actual document content
		const hashAlgo = this.#digestAlgorithmToNodeAlgo(this.#digestAlgorithm);
		const hash = crypto.createHash(hashAlgo);
		hash.update(documentContent);
		const digest = hash.digest();

		// Map algorithm names to OIDs
		const digestAlgorithmOID = this.#algorithmToOID(this.#digestAlgorithm);
		const encryptionAlgorithmOID = this.#algorithmToOID(this.#encryptionAlgorithm);

		// Create the RFC 3447 DigestInfo structure
		const digestInfo: DigestInfo = {
			digestAlgorithm: digestAlgorithmOID,
			digest: digest
		};

		// Create the Reference structure
		const reference: Reference = {
			external: externalReference,
			digest: digestInfo,
			encryptionAlgorithm: encryptionAlgorithmOID
		};

		return(reference);
	}

	/**
	 * // XXX:TODO We can handle these better later
	 * Map algorithm names to Node.js crypto algorithm names
	 */
	#digestAlgorithmToNodeAlgo(algorithm: string): string {
		const algoMap: { [key: string]: string } = {
			'sha256': 'sha256',
			'sha3-256': 'sha3-256',
			'sha2-256': 'sha256'
		};

		const nodeAlgo = algoMap[algorithm.toLowerCase()];
		if (!nodeAlgo) {
			throw(new Error(`Unsupported digest algorithm: ${algorithm}`));
		}

		return(nodeAlgo);
	}

	/**
	 * // XXX:TODO We can handle these better later
	 * Map algorithm names to OIDs
	 */
	#algorithmToOID(algorithm: string): ASN1OID {
		const oidMap: { [key: string]: string } = {
			'sha256': '2.16.840.1.101.3.4.2.1',
			'sha2-256': '2.16.840.1.101.3.4.2.1',
			'sha3-256': '2.16.840.1.101.3.4.2.8',
			'aes-256-cbc': '2.16.840.1.101.3.4.1.42',
			'aes-256-gcm': '2.16.840.1.101.3.4.1.46',
			'keetaencryptedcontainerv1': '1.3.6.1.4.1.62675.2'
		};

		const oid = oidMap[algorithm.toLowerCase()];
		if (!oid) {
			throw(new Error(`Unsupported algorithm: ${algorithm}`));
		}

		return({ type: 'oid', oid });
	}
}

export default ExternalReferenceBuilder;
