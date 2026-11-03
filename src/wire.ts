import type { Express } from 'express';
import type { Config } from './config.js';
import { createApp } from './http/app.js';
import { createLayerService, type LayerEntry, type LayerService } from './layers/service.js';
import type { Logger } from './log.js';
import { createServerFactory } from './mcp/server.js';
import { ByteLruCache } from './upstream/cache.js';
import { createUpstreamClient } from './upstream/client.js';
import { Limiter } from './upstream/limiter.js';
import { SERVER_ID, SERVER_VERSION } from './version.js';

/** The whole stack from a validated configuration. `index.ts` and the tests both build with this. */
export function buildServer(
  config: Config,
  logger: Logger,
): { app: Express; layers: LayerService; close(): Promise<void> } {
  const client = createUpstreamClient({
    timeoutMs: config.upstream.timeoutMs,
    maxBytes: config.upstream.maxBytes,
    userAgent: `tlcmap-mcp/${SERVER_VERSION} (+${config.publicUrl.origin})`,
  });
  const cache = new ByteLruCache<LayerEntry>({
    maxBytes: config.cache.maxBytes,
    ttlMs: config.cache.ttlMs,
    sizeOf: (e) => e.body.length,
  });
  const limiter = new Limiter({
    concurrency: config.upstream.concurrency,
    queueMax: config.upstream.queueMax,
    queueTimeoutMs: config.upstream.queueTimeoutMs,
  });
  const layers = createLayerService({
    client,
    cache,
    limiter,
    baseUrl: config.tlcmapBaseUrl,
    serverId: SERVER_ID,
    logger,
  });
  const factory = createServerFactory({ layers, logger, scopes: config.scopes });

  const startedAt = Date.now();
  const { app, close } = createApp({
    config,
    factory,
    logger,
    health: () => {
      const { cache: c, upstream } = layers.stats();
      return {
        status: 'ok',
        version: SERVER_VERSION,
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        scopes: config.scopes,
        cache: c,
        upstream,
      };
    },
  });
  return { app, layers, close };
}
