import { createAssert } from "typia";
import type { ClientRenderableContent } from "./metadata.types.js";

export const assertClientRenderableContentType: (value: unknown) => ClientRenderableContent['type'] = createAssert<ClientRenderableContent['type']>();
