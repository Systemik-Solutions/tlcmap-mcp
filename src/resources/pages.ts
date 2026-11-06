import { ResourceTemplate } from '@modelcontextprotocol/server';
import { TlcmapError, toProtocolError } from '../errors.js';
import type { Logger } from '../log.js';
import type { Registration } from '../mcp/scopes.js';
import type { PageService } from '../pages/service.js';

export const LAYER_PAGE_TEMPLATE = 'tlcmap://layer/{id}/features/{sha256}';
export const SEARCH_PAGE_TEMPLATE = 'tlcmap://search/{sha256}';

const MAX_LAYER_ID = 2147483647;
const CANONICAL_ID = /^[1-9][0-9]{0,9}$/;
const ID_RULE = 'a canonical decimal integer from 1 to 2147483647: no sign, leading zero or fraction';
const SHA256 = /^[0-9a-f]{64}$/;
const SHA_RULE = '64 lowercase hexadecimal characters';

export function layerPageUri(layerId: number, sha256: string): string {
  return `tlcmap://layer/${layerId}/features/${sha256}`;
}

export function searchPageUri(sha256: string): string {
  return `tlcmap://search/${sha256}`;
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

export function parseSha256(raw: string): string {
  if (SHA256.test(raw)) return raw;
  throw new TlcmapError('INVALID_ARGUMENT', `The hash in the resource URI must be ${SHA_RULE}.`, {
    field: 'sha256',
    value: raw,
    rule: SHA_RULE,
  });
}

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(',') : (v ?? ''));

export function pageResources(deps: { pages: PageService; logger: Logger }): Registration[] {
  const { pages, logger } = deps;

  function register(
    name: string,
    template: string,
    description: string,
    tool: string,
    validate: (vars: Record<string, string | string[] | undefined>) => void,
  ): Registration {
    return {
      scope: 'read',
      register(server) {
        server.registerResource(
          name,
          new ResourceTemplate(template, { list: undefined }),
          { mimeType: 'application/json', description },
          async (uri, vars) => {
            const started = Date.now();
            const finish = (outcome: string) =>
              logger.log(outcome === 'ok' ? 'info' : 'warn', 'resource', {
                uri: uri.href,
                outcome,
                duration_ms: Date.now() - started,
              });
            try {
              validate(vars);
              const entry = pages.peekResource(uri.href);
              if (!entry) {
                throw new TlcmapError(
                  'RESOURCE_EXPIRED',
                  `This resource is no longer held by the server. Call ${tool} again to obtain a fresh handle.`,
                  { uri: uri.href, tool },
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

  return [
    register(
      'layer-features-page',
      LAYER_PAGE_TEMPLATE,
      'One page of a TLCMap layer\'s GeoJSON features, exactly as fetched. Obtain the URI from a tlcmap_get_layer result.',
      'tlcmap_get_layer',
      (vars) => {
        parseLayerId(one(vars.id));
        parseSha256(one(vars.sha256));
      },
    ),
    register(
      'search-page',
      SEARCH_PAGE_TEMPLATE,
      'One page of place-search GeoJSON features, exactly as fetched. Obtain the URI from a tlcmap_search_places result.',
      'tlcmap_search_places',
      (vars) => {
        parseSha256(one(vars.sha256));
      },
    ),
  ];
}
