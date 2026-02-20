const whitespaceRegex = /\s/;
function isWhitespace(char: string): boolean {
	return(whitespaceRegex.test(char));
}

type removeIndexSignature<T> = {
	[K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
};

// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
export class GraphemeString implements removeIndexSignature<String> {
	readonly #parts: string[];
	readonly #locale: ConstructorParameters<typeof Intl.Segmenter>[0] | undefined;

	readonly length: number;

	constructor(input: string | string[], locale?: ConstructorParameters<typeof Intl.Segmenter>[0]);
	constructor(input: GraphemeString);
	constructor(input: string | string[] | GraphemeString, locale?: ConstructorParameters<typeof Intl.Segmenter>[0]) {
		if (input instanceof GraphemeString) {
			if (locale !== undefined) {
				throw(new Error('Locale argument must not be provided when input is a GraphemeString'));
			}

			this.#parts = [...input.#parts];
			this.#locale = input.#locale;
		} else if (Array.isArray(input)) {
			this.#parts = [...input];
			this.#locale = locale;
		} else {
			const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
			const normalizedInput = input.normalize('NFC');
			const segments = segmenter.segment(normalizedInput);
			const parts = Array.from(segments);
			this.#parts = parts.map(function(part) {
				return(part.segment);
			});
			this.#locale = locale;
		}

		Object.freeze(this.#parts);

		this.length = this.#parts.length;
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
		return(this.toString());
	}

	toString(): string {
		return(this.#parts.join(''));
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

	concatGrapheme(...strings: (string | GraphemeString)[]): GraphemeString {
		const stringsToConcat = strings.map(function(str) {
			if (typeof str === 'string') {
				return(str);
			} else if (str instanceof GraphemeString) {
				/* XXX:TODO: What do we do about multiple locales ? */
				return(str.toString());
			} else {
				throw(new TypeError('Argument must be a string or GraphemeString'));
			}
		});

		const concatenatedString = this.toString() + stringsToConcat.join('');

		return(new GraphemeString(concatenatedString, this.#locale));
	}

	concat(...strings: (string | GraphemeString)[]): string {
		return(this.concatGrapheme(...strings).toString());
	}

	includes(searchString: string | GraphemeString, position?: number): boolean {
		const indexOf = this.indexOf(searchString, position);

		if (indexOf !== -1) {
			return(true);
		}

		return(false);
	}

	indexOf(searchString: string | GraphemeString, position?: number): number {
		let searchStringEncoded: GraphemeString;
		if (typeof searchString === 'string') {
			searchStringEncoded = new GraphemeString(searchString);
		} else {
			searchStringEncoded = searchString;
		}

		const startPos = position === undefined ? 0 : Math.max(0, position);

		for (let index = startPos; index <= this.length - searchStringEncoded.length; index++) {
			const segment = this.#parts.slice(index, index + searchStringEncoded.length).join('');
			if (segment === searchStringEncoded.toString()) {
				return(index);
			}
		}

		return(-1);
	}

	lastIndexOf(searchString: string | GraphemeString, position?: number): number {
		let searchStringEncoded: GraphemeString;
		if (typeof searchString === 'string') {
			searchStringEncoded = new GraphemeString(searchString);
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
			if (segment === searchStringEncoded.toString()) {
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
			return(regex.exec(this.toString()));
		}

		if (typeof match[Symbol.match] === 'function') {
			const matcher = match[Symbol.match].bind(match);
			return(matcher(this.toString()));
		}

		throw(new TypeError('Argument must be a string, RegExp, or an object with a [Symbol.match] method'));
	}

	/**
	 * TODO
	 */
	replaceGrapheme(..._ignore_args: unknown[]): GraphemeString {
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

	search(start: string | GraphemeString): number;
	/**
	 * Partially supported by GraphemeString, but it will not work correctly for regexes that match within grapheme clusters. Use with caution.
	 * @deprecated
	 */
	// eslint-disable-next-line @typescript-eslint/unified-signatures
	search(start: RegExp): number;
	// Cannot be combined - some overloads are deprecated, others are not
	search(start: string | GraphemeString | RegExp): number {
		if (typeof start === 'string' || start instanceof GraphemeString) {
			return(this.indexOf(start));
		}

		if (start instanceof RegExp) {
			const regex = new RegExp(start.source, start.flags);
			const match = regex.exec(this.toString());
			if (match) {
				return(match.index);
			} else {
				return(-1);
			}
		}

		throw(new TypeError('Argument must be a string, GraphemeString, or RegExp'));
	}

	sliceGrapheme(start?: number, end?: number): GraphemeString {
		const slicedParts = this.#parts.slice(start, end);
		return(new GraphemeString(slicedParts, this.#locale));
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

	substringGrapheme(start: number, end?: number): GraphemeString {
		const slicedParts = this.#parts.slice(start, end);
		return(new GraphemeString(slicedParts, this.#locale));
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

	trimStartGrapheme(): GraphemeString {
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

	trimEndGrapheme(): GraphemeString {
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

	trimLeftGrapheme(): GraphemeString {
		return(this.trimStartGrapheme());
	}

	trimRightGrapheme(): GraphemeString {
		return(this.trimEndGrapheme());
	}

	trimGrapheme(): GraphemeString {
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

	substrGrapheme(start: number, length?: number): GraphemeString {
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

	endsWith(searchString: string | GraphemeString, position?: number): boolean {
		let searchStringEncoded: GraphemeString;
		if (typeof searchString === 'string') {
			searchStringEncoded = new GraphemeString(searchString);
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
		return(this.toString().normalize(...args));
	}

	repeatGrapheme(count: number): GraphemeString {
		if (count < 0 || count === Infinity) {
			throw(new RangeError('repeat count must be non-negative and not Infinity'));
		}

		if (!Number.isInteger(count)) {
			count = Math.floor(count);
		}

		const baseString = this.toString();
		const repeatedString = baseString.repeat(count);

		return(new GraphemeString(repeatedString, this.#locale));
	}

	repeat(count: number): string {
		return(this.repeatGrapheme(count).toString());
	}

	startsWith(searchString: string | GraphemeString, position = 0): boolean {
		let searchStringEncoded: GraphemeString;
		if (typeof searchString === 'string') {
			searchStringEncoded = new GraphemeString(searchString);
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

	padStartGrapheme(targetLength: number, padString?: string | GraphemeString): GraphemeString {
		if (targetLength <= this.length) {
			return(this);
		}

		padString ??= ' ';

		let padStringEncoded: GraphemeString;
		if (typeof padString === 'string') {
			padStringEncoded = new GraphemeString(padString);
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

		return(retval);
	}

	padStart(targetLength: number, padString?: string | GraphemeString): string {
		return(this.padStartGrapheme(targetLength, padString).toString());
	}

	padEndGrapheme(targetLength: number, padString?: string | GraphemeString): GraphemeString {
		if (targetLength <= this.length) {
			return(this);
		}

		padString ??= ' ';

		let padStringEncoded: GraphemeString;
		if (typeof padString === 'string') {
			padStringEncoded = new GraphemeString(padString);
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

	padEnd(targetLength: number, padString?: string | GraphemeString): string {
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
