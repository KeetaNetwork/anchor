// All KYC validators are server-only; they were moved to common.server.generated.ts
// to keep them out of client bundles. Re-exported here (named, so still
// tree-shakeable) for back-compat with any existing './common.generated.js' import.
export {
	assertCreateVerificationRequest,
	assertCreateVerificationResponse
} from './common.server.generated.js';
