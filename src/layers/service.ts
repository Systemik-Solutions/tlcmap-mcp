import { TlcmapError, type ErrorCode } from '../errors.js';
import type { Logger } from '../log.js';
import { buildProvenance, type CacheOutcome, type FetchProvenance } from '../provenance.js';
import { summariseLayerFeed, type LayerSummary } from '../summarise/layer.js';
import type { ByteLruCache } from '../upstream/cache.js';
import type { UpstreamClient, UpstreamResponse } from '../upstream/client.js';
import { SingleFlight, type Limiter } from '../upstream/limiter.js';

export interface LayerEntry {
  layerId: number;
  body: Buffer;
  summary: LayerSummary;
  provenance: FetchProvenance;
}

export interface UpstreamStats {
  requests_total: number;
  in_flight: number;
  queued: number;
  last_success_at: string | null;
  last_error: { code: ErrorCode; at: string } | null;
}

export interface LayerService {
  getLayer(layerId: number): Promise<{ entry: LayerEntry; cache: CacheOutcome }>;
  /** Returns the cached entry, if any. Never fetches. */
  peekLayer(layerId: number): LayerEntry | undefined;
  stats(): { upstream: UpstreamStats; cache: { entries: number; bytes: number } };
}

export function layerUrl(baseUrl: URL, layerId: number): URL {
  return new URL(`${baseUrl.href.replace(/\/+$/, '')}/layers/${layerId}/json`);
}

/**
 * TLCMap answers a missing or private layer with a 200 and an empty feed, so the feed
 * must prove it is the layer asked for. Only the identity field is inspected.
 */
export function checkLayerIdentity(summary: LayerSummary, layerId: number): void {
  if (summary.metadata['layer_id'] === layerId) return;
  throw new TlcmapError(
    'UPSTREAM_CONTRACT_VIOLATION',
    `The layer feed from TLCMap did not identify itself as layer ${layerId}.`,
    { expected: `metadata.layer_id to equal ${layerId}` },
  );
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body's `metadata` object, untouched, if the body is JSON and has one. */
function apiMetadataOf(body: Buffer): Record<string, unknown> | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  return isObj(doc) && isObj(doc.metadata) ? doc.metadata : undefined;
}

/**
 * A contract violation found in a 2xx body gains the request, the status and the API's
 * `metadata` verbatim (spec §7). Any other error passes through unchanged.
 */
function withResponseDetails(e: unknown, url: URL, res: UpstreamResponse): unknown {
  if (!(e instanceof TlcmapError) || e.code !== 'UPSTREAM_CONTRACT_VIOLATION') return e;
  const details: Record<string, unknown> = { request: `GET ${url.href}`, status: res.status, ...e.details };
  if (!('api_metadata' in details)) {
    const metadata = apiMetadataOf(res.body);
    if (metadata !== undefined) details.api_metadata = metadata;
  }
  return new TlcmapError(e.code, e.message, details);
}

export function createLayerService(deps: {
  client: UpstreamClient;
  cache: ByteLruCache<LayerEntry>;
  limiter: Limiter;
  baseUrl: URL;
  serverId: string;
  logger: Logger;
}): LayerService {
  const { client, cache, limiter, baseUrl, serverId, logger } = deps;
  const flight = new SingleFlight<{ entry: LayerEntry }>();
  let requestsTotal = 0;
  let lastSuccessAt: string | null = null;
  let lastError: { code: ErrorCode; at: string } | null = null;

  const keyOf = (layerId: number) => layerUrl(baseUrl, layerId).href;

  async function fetchLayer(layerId: number, url: URL): Promise<{ entry: LayerEntry }> {
    try {
      const { value: res, queueWaitMs } = await limiter.run(async () => {
        requestsTotal++;
        const started = Date.now();
        try {
          return await client.get(url);
        } catch (e) {
          if (e instanceof TlcmapError) {
            logger.log('warn', 'upstream', {
              url: url.href,
              outcome: e.code,
              duration_ms: Date.now() - started,
            });
          }
          throw e;
        }
      });
      lastSuccessAt = new Date().toISOString();
      logger.log('info', 'upstream', {
        url: url.href,
        status: res.status,
        bytes: res.body.length,
        queue_wait_ms: queueWaitMs,
        duration_ms: res.durationMs,
      });
      let summary: LayerSummary;
      try {
        summary = summariseLayerFeed(res.body);
        checkLayerIdentity(summary, layerId);
      } catch (e) {
        throw withResponseDetails(e, url, res);
      }
      const entry: LayerEntry = {
        layerId,
        body: res.body,
        summary,
        provenance: buildProvenance(res, summary.record_uids, serverId),
      };
      cache.set(url.href, entry);
      return { entry };
    } catch (e) {
      if (e instanceof TlcmapError) lastError = { code: e.code, at: new Date().toISOString() };
      throw e;
    }
  }

  return {
    async getLayer(layerId) {
      const url = layerUrl(baseUrl, layerId);
      const cached = cache.get(url.href);
      if (cached) return { entry: cached, cache: 'hit' };
      const { value, shared } = await flight.do(url.href, () => fetchLayer(layerId, url));
      return { entry: value.entry, cache: shared ? 'shared' : 'miss' };
    },

    peekLayer(layerId) {
      return cache.get(keyOf(layerId));
    },

    stats() {
      const l = limiter.stats();
      return {
        upstream: {
          requests_total: requestsTotal,
          in_flight: l.inFlight,
          queued: l.queued,
          last_success_at: lastSuccessAt,
          last_error: lastError,
        },
        cache: cache.stats(),
      };
    },
  };
}
