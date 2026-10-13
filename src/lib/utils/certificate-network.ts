import type * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as KeetaNet from '@keetanetwork/keetanet-client';

import type { KeetaAnchorCertificateRequiredKind } from '../error.js';
import { Certificate } from '../certificates.js';
import { KeetaAnchorCertificateRequiredError } from '../error.js';

type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;
type BaseCertificate = InstanceType<typeof KeetaNetClient.lib.Utils.Certificate.Certificate>;
type KeetaNetNetwork = typeof KeetaNet.Client.Config.networksArray[number];

/**
 * Outcome of verifying an account's on-chain cert chain against a trust
 * set:
 *
 * - `'trusted'`: at least one published cert chains to a trusted issuer.
 * - `'no-certs'`: account has no published certificates.
 * - `'untrusted'`: certs exist but none chain to a trusted issuer.
 */
export type CertificateChainStatus = 'trusted' | 'no-certs' | 'untrusted';

/**
 * Verify that the supplied account has at least one on-chain certificate
 * whose chain terminates at one of the supplied trusted issuers.
 */
export async function verifyAccountCertificateChain(args: {
	account: KeetaNetAccount;
	client: InstanceType<typeof KeetaNetClient.Client>;
	trustedIssuers: Certificate[];
}): Promise<CertificateChainStatus> {
	const { account, client, trustedIssuers } = args;
	const records = await client.getAllCertificates(account);
	if (records.length === 0) {
		return('no-certs');
	}

	if (trustedIssuers.length === 0) {
		return('untrusted');
	}

	const rootSet = new Set<BaseCertificate>(trustedIssuers);
	for (const record of records) {
		let intermediate: Set<BaseCertificate>;
		if (record.intermediates === null) {
			intermediate = new Set<BaseCertificate>();
		} else {
			intermediate = new Set<BaseCertificate>(record.intermediates.getCertificates());
		}

		let candidate: Certificate;
		try {
			candidate = new Certificate(record.certificate.toPEM(), {
				store: { root: rootSet, intermediate }
			});
		} catch {
			continue;
		}

		if (candidate.trusted) {
			return('trusted');
		}
	}

	return('untrusted');
}

/**
 * Public configuration for the on-chain certificate-chain gate. Pass on a
 * server config (`requireCertificateChain`) to require that every authenticated
 * caller has at least one published certificate chaining to one of `trustedIssuers`.
 */
export interface CertificateChainConfig {
	trustedIssuers: Certificate[];
	client: InstanceType<typeof KeetaNetClient.Client>;
}

/**
 * Post-validation form of {@link CertificateChainConfig}. `acceptedIssuerDNs`
 * is precomputed once so error payloads don't re-walk `trustedIssuers`.
 */
export interface ResolvedCertificateChainRequirement {
	readonly trustedIssuers: Certificate[];
	readonly client: InstanceType<typeof KeetaNetClient.Client>;
	readonly acceptedIssuerDNs: { name: string; value: string; }[][];
}

/**
 * Validate and freeze a `CertificateChainConfig`.
 */
export function resolveCertificateChainConfig(config: CertificateChainConfig | undefined): ResolvedCertificateChainRequirement | undefined {
	if (config === undefined) {
		return(undefined);
	}
	if (config.trustedIssuers.length === 0) {
		throw(new Error('requireCertificateChain.trustedIssuers must contain at least one issuer'));
	}

	return({
		trustedIssuers: config.trustedIssuers,
		client: config.client,
		acceptedIssuerDNs: config.trustedIssuers.map(function(cert) { return(cert.subjectDN); })
	});
}

/**
 * Default delimiter used by {@link certificateChainConfigFromBundle} to
 * separate concatenated PEM-encoded certificates in a single string.
 */
export const DEFAULT_CERTIFICATE_BUNDLE_DELIMITER = '|';

/**
 * Arguments accepted by {@link certificateChainConfigFromBundle}.
 */
export interface CertificateChainConfigFromBundleArgs {
	/**
	 * One or more PEM-encoded certificates joined with `delimiter`.
	 */
	pemBundle: string;

	/**
	 * KeetaNet network used to instantiate the client.
	 */
	network: KeetaNetNetwork;

	/**
	 * Delimiter used to split `pemBundle`. Defaults to
	 * {@link DEFAULT_CERTIFICATE_BUNDLE_DELIMITER}.
	 */
	delimiter?: string;
}

/**
 * Build a {@link CertificateChainConfig} from a delimited PEM bundle and a network.
 */
export function certificateChainConfigFromBundle(args: CertificateChainConfigFromBundleArgs): CertificateChainConfig {
	const delimiter = args.delimiter ?? DEFAULT_CERTIFICATE_BUNDLE_DELIMITER;
	const trustedIssuers = args.pemBundle
		.split(delimiter)
		.map(function(pem)    { return(pem.trim()); })
		.filter(function(pem) { return(pem.length > 0); })
		.map(function(pem)    { return(new Certificate(pem)); });

	if (trustedIssuers.length === 0) {
		throw(new Error('pemBundle contains no certificates'));
	}

	const client = KeetaNet.Client.fromNetwork(args.network);
	return({ trustedIssuers, client });
}

/**
 * Verify the signing account's on-chain certificate chain against the
 * resolved requirement. Throws `KeetaAnchorCertificateRequiredError` when
 * the gate is configured and the account fails it.
 */
export async function assertAccountCertificateChain(account: KeetaNetAccount, requirement: ResolvedCertificateChainRequirement | undefined): Promise<void> {
	if (requirement === undefined) {
		return;
	}

	const status = await verifyAccountCertificateChain({
		account,
		client: requirement.client,
		trustedIssuers: requirement.trustedIssuers
	});
	if (status === 'trusted') {
		return;
	}

	let kind: KeetaAnchorCertificateRequiredKind;
	if (status === 'no-certs') {
		kind = 'missing';
	} else {
		kind = 'untrusted';
	}

	throw(new KeetaAnchorCertificateRequiredError({ acceptedIssuers: requirement.acceptedIssuerDNs, kind }));
}
