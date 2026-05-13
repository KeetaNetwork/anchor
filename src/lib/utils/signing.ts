import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type {
	ValidateASN1 as KeetaNetASN1Validation,
	ASN1AnyJS as KeetaNetASN1AnyJS
} from '@keetanetwork/keetanet-client/lib/utils/asn1.js';

import { Buffer, bufferToArrayBuffer, arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';
import { assertNever } from '../../lib/utils/never.js';
import { KeetaAnchorError, KeetaAnchorUserError } from '../error.js';

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

const TO_SIGNABLE_MAX_TOKENS = 1000;

const OBJECT_OPEN = '{';
const OBJECT_CLOSE = '}';
const ARRAY_OPEN = '[';
const ARRAY_CLOSE = ']';
const NULL_MARKER = 'null';

/**
 * Canonicalize a tree into a flat {@link Signable}.
 *
 * Objects: sort keys by codepoint, frame with `{`/`}`, drop nullish values.
 * Arrays: keep index order, frame with `[`/`]`, replace nullish entries
 * with {@link NULL_MARKER}. Booleans become `1`/`0`.
 */
export function objectToSignable(item: SignableInput): Signable {
	const result: Signable = [];

	function emit(token: Signable[number]): void {
		result.push(token);
		if (result.length > TO_SIGNABLE_MAX_TOKENS) {
			throw(new KeetaAnchorUserError('Too much data to sign in objectToSignable'));
		}
	}

	function walk(current: unknown): void {
		if (current === null || current === undefined) {
			emit(NULL_MARKER);
			return;
		}

		if (typeof current === 'boolean') {
			emit(current ? 1 : 0);
			return;
		}

		if (Array.isArray(current)) {
			emit(ARRAY_OPEN);

			for (const value of current) {
				walk(value);
			}

			emit(ARRAY_CLOSE);
			return;
		}

		if (typeof current === 'object' && !KeetaNetLib.Account.isInstance(current)) {
			emit(OBJECT_OPEN);

			const entries = Object.entries(current).filter(([ , value ]) => value !== null && value !== undefined);
			entries.sort(([ a ], [ b ]) => {
				if (a < b) {
					return(-1);
				}
				if (a > b) {
					return(1);
				}

				return(0);
			});

			for (const [ key, value ] of entries) {
				emit(key);
				walk(value);
			}

			emit(OBJECT_CLOSE);
			return;
		}

		if (typeof current === 'string' || typeof current === 'number' || typeof current === 'bigint' || KeetaNetLib.Account.isInstance(current)) {
			emit(current);
			return;
		}

		throw(new KeetaAnchorError('Unsupported value type in objectToSignable'));
	}

	walk(item);

	return(result);
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
