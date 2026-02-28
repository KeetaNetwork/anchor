/* cspell:ignore NKFC Confusables remappings deconfused */
import * as unicodeConfusables from 'unicode-confusables/index.js';

const whitespaceRegex = /\s/;
function isWhitespace(char: string): boolean {
	return(whitespaceRegex.test(char));
}

const utf16SurrogatePairRegex = /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/;
function isSingleUTF16EncodedCodePoint(segment: string): boolean {
	if (segment.length === 1) {
		return(true);
	}

	if (segment.length === 2) {
		return(utf16SurrogatePairRegex.test(segment));
	}

	return(false);
}


type removeIndexSignature<T> = {
	[K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
};

const PARANOID = true;

type GraphemeStringOptions = {
	/**
	 * Any locale that is supported by Intl.Segmenter, if not provided,
	 * the default locale will be used. This will affect how the string
	 * is segmented into grapheme clusters, as different locales may have
	 * different rules for what constitutes a grapheme cluster.
	 */
	locale?: ConstructorParameters<typeof Intl.Segmenter>[0];
}

// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
abstract class GraphemeStringBase implements removeIndexSignature<String> {
	readonly #parts: string[];
	protected readonly options: GraphemeStringOptions;

	#original: string | null;
	#bytes: Uint8Array | null = null;

	readonly length: number;

	private static readonly KeetaAnchorGraphemeStringBaseObjectTypeID = 'c44bb821-d35b-43c2-9dfe-aae7fc9cfe7f';

	/**
	 * Get the constructor of the actual GraphemeString subclass to
	 * construct new instances of the correct type when constructing
	 * from parts.
	 */
	protected get newConstructor(): new (input: string | string[] | GraphemeStringBase | Uint8Array, options?: GraphemeStringOptions) => this {
		throw(new Error('newConstructor getter must be implemented by subclasses of GraphemeStringBase'));
	}

	/**
	 * Validate a segment of the input string to determine if it should be
	 * allowed as a grapheme cluster segment. This will be called for each
	 * segment and should return true if the segment is valid and should be
	 * included in the GraphemeString or false if it's invalid, in which
	 * case the string will not be able to be constructed from the input
	 * and an error will be thrown.
	 *
	 * Flow is [filterSegment -> remapSegment -> validateSegment], so if a
	 * segment is filtered out by filterSegment, it will not be passed to
	 * remapSegment or validateSegment, and if a segment is remapped by
	 * remapSegment, the remapped segments will be passed to validateSegment
	 * instead of the original segment.
	 */
	protected abstract validateSegment(segment: string): boolean;

	/**
	 * Filter out segments that are not part of the original representation
	 * of the string -- this includes things like SHY, zero-width-joiners,
	 * zero-width-non-joiners, and other non-printable characters that
	 * should not be treated as separate grapheme clusters, but should
	 * instead be attached to the previous segment (if valid).
	 */
	protected abstract filterSegment(segment: string): boolean;

	/**
	 * Remap a segment of the input string to zero or more segments that
	 * should be done canonically. This will be called for each
	 * segment and should return an array of segments that should be
	 * included in the GraphemeString in place of the original segment.
	 *
	 * If the segment should be excluded entirely, return an empty array.
	 * If the segment should be included as-is, return an array containing
	 * just the original segment.
	 */
	protected abstract remapSegment(segment: string): string[];

	static isInstance(value: unknown): value is GraphemeStringBase {
		if (typeof value !== 'object' || value === null) {
			return(false);
		}

		if (!('KeetaAnchorGraphemeStringBaseObjectTypeID' in value)) {
			return(false);
		}

		if (value.KeetaAnchorGraphemeStringBaseObjectTypeID === GraphemeStringBase.KeetaAnchorGraphemeStringBaseObjectTypeID) {
			return(true);
		}

		return(false);
	}

	constructor(input: string | string[] | Uint8Array, options?: GraphemeStringOptions);
	constructor(input: GraphemeStringBase);
	constructor(input: string | string[] | GraphemeStringBase | Uint8Array, options?: GraphemeStringOptions) {
		let paranoidCheckRequired = false;

		Object.defineProperty(this, 'KeetaAnchorGraphemeStringBaseObjectTypeID', {
			value: GraphemeStringBase.KeetaAnchorGraphemeStringBaseObjectTypeID,
			enumerable: false
		});

		if (GraphemeStringBase.isInstance(input)) {
			if (options !== undefined) {
				throw(new Error('Options cannot be provided when constructing a GraphemeString from another GraphemeString'));
			}

			this.#parts = [...input.#parts];
			this.options = { ...input.options };
			this.#original = input.#original;
		} else if (Array.isArray(input)) {
			this.#parts = [...input];
			this.options = { ...options };
			this.#original = null;

			paranoidCheckRequired = true;
		} else {
			this.options = { ...options };

			if (input instanceof Uint8Array) {
				const decoder = new TextDecoder();
				input = decoder.decode(input);
			}

			const inputNormalized = input.normalize('NFC');

			const segmenter = new Intl.Segmenter(options?.locale, { granularity: 'grapheme' });
			const segments = segmenter.segment(inputNormalized);
			const parts = Array.from(segments).map(function(part) {
				return(part.segment);
			});

			/*
			 * Apply any lossless normalization to the original
			 * string
			 */
			const original = parts.filter((part) => {
				return(this.filterSegment(part));
			});
			this.#original = original.join('');

			/*
			 * Apply any remapping to the segments, which may
			 * result in some segments being split into multiple
			 * segments or some segments being removed entirely.
			 */
			this.#parts = original.map((part) => {
				const remappedSegments = this.remapSegment(part);

				for (const remappedSegment of remappedSegments) {
					if (!this.validateSegment(remappedSegment)) {
						throw(new Error(`Invalid segment in input string: ${part}`));
					}
				}

				return(remappedSegments);

			}).flat(1);

		}

		Object.freeze(this.#parts);

		this.length = this.#parts.length;

		if (PARANOID && paranoidCheckRequired) {
			/*
			 * Validate that the input is already a
			 * canonicalized grapheme cluster string by
			 * constructing a new GraphemeString from the
			 * parts and comparing it to the original input.
			 *
			 * This will ensure that the input is what we
			 * would have generated if we had constructed
			 * the GraphemeString from a regular string
			 * directly instead of from parts, which is
			 * important because otherwise you could end
			 * up with a GraphemeString that has parts that
			 * are not actually grapheme clusters, which
			 * would break the API and cause various
			 * methods to behave incorrectly.
			 */
			const checked = new this.newConstructor(this.toString(), this.options);
			if (checked.bytes.join(',') !== this.bytes.join(',') || checked.toString() !== this.toString()) {
				throw(new Error('Paranoid check failed: GraphemeString constructed from parts does not match original input'));
			}
		}
	}

	/**
	 * Get a copy of the parts of this grapheme cluster string.
	 */
	protected get _parts(): string[] {
		return([...this.#parts]);
	}

	valueOfGrapheme(): this {
		return(this);
	}

	valueOf(): string {
		return(this.toCanonicalString());
	}

	/**
	 * Get the canonicalized interpretation of the GraphemeString
	 */
	toCanonicalString(): string {
		return(this.#parts.join(''));
	}

	toString(): string {
		if (this.#original === null) {
			this.#original = this.toCanonicalString();
		}

		return(this.#original);
	}

	/**
	 * The UTF-8 encoding of this GraphemeString as a Uint8Array.
	 */
	get bytes(): Uint8Array {
		if (this.#bytes === null) {
			const encoder = new TextEncoder();

			this.#bytes = encoder.encode(this.toString());
		}

		return(this.#bytes);
	}

	/**
	 * The byte length of the UTF-8 Encoding of this GraphemeString.
	 */
	get byteLength(): number {
		return(this.bytes.length);
	}

	charAt(pos: number): string {
		return(this.#parts[pos] ?? '');
	}

	at(pos: number): string {
		if (pos < 0) {
			pos = this.length + pos;
		}
		return(this.charAt(pos));
	}

	/**
	 * Not supported by GraphemeString, as it would be misleading. Use charAt instead.
	 *
	 * @deprecated
	 */
	charCodeAt(..._ignore_args: unknown[]): number {
		throw(new Error('charCodeAt is not supported by GraphemeString'));
	}

	concatGrapheme(...strings: (string | GraphemeStringBase)[]): this {
		const stringsToConcat = strings.map(function(str) {
			if (typeof str === 'string') {
				return(str);
			} else if (GraphemeStringBase.isInstance(str)) {
				/* XXX:TODO: What do we do about multiple locales ? */
				return(str.toString());
			} else {
				throw(new TypeError('Argument must be a string or GraphemeString'));
			}
		});

		const concatenatedString = this.toString() + stringsToConcat.join('');

		return(new this.newConstructor(concatenatedString, this.options));
	}

	concat(...strings: (string | GraphemeStringBase)[]): string {
		return(this.concatGrapheme(...strings).toString());
	}

	includes(searchString: string | GraphemeStringBase, position?: number): boolean {
		const indexOf = this.indexOf(searchString, position);

		if (indexOf !== -1) {
			return(true);
		}

		return(false);
	}

	indexOf(searchString: string | GraphemeStringBase, position?: number): number {
		let searchStringEncoded: GraphemeStringBase;
		if (typeof searchString === 'string') {
			searchStringEncoded = new this.newConstructor(searchString);
		} else {
			searchStringEncoded = searchString;
		}

		const startPos = position === undefined ? 0 : Math.max(0, position);

		for (let index = startPos; index <= this.length - searchStringEncoded.length; index++) {
			const segment = this.#parts.slice(index, index + searchStringEncoded.length).join('');
			if (segment === searchStringEncoded.toCanonicalString()) {
				return(index);
			}
		}

		return(-1);
	}

	lastIndexOf(searchString: string | GraphemeStringBase, position?: number): number {
		let searchStringEncoded: GraphemeStringBase;
		if (typeof searchString === 'string') {
			searchStringEncoded = new this.newConstructor(searchString);
		} else {
			searchStringEncoded = searchString;
		}

		let startPos: number;
		if (position === undefined) {
			startPos = this.length - searchStringEncoded.length;
		} else {
			startPos = Math.min(position, this.length - searchStringEncoded.length);
		}

		for (let index = startPos; index >= 0; index--) {
			const segment = this.#parts.slice(index, index + searchStringEncoded.length).join('');
			if (segment === searchStringEncoded.toCanonicalString()) {
				return(index);
			}
		}

		return(-1);
	}

	localeCompare(..._ignore_args: unknown[]): number {
		throw(new Error('localeCompare is not supported by GraphemeString'));
	}

	match(match: string): RegExpMatchArray | null;
	/**
	 * Partially supported by GraphemeString, but it will not work correctly for regexes that match within grapheme clusters. Use with caution.
	 * @deprecated
	 */
	// eslint-disable-next-line @typescript-eslint/unified-signatures
	match(match: RegExp): RegExpMatchArray | null;
	/**
	 * Partially supported by GraphemeString, but it will not work correctly for regexes that match within grapheme clusters. Use with caution.
	 * @deprecated
	 */
	// eslint-disable-next-line @typescript-eslint/unified-signatures
	match(match: { [Symbol.match](string: string): RegExpMatchArray | null }): RegExpMatchArray | null;
	// Cannot be combined - some overloads are deprecated, others are not
	match(match: string | RegExp | { [Symbol.match](string: string): RegExpMatchArray | null }): RegExpMatchArray | null {
		if (typeof match === 'string') {
			const index = this.indexOf(match);
			if (index === -1) {
				return(null);
			} else {
				return([match]);
			}
		}

		/*
		 * These are lossy because we downcast the GraphemeString to a
		 * regular string, but it's the best we can do without
		 * implementing our own regex engine that understands grapheme clusters.
		 */
		if (match instanceof RegExp) {
			const regex = new RegExp(match.source, match.flags);
			return(regex.exec(this.toCanonicalString()));
		}

		if (typeof match[Symbol.match] === 'function') {
			const matcher = match[Symbol.match].bind(match);
			return(matcher(this.toCanonicalString()));
		}

		throw(new TypeError('Argument must be a string, RegExp, or an object with a [Symbol.match] method'));
	}

	/**
	 * TODO
	 */
	replaceGrapheme(..._ignore_args: unknown[]): this {
		throw(new Error('not implemented'));
	}

	/**
	 * TODO
	 *
	 * @deprecated
	 */
	replace(..._ignore_args: unknown[]): string {
		throw(new Error('not implemented'));
	}

	search(start: string | GraphemeStringBase): number;
	/**
	 * Partially supported by GraphemeString, but it will not work correctly for regexes that match within grapheme clusters. Use with caution.
	 * @deprecated
	 */
	// eslint-disable-next-line @typescript-eslint/unified-signatures
	search(start: RegExp): number;
	// Cannot be combined - some overloads are deprecated, others are not
	search(start: string | GraphemeStringBase | RegExp): number {
		if (typeof start === 'string' || GraphemeStringBase.isInstance(start)) {
			return(this.indexOf(start));
		}

		if (start instanceof RegExp) {
			const regex = new RegExp(start.source, start.flags);
			const match = regex.exec(this.toCanonicalString());
			if (match) {
				return(match.index);
			} else {
				return(-1);
			}
		}

		throw(new TypeError('Argument must be a string, GraphemeString, or RegExp'));
	}

	sliceGrapheme(start?: number, end?: number): this {
		const slicedParts = this.#parts.slice(start, end);
		return(new this.newConstructor(slicedParts, this.options));
	}

	/**
	 * This is lossy because it returns a regular string instead of a GraphemeString
	 *
	 * @deprecated Use {@link sliceGrapheme} instead, which returns a GraphemeString and is more consistent with the rest of the API.
	 */
	slice(start?: number, end?: number): string {
		const slicedParts = this.#parts.slice(start, end);
		return(slicedParts.join(''));
	}

	/**
	 * TODO
	 * @deprecated
	 */
	split(separator: string, limit?: number): string[];
	/**
	 * Partially supported by GraphemeString, but it will not work correctly for regexes that match within grapheme clusters. Use with caution.
	 * @deprecated
	 */
	// eslint-disable-next-line @typescript-eslint/unified-signatures
	split(separator: RegExp, limit?: number): string[];
	// Cannot be combined - both overloads are deprecated (all variants)
	split(separator: string | RegExp, limit?: number): string[] {
		if (separator === '') {
			return(this.#parts.slice(0, limit));
		}

		throw(new Error('not implemented'));
	}

	substringGrapheme(start: number, end?: number): this {
		const slicedParts = this.#parts.slice(start, end);
		return(new this.newConstructor(slicedParts, this.options));
	}

	/**
	 * This is lossy because it returns a regular string instead of a GraphemeString
	 *
	 * @deprecated Use {@link substringGrapheme} instead, which returns a GraphemeString and is more consistent with the rest of the API.
	 */
	substring(start: number, end?: number): string {
		const slicedParts = this.#parts.slice(start, end);
		return(slicedParts.join(''));
	}

	/**
	 * Not supported
	 * @deprecated
	 */
	toLowerCase(): string {
		throw(new Error('toLowerCase is not supported by GraphemeString'));
	}

	/**
	 * Not supported
	 * @deprecated
	 */
	toLocaleLowerCase(..._ignore_args: unknown[]): string {
		throw(new Error('toLocaleLowerCase is not supported by GraphemeString'));
	}

	/**
	 * Not supported
	 * @deprecated
	 */
	toUpperCase(): string {
		throw(new Error('toUpperCase is not supported by GraphemeString'));
	}

	/**
	 * Not supported
	 * @deprecated
	 */
	toLocaleUpperCase(..._ignore_args: unknown[]): string {
		throw(new Error('toLocaleUpperCase is not supported by GraphemeString'));
	}

	trimStartGrapheme(): this {
		let start = 0;
		for (let index = start; index < this.length; index++) {
			const char = this.charAt(index);
			if (isWhitespace(char)) {
				start = index + 1;
			} else {
				break;
			}
		}

		return(this.sliceGrapheme(start));
	}

	trimEndGrapheme(): this {
		let end = this.length - 1;
		for (let index = end; index >= 0; index--) {
			const char = this.charAt(index);
			if (isWhitespace(char)) {
				end = index - 1;
			} else {
				break;
			}
		}

		return(this.sliceGrapheme(0, end + 1));
	}

	trimLeftGrapheme(): this {
		return(this.trimStartGrapheme());
	}

	trimRightGrapheme(): this {
		return(this.trimEndGrapheme());
	}

	trimGrapheme(): this {
		return(this.trimStartGrapheme().trimEndGrapheme());
	}

	trimStart(): string {
		return(this.trimStartGrapheme().toString());
	}

	trimEnd(): string {
		return(this.trimEndGrapheme().toString());
	}

	trimLeft(): string {
		return(this.trimLeftGrapheme().toString());
	}

	trimRight(): string {
		return(this.trimRightGrapheme().toString());
	}

	trim(): string {
		return(this.trimGrapheme().toString());
	}

	substrGrapheme(start: number, length?: number): this {
		let end: number | undefined;
		if (length !== undefined) {
			end = start + length;
		}
		return(this.sliceGrapheme(start, end));
	}

	/**
	 * This is lossy because it returns a regular string instead of a GraphemeString
	 *
	 * @see {String.prototype.substr} for the behavior of the start and length parameters.
	 *
	 * @deprecated Use {@link substrGrapheme} instead, which returns a GraphemeString and is more consistent with the rest of the API.
	 */
	substr(start: number, length?: number): string {
		return(this.substrGrapheme(start, length).toString());
	}

	/**
	 * Not supported by GraphemeString, as it would be misleading.
	 *
	 * @deprecated
	 */
	codePointAt(..._ignore_args: unknown[]): number {
		throw(new Error('codePointAt is not supported by GraphemeString'));
	}

	endsWith(searchString: string | GraphemeStringBase, position?: number): boolean {
		let searchStringEncoded: GraphemeStringBase;
		if (typeof searchString === 'string') {
			searchStringEncoded = new this.newConstructor(searchString);
		} else {
			searchStringEncoded = searchString;
		}

		let effectivePosition: number;
		if (position === undefined) {
			effectivePosition = this.length;
		} else {
			effectivePosition = Math.min(position, this.length);
		}
		const startIndex = effectivePosition - searchStringEncoded.length;

		if (startIndex < 0) {
			return(false);
		}

		const segment = this.#parts.slice(startIndex, effectivePosition).join('');
		const searchStringDecoded = searchStringEncoded.toString();

		if (segment === searchStringDecoded) {
			return(true);
		}

		return(false);
	}

	// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
	normalize(...args: Parameters<String['normalize']>): string {
		return(this.toCanonicalString().normalize(...args));
	}

	repeatGrapheme(count: number): this {
		if (count < 0 || count === Infinity) {
			throw(new RangeError('repeat count must be non-negative and not Infinity'));
		}

		if (!Number.isInteger(count)) {
			count = Math.floor(count);
		}

		const baseString = this.toString();
		const repeatedString = baseString.repeat(count);

		return(new this.newConstructor(repeatedString, this.options));
	}

	repeat(count: number): string {
		return(this.repeatGrapheme(count).toString());
	}

	startsWith(searchString: string | GraphemeStringBase, position = 0): boolean {
		let searchStringEncoded: GraphemeStringBase;
		if (typeof searchString === 'string') {
			searchStringEncoded = new this.newConstructor(searchString);
		} else {
			searchStringEncoded = searchString;
		}

		const effectivePosition = position;

		if (effectivePosition < 0 || effectivePosition > this.length) {
			return(false);
		}

		const segment = this.#parts.slice(effectivePosition, effectivePosition + searchStringEncoded.length).join('');
		const searchStringDecoded = searchStringEncoded.toString();

		if (segment === searchStringDecoded) {
			return(true);
		}

		return(false);
	}

	padStartGrapheme(targetLength: number, padString?: string | GraphemeStringBase): this {
		if (targetLength <= this.length) {
			return(this);
		}

		padString ??= ' ';

		let padStringEncoded: GraphemeStringBase;
		if (typeof padString === 'string') {
			padStringEncoded = new this.newConstructor(padString);
		} else {
			padStringEncoded = padString;
		}

		if (padStringEncoded.length === 0) {
			return(this);
		}

		const paddingNeeded = targetLength - this.length;

		const fullRepeatsCount = Math.floor(paddingNeeded / padStringEncoded.length);
		const fullPaddingString = padStringEncoded.repeatGrapheme(fullRepeatsCount);

		const remainderCount = paddingNeeded % padStringEncoded.length;
		const remainderPaddingString = padStringEncoded.sliceGrapheme(0, remainderCount);

		const retval = fullPaddingString.concatGrapheme(remainderPaddingString, this);

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(retval as this);
	}

	padStart(targetLength: number, padString?: string | GraphemeStringBase): string {
		return(this.padStartGrapheme(targetLength, padString).toString());
	}

	padEndGrapheme(targetLength: number, padString?: string | GraphemeStringBase): this {
		if (targetLength <= this.length) {
			return(this);
		}

		padString ??= ' ';

		let padStringEncoded: GraphemeStringBase;
		if (typeof padString === 'string') {
			padStringEncoded = new this.newConstructor(padString);
		} else {
			padStringEncoded = padString;
		}

		if (padStringEncoded.length === 0) {
			return(this);
		}

		const paddingNeeded = targetLength - this.length;

		const fullRepeatsCount = Math.floor(paddingNeeded / padStringEncoded.length);
		const fullPaddingString = padStringEncoded.repeatGrapheme(fullRepeatsCount);

		const remainderCount = paddingNeeded % padStringEncoded.length;
		const remainderPaddingString = padStringEncoded.sliceGrapheme(0, remainderCount);

		const retval = this.concatGrapheme(fullPaddingString, remainderPaddingString);

		return(retval);
	}

	padEnd(targetLength: number, padString?: string | GraphemeStringBase): string {
		return(this.padEndGrapheme(targetLength, padString).toString());
	}

	// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
	matchAll(..._ignore_args: unknown[]): ReturnType<String['matchAll']> {
		throw(new Error('matchAll is not supported by GraphemeString'));
	}

	replaceAll(..._ignore_args: unknown[]): string {
		throw(new Error('replaceAll is not supported by GraphemeString'));
	}

	[Symbol.iterator](): StringIterator<string> {
		return(this.#parts[Symbol.iterator]());
	}

	/*
	 * Various deprecated string functions
	 */
	// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
	anchor(...args: Parameters<String['anchor']>): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().anchor(...args));
	}

	big(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().big());
	}

	blink(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().blink());
	}

	bold(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().bold());
	}

	fixed(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().fixed());
	}

	// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
	fontcolor(...args: Parameters<String['fontcolor']>): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().fontcolor(...args));
	}

	fontsize(size: string | number): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().fontsize(String(size)));
	}

	italics(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().italics());
	}

	// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
	link(...args: Parameters<String['link']>): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().link(...args));
	}

	small(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().small());
	}

	strike(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().strike());
	}

	sub(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().sub());
	}

	sup(): string {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return(this.toString().sup());
	}
}

const isInvisible: { [key: string]: true } = {
	'\u00AD': true, /* soft hyphen */
	'\u200B': true, /* zero-width space */
	'\u200C': true, /* zero-width non-joiner */
	'\u200D': true, /* zero-width joiner */
	'\uFEFF': true /* zero-width no-break space, also bom */
};

/*
 * Extra re-mappings beyond the NKFC normalization and Unicode Confusables
 */
const remappings: { [key: string]: string[] } = {
};

type GraphemeStringTagOptions = {
	/**
	 * Whether to allow whitespace characters as valid grapheme clusters.

	 * The default value is false.
	 */
	allowWhitespace?: boolean;
}

/**
 * GraphemeStringTag provides a representation suitable for encoding short
 * strings (usernames, tags, slugs, etc) with a canonical representation that
 * can be compared to other strings in a way that is resistant to various types
 * of spoofing and confusion attacks, while still being human-readable for
 * things like length calculations.
 *
 * A normalized form of the original string, suitable for display purposes is
 * available via the toString() method, while a canonicalized form of the
 * string, suitable for comparison and length checking is available via the
 * toCanonicalString() method.  The UTF-8 encoded original string is available
 * via the bytes property
 */
export class GraphemeStringTag extends GraphemeStringBase {
	constructor(input: string | string[] | Uint8Array, options?: GraphemeStringOptions & GraphemeStringTagOptions);
	constructor(input: GraphemeStringBase);
	constructor(input: string | string[] | GraphemeStringBase | Uint8Array, options?: GraphemeStringOptions & GraphemeStringTagOptions) {
		if (GraphemeStringBase.isInstance(input)) {
			if (options !== undefined) {
				throw(new Error('Options cannot be provided when constructing a GraphemeString from another GraphemeString'));
			}
			super(input);
		} else {
			super(input, options);
		}
	}

	protected get newConstructor(): new (input: string | string[] | GraphemeStringBase | Uint8Array, options?: GraphemeStringOptions & GraphemeStringTagOptions) => this {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(GraphemeStringTag as never);
	}

	protected get tagOptions(): GraphemeStringTagOptions {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(this.options as GraphemeStringOptions & GraphemeStringTagOptions);
	}

	protected validateSegment(segment: string): boolean {
		/*
		 * Disallow any whitespace characters (unless allowed by
		 * options) because usernames are generally not expected
		 * to contain whitespace
		 */
		if (!this.tagOptions.allowWhitespace) {
			if (/^\p{White_Space}$/u.test(segment)) {
				return(false);
			}
		}

		/*
		 * Disallow any segments that are entirely made up of non-printable
		 * characters, specifically:
		 *    p{M} (Mark) - combining marks, which are not standalone
		 *                  grapheme clusters and should be attached
		 *                  to the previous segment if valid
		 *    p{Zl} (Separator, Line) - line separator characters,
		 *                              which are not really acceptable
		 *                              for usernames, tags, slugs, etc
		 *    p{C} (Other) - control characters and other non-printable
		 *                   characters, such as tabs, null, delete,
		 *                   bom, etc, which are inappropriate for
		 *                   snippets of text for human consumption
		 *                   like usernames, tags, slugs, etc
		 */
		if (/^[\p{M}\p{Zl}\p{C}]+$/u.test(segment)) {
			return(false);
		}

		return(true);
	}

	protected filterSegment(segment: string): boolean {
		if (isInvisible[segment]) {
			return(false);
		}

		return(true);
	}

	protected remapSegment(segment: string): string[] {
		if (/^[a-zA-Z0-9]$/u.test(segment)) {
			return([segment]);
		}

		const nfkc = segment.normalize('NFKC');
		if (nfkc !== segment) {
			return(nfkc.split(''));
		}

		/*
		 * If the input is a single unicode codepoint (which may be
		 * represented as one or two UTF-16 code units), check if
		 * it's a confusable character and if so, remap it to the
		 * original character(s) that it is confusable with.
		 */
		if (isSingleUTF16EncodedCodePoint(segment)) {
			const deconfused = unicodeConfusables.rectifyConfusion(segment);
			if (deconfused !== segment) {
				return(deconfused.split(''));
			}
		}

		const toRemap = remappings[segment];
		if (toRemap !== undefined) {
			return(toRemap);
		}

		return([segment]);
	}

	compare(other: string | this): boolean {
		let otherEncoded: GraphemeStringTag;
		if (typeof other === 'string') {
			otherEncoded = new this.newConstructor(other, this.options);
		} else {
			otherEncoded = other;
		}

		return(this.toCanonicalString() === otherEncoded.toCanonicalString());
	}
}

/** @internal */
export const _Testing = {
	GraphemeStringBase
};
