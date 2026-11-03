import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Express } from 'express';
import { vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { buildServer } from '../../src/wire.js';
import { startFakeTlcmap, type FakeRoute, type FakeTlcmap } from '../fake-tlcmap.js';

export const TEST_PUBLIC_URL = 'https://test-mcp.tlcmap.org';

export interface TestServer {
  url: URL;
  app: Express;
  fake: FakeTlcmap;
  client: Client;
  logs: Record<string, unknown>[];
  close(): Promise<void>;
}

export interface TestServerOptions {
  /** Extra fake TLCMap routes, keyed by path. */
  routes?: Record<string, FakeRoute>;
  /** Connect the MCP client (default true). A test counting requests can opt out. */
  connect?: boolean;
  /**
   * The client's protocol negotiation (default `'legacy'`, the SDK client's own default):
   * `'legacy'` speaks 2025-11-25 and is answered by the SDK's stateless fallback; `'auto'`
   * probes with `server/discover` and settles on 2026-07-28 against this server.
   */
  negotiation?: 'legacy' | 'auto';
}

/**
 * Starts a fake TLCMap, builds the real stack against it with `buildServer` (the wiring
 * `index.ts` uses), listens on an ephemeral port and connects an MCP client.
 */
export async function startTestServer(
  env: Record<string, string> = {},
  opts: TestServerOptions = {},
): Promise<TestServer> {
  const fake = await startFakeTlcmap(opts.routes);
  const config = loadConfig({
    PUBLIC_URL: TEST_PUBLIC_URL,
    LOG_LEVEL: 'debug',
    ...env,
    TLCMAP_BASE_URL: fake.baseUrl.href,
  });
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger(config.logLevel, (line) => {
    logs.push(JSON.parse(line) as Record<string, unknown>);
  });

  // The SDK warns on the console that JSON response mode drops mid-call notifications.
  // The warning is expected; keep it out of the test output.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let built: ReturnType<typeof buildServer>;
  try {
    built = buildServer(config, logger);
  } finally {
    warn.mockRestore();
  }

  const http = createServer(built.app);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const client = new Client(
    { name: 'tlcmap-mcp-test', version: '0.0.0' },
    { versionNegotiation: { mode: opts.negotiation ?? 'legacy' } },
  );
  if (opts.connect ?? true) await client.connect(new StreamableHTTPClientTransport(url));

  return {
    url,
    app: built.app,
    fake,
    client,
    logs,
    async close() {
      await client.close();
      await built.close();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      await fake.close();
    },
  };
}
