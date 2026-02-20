/* eslint-disable @typescript-eslint/no-deprecated */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* cspell:ignore abax xaba hicaf ababab mylink nihao shijie annyeong konnichiwa marhaba geia keycaps propos keycap kshi sawasdee ello precomposed cafx */
import { test, expect, describe } from 'vitest';
import { GraphemeString } from './grapheme-string.js';

describe('GraphemeString', function() {
	describe('Constructor', function() {
		test('should create from various input types', function() {
			const checks = [
				{ input: 'hello', expectedLength: 5, expectedString: 'hello', description: 'simple ASCII' },
				{ input: '', expectedLength: 0, expectedString: '', description: 'empty string' },
				{ input: '\uD83D\uDC4B\uD83C\uDFFD', expectedLength: 1, expectedString: '\uD83D\uDC4B\uD83C\uDFFD', description: 'emoji with skin tone' },
				{ input: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66', expectedLength: 1, expectedString: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66', description: 'family emoji ZWJ sequence' },
				{ input: '\uD83C\uDDFA\uD83C\uDDF8', expectedLength: 1, expectedString: '\uD83C\uDDFA\uD83C\uDDF8', description: 'flag emoji' },
				{ input: 'caf\u00e9', expectedLength: 4, expectedString: 'caf\u00e9', description: 'accented characters' },
				{ input: 'e\u0301', expectedLength: 1, expectedString: '\u00e9', description: 'NFD normalized to NFC' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.input);
				expect(gs.length).toBe(check.expectedLength);
				expect(gs.toString()).toBe(check.expectedString);
			}
		});

		test('should create from array of graphemes', function() {
			const checks = [
				{ input: ['h', 'e', 'l', 'l', 'o'], expected: 'hello', length: 5 },
				{ input: [], expected: '', length: 0 },
				{ input: ['\uD83D\uDC4B\uD83C\uDFFD', 'a', '\uD83D\uDE00'], expected: '\uD83D\uDC4B\uD83C\uDFFDa\uD83D\uDE00', length: 3 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.input);
				expect(gs.length).toBe(check.length);
				expect(gs.toString()).toBe(check.expected);
			}
		});

		test('should copy from another GraphemeString', function() {
			const gs1 = new GraphemeString('hello\uD83D\uDC4B\uD83C\uDFFD');
			const gs2 = new GraphemeString(gs1);
			expect(gs2.length).toBe(gs1.length);
			expect(gs2.toString()).toBe(gs1.toString());
		});

		test('should throw error when locale provided with GraphemeString input', function() {
			const gs1 = new GraphemeString('hello');
			expect(function() {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return(new GraphemeString(gs1 as any, 'en-US'));
			}).toThrow('Locale argument must not be provided when input is a GraphemeString');
		});

		test('should accept various locale formats', function() {
			const locales = ['en', 'en-US', 'fr-FR', 'ja-JP', undefined];
			for (const locale of locales) {
				const gs = new GraphemeString('hello', locale);
				expect(gs.toString()).toBe('hello');
			}
		});
	});

	describe('De-normalized Unicode inputs (NFC normalization)', function() {
		test('should normalize various NFD inputs to NFC', function() {
			const checks = [
				{ nfd: 'e\u0301', nfc: '\u00e9', expectedLength: 1, description: 'e with combining acute' },
				{ nfd: 'cafe\u0301', nfc: 'caf\u00e9', expectedLength: 4, description: 'cafe accent' },
				{ nfd: 'a\u0308', nfc: '\u00e4', expectedLength: 1, description: 'a with diaeresis' },
				{ nfd: 'n\u0303', nfc: '\u00f1', expectedLength: 1, description: 'n with tilde' },
				{ nfd: 'o\u0302', nfc: '\u00f4', expectedLength: 1, description: 'o with circumflex' },
				{ nfd: 'u\u0308', nfc: '\u00fc', expectedLength: 1, description: 'u with diaeresis' },
				{ nfd: 'i\u0301', nfc: '\u00ed', expectedLength: 1, description: 'i with acute' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.nfd);
				expect(gs.toString()).toBe(check.nfc);
				expect(gs.length).toBe(check.expectedLength);
			}
		});

		test('should handle multiple combining marks', function() {
			const checks = [
				{ input: 'e\u0301\u0302', expectedLength: 1, description: 'e with acute and circumflex' },
				{ input: 'a\u0308\u0304', expectedLength: 1, description: 'a with diaeresis and macron' },
				{ input: 'o\u0302\u0303', expectedLength: 1, description: 'o with circumflex and tilde' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.input);
				expect(gs.length).toBe(check.expectedLength);
			}
		});

		test('should normalize words with multiple accented characters', function() {
			const checks = [
				{ input: 'cafe\u0301 cre\u0300me bru\u0302le\u0301e', normalized: 'caf\u00e9 cr\u00e8me br\u00fbl\u00e9e' },
				{ input: 'a\u0308', normalized: '\u00e4' },
				{ input: 'Zu\u0308rich', normalized: 'Z\u00fcrich' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.input);
				expect(gs.toString()).toBe(check.normalized);
			}
		});
	});

	describe('Multi-code-point grapheme clusters', function() {
		test('should handle various emoji types', function() {
			const checks = [
				{ emoji: '\uD83D\uDC4B\uD83C\uDFFD', type: 'waving hand with skin tone', expectedLength: 1 },
				{ emoji: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66', type: 'family ZWJ sequence', expectedLength: 1 },
				{ emoji: '\uD83C\uDDFA\uD83C\uDDF8', type: 'US flag regional indicators', expectedLength: 1 },
				{ emoji: '\u263A\uFE0F', type: 'smiling face with variation selector', expectedLength: 1 },
				{ emoji: '1\uFE0F\u20E3', type: 'keycap 1', expectedLength: 1 },
				{ emoji: '\uD83D\uDC68\uD83C\uDFFD\u200D\u2695\uFE0F', type: 'male health worker with skin tone', expectedLength: 1 },
				{ emoji: '\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08', type: 'rainbow flag', expectedLength: 1 },
				{ emoji: '\uD83D\uDC69\u200D\u2764\uFE0F\u200D\uD83D\uDC8B\u200D\uD83D\uDC68', type: 'kiss woman man', expectedLength: 1 },
				{ emoji: '\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74\uDB40\uDC7F', type: 'Scotland flag', expectedLength: 1 },
				{ emoji: '\uD83D\uDC68\uD83C\uDFFD\u200D\uD83D\uDCBB', type: 'male technologist with skin tone', expectedLength: 1 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.emoji);
				expect(gs.length).toBe(check.expectedLength);
				expect(gs.toString()).toBe(check.emoji);
			}
		});

		test('should handle complex scripts with combining marks', function() {
			const checks = [
				{ text: '\u0915\u094D\u0937\u093F', script: 'Devanagari kshi', expectedLength: 1 },
				{ text: '\u0645\u064F\u062D\u064E\u0645\u064E\u0651\u062F', script: 'Arabic Muhammad with diacritics' },
				{ text: '\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35', script: 'Thai sawasdee' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.toString()).toBe(check.text);
				if (check.expectedLength) {
					expect(gs.length).toBe(check.expectedLength);
				}
			}
		});

		test('should correctly count multiple emoji', function() {
			const checks = [
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00\uD83C\uDDFA\uD83C\uDDF8', length: 3 },
				{ text: '\uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDEC\uD83C\uDDE7\uD83C\uDDEB\uD83C\uDDF7', length: 3 },
				{ text: '\uD83D\uDC4B\uD83C\uDFFB\uD83D\uDC4B\uD83C\uDFFC\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDC4B\uD83C\uDFFE\uD83D\uDC4B\uD83C\uDFFF', length: 5 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.length).toBe(check.length);
			}
		});
	});

	describe('charAt and at', function() {
		test('should return character at various positions', function() {
			const checks = [
				{ text: 'hello', pos: 0, expectedCharAt: 'h', expectedAt: 'h' },
				{ text: 'hello', pos: 4, expectedCharAt: 'o', expectedAt: 'o' },
				{ text: 'hello', pos: 5, expectedCharAt: '', expectedAt: '' },
				{ text: 'hello', pos: -1, expectedCharAt: '', expectedAt: 'o' },
				{ text: 'hello', pos: -2, expectedCharAt: '', expectedAt: 'l' },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00', pos: 0, expectedCharAt: '\uD83D\uDC4B\uD83C\uDFFD', expectedAt: '\uD83D\uDC4B\uD83C\uDFFD' },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00', pos: 1, expectedCharAt: '\uD83D\uDE00', expectedAt: '\uD83D\uDE00' },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00', pos: -1, expectedCharAt: '', expectedAt: '\uD83D\uDE00' },
				{ text: 'a\uD83D\uDC4B\uD83C\uDFFDb', pos: 1, expectedCharAt: '\uD83D\uDC4B\uD83C\uDFFD', expectedAt: '\uD83D\uDC4B\uD83C\uDFFD' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.charAt(check.pos)).toBe(check.expectedCharAt);
				expect(gs.at(check.pos)).toBe(check.expectedAt);
			}
		});
	});

	describe('concat and concatGrapheme', function() {
		test('should concatenate various types', function() {
			const checks = [
				{ base: 'hello', args: [' ', 'world'], expected: 'hello world' },
				{ base: 'a', args: ['b', 'c', 'd'], expected: 'abcd' },
				{ base: '\uD83D\uDC4B\uD83C\uDFFD', args: ['\uD83D\uDE00'], expected: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00' },
				{ base: '', args: ['hello'], expected: 'hello' },
				{ base: 'test', args: [], expected: 'test' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.base);
				expect(gs.concat(...check.args)).toBe(check.expected);
				expect(gs.concatGrapheme(...check.args).toString()).toBe(check.expected);
			}
		});

		test('should concatenate GraphemeStrings', function() {
			const gs1 = new GraphemeString('hello');
			const gs2 = new GraphemeString(' world');
			const gs3 = new GraphemeString('!');
			expect(gs1.concat(gs2, gs3)).toBe('hello world!');
			expect(gs1.concatGrapheme(gs2, gs3).toString()).toBe('hello world!');
		});

		test('should handle empty concatenations', function() {
			const gs = new GraphemeString('hello');
			expect(gs.concat('', '', '')).toBe('hello');
		});

		test('should concatenate multiple items including emoji', function() {
			const gs = new GraphemeString('start');
			const parts = [' ', 'middle', ' ', '\uD83D\uDC4B\uD83C\uDFFD', ' ', 'end'];
			const result = gs.concatGrapheme(...parts);
			expect(result.toString()).toBe('start middle \uD83D\uDC4B\uD83C\uDFFD end');
		});

		test('should correctly handle combining characters (modifiers) in concat', function() {
			const checks = [
				{
					description: 'concat combining acute to "cafe"',
					base: 'cafe',
					modifier: '\u0301',
					expectedString: 'caf\u00e9',
					expectedLength: 4
				},
				{
					description: 'concat combining diaeresis to "u"',
					base: 'u',
					modifier: '\u0308',
					expectedString: '\u00fc',
					expectedLength: 1
				},
				{
					description: 'concat combining tilde to "n"',
					base: 'n',
					modifier: '\u0303',
					expectedString: '\u00f1',
					expectedLength: 1
				},
				{
					description: 'concat combining acute to last char in multi-char string',
					base: 'hello',
					modifier: '\u0301',
					expectedString: 'hell\u00f3',
					expectedLength: 5
				},
				{
					description: 'concat multiple combining characters',
					base: 'e',
					modifier: '\u0301\u0302',
					expectedString: ('e\u0301\u0302').normalize('NFC'),
					expectedLength: 1
				},
				{
					description: 'concat combining characters affects last character only',
					base: 'test',
					modifier: '\u0308',
					expectedString: ('test\u0308').normalize('NFC'),
					expectedLength: 4
				}
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.base);
				const result = gs.concatGrapheme(check.modifier);
				expect(result.toString()).toBe(check.expectedString);
				expect(result.length).toBe(check.expectedLength);
			}
		});

		test('should handle combining characters with GraphemeString argument', function() {
			const base = new GraphemeString('cafe');
			const modifier = new GraphemeString('\u0301');
			const result = base.concatGrapheme(modifier);
			expect(result.toString()).toBe('caf\u00e9');
			expect(result.length).toBe(4);
			expect(result.charAt(3)).toBe('\u00e9');
		});

		test('should handle concat of base + modifier + more text', function() {
			const base = new GraphemeString('caf');
			const result = base.concatGrapheme('e\u0301', ' time');
			expect(result.toString()).toBe('caf\u00e9 time');
			expect(result.length).toBe(9);
			expect(result.charAt(3)).toBe('\u00e9');
		});

		test('should handle emoji skin tone modifiers in concat', function() {
			const base = new GraphemeString('Hello ');
			const wave = '\uD83D\uDC4B';
			const skinTone = '\uD83C\uDFFD';
			const result = base.concatGrapheme(wave, skinTone);
			expect(result.toString()).toBe('Hello \uD83D\uDC4B\uD83C\uDFFD');
			expect(result.length).toBe(7);
			expect(result.charAt(6)).toBe('\uD83D\uDC4B\uD83C\uDFFD');
		});

		test('should preserve normalization when concatenating', function() {
			const base = new GraphemeString('cafe');
			const result1 = base.concatGrapheme('\u0301');
			const result2 = base.concatGrapheme('\u00e9');

			expect(result1.toString().normalize('NFC')).toBe('caf\u00e9');
			expect(result2.toString()).toBe('cafe\u00e9');
			expect(result1.length).toBe(4);
			expect(result2.length).toBe(5);
		});
	});

	describe('includes', function() {
		test('should find substrings in various contexts', function() {
			const checks = [
				{ text: 'hello world', search: 'world', pos: undefined, expected: true },
				{ text: 'hello world', search: 'foo', pos: undefined, expected: false },
				{ text: 'hello hello', search: 'hello', pos: 1, expected: true },
				{ text: 'hello hello', search: 'hello', pos: 7, expected: false },
				{ text: 'Hello \uD83D\uDC4B\uD83C\uDFFD world', search: '\uD83D\uDC4B\uD83C\uDFFD', pos: undefined, expected: true },
				{ text: 'caf\u00e9', search: 'caf\u00e9', pos: undefined, expected: true }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.includes(check.search, check.pos)).toBe(check.expected);
			}
		});

		test('should accept GraphemeString as search', function() {
			const gs = new GraphemeString('hello world');
			const search = new GraphemeString('world');
			expect(gs.includes(search)).toBe(true);
		});
	});

	describe('indexOf and lastIndexOf', function() {
		test('should find index of substrings', function() {
			const checks = [
				{ text: 'hello world', search: 'world', pos: undefined, indexOf: 6, lastIndexOf: 6 },
				{ text: 'hello world', search: 'foo', pos: undefined, indexOf: -1, lastIndexOf: -1 },
				{ text: 'hello hello', search: 'hello', pos: 0, indexOf: 0, lastIndexOf: 0 },
				{ text: 'hello hello', search: 'hello', pos: 1, indexOf: 6, lastIndexOf: 0 },
				{ text: 'a\uD83D\uDC4B\uD83C\uDFFDb', search: '\uD83D\uDC4B\uD83C\uDFFD', pos: undefined, indexOf: 1, lastIndexOf: 1 },
				{ text: '\uD83D\uDC4B\uD83C\uDFFDa\uD83D\uDC4B\uD83C\uDFFD', search: '\uD83D\uDC4B\uD83C\uDFFD', pos: undefined, indexOf: 0, lastIndexOf: 2 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.indexOf(check.search, check.pos)).toBe(check.indexOf);
				if (check.pos !== undefined) {
					expect(gs.lastIndexOf(check.search, check.pos)).toBe(check.lastIndexOf);
				} else {
					expect(gs.lastIndexOf(check.search)).toBe(check.lastIndexOf);
				}
			}
		});

		test('should handle empty search string', function() {
			const gs = new GraphemeString('hello');
			const empty = new GraphemeString('');
			expect(gs.indexOf(empty)).toBe(0);
			expect(gs.indexOf(empty, 3)).toBe(3);
			expect(gs.lastIndexOf(empty)).toBe(5);
		});

		test('should accept GraphemeString as search parameter', function() {
			const gs = new GraphemeString('hello world');
			const search = new GraphemeString('world');
			expect(gs.indexOf(search)).toBe(6);
			expect(gs.lastIndexOf(search)).toBe(6);
		});

		test('should handle position edge cases', function() {
			const gs = new GraphemeString('hello hello');
			const indexOfChecks = [
				{ search: 'hello', pos: 0, expected: 0 },
				{ search: 'hello', pos: 1, expected: 6 },
				{ search: 'hello', pos: 6, expected: 6 },
				{ search: 'hello', pos: 7, expected: -1 },
				{ search: 'hello', pos: 100, expected: -1 }
			];

			for (const check of indexOfChecks) {
				expect(gs.indexOf(check.search, check.pos)).toBe(check.expected);
			}

			const lastIndexOfChecks = [
				{ search: 'hello', pos: undefined, expected: 6 },
				{ search: 'hello', pos: 10, expected: 6 },
				{ search: 'hello', pos: 5, expected: 0 },
				{ search: 'hello', pos: 0, expected: 0 }
			];

			for (const check of lastIndexOfChecks) {
				expect(gs.lastIndexOf(check.search, check.pos)).toBe(check.expected);
			}
		});
	});

	describe('match', function() {
		test('should match strings and regexes', function() {
			const checks = [
				{ text: 'hello world', search: 'world', expected: ['world'] },
				{ text: 'hello world', search: 'foo', expected: null },
				{ text: 'Hello \uD83D\uDC4B\uD83C\uDFFD', search: '\uD83D\uDC4B\uD83C\uDFFD', expected: ['\uD83D\uDC4B\uD83C\uDFFD'] }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.match(check.search)).toEqual(check.expected);
			}
		});

		test('should match with RegExp', function() {
			const gs = new GraphemeString('hello123world456');
			const result = gs.match(/\d+/);
			expect(result?.[0]).toBe('123');
		});
	});

	describe('search', function() {
		test('should return index for various searches', function() {
			const checks = [
				{ text: 'hello world', search: 'world', expected: 6 },
				{ text: 'hello world', search: 'foo', expected: -1 },
				{ text: 'hello123', search: /\d+/, expected: 5 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.search(check.search as string)).toBe(check.expected);
			}
		});

		test('should accept GraphemeString as search', function() {
			const gs = new GraphemeString('hello world');
			const search = new GraphemeString('world');
			expect(gs.search(search)).toBe(6);
		});
	});

	describe('slice/sliceGrapheme', function() {
		test('should slice at various positions', function() {
			const checks = [
				{ text: 'hello', start: 1, end: undefined, expected: 'ello' },
				{ text: 'hello', start: 1, end: 4, expected: 'ell' },
				{ text: 'hello', start: -2, end: undefined, expected: 'lo' },
				{ text: 'a\uD83D\uDC4B\uD83C\uDFFDb\uD83D\uDE00c', start: 1, end: 3, expected: '\uD83D\uDC4B\uD83C\uDFFDb', expectedLength: 2 },
				{ text: 'hello', start: 10, end: undefined, expected: '' },
				{ text: 'hello', start: 2, end: 2, expected: '' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.slice(check.start, check.end)).toBe(check.expected);
				const gsResult = gs.sliceGrapheme(check.start, check.end);
				expect(gsResult.toString()).toBe(check.expected);
				expect(gsResult).toBeInstanceOf(GraphemeString);
				if (check.expectedLength) {
					expect(gsResult.length).toBe(check.expectedLength);
				}
			}
		});

		test('should preserve emoji grapheme clusters in slicing', function() {
			const emoji = '\uD83D\uDC4B\uD83C\uDFFD';
			const text = 'abc' + emoji + 'def';
			const gs = new GraphemeString(text);

			expect(gs.sliceGrapheme(3, 4).toString()).toBe(emoji);
			expect(gs.sliceGrapheme(2, 5).toString()).toBe('c' + emoji + 'd');
		});
	});

	describe('substring/substringGrapheme', function() {
		test('should extract substrings', function() {
			const checks = [
				{ text: 'hello', start: 1, end: 4, expected: 'ell' },
				{ text: 'hello', start: 2, end: undefined, expected: 'llo' },
				{ text: 'a\uD83D\uDC4B\uD83C\uDFFDb', start: 0, end: 2, expected: 'a\uD83D\uDC4B\uD83C\uDFFD', expectedLength: 2 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.substring(check.start, check.end)).toBe(check.expected);
				const gsResult = gs.substringGrapheme(check.start, check.end);
				expect(gsResult.toString()).toBe(check.expected);
				if (check.expectedLength) {
					expect(gsResult.length).toBe(check.expectedLength);
				}
			}
		});
	});

	describe('substr/substrGrapheme', function() {
		test('should extract by start and length', function() {
			const checks = [
				{ text: 'hello', start: 1, length: 3, expected: 'ell' },
				{ text: 'hello', start: 2, length: undefined, expected: 'llo' },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00\uD83C\uDDFA\uD83C\uDDF8', start: 1, length: 1, expected: '\uD83D\uDE00' },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00\uD83C\uDDFA\uD83C\uDDF8', start: 1, length: 2, expected: '\uD83D\uDE00\uD83C\uDDFA\uD83C\uDDF8' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.substr(check.start, check.length)).toBe(check.expected);
				expect(gs.substrGrapheme(check.start, check.length).toString()).toBe(check.expected);
			}
		});
	});

	describe('split', function() {
		test('should split on empty string', function() {
			const checks = [
				{ text: 'hello', limit: undefined, expected: ['h', 'e', 'l', 'l', 'o'] },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00', limit: undefined, expected: ['\uD83D\uDC4B\uD83C\uDFFD', '\uD83D\uDE00'] },
				{ text: 'hello', limit: 3, expected: ['h', 'e', 'l'] },
				{ text: '', limit: undefined, expected: [] }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.split('', check.limit)).toEqual(check.expected);
			}
		});

		test('should split on non-empty string', function() {
			/* XXX:TODO */
		});
	});

	describe('startsWith and endsWith', function() {
		test('should check string starts and ends', function() {
			const checks = [
				{ text: 'hello world', search: 'hello', pos: undefined, startsWith: true, endsWith: false },
				{ text: 'hello world', search: 'world', pos: undefined, startsWith: false, endsWith: true },
				{ text: 'hello world', search: 'world', pos: 6, startsWith: true, endsWith: false },
				{ text: '\uD83D\uDC4B\uD83C\uDFFDhello', search: '\uD83D\uDC4B\uD83C\uDFFD', pos: undefined, startsWith: true, endsWith: false },
				{ text: 'hello\uD83D\uDC4B\uD83C\uDFFD', search: '\uD83D\uDC4B\uD83C\uDFFD', pos: undefined, startsWith: false, endsWith: true },
				{ text: 'hello', search: 'h', pos: -1, startsWith: false, endsWith: false },
				{ text: 'hello', search: 'o', pos: 10, startsWith: false, endsWith: true },
				{ text: 'hi', search: 'hello', pos: undefined, startsWith: false, endsWith: false }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.startsWith(check.search, check.pos)).toBe(check.startsWith);
				expect(gs.endsWith(check.search, check.pos)).toBe(check.endsWith);
			}
		});

		test('should handle empty string searches', function() {
			const gs = new GraphemeString('hello');
			expect(gs.startsWith('', 0)).toBe(true);
			expect(gs.startsWith('', 5)).toBe(true);
			expect(gs.endsWith('', 0)).toBe(true);
			expect(gs.endsWith('', 5)).toBe(true);
		});

		test('should accept GraphemeString as search', function() {
			const gs = new GraphemeString('hello world');
			const searchStart = new GraphemeString('hello');
			const searchEnd = new GraphemeString('world');
			expect(gs.startsWith(searchStart)).toBe(true);
			expect(gs.endsWith(searchEnd)).toBe(true);
		});
	});

	describe('Trim operations', function() {
		test('should trim whitespace from various positions', function() {
			const checks = [
				{ input: '  hello  ', trim: 'hello', trimStart: 'hello  ', trimEnd: '  hello' },
				{ input: '\t\nhello\r\n', trim: 'hello', trimStart: 'hello\r\n', trimEnd: '\t\nhello' },
				{ input: 'hello', trim: 'hello', trimStart: 'hello', trimEnd: 'hello' },
				{ input: '   ', trim: '', trimStart: '', trimEnd: '' },
				{ input: '  \uD83D\uDC4B\uD83C\uDFFD  ', trim: '\uD83D\uDC4B\uD83C\uDFFD', trimStart: '\uD83D\uDC4B\uD83C\uDFFD  ', trimEnd: '  \uD83D\uDC4B\uD83C\uDFFD' },
				{ input: ' \t\n\r hello \r\n\t ', trim: 'hello', trimStart: 'hello \r\n\t ', trimEnd: ' \t\n\r hello' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.input);
				expect(gs.trim()).toBe(check.trim);
				expect(gs.trimStart()).toBe(check.trimStart);
				expect(gs.trimEnd()).toBe(check.trimEnd);
				expect(gs.trimLeft()).toBe(check.trimStart);
				expect(gs.trimRight()).toBe(check.trimEnd);
				expect(gs.trimGrapheme().toString()).toBe(check.trim);
				expect(gs.trimStartGrapheme().toString()).toBe(check.trimStart);
				expect(gs.trimEndGrapheme().toString()).toBe(check.trimEnd);
				expect(gs.trimLeftGrapheme().toString()).toBe(check.trimStart);
				expect(gs.trimRightGrapheme().toString()).toBe(check.trimEnd);
			}
		});

		test('should handle ideographic space', function() {
			const gs = new GraphemeString('\u3000hello\u3000');
			const trimmed = gs.trim();
			expect(trimmed).toBe('hello');
		});

		test('should handle repeated trim operations', function() {
			const gs = new GraphemeString('  hello  ');
			const trimmed1 = gs.trimGrapheme();
			const trimmed2 = trimmed1.trimGrapheme();
			expect(trimmed1.toString()).toBe('hello');
			expect(trimmed2.toString()).toBe('hello');
			expect(gs.toString()).toBe('  hello  ');
		});
	});

	describe('Padding operations', function() {
		test('should pad strings with various parameters', function() {
			const checks = [
				{ text: 'hello', targetLength: 10, padString: undefined, padStart: '     hello', padEnd: 'hello     ' },
				{ text: '5', targetLength: 3, padString: '0', padStart: '005', padEnd: '500' },
				{ text: 'abc', targetLength: 10, padString: '123', padStart: '1231231abc', padEnd: 'abc1231231' },
				{ text: 'hello', targetLength: 5, padString: undefined, padStart: 'hello', padEnd: 'hello' },
				{ text: 'hello', targetLength: 3, padString: undefined, padStart: 'hello', padEnd: 'hello' },
				{ text: 'hi', targetLength: 4, padString: '\uD83D\uDC4B\uD83C\uDFFD', padStart: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDC4B\uD83C\uDFFDhi', padEnd: 'hi\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDC4B\uD83C\uDFFD' },
				{ text: 'hello', targetLength: 10, padString: '', padStart: 'hello', padEnd: 'hello' },
				{ text: 'x', targetLength: 4, padString: 'ab', padStart: 'abax', padEnd: 'xaba' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.padStart(check.targetLength, check.padString)).toBe(check.padStart);
				expect(gs.padEnd(check.targetLength, check.padString)).toBe(check.padEnd);
				expect(gs.padStartGrapheme(check.targetLength, check.padString).toString()).toBe(check.padStart);
				expect(gs.padEndGrapheme(check.targetLength, check.padString).toString()).toBe(check.padEnd);
			}
		});

		test('should handle padding with GraphemeString pad parameter', function() {
			const gs = new GraphemeString('hi');
			const pad = new GraphemeString('\uD83D\uDC4B\uD83C\uDFFD');
			expect(gs.padStartGrapheme(4, pad).toString()).toBe('\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDC4B\uD83C\uDFFDhi');
			expect(gs.padEndGrapheme(4, pad).toString()).toBe('hi\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDC4B\uD83C\uDFFD');
		});

		test('should handle padding with complex graphemes', function() {
			const checks = [
				{ text: 'x', target: 5, pad: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00', expectedStart: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00x', expectedEnd: 'x\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00' },
				{ text: 'hi', target: 6, pad: 'caf\u00e9', expectedStart: 'caf\u00e9hi', expectedEnd: 'hicaf\u00e9' },
				{ text: 'a', target: 4, pad: '\uD83C\uDDFA\uD83C\uDDF8', expectedStart: '\uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDFA\uD83C\uDDF8a', expectedEnd: 'a\uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDFA\uD83C\uDDF8' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.padStart(check.target, check.pad)).toBe(check.expectedStart);
				expect(gs.padEnd(check.target, check.pad)).toBe(check.expectedEnd);
			}
		});

		test('should handle padding with combining characters', function() {
			const checks = [
				{
					description: 'pad with decomposed accented character',
					text: 'x',
					target: 3,
					pad: 'e\u0301',
					expectedStart: '\u00e9\u00e9x',
					expectedEnd: 'x\u00e9\u00e9',
					expectedLength: 3
				},
				{
					description: 'pad string ending in base char, then concat combining',
					text: 'hi',
					target: 5,
					pad: 'e',
					testConcat: true,
					combiningChar: '\u0301'
				}
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				const paddedStart = gs.padStartGrapheme(check.target, check.pad);
				const paddedEnd = gs.padEndGrapheme(check.target, check.pad);

				if (check.expectedStart) {
					expect(paddedStart.toString()).toBe(check.expectedStart);
					expect(paddedStart.length).toBe(check.expectedLength);
				}
				if (check.expectedEnd) {
					expect(paddedEnd.toString()).toBe(check.expectedEnd);
					expect(paddedEnd.length).toBe(check.expectedLength);
				}

				if (check.testConcat && check.combiningChar) {
					// Test that concat after padding works correctly
					const withCombining = paddedEnd.concatGrapheme(check.combiningChar);
					expect(withCombining.length).toBe(check.target);
				}
			}
		});

		test('should not cause denormalization when padding splits at boundaries', function() {
			// Test that padding operations maintain normalization even when
			// the pad string is split and concatenated in parts
			const checks = [
				{
					description: 'padding with "café", sliced to "caf"',
					text: 'x',
					target: 4,
					pad: 'café',
					expectedResult: 'cafx',
					expectedLength: 4
				},
				{
					description: 'padding resulting in "e" + "é" concat',
					text: 'é',
					target: 3,
					pad: 'e',
					expectedResult: 'eeé',
					expectedLength: 3
				},
				{
					description: 'padding with decomposed character that normalizes',
					text: 'hi',
					target: 5,
					pad: 'e\u0301', // normalizes to é
					expectedResult: '\u00e9\u00e9\u00e9hi',
					expectedLength: 5
				}
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				const padded = gs.padStartGrapheme(check.target, check.pad);
				expect(padded.toString()).toBe(check.expectedResult);
				expect(padded.length).toBe(check.expectedLength);
			}
		});

		test('concat should be associative with respect to combining characters', function() {
			// Verify that concatGrapheme(a, b, c) === concatGrapheme(concatGrapheme(a, b), c)
			// This ensures no denormalization issues from different groupings
			const tests = [
				{
					a: 'caf',
					b: 'e',
					c: '\u0301',
					description: 'combining acute at end'
				},
				{
					a: 'e',
					b: '\u0301',
					c: '\u0302',
					description: 'multiple combining characters'
				}
			];

			for (const test of tests) {
				const a = new GraphemeString(test.a);
				const resultABC = a.concatGrapheme(test.b, test.c);
				const resultAB_C = a.concatGrapheme(test.b).concatGrapheme(test.c);

				expect(resultABC.toString()).toBe(resultAB_C.toString());
				expect(resultABC.length).toBe(resultAB_C.length);
			}
		});
	});

	describe('repeat/repeatGrapheme', function() {
		test('should repeat strings', function() {
			const checks = [
				{ text: 'ab', count: 3, expected: 'ababab' },
				{ text: 'hello', count: 0, expected: '' },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD', count: 3, expected: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDC4B\uD83C\uDFFD' },
				{ text: 'x', count: 1, expected: 'x' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.repeat(check.count)).toBe(check.expected);
				const gsResult = gs.repeatGrapheme(check.count);
				expect(gsResult.toString()).toBe(check.expected);
				expect(gsResult).toBeInstanceOf(GraphemeString);
			}
		});

		test('should throw for negative count', function() {
			const gs = new GraphemeString('hello');
			expect(function() {
				return(gs.repeat(-1));
			}).toThrow();
			expect(function() {
				return(gs.repeatGrapheme(-1));
			}).toThrow();
		});

		test('should handle repeating strings with combining characters', function() {
			const checks = [
				{
					description: 'repeat precomposed accented character',
					text: '\u00e9',
					count: 3,
					expectedString: '\u00e9\u00e9\u00e9',
					expectedLength: 3
				},
				{
					description: 'repeat decomposed accented character (normalizes to NFC)',
					text: 'e\u0301',
					count: 3,
					expectedString: '\u00e9\u00e9\u00e9',
					expectedLength: 3
				},
				{
					description: 'repeat multi-character string ending with accent',
					text: 'caf\u00e9',
					count: 2,
					expectedString: 'caf\u00e9caf\u00e9',
					expectedLength: 8
				}
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				const result = gs.repeatGrapheme(check.count);
				expect(result.toString()).toBe(check.expectedString);
				expect(result.length).toBe(check.expectedLength);
			}
		});

		test('should allow concat of combining character after repeat', function() {
			const gs = new GraphemeString('e');
			const repeated = gs.repeatGrapheme(3);
			const withCombining = repeated.concatGrapheme('\u0301');
			expect(withCombining.toString()).toBe('ee\u00e9');
			expect(withCombining.length).toBe(3);
		});
	});

	describe('Deprecated HTML methods', function() {
		test('should apply HTML wrapper methods', function() {
			const checks = [
				{ method: 'anchor' as const, args: ['mylink'], expected: '<a name="mylink">text</a>' },
				{ method: 'big' as const, args: [], expected: '<big>text</big>' },
				{ method: 'blink' as const, args: [], expected: '<blink>text</blink>' },
				{ method: 'bold' as const, args: [], expected: '<b>text</b>' },
				{ method: 'fixed' as const, args: [], expected: '<tt>text</tt>' },
				{ method: 'fontcolor' as const, args: ['red'], expected: '<font color="red">text</font>' },
				{ method: 'fontsize' as const, args: [7], expected: '<font size="7">text</font>' },
				{ method: 'italics' as const, args: [], expected: '<i>text</i>' },
				{ method: 'link' as const, args: ['http://example.com'], expected: '<a href="http://example.com">text</a>' },
				{ method: 'small' as const, args: [], expected: '<small>text</small>' },
				{ method: 'strike' as const, args: [], expected: '<strike>text</strike>' },
				{ method: 'sub' as const, args: [], expected: '<sub>text</sub>' },
				{ method: 'sup' as const, args: [], expected: '<sup>text</sup>' }
			];

			for (const check of checks) {
				const gs = new GraphemeString('text');
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const result = (gs as any)[check.method](...check.args);
				expect(result).toBe(check.expected);
			}
		});

		test('should work with emoji content', function() {
			const gs = new GraphemeString('\uD83D\uDC4B\uD83C\uDFFD');
			expect(gs.bold()).toBe('<b>\uD83D\uDC4B\uD83C\uDFFD</b>');
			expect(gs.link('http://example.com')).toBe('<a href="http://example.com">\uD83D\uDC4B\uD83C\uDFFD</a>');
		});
	});

	describe('Iterator', function() {
		test('should iterate over grapheme clusters', function() {
			const checks = [
				{ text: 'hello', expected: ['h', 'e', 'l', 'l', 'o'] },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00\uD83C\uDDFA\uD83C\uDDF8', expected: ['\uD83D\uDC4B\uD83C\uDFFD', '\uD83D\uDE00', '\uD83C\uDDFA\uD83C\uDDF8'] },
				{ text: 'a\uD83D\uDC4B\uD83C\uDFFDb', expected: ['a', '\uD83D\uDC4B\uD83C\uDFFD', 'b'] },
				{ text: '', expected: [] }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				const chars = [...gs];
				expect(chars).toEqual(check.expected);
			}
		});

		test('should work with for...of loop', function() {
			const gs = new GraphemeString('ab\uD83D\uDC4B\uD83C\uDFFD');
			const result: string[] = [];
			for (const char of gs) {
				result.push(char);
			}
			expect(result).toEqual(['a', 'b', '\uD83D\uDC4B\uD83C\uDFFD']);
		});
	});

	describe('valueOf and toString', function() {
		test('should convert to string', function() {
			const checks = [
				{ input: 'hello', expected: 'hello' },
				{ input: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00', expected: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00' },
				{ input: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66caf\u00e9\uD83C\uDDFA\uD83C\uDDF8', expected: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66caf\u00e9\uD83C\uDDFA\uD83C\uDDF8' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.input);
				expect(gs.valueOf()).toBe(check.expected);
				expect(gs.toString()).toBe(check.expected);
			}
		});

		test('valueOfGrapheme should return itself', function() {
			const gs = new GraphemeString('hello');
			expect(gs.valueOfGrapheme()).toBe(gs);
		});

		test('should work in string coercion', function() {
			const gs = new GraphemeString('world');
			expect(gs.valueOf() + ' hello').toBe('world hello');
			expect(`hello ${gs.valueOf()}`).toBe('hello world');
		});
	});

	describe('normalize', function() {
		test('should normalize to various forms', function() {
			const gs = new GraphemeString('caf\u00e9');
			expect(gs.normalize()).toBe('caf\u00e9');
			expect(gs.normalize('NFC')).toBe('caf\u00e9');
			expect(gs.normalize('NFD')).toBe('cafe\u0301');
		});
	});

	describe('Ligatures and special characters', function() {
		test('should handle various ligatures', function() {
			const checks = [
				{ text: '\uFB01re', description: 'fi ligature fire' },
				{ text: 'o\uFB00er', description: 'ff ligature offer' },
				{ text: '\uFB02our', description: 'fl ligature flour' },
				{ text: '\uFB03', description: 'ffi ligature' },
				{ text: '\uFB04', description: 'ffl ligature' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.toString()).toBe(check.text);
			}
		});

		test('should handle special Unicode spaces and dashes', function() {
			const checks = [
				{ text: 'a\u2003b', description: 'em space' },
				{ text: 'a\u00A0b', description: 'non-breaking space' },
				{ text: 'a\u2013b', description: 'en dash' },
				{ text: 'a\u2014b', description: 'em dash' },
				{ text: '\u002D \u2013 \u2014 \u2015', description: 'various dashes', expectedLength: 7 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.toString()).toBe(check.text);
				if (check.expectedLength) {
					expect(gs.length).toBe(check.expectedLength);
				}
			}
		});
	});

	describe('International text scripts', function() {
		test('should handle various writing systems', function() {
			const checks = [
				{ text: '\u4F60\u597D\u4E16\u754C', script: 'Chinese nihao shijie', expectedLength: 4 },
				{ text: '\uC548\uB155\uD558\uC138\uC694', script: 'Korean annyeong', expectedLength: 5 },
				{ text: '\u3053\u3093\u306B\u3061\u306F', script: 'Japanese Hiragana konnichiwa', expectedLength: 5 },
				{ text: '\u30AB\u30BF\u30AB\u30CA', script: 'Japanese Katakana', expectedLength: 4 },
				{ text: '\u041F\u0440\u0438\u0432\u0435\u0442', script: 'Cyrillic Privet', expectedLength: 6 },
				{ text: '\u0645\u0631\u062D\u0628\u0627', script: 'Arabic marhaba', expectedLength: 5 },
				{ text: '\u05E9\u05DC\u05D5\u05DD', script: 'Hebrew shalom', expectedLength: 4 },
				{ text: '\u0393\u03B5\u03B9\u03AC \u03C3\u03BF\u03C5', script: 'Greek geia sou', expectedLength: 8 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.length).toBe(check.expectedLength);
				expect(gs.toString()).toBe(check.text);
			}
		});

		test('should handle mixed RTL and LTR text', function() {
			const mixed = 'Hello \u05E9\u05DC\u05D5\u05DD World';
			const gs = new GraphemeString(mixed);
			expect(gs.includes('Hello')).toBe(true);
			expect(gs.includes('\u05E9\u05DC\u05D5\u05DD')).toBe(true);
			expect(gs.includes('World')).toBe(true);
		});

		test('should handle Japanese mixed scripts', function() {
			const japanese = '\u3053\u3093\u306B\u3061\u306F\u4E16\u754C\uFF01Hello \uD83D\uDE00';
			const gs = new GraphemeString(japanese);
			expect(gs.includes('\u3053\u3093\u306B\u3061\u306F')).toBe(true);
			expect(gs.includes('\u4E16\u754C')).toBe(true);
			expect(gs.includes('Hello')).toBe(true);
			expect(gs.includes('\uD83D\uDE00')).toBe(true);
		});
	});

	describe('Search and comparison with normalization', function() {
		test('should handle de-normalized input in operations', function() {
			const nfdString = 'e\u0301';
			const nfcString = '\u00e9';
			const gs1 = new GraphemeString(nfdString);
			const gs2 = new GraphemeString(nfcString);
			expect(gs1.indexOf(gs2)).toBe(0);
			expect(gs1.includes(gs2)).toBe(true);
			expect(gs1.toString()).toBe(gs2.toString());
		});

		test('should handle normalized text in searches', function() {
			const text1 = 'I love caf\u00e9 and cr\u00e8me br\u00fbl\u00e9e';
			const gs = new GraphemeString(text1);

			const searches = ['caf\u00e9', 'cr\u00e8me', 'br\u00fbl\u00e9e'];
			for (const search of searches) {
				expect(gs.includes(search)).toBe(true);
			}
		});

		test('should find normalized strings in mixed format text', function() {
			const text = 'This is caf\u00e9 and this is cafe\u0301';
			const gs = new GraphemeString(text);
			expect(gs.indexOf('caf\u00e9')).toBe(8);
			expect(gs.lastIndexOf('caf\u00e9')).toBe(25);
		});
	});

	describe('Edge cases and boundary conditions', function() {
		test('should handle boundary conditions for various methods', function() {
			const checks = [
				{ text: 'hello', method: 'startsWith', args: ['', 0], expected: true },
				{ text: 'hello', method: 'endsWith', args: ['', 5], expected: true },
				{ text: 'hello', method: 'indexOf', args: ['hello', 10], expected: -1 },
				{ text: 'hello hello', method: 'lastIndexOf', args: ['hello', 0], expected: 0 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const result = (gs as any)[check.method](...check.args);
				expect(result).toBe(check.expected);
			}
		});

		test('should handle empty string operations', function() {
			const gs = new GraphemeString('');
			expect(gs.includes('')).toBe(true);
			expect(gs.startsWith('')).toBe(true);
			expect(gs.endsWith('')).toBe(true);
			expect(gs.concat('')).toBe('');
			expect(gs.slice(0)).toBe('');
			expect(gs.length).toBe(0);
		});

		test('should handle single grapheme operations', function() {
			const checks = [
				{ text: 'a', charAt: 'a', slice: 'a', substring: 'a', substr: 'a' },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD', charAt: '\uD83D\uDC4B\uD83C\uDFFD', slice: '\uD83D\uDC4B\uD83C\uDFFD', substring: '\uD83D\uDC4B\uD83C\uDFFD', substr: '\uD83D\uDC4B\uD83C\uDFFD' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.charAt(0)).toBe(check.charAt);
				expect(gs.slice(0, 1)).toBe(check.slice);
				expect(gs.substring(0, 1)).toBe(check.substring);
				expect(gs.substr(0, 1)).toBe(check.substr);
			}
		});
	});

	describe('Complex emoji scenarios', function() {
		test('should handle various complex emoji', function() {
			const checks = [
				{ emoji: '\uD83D\uDC71\uD83C\uDFFD\u200D\u2640\uFE0F', description: 'woman with blonde hair and skin tone', expectedLength: 1 },
				{ emoji: '\uD83E\uDDD1\uD83C\uDFFD\u200D\uD83D\uDCBB', description: 'technologist with skin tone', expectedLength: 1 },
				{ emoji: '\uD83D\uDC68\uD83C\uDFFD\u200D\u2695\uFE0F', description: 'male health worker with skin tone', expectedLength: 1 },
				{ emoji: '\uD83E\uDDD1\u200D\uD83C\uDF73', description: 'cook', expectedLength: 1 },
				{ emoji: '\uD83E\uDDD1\u200D\uD83C\uDFA8', description: 'artist', expectedLength: 1 },
				{ emoji: '\uD83D\uDC6E\u200D\u2640\uFE0F', description: 'female police officer', expectedLength: 1 },
				{ emoji: '\uD83E\uDDD9\u200D\u2642\uFE0F', description: 'male mage', expectedLength: 1 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.emoji);
				expect(gs.length).toBe(check.expectedLength);
				expect(gs.toString()).toBe(check.emoji);
			}
		});

		test('should handle multiple flags', function() {
			const flags = '\uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDEC\uD83C\uDDE7\uD83C\uDDEB\uD83C\uDDF7\uD83C\uDDE9\uD83C\uDDEA\uD83C\uDDEF\uD83C\uDDF5';
			const gs = new GraphemeString(flags);
			expect(gs.length).toBe(5);
			const flagArray = [...gs];
			expect(flagArray).toEqual([
				'\uD83C\uDDFA\uD83C\uDDF8',
				'\uD83C\uDDEC\uD83C\uDDE7',
				'\uD83C\uDDEB\uD83C\uDDF7',
				'\uD83C\uDDE9\uD83C\uDDEA',
				'\uD83C\uDDEF\uD83C\uDDF5'
			]);
		});

		test('should handle emoji sequences in operations', function() {
			const text = 'Hello \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66 family \uD83C\uDDFA\uD83C\uDDF8';
			const gs = new GraphemeString(text);
			expect(gs.includes('\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66')).toBe(true);
			expect(gs.indexOf('\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66')).toBe(6);
			expect(gs.indexOf('family')).toBe(8);
			expect(gs.indexOf('\uD83C\uDDFA\uD83C\uDDF8')).toBe(15);
		});

		test('should handle all skin tone variations', function() {
			const variations = [
				'\uD83D\uDC4B',
				'\uD83D\uDC4B\uD83C\uDFFB',
				'\uD83D\uDC4B\uD83C\uDFFC',
				'\uD83D\uDC4B\uD83C\uDFFD',
				'\uD83D\uDC4B\uD83C\uDFFE',
				'\uD83D\uDC4B\uD83C\uDFFF'
			];
			const text = variations.join('');
			const gs = new GraphemeString(text);
			expect(gs.length).toBe(6);

			for (let i = 0; i < variations.length; i++) {
				expect(gs.charAt(i)).toBe(variations[i]);
			}
		});

		test('should handle gender and profession emoji variants', function() {
			const variants = [
				'\uD83E\uDDD1\u200D\uD83C\uDF93',
				'\uD83D\uDC68\u200D\uD83C\uDF93',
				'\uD83D\uDC69\u200D\uD83C\uDF93'
			];
			const text = variants.join(' ');
			const gs = new GraphemeString(text);

			for (const variant of variants) {
				expect(gs.includes(variant)).toBe(true);
			}
		});

		test('should handle couple emoji with skin tones', function() {
			const couples = [
				'\uD83D\uDC6B',
				'\uD83D\uDC6B\uD83C\uDFFB',
				'\uD83D\uDC6B\uD83C\uDFFC',
				'\uD83D\uDC6B\uD83C\uDFFD',
				'\uD83D\uDC6B\uD83C\uDFFE',
				'\uD83D\uDC6B\uD83C\uDFFF'
			];
			const text = couples.join('');
			const gs = new GraphemeString(text);
			expect(gs.length).toBe(6);

			for (let i = 0; i < couples.length; i++) {
				expect(gs.charAt(i)).toBe(couples[i]);
			}
		});

		test('should handle basic emoji sequence', function() {
			const emojis = '\uD83D\uDE00\uD83D\uDE03\uD83D\uDE04\uD83D\uDE01\uD83D\uDE06\uD83D\uDE05\uD83E\uDD23\uD83D\uDE02';
			const gs = new GraphemeString(emojis);
			expect(gs.length).toBe(8);
			expect(gs.toString()).toBe(emojis);
		});

		test('should handle hand gesture variations', function() {
			const gestures = [
				'\uD83D\uDC4D',
				'\uD83D\uDC4E',
				'\u270A',
				'\uD83D\uDC4A',
				'\uD83E\uDD1B',
				'\uD83E\uDD1C',
				'\uD83D\uDC4F',
				'\uD83D\uDE4C',
				'\uD83D\uDC50',
				'\uD83E\uDD32'
			];
			const text = gestures.join('');
			const gs = new GraphemeString(text);
			expect(gs.length).toBe(10);
		});
	});

	describe('Grapheme cluster boundary cases', function() {
		test('should handle various variation selectors', function() {
			const checks = [
				{ text: 'VS15: \u263A\uFE0E', description: 'text presentation' },
				{ text: 'VS16: \u263A\uFE0F', description: 'emoji presentation' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.toString()).toBe(check.text);
			}
		});

		test('should handle combining enclosing keycaps', function() {
			const keycaps = '1\u20E32\u20E33\u20E34\u20E35\u20E3';
			const gs = new GraphemeString(keycaps);
			expect(gs.toString()).toBe(keycaps);
		});

		test('should handle emoji modifiers consistently', function() {
			const withoutModifier = '\uD83D\uDC4B';
			const withModifier = '\uD83D\uDC4B\uD83C\uDFFD';
			const gs1 = new GraphemeString(withoutModifier);
			const gs2 = new GraphemeString(withModifier);
			expect(gs1.length).toBe(1);
			expect(gs2.length).toBe(1);
			expect(gs1.toString()).not.toBe(gs2.toString());
		});
	});

	describe('Special Unicode categories', function() {
		test('should handle zero-width characters', function() {
			const checks = [
				{ text: 'hello\u200Bworld', description: 'zero-width space U+200B' },
				{ text: 'hello\u200Dworld', description: 'zero-width joiner U+200D' },
				{ text: 'hello\u200Cworld', description: 'zero-width non-joiner U+200C' },
				{ text: 'hello\u200Eworld', description: 'LTR mark U+200E' },
				{ text: 'hello\u200Fworld', description: 'RTL mark U+200F' },
				{ text: 'hello\uFEFFworld', description: 'zero-width no-break space U+FEFF' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.toString()).toBe(check.text);
			}
		});

		test('should handle soft hyphen and dashes', function() {
			const checks = [
				{ text: 'hel\u00ADlo', description: 'soft hyphen' },
				{ text: '\u002D \u2013 \u2014 \u2015', description: 'various dashes', expectedLength: 7 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.toString()).toBe(check.text);
				if (check.expectedLength) {
					expect(gs.length).toBe(check.expectedLength);
				}
			}
		});

		test('should handle non-breaking space', function() {
			const text = 'hello\u00A0world';
			const gs = new GraphemeString(text);
			expect(gs.includes('\u00A0')).toBe(true);
			expect(gs.toString()).toBe(text);
		});
	});

	describe('Immutability and chained operations', function() {
		test('should preserve immutability of internal parts', function() {
			const gs = new GraphemeString('hello');
			const sliced = gs.sliceGrapheme(0, 3);
			const trimmed = gs.trimGrapheme();
			const concatenated = gs.concatGrapheme('!');

			expect(gs.toString()).toBe('hello');
			expect(gs.length).toBe(5);
			expect(sliced.toString()).toBe('hel');
			expect(trimmed.toString()).toBe('hello');
			expect(concatenated.toString()).toBe('hello!');
		});

		test('should freeze internal parts array', function() {
			const parts = ['h', 'e', 'l', 'l', 'o'];
			const gs = new GraphemeString(parts);
			parts[0] = 'j';
			expect(gs.toString()).toBe('hello');
		});

		test('should handle chained operations', function() {
			const gs = new GraphemeString('  hello  ');
			const result = gs.trimGrapheme().concatGrapheme(' ', 'world').sliceGrapheme(0, 11);
			expect(result.toString()).toBe('hello world');
		});

		test('should maintain immutability across all operations', function() {
			const original = 'hello';
			const gs = new GraphemeString(original);

			gs.sliceGrapheme(0, 3);
			gs.concatGrapheme(' world');
			gs.trimGrapheme();
			gs.padStartGrapheme(10);
			gs.padEndGrapheme(10);
			gs.repeatGrapheme(2);

			expect(gs.toString()).toBe(original);
			expect(gs.length).toBe(5);
		});
	});

	describe('Length property validation', function() {
		test('should accurately report grapheme count', function() {
			const checks = [
				{ text: 'hello', expected: 5 },
				{ text: '\uD83D\uDC4B\uD83C\uDFFD\uD83D\uDE00', expected: 2 },
				{ text: 'a\uD83D\uDC4B\uD83C\uDFFDb\uD83D\uDE00c', expected: 5 },
				{ text: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66abc', expected: 4 },
				{ text: 'caf\u00e9', expected: 4 },
				{ text: '', expected: 0 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.length).toBe(check.expected);
			}
		});

		test('length should be immutable', function() {
			const gs = new GraphemeString('hello');
			const originalLength = gs.length;
			gs.sliceGrapheme(0, 3);
			gs.concatGrapheme(' world');
			gs.trimGrapheme();
			expect(gs.length).toBe(originalLength);
		});
	});

	describe('Real-world use cases', function() {
		test('should correctly truncate user input with emoji', function() {
			const userInput = 'Hello \uD83D\uDC4B\uD83C\uDFFD World \uD83D\uDE00!';
			const gs = new GraphemeString(userInput);
			const truncated = gs.sliceGrapheme(0, 10);
			expect(truncated.length).toBe(10);
			expect(truncated.toString()).toBe('Hello \uD83D\uDC4B\uD83C\uDFFD Wo');
		});

		test('should correctly validate password length with emoji', function() {
			const passwords = [
				{ password: 'pass\uD83D\uDC4B\uD83C\uDFFDword', expectedLength: 9 },
				{ password: 'secure\uD83D\uDD12password', expectedLength: 15 },
				{ password: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66family', expectedLength: 7 }
			];

			for (const check of passwords) {
				const gs = new GraphemeString(check.password);
				expect(gs.length).toBe(check.expectedLength);
			}
		});

		test('should handle username operations', function() {
			const username = 'user_caf\u00e9_\uD83D\uDC4B\uD83C\uDFFD';
			const gs = new GraphemeString(username);
			expect(gs.includes('caf\u00e9')).toBe(true);
			expect(gs.endsWith('\uD83D\uDC4B\uD83C\uDFFD')).toBe(true);
			expect(gs.startsWith('user')).toBe(true);
		});

		test('should center align text with emoji', function() {
			const text = '\uD83D\uDC4B\uD83C\uDFFD';
			const gs = new GraphemeString(text);
			const padded = gs.padStartGrapheme(3, ' ').padEndGrapheme(5, ' ');
			expect(padded.length).toBe(5);
			expect(padded.toString()).toBe('  \uD83D\uDC4B\uD83C\uDFFD  ');
		});

		test('should handle comprehensive string manipulation', function() {
			const input = '  Hello \uD83D\uDC4B\uD83C\uDFFD, caf\u00e9 lover \uD83C\uDDFA\uD83C\uDDF8!  ';
			const gs = new GraphemeString(input);

			const trimmed = gs.trimGrapheme();
			expect(trimmed.toString()).toBe('Hello \uD83D\uDC4B\uD83C\uDFFD, caf\u00e9 lover \uD83C\uDDFA\uD83C\uDDF8!');

			const firstPart = trimmed.sliceGrapheme(0, 8);
			expect(firstPart.toString()).toBe('Hello \uD83D\uDC4B\uD83C\uDFFD,');

			const withExclamation = firstPart.concatGrapheme('!!!');
			expect(withExclamation.toString()).toBe('Hello \uD83D\uDC4B\uD83C\uDFFD,!!!');

			expect(trimmed.includes('caf\u00e9')).toBe(true);
			expect(trimmed.startsWith('Hello')).toBe(true);
			expect(trimmed.endsWith('\uD83C\uDDFA\uD83C\uDDF8!')).toBe(true);
		});

		test('should handle text formatting with grapheme awareness', function() {
			const name = '\uD83D\uDC68\uD83C\uDFFD\u200D\uD83D\uDCBB John';
			const gs = new GraphemeString(name);

			expect(gs.length).toBe(6);
			expect(gs.charAt(0)).toBe('\uD83D\uDC68\uD83C\uDFFD\u200D\uD83D\uDCBB');

			const padded = gs.padEndGrapheme(15, '.');
			expect(padded.length).toBe(15);
			expect(padded.toString()).toBe('\uD83D\uDC68\uD83C\uDFFD\u200D\uD83D\uDCBB John.........');
		});
	});

	describe('Multiple occurrences in search operations', function() {
		test('should find multiple occurrences correctly', function() {
			const text = '\uD83D\uDC4B\uD83C\uDFFD hello \uD83D\uDC4B\uD83C\uDFFD goodbye \uD83D\uDC4B\uD83C\uDFFD';
			const gs = new GraphemeString(text);

			const checks = [
				{ search: '\uD83D\uDC4B\uD83C\uDFFD', pos: undefined, indexOf: 0 },
				{ search: '\uD83D\uDC4B\uD83C\uDFFD', pos: 1, indexOf: 8 },
				{ search: '\uD83D\uDC4B\uD83C\uDFFD', pos: 9, indexOf: 18 },
				{ search: 'hello', pos: undefined, indexOf: 2 },
				{ search: 'goodbye', pos: undefined, indexOf: 10 }
			];

			for (const check of checks) {
				expect(gs.indexOf(check.search, check.pos)).toBe(check.indexOf);
			}

			expect(gs.lastIndexOf('\uD83D\uDC4B\uD83C\uDFFD')).toBe(18);
		});
	});

	describe('Comprehensive integration tests', function() {
		test('should handle text with all types of grapheme clusters', function() {
			const complex = 'ASCII a\uD83D\uDC4B\uD83C\uDFFD emoji \u00e9 accent \uD83C\uDDFA\uD83C\uDDF8 flag \u0915\u094D\u0937\u093F devanagari \u4F60\u597D chinese';
			const gs = new GraphemeString(complex);

			const searchTerms = ['ASCII', '\uD83D\uDC4B\uD83C\uDFFD', '\u00e9', '\uD83C\uDDFA\uD83C\uDDF8', '\u0915\u094D\u0937\u093F', '\u4F60\u597D'];
			for (const term of searchTerms) {
				expect(gs.includes(term)).toBe(true);
			}

			expect(gs.toString()).toBe(complex);
		});

		test('should correctly count complex multi-script strings', function() {
			const checks = [
				{ text: 'a\uD83D\uDC4B\uD83C\uDFFD\u00e9\uD83C\uDDFA\uD83C\uDDF8b', positions: { 0: 'a', 1: '\uD83D\uDC4B\uD83C\uDFFD', 2: '\u00e9', 3: '\uD83C\uDDFA\uD83C\uDDF8', 4: 'b' }, length: 5 },
				{ text: '\uD55C\uAE00', positions: { 0: '\uD55C', 1: '\uAE00' }, length: 2 },
				{ text: '\u3053\u3093\u306B\u3061\u306F', positions: { 0: '\u3053', 1: '\u3093', 2: '\u306B', 3: '\u3061', 4: '\u306F' }, length: 5 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(gs.length).toBe(check.length);
				for (const [pos, expected] of Object.entries(check.positions)) {
					expect(gs.charAt(Number(pos))).toBe(expected);
				}
			}
		});

		test('should handle searching in normalized text', function() {
			const text1 = 'caf\u00e9';
			const text2 = 'cafe\u0301';
			const gs1 = new GraphemeString(text1);
			const gs2 = new GraphemeString(text2);

			expect(gs1.toString()).toBe(gs2.toString());
			expect(gs1.indexOf('caf\u00e9')).toBe(0);
			expect(gs2.indexOf('caf\u00e9')).toBe(0);
		});
	});

	describe('Performance and stress tests', function() {
		test('should handle very long strings', function() {
			const checks = [
				{ base: 'a', repeat: 10000, expectedLength: 10000 },
				{ base: '\uD83D\uDC4B\uD83C\uDFFD', repeat: 1000, expectedLength: 1000 },
				{ base: 'ab', repeat: 5000, expectedLength: 10000 }
			];

			for (const check of checks) {
				const longString = check.base.repeat(check.repeat);
				const gs = new GraphemeString(longString);
				expect(gs.length).toBe(check.expectedLength);
			}
		});

		test('should handle deeply nested operations', function() {
			let gs = new GraphemeString('test');
			for (let i = 0; i < 10; i++) {
				gs = gs.concatGrapheme('!');
			}
			expect(gs.toString()).toBe('test!!!!!!!!!!');
			expect(gs.length).toBe(14);
		});

		test('should handle very long emoji strings', function() {
			const emoji = '\uD83D\uDC4B\uD83C\uDFFD';
			const longEmojiString = emoji.repeat(1000);
			const gs = new GraphemeString(longEmojiString);
			expect(gs.length).toBe(1000);
			expect(gs.charAt(0)).toBe(emoji);
			expect(gs.charAt(999)).toBe(emoji);
		});
	});

	describe('Comparison with regular string behavior', function() {
		test('should demonstrate advantage over regular strings', function() {
			const checks = [
				{ text: '\uD83D\uDC4B\uD83C\uDFFD', regularLength: 4, graphemeLength: 1 },
				{ text: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66', regularLength: 11, graphemeLength: 1 },
				{ text: '\uD83C\uDDFA\uD83C\uDDF8', regularLength: 4, graphemeLength: 1 }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.text);
				expect(check.text.length).toBe(check.regularLength);
				expect(gs.length).toBe(check.graphemeLength);
			}
		});

		test('should slice emoji correctly vs regular string', function() {
			const text = 'Hello \uD83D\uDC4B\uD83C\uDFFD!';
			const gs = new GraphemeString(text);
			const gsSlice = gs.sliceGrapheme(6, 7).toString();
			expect(gsSlice).toBe('\uD83D\uDC4B\uD83C\uDFFD');
			expect(gs.charAt(6)).toBe('\uD83D\uDC4B\uD83C\uDFFD');
		});
	});

	describe('Error handling', function() {
		test('should throw appropriate errors', function() {
			const gs = new GraphemeString('hello');
			const errorChecks = [
				{ fn: function() { return(gs.concatGrapheme(123 as unknown as string)); }, error: TypeError, message: 'Argument must be a string or GraphemeString' },
				{ fn: function() { return(gs.search(123 as unknown as string)); }, error: TypeError, message: 'Argument must be a string, GraphemeString, or RegExp' },
				{ fn: function() { return(gs.repeatGrapheme(-5)); }, error: RangeError, message: 'repeat count must be non-negative' }
			];

			for (const check of errorChecks) {
				expect(check.fn).toThrow(check.error);
				expect(check.fn).toThrow(check.message);
			}
		});
	});

	describe('Method return type validation', function() {
		test('Grapheme methods should return GraphemeString', function() {
			const gs = new GraphemeString('hello');
			const graphemeMethods = [
				gs.sliceGrapheme(0, 3),
				gs.substringGrapheme(0, 3),
				gs.substrGrapheme(0, 3),
				gs.concatGrapheme('!'),
				gs.trimGrapheme(),
				gs.trimStartGrapheme(),
				gs.trimEndGrapheme(),
				gs.trimLeftGrapheme(),
				gs.trimRightGrapheme(),
				gs.padStartGrapheme(10),
				gs.padEndGrapheme(10),
				gs.repeatGrapheme(2),
				gs.valueOfGrapheme()
			];

			for (const result of graphemeMethods) {
				expect(result).toBeInstanceOf(GraphemeString);
			}
		});

		test('String methods should return string', function() {
			const gs = new GraphemeString('hello');
			const stringMethods = [
				gs.slice(0, 3),
				gs.substring(0, 3),
				gs.substr(0, 3),
				gs.concat('!'),
				gs.trim(),
				gs.trimStart(),
				gs.trimEnd(),
				gs.trimLeft(),
				gs.trimRight(),
				gs.padStart(10),
				gs.padEnd(10),
				gs.repeat(2),
				gs.valueOf(),
				gs.toString(),
				gs.charAt(0),
				gs.at(0)
			];

			for (const result of stringMethods) {
				expect(typeof result).toBe('string');
			}
		});
	});

	describe('Mathematical and special symbols', function() {
		test('should handle mathematical alphanumeric symbols', function() {
			const mathSymbols = '\uD835\uDC00\uD835\uDC01\uD835\uDC02\uD835\uDFCE\uD835\uDFCF\uD835\uDFD0';
			const gs = new GraphemeString(mathSymbols);
			expect(gs.length).toBe(6);
			expect(gs.toString()).toBe(mathSymbols);
		});

		test('should handle various quotation marks', function() {
			const quotes = '"\u2018\u2019\u201C\u201D\u2039\u203A\u00AB\u00BB';
			const gs = new GraphemeString(quotes);
			expect(gs.toString()).toBe(quotes);
		});

		test('should handle currency symbols', function() {
			const currencies = '$\u20AC\u00A3\u00A5\u20A9\u20BD';
			const gs = new GraphemeString(currencies);
			expect(gs.toString()).toBe(currencies);
		});
	});

	describe('Complex normalization scenarios', function() {
		test('should normalize complex accented text', function() {
			const checks = [
				{ input: 'a\u0308', normalized: '\u00e4', description: 'a with diaeresis' },
				{ input: 'Zu\u0308rich', normalized: 'Z\u00fcrich', description: 'Zurich' },
				{ input: 'n\u0303', normalized: '\u00f1', description: 'n with tilde' },
				{ input: 'a\u0300 propos', normalized: '\u00e0 propos', description: 'apropos' }
			];

			for (const check of checks) {
				const gs = new GraphemeString(check.input);
				expect(gs.toString()).toBe(check.normalized);
			}
		});

		test('should handle mixed NFD and NFC in same string', function() {
			const mixed = 'caf\u00e9 and cafe\u0301';
			const gs = new GraphemeString(mixed);
			expect(gs.indexOf('caf\u00e9', 0)).toBe(0);
			expect(gs.indexOf('caf\u00e9', 1)).toBe(9);
		});
	});

	describe('Mixed content comprehensive tests', function() {
		test('should handle extremely mixed content', function() {
			const mixed = 'Hello \uD83D\uDC4B\uD83C\uDFFD caf\u00e9 \uD83C\uDDFA\uD83C\uDDF8! \u4F60\u597D \u05E9\u05DC\u05D5\u05DD \u0915\u094D\u0937\u093F';
			const gs = new GraphemeString(mixed);
			expect(gs.toString()).toBe(mixed);
			expect(gs.includes('caf\u00e9')).toBe(true);
			expect(gs.includes('\uD83D\uDC4B\uD83C\uDFFD')).toBe(true);
			expect(gs.includes('\uD83C\uDDFA\uD83C\uDDF8')).toBe(true);
			expect(gs.includes('\u4F60\u597D')).toBe(true);
			expect(gs.includes('\u05E9\u05DC\u05D5\u05DD')).toBe(true);
			expect(gs.includes('\u0915\u094D\u0937\u093F')).toBe(true);
		});

		test('should demonstrate grapheme-aware text operations', function() {
			const text = 'User: @caf\u00e9_lover\uD83D\uDC4B\uD83C\uDFFD | Location: \uD83C\uDDFA\uD83C\uDDF8';
			const gs = new GraphemeString(text);

			const atIndex = gs.indexOf('@');
			const pipeIndex = gs.indexOf(' |');
			const username = gs.sliceGrapheme(atIndex + 1, pipeIndex);
			expect(username.toString()).toBe('caf\u00e9_lover\uD83D\uDC4B\uD83C\uDFFD');

			const location = gs.sliceGrapheme(gs.length - 1, gs.length);
			expect(location.toString()).toBe('\uD83C\uDDFA\uD83C\uDDF8');
		});
	});

	describe('Immutability guarantees', function() {
		test('should guarantee immutability across operations', function() {
			const original = '  test\uD83D\uDC4B\uD83C\uDFFD  ';
			const gs = new GraphemeString(original);

			const ops = [
				gs.trimGrapheme(),
				gs.sliceGrapheme(0, 4),
				gs.concatGrapheme('!!!'),
				gs.padStartGrapheme(20),
				gs.padEndGrapheme(20),
				gs.repeatGrapheme(2),
				gs.substringGrapheme(2, 5),
				gs.substrGrapheme(2, 3)
			];

			for (const op of ops) {
				expect(op).toBeInstanceOf(GraphemeString);
			}

			expect(gs.toString()).toBe(original);
		});
	});

	describe('String API conformance', function() {
		test('should match String behavior for charAt', function() {
			const testCases = [
				{ str: 'hello', pos: 0 },
				{ str: 'hello', pos: 4 },
				{ str: 'hello', pos: 5 },
				{ str: 'hello', pos: -1 },
				{ str: '', pos: 0 }
			];

			for (const { str, pos } of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.charAt(pos)).toBe(str.charAt(pos));
			}
		});

		test('should match String behavior for concat', function() {
			const gs = new GraphemeString('hello');
			const str = 'hello';
			expect(gs.concat(' ', 'world')).toBe(str.concat(' ', 'world'));
			expect(gs.concat()).toBe(str.concat());
		});

		test('should match String behavior for includes', function() {
			const testCases = [
				{ str: 'hello world', search: 'world', pos: undefined, expected: true },
				{ str: 'hello world', search: 'world', pos: 0, expected: true },
				{ str: 'hello world', search: 'world', pos: 7, expected: false },
				{ str: 'hello', search: 'bye', pos: undefined, expected: false }
			];

			for (const { str, search, pos, expected } of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.includes(search, pos)).toBe(expected);
				expect(gs.includes(search, pos)).toBe(str.includes(search, pos));
			}
		});

		test('should match String behavior for indexOf', function() {
			const testCases = [
				{ str: 'hello world', search: 'world' },
				{ str: 'hello world', search: 'o' },
				{ str: 'hello world', search: 'o', fromIndex: 5 },
				{ str: 'hello', search: 'bye' },
				{ str: 'hello', search: '' }
			];

			for (const test of testCases) {
				const gs = new GraphemeString(test.str);
				expect(gs.indexOf(test.search, test.fromIndex)).toBe(test.str.indexOf(test.search, test.fromIndex));
			}
		});

		test('should match String behavior for lastIndexOf', function() {
			const testCases = [
				{ str: 'hello world hello', search: 'hello' },
				{ str: 'hello world', search: 'o' },
				{ str: 'hello world', search: 'o', fromIndex: 5 },
				{ str: 'hello', search: 'bye' }
			];

			for (const test of testCases) {
				const gs = new GraphemeString(test.str);
				expect(gs.lastIndexOf(test.search, test.fromIndex)).toBe(test.str.lastIndexOf(test.search, test.fromIndex));
			}
		});

		test('should match String behavior for startsWith', function() {
			const testCases = [
				{ str: 'hello world', search: 'hello', pos: undefined },
				{ str: 'hello world', search: 'world', pos: 6 },
				{ str: 'hello', search: 'bye', pos: undefined },
				{ str: 'hello', search: '', pos: 0 }
			];

			for (const { str, search, pos } of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.startsWith(search, pos)).toBe(str.startsWith(search, pos));
			}
		});

		test('should match String behavior for endsWith', function() {
			const testCases = [
				{ str: 'hello world', search: 'world', pos: undefined },
				{ str: 'hello world', search: 'hello', pos: 5 },
				{ str: 'hello', search: 'bye', pos: undefined },
				{ str: 'hello', search: '', pos: 5 }
			];

			for (const { str, search, pos } of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.endsWith(search, pos)).toBe(str.endsWith(search, pos));
			}
		});

		test('should match String behavior for trim operations', function() {
			const testCases = ['  hello  ', '\thello\n', '  ', 'hello'];

			for (const str of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.trim()).toBe(str.trim());
				expect(gs.trimStart()).toBe(str.trimStart());
				expect(gs.trimEnd()).toBe(str.trimEnd());
			}
		});

		test('should match String behavior for padStart and padEnd', function() {
			const testCases = [
				{ str: 'hello', target: 10, pad: ' ' },
				{ str: 'hi', target: 5, pad: '0' },
				{ str: 'test', target: 2, pad: 'x' }
			];

			for (const { str, target, pad } of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.padStart(target, pad)).toBe(str.padStart(target, pad));
				expect(gs.padEnd(target, pad)).toBe(str.padEnd(target, pad));
			}
		});

		test('should match String behavior for repeat', function() {
			const testCases = [
				{ str: 'hello', count: 3 },
				{ str: 'x', count: 0 },
				{ str: 'ab', count: 2 }
			];

			for (const { str, count } of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.repeat(count)).toBe(str.repeat(count));
			}
		});

		test('should match String behavior for toString and valueOf', function() {
			const testCases = ['hello', '', 'world'];

			for (const str of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.toString()).toBe(str.toString());
				expect(gs.valueOf()).toBe(str.valueOf());
			}
		});

		test('should match String behavior for slice with ASCII', function() {
			const str = 'hello world';
			const gs = new GraphemeString(str);

			const testCases = [
				{ start: 0, end: 5 },
				{ start: 6, end: undefined },
				{ start: -5, end: undefined },
				{ start: 0, end: -6 }
			];

			for (const { start, end } of testCases) {
				expect(gs.slice(start, end)).toBe(str.slice(start, end));
			}
		});

		test('should match String behavior for substring with ASCII', function() {
			const str = 'hello world';
			const gs = new GraphemeString(str);

			const testCases = [
				{ start: 0, end: 5 },
				{ start: 6, end: 11 },
				{ start: 6, end: undefined }
			];

			for (const { start, end } of testCases) {
				expect(gs.substring(start, end)).toBe(str.substring(start, end));
			}
		});

		test('should match String behavior for normalize', function() {
			const str = 'caf\u00e9';
			const gs = new GraphemeString(str);

			expect(gs.normalize('NFC')).toBe(str.normalize('NFC'));
			expect(gs.normalize('NFD')).toBe(str.normalize('NFD'));
		});

		test('should match String length for ASCII strings', function() {
			const testCases = ['hello', '', 'world', 'a'];

			for (const str of testCases) {
				const gs = new GraphemeString(str);
				expect(gs.length).toBe(str.length);
			}
		});

		test('should behave like String in string coercion', function() {
			const gs = new GraphemeString('hello');
			const str = 'hello';

			expect(String(gs)).toBe(String(str));
			expect(`${gs}`).toBe(str);
			expect(String(gs) + ' world').toBe(str + ' world');
		});

		test('should handle match with string like String (simplified)', function() {
			const str = 'hello world';
			const gs = new GraphemeString(str);

			const gsResult = gs.match('world');
			const strResult = str.match('world');
			// GraphemeString returns simplified match result
			expect(gsResult).toEqual(['world']);
			expect(strResult ? strResult[0] : null).toBe('world');

			expect(gs.match('xyz')).toEqual(str.match('xyz'));
		});

		test('should handle search like String for non-grapheme cases', function() {
			const str = 'hello world';
			const gs = new GraphemeString(str);

			expect(gs.search('world')).toBe(str.search('world'));
			expect(gs.search('xyz')).toBe(str.search('xyz'));
		});
	});
});
