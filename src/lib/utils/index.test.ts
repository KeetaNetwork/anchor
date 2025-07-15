import { test, expect, describe } from 'vitest';
import { JSON as JSONUtils, Array as ArrayUtils } from './index.js';
import { Account } from '@keetanetwork/keetanet-node/dist/lib/account.js';

const testAccount1 = Account.fromSeed('D6986115BE7334E50DA8D73B1A4670A510E8BF47E8C5C9960B8F5248EC7D6E3D', 0);
const testAccount2 = Account.fromPublicKeyString(testAccount1.publicKeyString.get());

describe('JSON: Utils', function() {
	function generateObjectWithAllTypes() {
		return({
			string: 'abcdef',
			number: 10,
			number_nan: NaN,
			number_inf: Infinity,
			number_neginf: -Infinity,
			boolean: true,
			array: [1, 2, 3, BigInt(4), null, undefined, 'abc'],
			buffer: Buffer.from('abcdef'),
			arraybuffer: new ArrayBuffer(10),
			bigint: BigInt('10000000000000000000000000000000000000'),
			bigint_neg: BigInt('-10000000000000000000000000000000000000'),
			bigint_small_neg: BigInt('-100'),
			bigint_small: BigInt('100'),
			date: new Date(),
			symbol: Symbol('abc\\xx\x99\x01'),
			function: () => {},
			promise: Promise.resolve(),
			nullable: null,
			undefined: undefined,
			account1: testAccount1,
			account2: testAccount2,
			class: class TestClass {},
			serializable: new (class Serializable {
				toJSON() {
					return('ToJSON Serializable');
				}
			})(),
			unserializable: new (class Unserializable {
				toString() {
					return('ToString Unserializable');
				}
			})()
		});
	};

	describe('convertToJSONObject', function() {
		test('should convert a string to JSON', function() {
			const expected = {
				...generateObjectWithAllTypes(),
				nested: generateObjectWithAllTypes()
			};
			const result = {
				true: {
					...expected,
					buffer: 'YWJjZGVm',
					arraybuffer: 'AAAAAAAAAAAAAA==',
					number_inf: '#Inf',
					number_neginf: '#-Inf',
					number_nan: '#NaN',
					promise: '[Promise]',
					bigint: '0x785ee10d5da46d900f436a000000000',
					bigint_neg: '-0x785ee10d5da46d900f436a000000000',
					bigint_small: 100,
					bigint_small_neg: -100,
					function: '[Function function]',
					date: expected.date.toISOString(),
					symbol: `[${expected.symbol.toString()}]`,
					undefined: 'undefined',
					array: [1, 2, 3, 4, null, 'undefined', 'abc'],
					account1: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PRIVATE]',
					account2: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PUBLIC]',
					class: '[Class TestClass]',
					serializable: 'ToJSON Serializable',
					unserializable: '[Instance Unserializable]',
					nested: {
						...expected.nested,
						buffer: 'YWJjZGVm',
						arraybuffer: 'AAAAAAAAAAAAAA==',
						number_inf: '#Inf',
						number_neginf: '#-Inf',
						number_nan: '#NaN',
						bigint: '0x785ee10d5da46d900f436a000000000',
						bigint_neg: '-0x785ee10d5da46d900f436a000000000',
						bigint_small: 100,
						bigint_small_neg: -100,
						promise: '[Promise]',
						function: '[Function function]',
						date: expected.nested.date.toISOString(),
						symbol: `[${expected.nested.symbol.toString()}]`,
						undefined: 'undefined',
						array: [1, 2, 3, 4, null, 'undefined', 'abc'],
						account1: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PRIVATE]',
						account2: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PUBLIC]',
						class: '[Class TestClass]',
						serializable: 'ToJSON Serializable',
						unserializable: '[Instance Unserializable]'
					}
				},
				false: {
					...expected,
					buffer: 'YWJjZGVm',
					arraybuffer: 'AAAAAAAAAAAAAA==',
					number_inf: '\u221e',
					number_neginf: '-\u221e',
					number_nan: '#NaN',
					promise: '[Promise]',
					bigint: '0x785ee10d5da46d900f436a000000000[=>10000000000000000000000000000000000000]',
					bigint_neg: '-0x785ee10d5da46d900f436a000000000[=>-10000000000000000000000000000000000000]',
					bigint_small: 100,
					bigint_small_neg: -100,
					function: '[Function function]',
					date: `[Date ${expected.date.toISOString()}]`,
					symbol: `[${expected.symbol.toString()}]`,
					undefined: 'undefined',
					array: [1, 2, 3, 4, null, 'undefined', 'abc'],
					account1: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PRIVATE]',
					account2: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PUBLIC]',
					class: '[Class TestClass]',
					serializable: 'ToJSON Serializable',
					unserializable: '[Instance Unserializable]',
					nested: {
						...expected.nested,
						buffer: 'YWJjZGVm',
						arraybuffer: 'AAAAAAAAAAAAAA==',
						number_inf: '\u221e',
						number_neginf: '-\u221e',
						number_nan: '#NaN',
						bigint: '0x785ee10d5da46d900f436a000000000[=>10000000000000000000000000000000000000]',
						bigint_neg: '-0x785ee10d5da46d900f436a000000000[=>-10000000000000000000000000000000000000]',
						bigint_small: 100,
						bigint_small_neg: -100,
						promise: '[Promise]',
						function: '[Function function]',
						date: `[Date ${expected.nested.date.toISOString()}]`,
						symbol: `[${expected.nested.symbol.toString()}]`,
						undefined: 'undefined',
						array: [1, 2, 3, 4, null, 'undefined', 'abc'],
						account1: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PRIVATE]',
						account2: '[Account keeta_aabkmqlcfb73ts7p3syzker5cim4by3u5nlkygr23jztwm27klf5q62cic23t2y PUBLIC]',
						class: '[Class TestClass]',
						serializable: 'ToJSON Serializable',
						unserializable: '[Instance Unserializable]'
					}
				}
			}

			for (const searchable of [true, false]) {
				const checkResults = JSONUtils.convertToJSON(expected, { searchable });
				const expectedResults = result[searchable.toString() as 'true' | 'false'];

				try {
					expect(checkResults).toStrictEqual(expectedResults);
				} catch (failure) {
					console.error('Failed to ConvertToJSON with searchable as', searchable);
					throw(failure);
				}
			}
		});
	});
});

describe('Array: Utils', function() {
	test('Array: Utils', function() {
		const checks: { input: unknown, len?: number; result: boolean; }[] = [{
			input: [],
			result: true
		}, {
			input: [],
			len: 0,
			result: true
		}, {
			input: [],
			len: 1,
			result: false
		}, {
			input: [1],
			len: 1,
			result: true, 
		}, {
			input: null,
			result: false
		}];

		for (const check of checks) {
			expect(ArrayUtils.isArray(check.input, check.len)).toEqual(check.result);
		}
	});
});
