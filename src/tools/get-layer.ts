import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Registration } from '../mcp/scopes.js';
import { layerPageUri } from '../resources/pages.js';
import {
  checkFeaturesOfLayer,
  checkLayerIdentity,
  layerFeaturesResponse,
  layerSchema,
  pageSchema,
  parseV2,
  summarySchema,
  withoutFeatures,
} from '../v2/schemas.js';
import { layerFeaturesUrl } from '../v2/url.js';
import { layerIdSchema, provenanceSchema, runTool, type ToolDeps } from './common.js';

export const GET_LAYER_TOOL = 'tlcmap_get_layer';

const DESCRIPTION =
  "Read one page of a TLCMap layer's records, with the layer's metadata and the summary of the whole " +
  'layer. The records are not inline: read them from resource_uri. Follow page.next_cursor to read ' +
  'further pages; the summary describes the whole layer on every page, not the page. Its undated and ' +
  'no-coordinates counts are what lets a result say which records it could not place. Licence, rights ' +
  'and warning text are returned verbatim and must be shown to the user, not paraphrased. For a ' +
  "layer's records within a region, use tlcmap_search_places with layers and bbox.";

const inputSchema = z.strictObject({
  layer_id: layerIdSchema,
  sort: z.enum(['order', 'id', 'title', 'start', 'end']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  nulls: z.enum(['first', 'last']).optional(),
  limit: z.number().int().optional(),
  cursor: z.string().optional(),
  per_page: z.number().int().optional(),
});

const outputSchema = z.object({
  layer: layerSchema,
  query: z.looseObject({}),
  summary: summarySchema,
  page: pageSchema,
  resource_uri: z.string(),
  provenance: provenanceSchema,
});

export function getLayerTool(deps: ToolDeps): Registration {
  const { pages, baseUrl, logger } = deps;
  return {
    scope: 'read',
    register(server) {
      server.registerTool(
        GET_LAYER_TOOL,
        { description: DESCRIPTION, inputSchema, outputSchema },
        (args): Promise<CallToolResult> =>
          runTool(GET_LAYER_TOOL, args, logger, async () => {
            const { layer_id, ...options } = args;
            const { entry, cache } = await pages.fetch({
              url: layerFeaturesUrl(baseUrl, layer_id, options),
              parse(body) {
                const doc = parseV2(body, layerFeaturesResponse);
                checkLayerIdentity(doc.layer, layer_id);
                checkFeaturesOfLayer(doc.features, layer_id);
                return {
                  head: withoutFeatures(doc),
                  ids: { record_uids: doc.features.map((f) => String(f.properties.id)) },
                };
              },
              resourceUri: (sha) => layerPageUri(layer_id, sha),
            });
            const { layer, query, summary, page } = entry.head;
            return {
              structured: {
                layer,
                query,
                summary,
                page,
                resource_uri: entry.resourceUri,
                provenance: { ...entry.provenance, cache },
              },
              cache,
            };
          }),
      );
    },
  };
}
