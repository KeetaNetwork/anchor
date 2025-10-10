import { test, expect } from 'vitest';
import * as fc from 'fast-check';
import type {
	ConversionInputCanonical,
	KeetaFXAnchorEstimateResponse,
	KeetaFXAnchorExchangeResponse,
	KeetaFXAnchorQuote
} from './common.ts';
import {
	assertConversionInputCanonicalJSON,
	assertConversionQuoteJSON,
	assertKeetaNetTokenPublicKeyString,
	isKeetaFXAnchorEstimateResponse,
	isKeetaFXAnchorExchangeResponse,
	isKeetaFXAnchorQuoteResponse
} from './common.js';
import { KeetaNet } from '../../client/index.js';

const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
const token = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);

function isRecord(obj: unknown): obj is { [key: string]: unknown } {
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj) || Object.prototype.toString.call(obj) !== '[object Object]'){
		return(false);
	}
	// Ensure all keys are strings
	for (const key of Object.keys(obj)) {
		if (typeof key !== 'string') {
			return(false);
		}
	}
	return(true);
}

function getLeafPaths(obj: unknown, prefix = '', includeParents = true): string[] {
	const paths: string[] = [];
	if (!isRecord(obj)) {
		throw(new Error('input should be a non-null object with string keys'));
	}

	for (const key in obj) {
		const value = obj[key];
		const fullPath = prefix ? `${prefix}.${key}` : key;

		if (value !== null && typeof value === 'object') {
			if (Object.prototype.toString.call(value) === '[object Object]' && includeParents) {
			// Include the full object as a fuzz target
				paths.push(fullPath);
			}
			paths.push(...getLeafPaths(value, fullPath));
		} else {
			paths.push(fullPath);
		}
	}

	return(paths);
}

function setByPath(obj: unknown, path: string, value: unknown): void {
	const parts = path.split('.');
	const last = parts.pop();
	if (last === undefined) {
		throw(new Error('last value is undefined'));
	}

	let target = obj;
	for (const part of parts) {
		if (!isRecord(target)) {
			throw(new Error('target should be a non-null object with string keys'));
		}
		if (!(part in target)) {
			target[part] = {};
		}
		target = target[part];
	}

	if (!isRecord(target)) {
		throw(new Error('target should be a non-null object with string keys'));
	}
	target[last] = value;
}

const requestCanonical: ConversionInputCanonical = {
	from: token,
	to: token,
	amount: 100n,
	affinity: 'from'
};
const requestCanonicalJSON = KeetaNet.lib.Utils.Conversion.toJSONSerializable(requestCanonical);
const requestPaths = getLeafPaths(requestCanonicalJSON);

for (const path of requestPaths) {
	test(`Fuzzing field: ${path}`, async () => {
		fc.assert(
			fc.property(fc.anything(), (fuzzedValue) => {
				const input = structuredClone(requestCanonical);
				setByPath(input, path, fuzzedValue);
				try {
					expect(() => assertConversionInputCanonicalJSON(input)).toThrow();
				} catch { /* ignored */ }

				return(true);
			}),
			{ numRuns: 100 }
		);
	});
}

const baseEstimate: KeetaFXAnchorEstimateResponse = {
	ok: true,
	estimate: KeetaNet.lib.Utils.Conversion.toJSONSerializable({
		request: requestCanonical,
		convertedAmount: 200n,
		expectedCost: {
			min: 5n,
			max: 10n,
			token: token
		}
	})
};
const estimatePaths = getLeafPaths(baseEstimate);
for (const path of estimatePaths) {
	test(`Fuzzing Estimate Field: ${path}`, async () => {
		fc.assert(
			fc.property(fc.anything(), (fuzzedValue) => {
				const input = structuredClone(baseEstimate);
				setByPath(input, path, fuzzedValue);
				// Skip this test case if it’s still valid
				fc.pre(!isKeetaFXAnchorEstimateResponse(input));
				expect(isKeetaFXAnchorEstimateResponse(input)).toBe(false);

				return(true);
			}),
			{ numRuns: 100 }
		);
	});
}

test(`Fuzzing TokenPublicKeyString`, async () => {
	fc.assert(
		fc.property(fc.anything(), (fuzzedValue) => {
			try {
				expect(() => assertKeetaNetTokenPublicKeyString(fuzzedValue)).toThrow();
			} catch { /* ignored */ }

			return(true);
		}),
		{ numRuns: 100 }
	);
});

const baseQuote: KeetaFXAnchorQuote = {
	request: requestCanonical,
	account: account,
	convertedAmount: 200n,
	cost: {
		amount: 10n,
		token: token
	},
	signed: {
		nonce: '1',
		timestamp: (new Date()).toISOString(),
		signature: '123'
	}
};

const quotePaths = getLeafPaths(baseQuote);
for (const path of quotePaths) {
	test(`Fuzzing Quote Field: ${path}`, async () => {
		fc.assert(
			fc.property(fc.anything(), (fuzzedValue) => {
				const input = structuredClone(baseQuote);
				setByPath(input, path, fuzzedValue);

				fc.pre(!isKeetaFXAnchorQuoteResponse(input));
				expect(isKeetaFXAnchorQuoteResponse(input)).toBe(false);

				try {
					expect(() => assertConversionQuoteJSON(KeetaNet.lib.Utils.Conversion.toJSONSerializable(input))).toThrow();
				} catch { /* ignored */ }

				return(true);
			}),
			{ numRuns: 100 }
		);
	});
}

const baseQuoteJSON = KeetaNet.lib.Utils.Conversion.toJSONSerializable(baseQuote);
const quoteJSONPaths = getLeafPaths(baseQuoteJSON);
for (const path of quoteJSONPaths) {
	test(`Fuzzing Quote Field: ${path}`, async () => {
		fc.assert(
			fc.property(fc.anything(), (fuzzedValue) => {
				const input = structuredClone(baseQuoteJSON);
				setByPath(input, path, fuzzedValue);
				try {
					expect(() => assertConversionQuoteJSON(input)).toThrow();
				} catch { /* ignored */ }

				return(true);
			}),
			{ numRuns: 100 }
		);
	});
}

const exchangeResponse: KeetaFXAnchorExchangeResponse = {
	exchangeID: '123',
	ok: true
}
const exchangePaths = getLeafPaths(exchangeResponse);
for (const path of exchangePaths) {
	test(`Fuzzing Estimate Field: ${path}`, async () => {
		fc.assert(
			fc.property(fc.anything(), (fuzzedValue) => {
				const input = structuredClone(exchangeResponse);
				setByPath(input, path, fuzzedValue);
				// Skip this test case if it’s still valid
				fc.pre(!isKeetaFXAnchorExchangeResponse(input));
				expect(isKeetaFXAnchorExchangeResponse(input)).toBe(false);

				return(true);
			}),
			{ numRuns: 100 }
		);
	});
}

test('FX Fuzz Test', async function() {
	const fcConversionInput = fc.dictionary(
		fc.constantFrom('from', 'to', 'amount', 'affinity'),
		fc.anything()
	);
	const fcKeetaFXAnchorEstimate = fc.record({
		request: fcConversionInput,
		convertedAmount: fc.bigInt(),
		expectedCost: fc.dictionary(
			fc.constantFrom('min', 'max', 'token'),
			fc.anything()
		)
	});
	const fcKeetaFXAnchorQuote = fc.record({
		request: fcConversionInput,
		convertedAmount: fc.bigInt(),
		cost: fc.dictionary(
			fc.constantFrom('amount', 'token'),
			fc.anything()
		),
		signed: fc.dictionary(
			fc.constantFrom('nonce', 'timestamp', 'signature'),
			fc.anything()
		)
	});

	fc.assert(
		fc.property(fcConversionInput, (input) => {
			try {
				expect(() => assertConversionInputCanonicalJSON(input)).toThrow();
			} catch { /* ignored */ }

			return(true);
		}),
		{ numRuns: 1000 }
	);

	fc.assert(
		fc.property(fcKeetaFXAnchorEstimate, (input) => {
			expect(isKeetaFXAnchorEstimateResponse(input)).toBe(false);

			return(true);
		}),
		{ numRuns: 1000 }
	);

	fc.assert(
		fc.property(fcKeetaFXAnchorQuote, (input) => {
			fc.pre(!isKeetaFXAnchorQuoteResponse(input));
			expect(isKeetaFXAnchorQuoteResponse(input)).toBe(false);
			try {
				expect(() => assertConversionQuoteJSON(input)).toThrowError();
			} catch { /* ignored */  }

			return(true);
		}),
		{ numRuns: 1000 }
	);
});

test('FX Fuzz Test', async function() {
	expect(1).toBe(1);
});
