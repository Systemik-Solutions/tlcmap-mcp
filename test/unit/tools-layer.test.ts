import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Logger } from '../../src/log.js';
import { registerEnabled } from '../../src/mcp/scopes.js';
import { createPageService } from '../../src/pages/service.js';
import { layerPageUri, pageResources } from '../../src/resources/pages.js';
import { getLayerTool } from '../../src/tools/get-layer.js';
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
  registerEnabled(server, [
      getLayerTool({ pages, baseUrl: new URL(BASE), logger }),
      getLayerMetadataTool({ pages, baseUrl: new URL(BASE), logger }),
      ...pageResources({ pages, logger }),
    ], ['read']);
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
    expect(Object.keys(sc).sort()).toEqual(['layer', 'provenance', 'summary']);
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

const callLayer = async (args: Record<string, unknown>) =>
  (await client.callTool({ name: 'tlcmap_get_layer', arguments: args })) as unknown as ToolResult;

type Features = {
  layer: unknown;
  query: unknown;
  summary: { total: number };
  page: { next_cursor: string | null };
  features: { properties: { id: string } }[];
};
const idsOf = (f: Features) => f.features.map((x) => x.properties.id);
const readUri = async (uri: string) =>
  ((await client.readResource({ uri })) as unknown as { contents: { text: string }[] }).contents[0]!.text;

describe('tlcmap_get_layer', () => {
  test('206 with no options returns v2 objects by name and the resource uri', async () => {
    const fx = v2Json<Features>('layer-206-features.json');
    const r = await callLayer({ layer_id: 206 });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent!;
    expect(Object.keys(sc).sort()).toEqual(['layer', 'page', 'provenance', 'query', 'resource_uri', 'summary']);
    expect(sc.layer).toEqual(fx.layer);
    expect(sc.query).toEqual(fx.query);
    expect(sc.summary).toEqual(fx.summary);
    expect(sc.page).toEqual(fx.page);
    expect(sc.summary.total).toBe(52);
    expect(sc.resource_uri).toBe(layerPageUri(206, sc.provenance.sha256));
    expect(sc.provenance.record_uids).toEqual(idsOf(fx));
    expect(sc.provenance.record_uids).toHaveLength(52);
    expect(requests).toEqual([`${BASE}/api/v2/layers/206/features`]);
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify(sc) }]);
  });

  test('cursor following gives two pages that union to the whole layer', async () => {
    const one = await callLayer({ layer_id: 206, per_page: 30 });
    const a = one.structuredContent!;
    expect(a.provenance.record_uids).toHaveLength(30);
    expect(typeof a.page.next_cursor).toBe('string');
    const two = await callLayer({ layer_id: 206, per_page: 30, cursor: a.page.next_cursor });
    const b = two.structuredContent!;
    expect(two.isError).toBeFalsy();
    expect(b.provenance.record_uids).toHaveLength(22);
    expect(b.page.next_cursor).toBeNull();
    expect(new Set([...a.provenance.record_uids, ...b.provenance.record_uids]).size).toBe(52);
    expect(a.summary.total).toBe(52);
    expect(b.summary.total).toBe(52);
  });

  test('an empty layer returns its page, an empty record_uids and a readable resource', async () => {
    const r = await callLayer({ layer_id: 257 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.summary.total).toBe(0);
    expect(r.structuredContent?.provenance.record_uids).toEqual([]);
    expect(await readUri(r.structuredContent!.resource_uri)).toEqual(expect.any(String));
  });

  test('per_page 6000 is INVALID_PARAMETER with v2 message', async () => {
    const fx = v2Json<{ error: { message: string } }>('error-per-page.json');
    const r = await callLayer({ layer_id: 206, per_page: 6000 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('INVALID_PARAMETER');
    expect(r.structuredContent?.error.details?.parameter).toBe('per_page');
    expect(r.structuredContent?.error.message).toBe(fx.error.message);
  });

  test('a feature of another layer is an upstream contract violation', async () => {
    await client.close();
    await server.close();
    const fx = v2Json<Features>('layer-206-features.json');
    (fx.features[0]!.properties as Record<string, unknown>).layer_id = 258;
    await start({ '/api/v2/layers/206/features': { status: 200, body: JSON.stringify(fx) } });
    const r = await callLayer({ layer_id: 206 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
  });

  test('the resource bytes hash to provenance.sha256', async () => {
    const r = await callLayer({ layer_id: 206 });
    const text = await readUri(r.structuredContent!.resource_uri);
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(r.structuredContent?.provenance.sha256);
  });

  test('the input schema carries the v2 enums and rejects unknown keys', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'tlcmap_get_layer')!;
    const p = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(p.sort?.enum).toEqual(['order', 'id', 'title', 'start', 'end']);
    expect(p.direction?.enum).toEqual(['asc', 'desc']);
    expect(p.nulls?.enum).toEqual(['first', 'last']);
    expect(p.limit?.type).toBe('integer');
    expect(p.per_page?.type).toBe('integer');
    expect(p.cursor?.type).toBe('string');
    const r = await callLayer({ layer_id: 206, bbox: [1, 2, 3, 4] });
    expect(r.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});
