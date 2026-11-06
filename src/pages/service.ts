import { TlcmapError, type ErrorCode } from '../errors.js';
import type { Logger } from '../log.js';
import { buildProvenance, type CacheOutcome, type FetchProvenance, type Ids } from '../provenance.js';
import { ByteLruCache } from '../upstream/cache.js';
import type { UpstreamClient, UpstreamResponse } from '../upstream/client.js';
import { SingleFlight, type Limiter } from '../upstream/limiter.js';

export interface PageEntry {
  url: string;
  body: Buffer;
  head: Record<string, unknown>;
  provenance: FetchProvenance;
  resourceUri: string | null;
}

export interface PageRequest {
  url: URL;
  /** Validate and check the body; return it without features, and its ids. Throws TlcmapError. */
  parse(body: Buffer): { head: Record<string, unknown>; ids: Ids };
  /** Present only for feature pages. */
  resourceUri?(sha256: string): string;
}

export interface UpstreamStats {
  requests_total: number;
  in_flight: number;
  queued: number;
  last_success_at: string | null;
  last_error: { code: ErrorCode; at: string } | null;
}

export interface PageService {
  fetch(req: PageRequest): Promise<{ entry: PageEntry; cache: CacheOutcome }>;
  /** Returns the cached entry named by `uri`, if any. Never fetches. */
  peekResource(uri: string): PageEntry | undefined;
  stats(): { upstream: UpstreamStats; cache: { entries: number; bytes: number } };
}

/** v2's own error answers: the upstream was reachable and answered in contract (spec §9.3). */
const V2_ANSWER_CODES: ReadonlySet<ErrorCode> = new Set([
  'INVALID_PARAMETER',
  'INVALID_GEOMETRY',
  'FILTER_REJECTED',
  'LAYER_PRIVATE',
  'LAYER_NOT_FOUND',
]);

/** The codes that say the upstream itself is unwell (spec §9.3). */
const UPSTREAM_FAULT_CODES: ReadonlySet<ErrorCode> = new Set([
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_CONTRACT_VIOLATION',
  'RESPONSE_TOO_LARGE',
]);

/** A contract violation found in a 2xx body gains the request and status, never the body (spec §9.2). */
function withResponseDetails(e: unknown, url: URL, res: UpstreamResponse): unknown {
  if (!(e instanceof TlcmapError) || e.code !== 'UPSTREAM_CONTRACT_VIOLATION') return e;
  return new TlcmapError(e.code, e.message, { request: `GET ${url.href}`, status: res.status, ...e.details });
}

export function createPageService(deps: {
  client: UpstreamClient;
  limiter: Limiter;
  cache: { maxBytes: number; ttlMs: number; now?: () => number };
  serverId: string;
  logger: Logger;
}): PageService {
  const { client, limiter, serverId, logger } = deps;
  const uriIndex = new Map<string, string>(); // resource URI -> cache key
  const cache = new ByteLruCache<PageEntry>({
    maxBytes: deps.cache.maxBytes,
    ttlMs: deps.cache.ttlMs,
    sizeOf: (e) => e.body.length,
    ...(deps.cache.now ? { now: deps.cache.now } : {}),
    onEvict: (key, entry) => {
      if (entry.resourceUri !== null && uriIndex.get(entry.resourceUri) === key) {
        uriIndex.delete(entry.resourceUri);
      }
    },
  });
  const flight = new SingleFlight<{ entry: PageEntry }>();
  let requestsTotal = 0;
  let lastSuccessAt: string | null = null;
  let lastError: { code: ErrorCode; at: string } | null = null;

  async function fetchPage(req: PageRequest): Promise<{ entry: PageEntry }> {
    const url = req.url;
    try {
      const { value: res, queueWaitMs } = await limiter.run(async () => {
        requestsTotal++;
        const started = Date.now();
        try {
          return await client.get(url);
        } catch (e) {
          if (e instanceof TlcmapError) {
            if (V2_ANSWER_CODES.has(e.code)) lastSuccessAt = new Date().toISOString();
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
      let parsed: { head: Record<string, unknown>; ids: Ids };
      try {
        parsed = req.parse(res.body);
      } catch (e) {
        throw withResponseDetails(e, url, res);
      }
      const provenance = buildProvenance(res, parsed.ids, serverId);
      const entry: PageEntry = {
        url: url.href,
        body: res.body,
        head: parsed.head,
        provenance,
        resourceUri: req.resourceUri ? req.resourceUri(provenance.sha256) : null,
      };
      cache.set(url.href, entry);
      if (entry.resourceUri !== null && cache.get(url.href) === entry) {
        uriIndex.set(entry.resourceUri, url.href);
      }
      return { entry };
    } catch (e) {
      if (e instanceof TlcmapError && UPSTREAM_FAULT_CODES.has(e.code)) {
        lastError = { code: e.code, at: new Date().toISOString() };
      }
      throw e;
    }
  }

  return {
    async fetch(req) {
      const cached = cache.get(req.url.href);
      if (cached) return { entry: cached, cache: 'hit' };
      const { value, shared } = await flight.do(req.url.href, () => fetchPage(req));
      return { entry: value.entry, cache: shared ? 'shared' : 'miss' };
    },

    peekResource(uri) {
      const key = uriIndex.get(uri);
      if (key === undefined) return undefined;
      const entry = cache.get(key);
      return entry !== undefined && entry.resourceUri === uri ? entry : undefined;
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
