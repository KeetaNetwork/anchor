import type { KeetaStorageAnchorSession } from '../client.js';
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

	constructor(session: KeetaStorageAnchorSession) {
		this.#session = session;
	}

	async set(icon: IconData): Promise<void> {
		if (!icon.mimeType.startsWith('image/')) {
			throw(new Errors.ValidationFailed(`Invalid icon MIME type: "${icon.mimeType}". Must be an image/* type.`));
		}

		await this.#session.put(ICON_FILENAME, icon.data, {
			mimeType: icon.mimeType
		});
	}

	async get(): Promise<IconData | null> {
		const result = await this.#session.get(ICON_FILENAME);
		if (!result) {
			return(null);
		}

		return({ data: result.data, mimeType: result.mimeType });
	}

	async delete(): Promise<boolean> {
		const result = await this.#session.delete(ICON_FILENAME);
		return(result);
	}
}

// #endregion
