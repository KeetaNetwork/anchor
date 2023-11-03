import AnchorError from '.';

const MetadataErrorType = 'METADATA' as const;
const MetadataErrorCodes = [
	'ENCRYPTION_KEY_REQUIRED',
	'ENCRYPTION_KEY_INVALID_SET',
	'COULD_NOT_FIND_PRINCIPAL_DECRYPTION_MATCH',
	'INVALID_ASN1_SCHEMA',
	'PRINCIPAL_REQUIRED_TO_DECRYPT',
	'ACCOUNT_MUST_SUPPORT_ENCRYPTION',
	'CANNOT_REVOKE_ACCESS_LAST_ACCOUNT',
	'CANNOT_REVOKE_ACCESS_NOT_ENCRYPTED',
	'INVALID_VERSION'
] as const;

export type MetadataErrorCode = `${typeof MetadataErrorType}_${typeof MetadataErrorCodes[number]}`;
export default class AnchorMetadataError extends AnchorError {
	constructor(code: MetadataErrorCode, message: string) {
		super(code, message, { type: MetadataErrorType, codes: MetadataErrorCodes });
	}
}
