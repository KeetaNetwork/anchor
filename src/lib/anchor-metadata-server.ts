import type { KeetaAnchorHTTPServerConfig } from './http-server/index.js';
import type { HTTPSignedField } from './http-server/common.js';
import type { SignableAccount, VerifiableAccount } from './utils/signing.js';
import type { SharedAnchorMetadataLegalExtension, SharedAnchorMetadataSignedExtension } from './metadata.types.js';
import { KeetaNetAnchorHTTPServer } from './http-server/index.js';
import { SignData, VerifySignedData, objectToSignable } from './utils/signing.js';

/**
 * Namespace tag bound into every service metadata signature.
 */
export const METADATA_SIGNATURE_NAMESPACE = 'keetanet/anchor/service-metadata/v1';

/**
 * Service metadata shape whose signed fields can be authenticated
 * by {@link KeetaAnchorMetadataServer}.
 */
export type SignableServiceMetadata = SharedAnchorMetadataLegalExtension & {
	operations: { [operationName: string]: unknown };
};

/**
 * Canonical fields covered by the metadata signature. `namespace` scopes
 * the signature to this protocol/version.
 */
export type SignedServiceMetadataFields = {
	namespace: typeof METADATA_SIGNATURE_NAMESPACE;
	account: string;
	operations: SignableServiceMetadata['operations'];
	legal?: SignableServiceMetadata['legal'];
};

export interface KeetaAnchorMetadataServerConfig extends KeetaAnchorHTTPServerConfig {
	/** Signs the published metadata. Omit for unsigned metadata. */
	metadataSigner?: SignableAccount | undefined;
}

/**
 * Extracts the subset of `metadata` that is covered by the signature.
 * `account` is the public-key string of the claimed signer.
 */
export function extractSignedFields(account: string, metadata: SignableServiceMetadata): SignedServiceMetadataFields {
	const fields: SignedServiceMetadataFields = {
		namespace: METADATA_SIGNATURE_NAMESPACE,
		account: account,
		operations: metadata.operations
	};
	if (metadata.legal !== undefined) {
		fields.legal = metadata.legal;
	}

	return(fields);
}

/**
 * Verifies that `signed` was produced by `account` over the signed
 * fields of `metadata` (see {@link extractSignedFields}).
 */
export async function verifyMetadataSignature(account: VerifiableAccount, metadata: SignableServiceMetadata, signed: HTTPSignedField): Promise<boolean> {
	const signedFields = extractSignedFields(account.publicKeyString.get(), metadata);
	const signable = objectToSignable(signedFields);
	const verifyOptions = { maxSkewMs: Number.POSITIVE_INFINITY };

	return(await VerifySignedData(account, signable, signed, verifyOptions));
}

/**
 * Publishes anchor service metadata, optionally signed by `metadataSigner`.
 * Subclasses implement {@link buildServiceMetadata}.
 */
export abstract class KeetaAnchorMetadataServer<
	Built extends SignableServiceMetadata,
	C extends KeetaAnchorMetadataServerConfig = KeetaAnchorMetadataServerConfig
> extends KeetaNetAnchorHTTPServer<C> {
	readonly #metadataSigner: SignableAccount | undefined;

	constructor(config: C) {
		super(config);
		this.#metadataSigner = config.metadataSigner;
	}

	get metadataSigner(): SignableAccount | undefined {
		return(this.#metadataSigner);
	}

	protected abstract buildServiceMetadata(): Promise<Built>;

	async serviceMetadata(): Promise<Built & SharedAnchorMetadataSignedExtension> {
		const built = await this.buildServiceMetadata();

		const signer = this.#metadataSigner;
		if (signer === undefined) {
			return(built);
		}

		const account = signer.publicKeyString.get();
		const signedFields = extractSignedFields(account, built);
		const signable = objectToSignable(signedFields);
		const signed = await SignData(signer, signable);

		return({
			...built,
			account,
			signed
		});
	}
}
