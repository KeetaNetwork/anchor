import { assertClientRenderableContentType } from "./metadata.types.generated.js";
import type { Logger } from "./log/index.js";
import type { ToValuizable } from "./resolver.js";


/**
 * This is the type of content that can be rendered directly in a client application.
 *
 * There is no guarantee on if/how this content will be displayed, so it should not be used for critical information, rather as a way to provide the user additional context about a transfer.
 */
export type ClientRenderableContent = { type: 'markdown' | 'plaintext'; content: string; };


export interface AnchorMetadataLegalField {
	disclaimers?: {
		purpose: 'general';
		content: ClientRenderableContent;
	}[] | undefined;
}

export interface SharedAnchorMetadataLegalExtension {
	/**
	 * Legal details that the anchor wants to share with the user.
	 * This can include things like disclaimers, terms of service, etc.
	 */
	legal?: AnchorMetadataLegalField;
}

async function resolveClientRenderableContent(content: ToValuizable<ClientRenderableContent>): Promise<ClientRenderableContent> {
	const resolved = await content('object');

	return({
		type: assertClientRenderableContentType(await resolved.type('string')),
		content: await resolved.content('string')
	})
}

export async function resolveSharedAnchorMetadataLegalExtension(metadata: ToValuizable<AnchorMetadataLegalField> | undefined, options: {
	logger?: Logger | undefined;
}): Promise<SharedAnchorMetadataLegalExtension> {
	if (!metadata) {
		return({});
	}

	const resolvedField = await metadata('object');

	if (!resolvedField) {
		return({});
	}

	const disclaimers = await (async (): Promise<AnchorMetadataLegalField['disclaimers']> => {
		const resolvedDisclaimers = await resolvedField.disclaimers?.('array');
		if (!resolvedDisclaimers) {
			return(undefined);
		}

		const parsedDisclaimers = await Promise.allSettled(resolvedDisclaimers.map(async function(disclaimer): Promise<NonNullable<AnchorMetadataLegalField['disclaimers']>[number]> {
			const resolvedDisclaimer = await disclaimer('object');

			const purpose = await resolvedDisclaimer.purpose('string');

			if (purpose !== 'general') {
				throw(new Error(`Unsupported disclaimer purpose: ${purpose}`));
			}

			return({
				purpose: purpose,
				content: await resolveClientRenderableContent(resolvedDisclaimer.content)
			});
		}));

		const filtered = [];

		for (const result of parsedDisclaimers) {
			if (result.status === 'fulfilled') {
				filtered.push(result.value);
			} else {
				options.logger?.warn('resolveSharedAnchorMetadataLegalExtension', 'Failed to resolve disclaimer content', result.reason);
			}
		}

		return(filtered);
	})();

	return({
		legal: {
			disclaimers
		}
	});
}
