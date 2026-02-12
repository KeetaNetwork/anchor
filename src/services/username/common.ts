import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { ToJSONSerializable } from '../../lib/utils/json.ts';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { KeetaAnchorUserError, KeetaAnchorUserValidationError } from '../../lib/error.js';
export * from './common.generated.js';

export const USERNAME_DELIMITER = '$';
export const USERNAME_MAX_LENGTH = 256;

export type UsernameValidationReason = 'length' | 'latin1';

export interface UsernameValidationIssue {
	reason: UsernameValidationReason;
	message: string;
}

const LATIN1_MAX_CODE_POINT = 0xFF;

type ValidateUsernameOptions = {
	pattern?: string | RegExp | undefined;
	fieldPath?: string;
};

export function validateUsernameDefault(username: string, options: ValidateUsernameOptions = {}): void {
	const fieldPath = options.fieldPath ?? 'username';

	if (username.length > USERNAME_MAX_LENGTH) {
		throw(new KeetaAnchorUserValidationError({
			fields: [
				{
					path: fieldPath,
					message: `Username must not exceed ${USERNAME_MAX_LENGTH} characters`,
					receivedValue: username,
					valueRules: { maximum: String(USERNAME_MAX_LENGTH) }
				}
			]
		}));
	}

	for (const char of username) {
		if (char.charCodeAt(0) > LATIN1_MAX_CODE_POINT) {
			throw(new KeetaAnchorUserValidationError({
				fields: [
					{
						path: fieldPath,
						message: 'Username must contain only Latin-1 characters',
						receivedValue: username,
						expected: 'Latin-1 characters'
					}
				]
			}));
		}
	}

	if (options.pattern !== undefined) {
		const pattern = typeof options.pattern === 'string' ? new RegExp(options.pattern) : options.pattern;
		pattern.lastIndex = 0;
		if (!pattern.test(username)) {
			throw(new KeetaAnchorUserValidationError({
				fields: [
					{
						path: fieldPath,
						message: 'Provider issued name does not match required pattern',
						receivedValue: username,
						expected: pattern.source
					}
				]
			}));
		}
	}
}

export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;
export type GloballyIdentifiableUsername = `${string}${typeof USERNAME_DELIMITER}${string}`;
export interface UsernameComponents {
	username: string;
	providerID: string;
};

export type KeetaUsernameAnchorResolveRequest = {
	username: string;
};

export type KeetaUsernameAnchorResolveResponse = ({
	ok: true;
	account: string;
	username: string;
}) | ({
	ok: false;
	error: string;
});


export type KeetaUsernameAnchorAccountResolutionContext = {
	account: KeetaNetAccount;
};

export type KeetaUsernameAnchorUsernameResolutionContext = {
	username: string;
};

export type KeetaUsernameAnchorClaimContext = {
	username: string;
	account: KeetaNetAccount;
	signed: HTTPSignedField;
};

export type KeetaUsernameAnchorResolveResponseJSON = ToJSONSerializable<KeetaUsernameAnchorResolveResponse>;

export type KeetaUsernameAnchorClaimRequest = {
	username: string;
	account: string;
	signed: HTTPSignedField;
};

export type KeetaUsernameAnchorClaimResponse = ({
	ok: true;
}) | ({
	ok: false;
	error: string;
});

function assertSegment(value: string, type: 'provider issued unique name' | 'provider ID'): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw(new Error(`Globally identifiable username ${type} must not be empty`));
	}

	if (trimmed.includes(USERNAME_DELIMITER)) {
		throw(new Error(`Globally identifiable username ${type} must not contain "${USERNAME_DELIMITER}"`));
	}

	return(trimmed);
}

export function formatGloballyIdentifiableUsername(providerIssuedName: string, providerID: string): GloballyIdentifiableUsername {
	const safeName = assertSegment(providerIssuedName, 'provider issued unique name');
	const safeProviderID = assertSegment(providerID, 'provider ID');

	return(`${safeName}${USERNAME_DELIMITER}${safeProviderID}`);
}

function attemptParseGloballyIdentifiableUsername(input: unknown): UsernameComponents {
	if (typeof input !== 'string') {
		throw(new Error('Globally identifiable username must be a string'));
	}

	const trimmed = input.trim();

	if (trimmed.length !== input.length) {
		throw(new Error('Globally identifiable username must not have leading or trailing whitespace'));
	}

	const separatorIndex = trimmed.lastIndexOf(USERNAME_DELIMITER);
	if (separatorIndex === -1) {
		throw(new Error(`Globally identifiable username must contain "${USERNAME_DELIMITER}" separator`));
	}

	const providerIssuedNameSegment = trimmed.slice(0, separatorIndex);
	const providerIDSegment = trimmed.slice(separatorIndex + 1);

	const username = assertSegment(providerIssuedNameSegment, 'provider issued unique name');
	const providerID = assertSegment(providerIDSegment, 'provider ID');

	return({
		username,
		providerID
	});
}

export function isGloballyIdentifiableUsername(input: unknown): input is GloballyIdentifiableUsername {
	try {
		attemptParseGloballyIdentifiableUsername(input);
		return(true);
	} catch {
		return(false);
	}
}

export function parseGloballyIdentifiableUsername(input: GloballyIdentifiableUsername): UsernameComponents {
	return(attemptParseGloballyIdentifiableUsername(input));
}

export function getUsernameClaimSignable(username: string, account: KeetaNetAccount): Signable {
	return([
		'CLAIM_USERNAME',
		username,
		account.publicKeyString.get()
	]);
}

interface KeetaUsernameAnchorUsernameAlreadyTakenErrorProperties {
	username: string;
}

type KeetaUsernameAnchorUsernameAlreadyTakenErrorJSON = ReturnType<KeetaAnchorUserError['toJSON']> & KeetaUsernameAnchorUsernameAlreadyTakenErrorProperties;

class KeetaUsernameAnchorUsernameAlreadyTakenError extends KeetaAnchorUserError implements KeetaUsernameAnchorUsernameAlreadyTakenErrorProperties {
	static override readonly name: string = 'KeetaUsernameAnchorUsernameAlreadyTakenError';
	private readonly KeetaUsernameAnchorUsernameAlreadyTakenErrorObjectTypeID!: string;
	private static readonly KeetaUsernameAnchorUsernameAlreadyTakenErrorObjectTypeID = 'e5bba4dd-0217-4d96-8f66-2b9a61069c11';
	override readonly logLevel = 'INFO';
	readonly username: string;

	constructor(properties: KeetaUsernameAnchorUsernameAlreadyTakenErrorProperties, message?: string) {
		super(message ?? `Username ${properties.username} already taken`);
		this.statusCode = 409;

		Object.defineProperty(this, 'KeetaUsernameAnchorUsernameAlreadyTakenErrorObjectTypeID', {
			value: KeetaUsernameAnchorUsernameAlreadyTakenError.KeetaUsernameAnchorUsernameAlreadyTakenErrorObjectTypeID,
			enumerable: false
		});

		this.username = properties.username;
	}

	static isInstance(input: unknown): input is KeetaUsernameAnchorUsernameAlreadyTakenError {
		return(this.hasPropWithValue(input, 'KeetaUsernameAnchorUsernameAlreadyTakenErrorObjectTypeID', KeetaUsernameAnchorUsernameAlreadyTakenError.KeetaUsernameAnchorUsernameAlreadyTakenErrorObjectTypeID));
	}

	toJSON(): KeetaUsernameAnchorUsernameAlreadyTakenErrorJSON {
		return({
			...super.toJSON(),
			username: this.username
		});
	}

	static async fromJSON(input: unknown): Promise<KeetaUsernameAnchorUsernameAlreadyTakenError> {
		const { message, other } = this.extractErrorProperties(input, this);

		if (!('username' in other) || typeof other.username !== 'string') {
			throw(new Error('Invalid KeetaUsernameAnchorUsernameAlreadyTakenError JSON object: missing or invalid username'));
		}

		const error = new this({ username: other.username }, message);
		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	UsernameAlreadyTaken: typeof KeetaUsernameAnchorUsernameAlreadyTakenError;
} = {
	UsernameAlreadyTaken: KeetaUsernameAnchorUsernameAlreadyTakenError
};
