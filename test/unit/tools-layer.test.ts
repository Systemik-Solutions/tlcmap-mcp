import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Logger } from '../../src/log.js';
import { registerEnabled } from '../../src/mcp/scopes.js';
import { createPageService } from '../../src/pages/service.js';
import { getLayerMetadataTool } from '../../src/tools/get-layer-metadata.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import { Limiter } from '../../src/upstream/limiter.js';
import { SERVER_ID } from '../../src/version.js';
import { fixtureFetch, v2Bytes, v2Json } from '../helpers/v2-fixtures.js';

const BASE = 'http://tlcmap-ghap.laragon.local';

type LogEvent = { level: string; event: string; fields: Record<string, unknown> };
type ToolResult = {
  isError?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: Record<string, any>;
  content: { type: string; text: string }[];
};

let events: LogEvent[];
let requests: string[];
let client: Client;
let server: McpServer;

async function start(overrides: Parameters<typeof fixtureFetch>[0] = {}) {
  const inner = fixtureFetch(overrides);
  requests = [];
  const fetch = (async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return inner(input);
  }) as typeof globalThis.fetch;
  events = [];
  const logger: Logger = { log: (level, event, fields = {}) => events.push({ level, event, fields }) };
  const pages = createPageService({
    client: createUpstreamClient({ timeoutMs: 5000, maxBytes: 50_000_000, userAgent: 'test', fetch }),
    limiter: new Limiter({ concurrency: 4, queueMax: 8, queueTimeoutMs: 1000 }),
    cache: { maxBytes: 50_000_000, ttlMs: 60_000 },
    serverId: SERVER_ID,
    logger,
  });
  server = new McpServer({ name: 'test', version: '0.0.0' });
  registerEnabled(server, [getLayerMetadataTool({ pages, baseUrl: new URL(BASE), logger })], ['read']);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(c);
}

beforeEach(() => start());
afterEach(async () => {
  await client.close();
  await server.close();
});

const call = async (args: Record<string, unknown>) =>
  (await client.callTool({ name: 'tlcmap_get_layer_metadata', arguments: args })) as unknown as ToolResult;

describe('tlcmap_get_layer_metadata', () => {
  test('206 returns v2 layer and summary verbatim with provenance', async () => {
    const fx = v2Json<{ layer: Record<string, unknown>; summary: unknown }>('layer-206.json');
    const bytes = v2Bytes('layer-206.json');
    const r = await call({ layer_id: 206 });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent!;
    expect(sc.layer).toEqual(fx.layer);
    expect(sc.summary).toEqual(fx.summary);
    expect(sc.layer.warning).toBe('None');
    expect(sc.layer.license).toBeNull();
    expect(sc.provenance).toEqual({
      request: `GET ${BASE}/api/v2/layers/206`,
      cache: 'miss',
      layer_ids: [206],
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      fetched_at: expect.any(String),
      server: SERVER_ID,
    });
    expect('record_uids' in sc.provenance).toBe(false);
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify(sc) }]);
  });

  test('258 licence and warning pass through', async () => {
    const fx = v2Json<{ layer: { warning: string } }>('layer-258.json');
    const r = await call({ layer_id: 258 });
    expect(r.structuredContent?.layer.license).toBe('Do not use without permission.');
    expect(r.structuredContent?.layer.warning).toBe(fx.layer.warning);
  });

  test('472 warning is byte-identical', async () => {
    const fx = v2Json<{ layer: { warning: string } }>('layer-472.json');
    const r = await call({ layer_id: 472 });
    expect(r.structuredContent?.layer.warning).toBe(fx.layer.warning);
  });

  test('33 is LAYER_PRIVATE and 99999999 is LAYER_NOT_FOUND', async () => {
    const p = await call({ layer_id: 33 });
    expect(p.isError).toBe(true);
    expect(p.structuredContent?.error.code).toBe('LAYER_PRIVATE');
    expect(p.structuredContent?.error.details.layer_id).toBe(33);
    const n = await call({ layer_id: 99999999 });
    expect(n.structuredContent?.error.code).toBe('LAYER_NOT_FOUND');
  });

  test('a body for another layer is an upstream contract violation', async () => {
    await client.close();
    await server.close();
    const fx = v2Json<{ layer: Record<string, unknown> }>('layer-206.json');
    fx.layer.id = 207;
    await start({ '/api/v2/layers/206': { status: 200, body: JSON.stringify(fx) } });
    const r = await call({ layer_id: 206 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
  });

  test.each([{ layer_id: 'abc' }, { layer_id: 0 }, { layer_id: 2147483648 }, { layer_id: 206, sort: 'id' }])(
    'rejects %j before any request',
    async (args) => {
      const r = await call(args);
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/^Input validation error:/);
      expect(requests).toEqual([]);
    },
  );

  test('one tool log event per call', async () => {
    await call({ layer_id: 206 });
    await call({ layer_id: 33 });
    const tool = events.filter((e) => e.event === 'tool');
    expect(tool).toHaveLength(2);
    expect(tool[0]?.fields).toMatchObject({
      tool: 'tlcmap_get_layer_metadata',
      arguments: { layer_id: 206 },
      outcome: 'ok',
      cache: 'miss',
      duration_ms: expect.any(Number),
    });
    expect(tool[1]?.fields).toMatchObject({ outcome: 'LAYER_PRIVATE' });
  });
});
