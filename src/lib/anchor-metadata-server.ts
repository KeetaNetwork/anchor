import type { KeetaAnchorHTTPServerConfig, Routes } from './http-server/index.js';
import { parseSignatureFromURL, type HTTPSignedField } from './http-server/common.js';
import type { SignableAccount, VerifiableAccount } from './utils/signing.js';
import type { ServiceMetadataEndpoint, SharedAnchorMetadataLegalExtension, SharedAnchorMetadataSignedExtension } from './metadata.types.js';
import { KeetaNetAnchorHTTPServer } from './http-server/index.js';
import { SignData, VerifySignedData, objectToSignable } from './utils/signing.js';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import { KeetaAnchorUserValidationError } from './error.js';
import Resolver from './resolver.js';
import { KeetaNet } from '../client/index.js';

/**
 * Namespace tag bound into every service metadata signature.
 */
export const METADATA_SIGNATURE_NAMESPACE = 'keetanet/anchor/service-metadata/v1';

/**
 * Service metadata shape whose signed fields can be authenticated
 * by {@link KeetaAnchorMetadataServer}.
 */
export type SignableServiceMetadata = SharedAnchorMetadataLegalExtension & {
	operations: { [operationName: string]: ServiceMetadataEndpoint | undefined };
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

	serviceMetadataEndpoint?: {
		expose: false;
	} | {
		expose: true;

		authentication?: {
			required: false;
		} | {
			required: true;
			allowAccount: InstanceType<typeof Account.Set> | ((account: GenericAccount) => Promise<boolean>);
		}
	}
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

	protected async initRoutes(config: C): Promise<Routes> {
		const routes: Routes = {};

		if (config.serviceMetadataEndpoint?.expose) {
			const endpointConfig = config.serviceMetadataEndpoint;
			routes['GET /serviceMetadata'] = {
				bodyType: 'none',
				handler: async (_ignore_params, _ignore_data, _ignore_headers, url: URL) => {
					if (endpointConfig.authentication?.required) {
						const signature = parseSignatureFromURL(url);

						try {
							if (!signature.account || !signature.signedField) {
								throw(new KeetaAnchorUserValidationError({ fields: [] }, 'Missing signature fields in request URL'));
							}

							const signable = Resolver.getExternalURLSignable(url);
							const verified = await VerifySignedData(signature.account, signable, signature.signedField);

							if (!verified) {
								throw(new KeetaAnchorUserValidationError({ fields: [] }, 'Invalid signature in request URL'));
							}

							let allowAccount = false;
							if (typeof endpointConfig.authentication.allowAccount === 'function') {
								allowAccount = await endpointConfig.authentication.allowAccount(signature.account);
							} else {
								allowAccount = endpointConfig.authentication.allowAccount.has(signature.account);
							}

							if (!allowAccount) {
								throw(new KeetaAnchorUserValidationError({ fields: [] }, 'Account not allowed to access this endpoint'));
							}
						} catch (error) {
							this.logger?.debug('KeetaAnchorMetadataServer', 'serviceMetadata endpoint authentication failed:', error);

							return({
								statusCode: 404,
								headers: { 'Content-Type': 'text/plain' },
								output: 'Not Found'
							});
						}
					}

					const serviceMetadata = await this.serviceMetadata();
					const serializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable(serviceMetadata);

					return({
						output: JSON.stringify(serializable),
						headers: { 'Content-Type': 'application/json' },
						statusCode: 200
					})
				}
			}
		}

		return(routes);
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
