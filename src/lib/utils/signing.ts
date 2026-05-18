import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type {
	ValidateASN1 as KeetaNetASN1Validation,
	ASN1AnyJS as KeetaNetASN1AnyJS
} from '@keetanetwork/keetanet-client/lib/utils/asn1.js';

import { Buffer, bufferToArrayBuffer, arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';
import { assertNever } from '../../lib/utils/never.js';
import { KeetaAnchorError } from '../error.js';

export type SignableAccount = ReturnType<InstanceType<typeof KeetaNetLib.Account>['assertAccount']>;
export type VerifiableAccount = InstanceType<typeof KeetaNetLib.Account>;
export type Signable = (string | number | bigint | InstanceType<typeof KeetaNetLib.Account>)[];

/**
 * Structural input to {@link objectToSignable}.
 */
export type SignableInput =
	{ [key: string | number | symbol]: unknown } |
	SignableInput[] |
	Signable[number] |
	undefined |
	null |
	boolean;

const TO_SIGNABLE_MAX_NODES = 1000;
const TO_SIGNABLE_MAX_OUTPUT_BYTES = 65536;

/**
 * Detects unpaired UTF-16 surrogate code units. JCS
 * ({@link https://www.rfc-editor.org/rfc/rfc8785 RFC 8785} Section 3.2.2.2)
 * requires implementations to reject such strings.
 */
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Serialize a JSON-shaped value following JCS
 * ({@link https://www.rfc-editor.org/rfc/rfc8785 RFC 8785}).
 */
function canonicalizeJson(value: unknown): string {
	/**
	 * Literal serialization (Section 3.2.2.1).
	 */
	if (value === null || typeof value === 'boolean') {
		return(JSON.stringify(value));
	}

	/**
	 * String serialization (Section 3.2.2.2). Lone UTF-16 surrogates MUST cause termination.
	 */
	if (typeof value === 'string') {
		if (LONE_SURROGATE_PATTERN.test(value)) {
			throw(new KeetaAnchorError('Lone UTF-16 surrogate in canonicalizeJson'));
		}

		return(JSON.stringify(value));
	}

	/**
	 * Number serialization (Section 3.2.2.3). NaN and Infinity MUST cause termination.
	 */
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw(new KeetaAnchorError('non-finite number in canonicalizeJson'));
		}

		return(JSON.stringify(value));
	}

	/**
	 * Big integer serialization (Appendix D); I-JSON safe-integer range required.
	 */
	if (typeof value === 'bigint') {
		if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
			throw(new KeetaAnchorError('bigint out of safe integer range in canonicalizeJson'));
		}

		return(value.toString());
	}

	/**
	 * Array element order MUST NOT be changed (Section 3.2.3); sparse holes serialize as JSON `null`.
	 */
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (let i = 0; i < value.length; i++) {
			parts.push(i in value ? canonicalizeJson(value[i]) : 'null');
		}

		return(`[${parts.join(',')}]`);
	}

	/**
	 * Object property sorting by UTF-16 code unit (Section 3.2.3); recursion required.
	 * Only plain objects are permitted; class instances (Date, Map, etc.) are rejected.
	 */
	if (typeof value === 'object') {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			throw(new KeetaAnchorError('Non-plain object in canonicalizeJson'));
		}

		const entries = Object.entries(value);
		for (const [ key ] of entries) {
			if (LONE_SURROGATE_PATTERN.test(key)) {
				throw(new KeetaAnchorError('Lone UTF-16 surrogate in object key'));
			}
		}

		entries.sort(([ a ], [ b ]) => {
			if (a < b) {
				return(-1);
			}
			if (a > b) {
				return(1);
			}

			return(0);
		});

		const parts: string[] = [];
		for (const [ key, child ] of entries) {
			parts.push(`${JSON.stringify(key)}:${canonicalizeJson(child)}`);
		}

		return(`{${parts.join(',')}}`);
	}

	throw(new KeetaAnchorError('Unsupported value type in canonicalizeJson'));
}

/**
 * Canonicalize a tree into a {@link Signable} via {@link canonicalizeJson}.
 * {@link KeetaNetLib.Account} instances are replaced by their `publicKeyAndTypeString`.
 * {@link Date} instances are replaced by their ISO 8601 string.
 */
export function objectToSignable(item: SignableInput): Signable {
	let nodeCount = 0;
	function visit(value: unknown): unknown {
		nodeCount++;
		if (nodeCount > TO_SIGNABLE_MAX_NODES) {
			throw(new KeetaAnchorError('Too much data to sign in objectToSignable'));
		}

		if (value === undefined || value === null) {
			return(null);
		}
		if (value instanceof Date) {
			if (Number.isNaN(value.valueOf())) {
				throw(new KeetaAnchorError('Invalid Date in objectToSignable'));
			}

			return(value.toISOString());
		}
		if (KeetaNetLib.Account.isInstance(value)) {
			return(value.publicKeyAndTypeString);
		}
		if (Array.isArray(value)) {
			if (value.length > TO_SIGNABLE_MAX_NODES - nodeCount) {
				throw(new KeetaAnchorError('Too much data to sign in objectToSignable'));
			}

			const result: unknown[] = [];
			for (const child of value) {
				result.push(visit(child));
			}

			return(result);
		}
		if (typeof value === 'object') {
			if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
				throw(new KeetaAnchorError('Non-plain object in objectToSignable'));
			}

			const result: { [key: string]: unknown } = {};
			for (const [ key, child ] of Object.entries(value)) {
				if (child === undefined) {
					continue;
				}

				result[key] = visit(child);
			}

			return(result);
		}

		return(value);
	}

	const canonical = canonicalizeJson(visit(item));
	if (Buffer.byteLength(canonical, 'utf8') > TO_SIGNABLE_MAX_OUTPUT_BYTES) {
		throw(new KeetaAnchorError('Canonical output exceeds size limit in objectToSignable'));
	}

	return([ canonical ]);
}

/**
 * Options for signature verification
 */
export interface VerifyOptions {
	/** Maximum allowed time difference in milliseconds (default: 5 * 60 * 1000 = 5 minutes) */
	maxSkewMs?: number;
	/** Reference time for skew calculation (default: new Date()) */
	referenceTime?: Date;
}

export function FormatData(account: VerifiableAccount, data: Signable, nonce?: string, timestamp?: string | Date): { nonce: string; timestamp: string; verificationData: Buffer; } {
	nonce ??= crypto.randomUUID();
	timestamp ??= new Date();

	let timestampString: string;
	if (typeof timestamp === 'string') {
		timestampString = timestamp;
	} else {
		timestampString = timestamp.toISOString();
	}

	const input: KeetaNetASN1AnyJS[] = [
		nonce,
		timestampString,
		account.publicKeyAndType
	];

	const schema: KeetaNetASN1Validation.Schema[] = [
		{ type: 'string', kind: 'utf8' },
		{ type: 'string', kind: 'utf8' },
		KeetaNetLib.Utils.ASN1.ValidateASN1.IsOctetString
	];

	for (const item of data) {
		if (typeof item === 'string') {
			input.push(item);
			schema.push({ type: 'string', kind: 'utf8' });
		} else if (typeof item === 'number' || typeof item === 'bigint') {
			input.push(item);
			schema.push(KeetaNetLib.Utils.ASN1.ValidateASN1.IsInteger);
		} else if (KeetaNetLib.Account.isInstance(item)) {
			input.push(item.publicKeyAndType);
			schema.push(KeetaNetLib.Utils.ASN1.ValidateASN1.IsOctetString);
		} else {
			assertNever(item);
		}
	}

	/*
	 * Verify that the generated ASN.1 data matches the expected schema before returning it.
	 */
	// @ts-ignore
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const inputCanonical = KeetaNetLib.Utils.ASN1.ValidateASN1.againstSchema(input, schema);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
	const verificationData = KeetaNetLib.Utils.ASN1.JStoASN1(inputCanonical);

	return({
		nonce: nonce,
		timestamp: timestampString,
		verificationData: arrayBufferLikeToBuffer(verificationData.toBER())
	});
}

export async function SignData(account: SignableAccount, data: Signable): Promise<{ nonce: string; timestamp: string; signature: string; }> {
	const { nonce, timestamp, verificationData } = FormatData(account, data);
	const signature = await account.sign(bufferToArrayBuffer(verificationData));

	return({
		nonce: nonce,
		timestamp: timestamp,
		signature: signature.getBuffer().toString('base64')
	});
}

export async function VerifySignedData(
	account: VerifiableAccount,
	data: Signable,
	signed: Awaited<ReturnType<typeof SignData>>,
	options?: VerifyOptions
): Promise<boolean> {
	const nonce = signed.nonce;
	const timestampString = signed.timestamp;
	const signatureBuffer = Buffer.from(signed.signature, 'base64');

	const timestamp = new Date(timestampString);
	/*
	 * Enforce that the timestamp string is in valid ISO 8601 format,
	 * not just a date that can be parsed
	 *
	 * XXX:TODO: This is not a perfect check since ISO 8601 does not require millisecond-level
	 *           precision and technically allows other timezones (though we will not support
	 *           those).  This will be changed in the future to be more robust.
	 */
	if (timestamp.toISOString() !== timestampString) {
		return(false);
	}

	const maxSkewMs = options?.maxSkewMs ?? 5 * 60 * 1000;
	const referenceTime = options?.referenceTime ?? new Date();
	if (Math.abs(timestamp.valueOf() - referenceTime.valueOf()) > maxSkewMs) {
		/* Timestamp exceeds allowed skew from reference time */
		return(false);
	}

	/* XXX:TODO: Verify that the timestamp is a valid ISO 8601 date string within a reasonable range */
	const { verificationData } = FormatData(account, data, nonce, timestampString);

	return(account.verify(KeetaNetLib.Utils.Helper.bufferToArrayBuffer(verificationData), KeetaNetLib.Utils.Helper.bufferToArrayBuffer(signatureBuffer)));
}
