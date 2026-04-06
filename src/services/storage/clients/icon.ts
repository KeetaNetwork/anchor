import type { KeetaStorageAnchorSession } from '../client.js';
import type { Logger } from '../../../lib/log/index.js';
import type { Buffer } from '../../../lib/utils/buffer.js';
import { Errors } from '../common.js';

// #region Types

/**
 * Icon binary data with its MIME type.
 */
export type IconData = {
	data: Buffer;
	mimeType: string;
};

// #endregion

// #region Interface

/**
 * Generic icons client interface.
 */
export interface IconsClient {
	set(icon: IconData): Promise<void>;
	get(): Promise<IconData | null>;
	delete(): Promise<boolean>;
}

// #endregion

// #region Storage Implementation

const ICON_FILENAME = 'icon';

/**
 * Storage Anchor-backed implementation of `IconsClient`.
 * Stores a single icon as a public binary object via a `KeetaStorageAnchorSession`.
 */
export class StorageIconsClient implements IconsClient {
	readonly #session: KeetaStorageAnchorSession;
	readonly #logger?: Logger | undefined;

	constructor(session: KeetaStorageAnchorSession, logger?: Logger) {
		this.#session = session;
		this.#logger = logger;
	}

	async set(icon: IconData): Promise<void> {
		this.#logger?.debug(`Setting icon (${icon.mimeType})`);

		if (!icon.mimeType.startsWith('image/')) {
			throw(new Errors.ValidationFailed(`Invalid icon MIME type: "${icon.mimeType}". Must be an image/* type.`));
		}

		await this.#session.put(ICON_FILENAME, icon.data, {
			mimeType: icon.mimeType
		});

		this.#logger?.debug('Icon set successfully');
	}

	async get(): Promise<IconData | null> {
		this.#logger?.debug('Getting icon');

		const result = await this.#session.get(ICON_FILENAME);
		if (!result) {
			this.#logger?.debug('Icon not found');
			return(null);
		}

		this.#logger?.debug('Icon retrieved');
		return({ data: result.data, mimeType: result.mimeType });
	}

	async delete(): Promise<boolean> {
		this.#logger?.debug('Deleting icon');
		const result = await this.#session.delete(ICON_FILENAME);
		this.#logger?.debug(`Icon delete: ${result ? 'removed' : 'not found'}`);
		return(result);
	}
}

// #endregion
