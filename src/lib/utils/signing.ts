import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type {
	ValidateASN1 as KeetaNetASN1Validation,
	ASN1AnyJS as KeetaNetASN1AnyJS
} from '@keetanetwork/keetanet-client/lib/utils/asn1.js';

import { Buffer, bufferToArrayBuffer, arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';
import { assertNever } from '../../lib/utils/never.js';
import { KeetaAnchorUserError } from '../error.js';

export type SignableAccount = ReturnType<InstanceType<typeof KeetaNetLib.Account>['assertAccount']>;
export type VerifiableAccount = InstanceType<typeof KeetaNetLib.Account>;
export type Signable = (string | number | bigint | InstanceType<typeof KeetaNetLib.Account>)[];

/**
 * Structural input to {@link objectToSignable}.
 */
export type SignableInput =
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	{ [key: string | number | symbol]: any } |
	SignableInput[] |
	Signable[number] |
	undefined |
	null |
	boolean;

/** DoS guard for {@link objectToSignable}. */
const TO_SIGNABLE_MAX_QUEUE_LENGTH = 250;

/**
 * Canonicalize a tree into a deterministic {@link Signable}.
 *
 * Drops `undefined`/`null`, encodes booleans as 1/0, sorts the flattened
 * dot/index key path with a stable locale comparator.
 */
export function objectToSignable(item: SignableInput): Signable {
	const queue: [ string, SignableInput ][] = [[ '', item ]];
	const result: [ string, Signable[number] ][] = [];

	while (queue.length > 0) {
		const next = queue.shift();
		if (!next) {
			continue;
		}

		const [ prefix, current ] = next;
		if (current === null || current === undefined) {
			continue;
		}

		if (typeof current === 'boolean') {
			result.push([ prefix, current ? 1 : 0 ]);
		} else if (Array.isArray(current)) {
			for (let i = 0; i < current.length; i++) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				queue.push([ `${prefix}[${i}]`, current[i] as SignableInput ]);
			}
		} else if (typeof current === 'object') {
			for (const [ key, value ] of Object.entries(current)) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				queue.push([ prefix ? `${prefix}.${key}` : key, value as SignableInput ]);
			}
		} else {
			result.push([ prefix, current ]);
		}

		if (queue.length > TO_SIGNABLE_MAX_QUEUE_LENGTH) {
			throw(new KeetaAnchorUserError('Too much data to sign in objectToSignable'));
		}
	}

	result.sort((a, b) => {
		return(a[0].localeCompare(b[0], 'en-US', {
			usage: 'sort',
			numeric: true,
			sensitivity: 'case',
			ignorePunctuation: false
		}));
	});

	return(result.map(item => item[1]));
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
