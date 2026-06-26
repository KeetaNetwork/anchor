/**
 * Standard set of KYC verification statuses reported by a KYC Anchor.
 *
 * Providers report one of these values via the `getVerificationStatus` operation
 * and (where applicable) on certificate issuance flows.
 */
export enum KYCVerificationStatus {
	PASSED = 'pass',
	FAILED = 'fail',
	INCOMPLETE = 'incomplete',
	PENDING = 'pending',
	ERROR = 'error'
}
