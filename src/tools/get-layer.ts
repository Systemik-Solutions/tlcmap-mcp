import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { TlcmapError, toToolErrorResult } from '../errors.js';
import type { LayerService } from '../layers/service.js';
import type { Logger } from '../log.js';
import type { Registration } from '../mcp/scopes.js';
import { layerFeaturesUri } from '../resources/layer-features.js';

export const GET_LAYER_TOOL = 'tlcmap_get_layer';

const DESCRIPTION =
  "Fetch one TLCMap layer by its numeric ID. Returns a summary computed from the layer's records — " +
  "record count, extent, date range, undated and ungeolocated counts — the layer's metadata exactly " +
  'as TLCMap holds it, a resource URI for the full GeoJSON features, and provenance. Licence, ' +
  'rights and warning text are returned verbatim and must be shown to the user, not paraphrased.';

const inputSchema = z.strictObject({
  layer_id: z.number().int().min(1).max(2147483647),
});

const dateBound = z.object({ udate: z.number(), as_written: z.string().nullable() });

const outputSchema = z.object({
  layer_id: z.number().int(),
  metadata: z.record(z.string(), z.unknown()),
  record_count: z.number().int(),
  extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  date_range: z.object({ start: dateBound.nullable(), end: dateBound.nullable() }).nullable(),
  undated_count: z.number().int(),
  ungeolocated_count: z.number().int(),
  resource_uri: z.string(),
  provenance: z.object({
    request: z.string(),
    fetched_at: z.string(),
    cache: z.enum(['miss', 'hit', 'shared']),
    sha256: z.string(),
    bytes: z.number().int(),
    record_uids: z.array(z.string()),
    server: z.string(),
  }),
});

export function getLayerTool(deps: { layers: LayerService; logger: Logger }): Registration {
  const { layers, logger } = deps;
  return {
    scope: 'read',
    register(server) {
      server.registerTool(
        GET_LAYER_TOOL,
        { description: DESCRIPTION, inputSchema, outputSchema },
        async (args): Promise<CallToolResult> => {
          const started = Date.now();
          const { layer_id } = args;
          try {
            const { entry, cache } = await layers.getLayer(layer_id);
            const s = entry.summary;
            const resource_uri = layerFeaturesUri(layer_id);
            const structured: z.infer<typeof outputSchema> = {
              layer_id,
              metadata: s.metadata,
              record_count: s.record_count,
              extent: s.extent,
              date_range: s.date_range,
              undated_count: s.undated_count,
              ungeolocated_count: s.ungeolocated_count,
              resource_uri,
              provenance: { ...entry.provenance, cache },
            };
            logger.log('info', 'tool', {
              tool: GET_LAYER_TOOL,
              arguments: args,
              outcome: 'ok',
              cache,
              duration_ms: Date.now() - started,
            });
            return {
              structuredContent: structured,
              content: [
                {
                  type: 'text',
                  text:
                    `Layer ${layer_id}: ${s.record_count} records, ${s.undated_count} undated, ` +
                    `${s.ungeolocated_count} without geometry. Features: ${resource_uri}`,
                },
              ],
            };
          } catch (e) {
            if (!(e instanceof TlcmapError)) throw e;
            logger.log('warn', 'tool', {
              tool: GET_LAYER_TOOL,
              arguments: args,
              outcome: e.code,
              duration_ms: Date.now() - started,
            });
            return toToolErrorResult(e);
          }
        },
      );
    },
  };
}
