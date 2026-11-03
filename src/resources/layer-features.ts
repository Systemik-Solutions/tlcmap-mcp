import { ResourceTemplate } from '@modelcontextprotocol/server';
import { TlcmapError, toProtocolError } from '../errors.js';
import type { LayerService } from '../layers/service.js';
import type { Logger } from '../log.js';
import type { Registration } from '../mcp/scopes.js';
// The tool module imports layerFeaturesUri from here; both bindings are used only at call time.
import { GET_LAYER_TOOL } from '../tools/get-layer.js';

export const LAYER_FEATURES_TEMPLATE = 'tlcmap://layer/{id}/features';

const MAX_LAYER_ID = 2147483647;
const CANONICAL_ID = /^[1-9][0-9]{0,9}$/;
const ID_RULE = 'a canonical decimal integer from 1 to 2147483647: no sign, leading zero or fraction';

export function layerFeaturesUri(layerId: number): string {
  return `tlcmap://layer/${layerId}/features`;
}

/** Accepts only canonical decimal layer IDs, so `007` is never read as layer 7. */
export function parseLayerId(raw: string): number {
  const value = CANONICAL_ID.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value <= MAX_LAYER_ID) return value;
  throw new TlcmapError('INVALID_ARGUMENT', `The layer ID in the resource URI must be ${ID_RULE}.`, {
    field: 'id',
    value: raw,
    rule: ID_RULE,
  });
}

export function layerFeaturesResource(deps: { layers: LayerService; logger: Logger }): Registration {
  const { layers, logger } = deps;
  return {
    scope: 'read',
    register(server) {
      server.registerResource(
        'layer-features',
        new ResourceTemplate(LAYER_FEATURES_TEMPLATE, { list: undefined }),
        {
          mimeType: 'application/json',
          description:
            'The full GeoJSON features of a TLCMap layer, exactly as fetched by tlcmap_get_layer. ' +
            'Obtain the URI from a tlcmap_get_layer result.',
        },
        async (uri, vars) => {
          const started = Date.now();
          const finish = (outcome: string) =>
            logger.log(outcome === 'ok' ? 'info' : 'warn', 'resource', {
              uri: uri.href,
              outcome,
              duration_ms: Date.now() - started,
            });
          try {
            const raw = Array.isArray(vars.id) ? vars.id.join(',') : (vars.id ?? '');
            const entry = layers.peekLayer(parseLayerId(raw));
            if (!entry) {
              throw new TlcmapError(
                'RESOURCE_EXPIRED',
                `This resource is no longer held by the server. Call ${GET_LAYER_TOOL} again to obtain a fresh handle.`,
                { uri: uri.href, tool: GET_LAYER_TOOL },
              );
            }
            finish('ok');
            return {
              contents: [{ uri: uri.href, mimeType: 'application/json', text: entry.body.toString('utf8') }],
              _meta: { provenance: { ...entry.provenance, cache: 'hit' } },
            };
          } catch (e) {
            if (e instanceof TlcmapError) {
              finish(e.code);
              throw toProtocolError(e);
            }
            throw e;
          }
        },
      );
    },
  };
}
