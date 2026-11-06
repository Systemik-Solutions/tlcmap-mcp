import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Registration } from '../mcp/scopes.js';
import { searchPageUri } from '../resources/pages.js';
import {
  pageSchema,
  parseV2,
  placesResponse,
  placesSummaryOnlyResponse,
  placesSummarySchema,
  withoutFeatures,
} from '../v2/schemas.js';
import { placesUrl } from '../v2/url.js';
import { bboxSchema, polygonSchema, provenanceSchema, runTool, type ToolDeps } from './common.js';

export const SEARCH_PLACES_TOOL = 'tlcmap_search_places';

const DESCRIPTION =
  "Search TLCMap's places across contributed layers and the ANPS, NCG and text gazetteers. The " +
  'records are not inline: read them from resource_uri; follow page.next_cursor for further pages. ' +
  'The summary describes the whole match set, not the page; its undated and no-coordinates counts ' +
  'are what lets a result say which records it could not place, and by_layer names every ' +
  'contributing layer with its warning, verbatim, which must be shown to the user. Read each ' +
  "layer's licence and rights with tlcmap_get_layer_metadata. summary_only returns the summary " +
  'without records. include_undated defaults to true, so a date filter keeps undated records ' +
  'unless it is false.';

const inputSchema = z.strictObject({
  name: z.string().optional(),
  match: z.enum(['exact', 'contains', 'fuzzy']).optional(),
  sources: z.array(z.enum(['layers', 'anps', 'ncg', 'text'])).optional(),
  layers: z.array(z.number().int().positive()).optional(),
  bbox: bboxSchema.optional(),
  polygon: polygonSchema.optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  include_undated: z.boolean().optional(),
  summary_only: z.boolean().optional(),
  state: z.string().optional(),
  lga: z.string().optional(),
  feature_term: z.string().optional(),
  record_type: z.string().optional(),
  extended_data: z.string().optional(),
  sort: z.enum(['id', 'title', 'start', 'end']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  nulls: z.enum(['first', 'last']).optional(),
  limit: z.number().int().optional(),
  sample: z.number().int().optional(),
  seed: z.string().optional(),
  cursor: z.string().optional(),
  per_page: z.number().int().optional(),
});

const outputSchema = z.object({
  query: z.looseObject({}),
  summary: placesSummarySchema,
  page: pageSchema.nullable(),
  resource_uri: z.string().nullable(),
  provenance: provenanceSchema,
});

export function searchPlacesTool(deps: ToolDeps): Registration {
  const { pages, baseUrl, logger } = deps;
  return {
    scope: 'read',
    register(server) {
      server.registerTool(
        SEARCH_PLACES_TOOL,
        { description: DESCRIPTION, inputSchema, outputSchema },
        (args): Promise<CallToolResult> =>
          runTool(SEARCH_PLACES_TOOL, args, logger, async () => {
            const summaryOnly = args.summary_only === true;
            const { entry, cache } = await pages.fetch({
              url: placesUrl(baseUrl, args),
              parse(body) {
                if (summaryOnly) {
                  return { head: parseV2(body, placesSummaryOnlyResponse), ids: { record_uids: [] } };
                }
                const doc = parseV2(body, placesResponse);
                return {
                  head: withoutFeatures(doc),
                  ids: { record_uids: doc.features.map((f) => String(f.properties.id)) },
                };
              },
              ...(summaryOnly ? {} : { resourceUri: searchPageUri }),
            });
            const { query, summary } = entry.head;
            return {
              structured: {
                query,
                summary,
                page: summaryOnly ? null : entry.head.page,
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
