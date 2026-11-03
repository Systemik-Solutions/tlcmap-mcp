import { createServer } from 'node:http';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createLogger } from './log.js';
import { SERVER_VERSION } from './version.js';
import { buildServer } from './wire.js';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`config error: ${e.message}\n`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const built = buildServer(config, logger);
const server = createServer(built.app);

server.on('error', (e) => {
  logger.log('error', 'listen_error', { message: e.message });
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  logger.log('info', 'startup', {
    version: SERVER_VERSION,
    scopes: config.scopes,
    host: config.host,
    port: config.port,
    limits: {
      upstream: {
        concurrency: config.upstream.concurrency,
        queue_max: config.upstream.queueMax,
        queue_timeout_ms: config.upstream.queueTimeoutMs,
        timeout_ms: config.upstream.timeoutMs,
        max_bytes: config.upstream.maxBytes,
      },
      cache: { max_bytes: config.cache.maxBytes, ttl_s: config.cache.ttlMs / 1000 },
      rate_limit_per_min: config.rateLimitPerMin,
    },
  });
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await built.close();
  server.closeIdleConnections();
  await closed;
  logger.log('info', 'shutdown', { version: SERVER_VERSION, scopes: config.scopes, signal });
  process.exit(0);
}

process.on('SIGTERM', (s) => void shutdown(s));
process.on('SIGINT', (s) => void shutdown(s));
