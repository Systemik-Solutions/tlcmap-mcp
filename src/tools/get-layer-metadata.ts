import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Registration } from '../mcp/scopes.js';
import { checkLayerIdentity, layerDetailResponse, layerSchema, parseV2, summarySchema } from '../v2/schemas.js';
import { layerUrl } from '../v2/url.js';
import { layerIdSchema, provenanceSchema, runTool, type ToolDeps } from './common.js';

export const GET_LAYER_METADATA_TOOL = 'tlcmap_get_layer_metadata';

const DESCRIPTION =
  "Read one TLCMap layer's metadata — name, creator, citation, licence, rights and warning — and the " +
  'summary of its records (count, extent, date range, undated and no-coordinates counts), without ' +
  'fetching any records. Use it to check a layer\'s rights before using its data. Licence, rights and ' +
  'warning text are returned verbatim and must be shown to the user, not paraphrased. The summary\'s ' +
  'undated and no-coordinates counts are what lets a result say which records it could not place.';

const inputSchema = z.strictObject({ layer_id: layerIdSchema });

const outputSchema = z.object({
  layer: layerSchema,
  summary: summarySchema,
  provenance: provenanceSchema,
});

export function getLayerMetadataTool(deps: ToolDeps): Registration {
  const { pages, baseUrl, logger } = deps;
  return {
    scope: 'read',
    register(server) {
      server.registerTool(
        GET_LAYER_METADATA_TOOL,
        { description: DESCRIPTION, inputSchema, outputSchema },
        (args): Promise<CallToolResult> =>
          runTool(GET_LAYER_METADATA_TOOL, args, logger, async () => {
            const { layer_id } = args;
            const { entry, cache } = await pages.fetch({
              url: layerUrl(baseUrl, layer_id),
              parse(body) {
                const doc = parseV2(body, layerDetailResponse);
                checkLayerIdentity(doc.layer, layer_id);
                return { head: doc, ids: { layer_ids: [layer_id] } };
              },
            });
            const { layer, summary } = entry.head;
            return {
              structured: { layer, summary, provenance: { ...entry.provenance, cache } },
              cache,
            };
          }),
      );
    },
  };
}
