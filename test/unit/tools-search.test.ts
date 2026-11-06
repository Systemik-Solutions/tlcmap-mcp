import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Logger } from '../../src/log.js';
import { registerEnabled } from '../../src/mcp/scopes.js';
import { createPageService } from '../../src/pages/service.js';
import { pageResources, searchPageUri } from '../../src/resources/pages.js';
import { listLayersTool } from '../../src/tools/list-layers.js';
import { searchPlacesTool } from '../../src/tools/search-places.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import { Limiter } from '../../src/upstream/limiter.js';
import { SERVER_ID } from '../../src/version.js';
import { fixtureFetch, MANIFEST, v2Bytes, v2Json } from '../helpers/v2-fixtures.js';

const BASE = 'http://tlcmap-ghap.laragon.local';

type ToolResult = {
  isError?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: Record<string, any>;
  content: { type: string; text: string }[];
};

let requests: string[];
let client: Client;
let server: McpServer;

beforeEach(async () => {
  const inner = fixtureFetch();
  requests = [];
  const fetch = (async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return inner(input);
  }) as typeof globalThis.fetch;
  const logger: Logger = { log: () => undefined };
  const pages = createPageService({
    client: createUpstreamClient({ timeoutMs: 5000, maxBytes: 50_000_000, userAgent: 'test', fetch }),
    limiter: new Limiter({ concurrency: 4, queueMax: 8, queueTimeoutMs: 1000 }),
    cache: { maxBytes: 50_000_000, ttlMs: 60_000 },
    serverId: SERVER_ID,
    logger,
  });
  server = new McpServer({ name: 'test', version: '0.0.0' });
  registerEnabled(
    server,
    [
      listLayersTool({ pages, baseUrl: new URL(BASE), logger }),
      searchPlacesTool({ pages, baseUrl: new URL(BASE), logger }),
      ...pageResources({ pages, logger }),
    ],
    ['read'],
  );
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(c);
});
afterEach(async () => {
  await client.close();
  await server.close();
});

const callTool = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
const layers = (args: Record<string, unknown>) => callTool('tlcmap_list_layers', args);
const places = (args: Record<string, unknown>) => callTool('tlcmap_search_places', args);
const readUri = async (uri: string) =>
  ((await client.readResource({ uri })) as unknown as { contents: { text: string }[] }).contents[0]!.text;

const HUNTER = [150.8, -33.1, 151.4, -32.6];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('tlcmap_list_layers', () => {
  test('the Hunter Valley bbox returns the fixture objects and layer_ids', async () => {
    const fx = v2Json<{ query: unknown; total: number; page: unknown; layers: unknown[] }>('layers-hunter.json');
    const r = await layers({ bbox: HUNTER });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent!;
    expect(Object.keys(sc).sort()).toEqual(['layers', 'page', 'provenance', 'query', 'total']);
    expect(sc.query).toEqual(fx.query);
    expect(sc.total).toBe(8);
    expect(sc.total).toBe(fx.total);
    expect(sc.page).toEqual(fx.page);
    expect(sc.layers).toEqual(fx.layers);
    expect(sc.provenance.layer_ids).toEqual([84, 102, 140, 170, 206, 379, 461, 462]);
    expect('record_uids' in sc.provenance).toBe(false);
    expect('resource_uri' in sc).toBe(false);
    expect(sc.provenance.sha256).toBe(sha(v2Bytes('layers-hunter.json')));
    expect(requests).toEqual([`${BASE}/api/v2/layers?bbox=150.8,-33.1,151.4,-32.6`]);
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify(sc) }]);
  });

  test('the description is the catalogue text', async () => {
    const t = (await client.listTools()).tools.find((x) => x.name === 'tlcmap_list_layers')!;
    expect(t.description).toMatch(/^Search TLCMap's catalogue of public layers\./);
    expect(t.description).toMatch(/never by a declared extent/);
  });

  test.each([
    { bbox: [1, 2, 3] },
    { polygon: [[0, 0], [1, 1]] },
    { include_undated: 'false' },
    { has_license: 'yes' },
    { sort: 'title' },
  ])('rejects %j before any request', async (args) => {
    const r = await layers(args);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^Input validation error:/);
    expect(requests).toEqual([]);
  });
});

describe('tlcmap_search_places', () => {
  test('the Hunter Valley box returns query, summary, page and the resource', async () => {
    const fx = v2Json<{
      query: unknown;
      summary: { total: number; by_layer: unknown[] };
      page: unknown;
      features: { properties: { id: string } }[];
    }>('places-hunter.json');
    const bytes = v2Bytes('places-hunter.json');
    const r = await places({ bbox: HUNTER, per_page: 20 });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent!;
    expect(Object.keys(sc).sort()).toEqual(['page', 'provenance', 'query', 'resource_uri', 'summary']);
    expect(sc.query).toEqual(fx.query);
    expect(sc.summary).toEqual(fx.summary);
    expect(sc.summary.by_layer).toEqual(fx.summary.by_layer);
    expect(sc.summary.total).toBe(1318);
    expect(sc.page).toEqual(fx.page);
    expect(sc.provenance.record_uids).toEqual(fx.features.map((f) => String(f.properties.id)));
    expect(sc.provenance.record_uids).toHaveLength(20);
    expect(sc.resource_uri).toBe(searchPageUri(sha(bytes)));
    expect(await readUri(sc.resource_uri)).toBe(bytes.toString('utf8'));
    expect(requests).toEqual([`${BASE}/api/v2/places?bbox=150.8,-33.1,151.4,-32.6&per_page=20`]);
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify(sc) }]);
  });

  test('summary_only gives the summary with null page and resource_uri and no record_uids', async () => {
    const fx = v2Json<{ query: unknown; summary: unknown }>('places-hunter-summary.json');
    const r = await places({ bbox: HUNTER, summary_only: true });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent!;
    expect(Object.keys(sc).sort()).toEqual(['page', 'provenance', 'query', 'resource_uri', 'summary']);
    expect(sc.summary).toEqual(fx.summary);
    expect(sc.query).toEqual(fx.query);
    expect(sc.page).toBeNull();
    expect(sc.resource_uri).toBeNull();
    expect(sc.provenance.record_uids).toEqual([]);
    expect(requests).toEqual([`${BASE}/api/v2/places?bbox=150.8,-33.1,151.4,-32.6&summary_only=true`]);
  });

  test('extended_data Years > many is FILTER_REJECTED with v2 details', async () => {
    const fx = v2Json<{ error: { details: Record<string, unknown> } }>('error-filter.json');
    const r = await places({ extended_data: 'Years > many' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('FILTER_REJECTED');
    const d = r.structuredContent?.error.details;
    expect(d.expression).toBe(fx.error.details.expression);
    expect(d.position).toBe(fx.error.details.position);
    expect(d.expected).toBe(fx.error.details.expected);
  });

  test('a self-intersecting polygon is INVALID_GEOMETRY with the reason', async () => {
    const fx = v2Json<{ error: { details: { reason: string } } }>('error-geometry.json');
    const r = await places({ polygon: [[0, 0], [1, 1], [0, 1], [1, 0]] });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('INVALID_GEOMETRY');
    expect(r.structuredContent?.error.details.reason).toBe(fx.error.details.reason);
  });

  test('layers [33] is LAYER_PRIVATE naming layer 33', async () => {
    const r = await places({ layers: [33] });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('LAYER_PRIVATE');
    expect(r.structuredContent?.error.details.layer_id).toBe(33);
  });

  test('a cursor from another query is INVALID_PARAMETER naming cursor', async () => {
    const entry = MANIFEST.find((m) => m.file === 'error-cursor.json')!;
    const cursor = new URL(entry.path, 'http://x').searchParams.get('cursor')!;
    const r = await places({ bbox: [150, -33, 151, -32], cursor, per_page: 20 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('INVALID_PARAMETER');
    expect(r.structuredContent?.error.details.parameter).toBe('cursor');
  });

  test('an empty sources array is sent as sources= and v2 decides', async () => {
    await places({ sources: [] });
    expect(requests).toEqual([`${BASE}/api/v2/places?sources=`]);
  });

  test('the description is the places text', async () => {
    const t = (await client.listTools()).tools.find((x) => x.name === 'tlcmap_search_places')!;
    expect(t.description).toMatch(/^Search TLCMap's places across contributed layers/);
    expect(t.description).toMatch(/include_undated defaults to true/);
  });

  test.each([
    { bbox: [1, 2, 3] },
    { polygon: [[0, 0], [1, 1]] },
    { sources: ['gaz'] },
    { match: 'like' },
    { include_undated: 'false' },
    { layers: ['33'] },
  ])('rejects %j before any request', async (args) => {
    const r = await places(args);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^Input validation error:/);
    expect(requests).toEqual([]);
  });

  test('a bbox with minLon above maxLon (the antimeridian) is accepted and sent', async () => {
    await places({ bbox: [170, -40, -170, -30] });
    expect(requests).toEqual([`${BASE}/api/v2/places?bbox=170,-40,-170,-30`]);
  });
});

test('the two templates are the only resources', async () => {
  expect((await client.listResources()).resources).toEqual([]);
  const t = (await client.listResourceTemplates()).resourceTemplates.map((x) => x.uriTemplate);
  expect(t.sort()).toEqual(['tlcmap://layer/{id}/features/{sha256}', 'tlcmap://search/{sha256}']);
});
