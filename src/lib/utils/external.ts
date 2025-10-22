import * as crypto from 'crypto';
import { EncryptedContainer } from '../encrypted-container.js';
import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { Reference, ExternalReference, DigestInfo } from '../../services/kyc/iso20022.generated.js';
import type { ASN1OID } from './asn1.js';
import { Buffer } from './buffer.js';

type Account = InstanceType<typeof KeetaNetLib.Account>;

/**
 * Builder for RFC 3447 Reference structures (Document references)
 *
 * Creates a Reference containing:
 * - ExternalReference: URL and content type (encrypted)
 * - DigestInfo: Hash algorithm OID and digest
 * - Encryption algorithm OID
 */
export class ExternalReferenceBuilder {
	#url: string;
	#contentType: string;
	#digestAlgorithm = 'sha3-256';
	#encryptionAlgorithm = 'aes-256-gcm';

	/**
	 * Create a new DocumentBuilder
	 *
	 * @param url - The URL where the document can be accessed
	 * @param contentType - MIME type of the document (e.g., 'image/jpeg', 'application/pdf')
	 */
	constructor(url: string, contentType: string) {
		this.#url = url;
		this.#contentType = contentType;
	}

	/**
	 * Set the digest algorithm (default: 'sha256')
	 *
	 * @param algorithm - Hash algorithm name (e.g., 'sha256', 'sha3-256')
	 * @returns this builder for chaining
	 */
	setDigestAlgorithm(algorithm: string): this {
		this.#digestAlgorithm = algorithm;
		return(this);
	}

	/**
	 * Set the encryption algorithm (default: 'aes-256-cbc')
	 *
	 * @param algorithm - Encryption algorithm name
	 * @returns this builder for chaining
	 */
	setEncryptionAlgorithm(algorithm: string): this {
		this.#encryptionAlgorithm = algorithm;
		return(this);
	}

	/**
	 * Build the Reference structure with encrypted URL
	 *
	 * @param documentContent - The actual document content to hash
	 * @param principals - Account(s) that can decrypt the URL
	 * @returns The RFC 3447 Reference structure
	 */
	async build(documentContent: Buffer, principals: Account[] | Account): Promise<Reference> {
		const principalArray = Array.isArray(principals) ? principals : [principals];

		// Encrypt the URL
		const urlBuffer = Buffer.from(this.#url, 'utf-8');
		const encryptedContainer = EncryptedContainer.fromPlaintext(
			urlBuffer,
			principalArray,
			true
		);
		const encryptedUrlBuffer = await encryptedContainer.getEncodedBuffer();

		// Create the ExternalReference structure with encrypted URL
		const externalReference: ExternalReference = {
			url: encryptedUrlBuffer,
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

		// Create the DigestInfo structure
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
	 * Map algorithm names to OIDs
	 */
	#algorithmToOID(algorithm: string): ASN1OID {
		const oidMap: { [key: string]: string } = {
			'sha256': '2.16.840.1.101.3.4.2.1',
			'sha2-256': '2.16.840.1.101.3.4.2.1',
			'sha3-256': '2.16.840.1.101.3.4.2.8',
			'aes-256-cbc': '2.16.840.1.101.3.4.1.42',
			'aes-256-gcm': '2.16.840.1.101.3.4.1.46'
		};

		const oid = oidMap[algorithm.toLowerCase()];
		if (!oid) {
			throw(new Error(`Unsupported algorithm: ${algorithm}`));
		}

		return({ type: 'oid', oid });
	}
}

export default ExternalReferenceBuilder;
