import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Registration } from '../mcp/scopes.js';
import { catalogueEntrySchema, catalogueResponse, pageSchema, parseV2 } from '../v2/schemas.js';
import { layersUrl } from '../v2/url.js';
import { bboxSchema, polygonSchema, provenanceSchema, runTool, type ToolDeps } from './common.js';

export const LIST_LAYERS_TOOL = 'tlcmap_list_layers';

const DESCRIPTION =
  "Search TLCMap's catalogue of public layers. bbox, polygon and the date filters match a layer when " +
  'at least one of its records matches — never by a declared extent — and matching_count gives how ' +
  'many do. has_license and has_warning report whether the field is present, not what it says; read ' +
  'the text itself with tlcmap_get_layer_metadata. total counts every matching layer; follow ' +
  'page.next_cursor for further pages.';

const inputSchema = z.strictObject({
  q: z.string().optional(),
  bbox: bboxSchema.optional(),
  polygon: polygonSchema.optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  include_undated: z.boolean().optional(),
  has_license: z.boolean().optional(),
  has_warning: z.boolean().optional(),
  record_type: z.string().optional(),
  creator: z.string().optional(),
  min_records: z.number().int().optional(),
  sort: z.enum(['id', 'name']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().optional(),
  per_page: z.number().int().optional(),
});

const outputSchema = z.object({
  query: z.looseObject({}),
  total: z.number().int(),
  page: pageSchema,
  layers: z.array(catalogueEntrySchema),
  provenance: provenanceSchema,
});

export function listLayersTool(deps: ToolDeps): Registration {
  const { pages, baseUrl, logger } = deps;
  return {
    scope: 'read',
    register(server) {
      server.registerTool(
        LIST_LAYERS_TOOL,
        { description: DESCRIPTION, inputSchema, outputSchema },
        (args): Promise<CallToolResult> =>
          runTool(LIST_LAYERS_TOOL, args, logger, async () => {
            const { entry, cache } = await pages.fetch({
              url: layersUrl(baseUrl, args),
              parse(body) {
                const doc = parseV2(body, catalogueResponse);
                return { head: doc, ids: { layer_ids: doc.layers.map((l) => l.id) } };
              },
            });
            const { query, total, page, layers } = entry.head;
            return {
              structured: { query, total, page, layers, provenance: { ...entry.provenance, cache } },
              cache,
            };
          }),
      );
    },
  };
}
