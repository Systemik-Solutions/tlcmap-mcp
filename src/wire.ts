import type { Express } from 'express';
import type { Config } from './config.js';
import { createApp } from './http/app.js';
import type { Logger } from './log.js';
import { createServerFactory } from './mcp/server.js';
import { createPageService, type PageService } from './pages/service.js';
import { createUpstreamClient } from './upstream/client.js';
import { Limiter } from './upstream/limiter.js';
import { SERVER_ID, SERVER_VERSION } from './version.js';

/** The whole stack from a validated configuration. `index.ts` and the tests both build with this. */
export function buildServer(
  config: Config,
  logger: Logger,
): { app: Express; pages: PageService; close(): Promise<void> } {
  const client = createUpstreamClient({
    timeoutMs: config.upstream.timeoutMs,
    maxBytes: config.upstream.maxBytes,
    userAgent: `tlcmap-mcp/${SERVER_VERSION} (+${config.publicUrl.origin})`,
  });
  const limiter = new Limiter({
    concurrency: config.upstream.concurrency,
    queueMax: config.upstream.queueMax,
    queueTimeoutMs: config.upstream.queueTimeoutMs,
  });
  const pages = createPageService({
    client,
    limiter,
    cache: { maxBytes: config.cache.maxBytes, ttlMs: config.cache.ttlMs },
    serverId: SERVER_ID,
    logger,
  });
  const factory = createServerFactory({ pages, baseUrl: config.tlcmapBaseUrl, logger, scopes: config.scopes });

  const startedAt = Date.now();
  const { app, close } = createApp({
    config,
    factory,
    logger,
    health: () => {
      const { cache: c, upstream } = pages.stats();
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
  return { app, pages, close };
}
