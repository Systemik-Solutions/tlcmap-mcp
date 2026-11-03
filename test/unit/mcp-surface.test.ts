import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Scope } from '../../src/config.js';
import { TlcmapError } from '../../src/errors.js';
import type { LayerEntry, LayerService } from '../../src/layers/service.js';
import type { Logger } from '../../src/log.js';
import { registerEnabled, type Registration } from '../../src/mcp/scopes.js';
import { createServerFactory } from '../../src/mcp/server.js';
import { buildProvenance, type CacheOutcome } from '../../src/provenance.js';
import { layerFeaturesUri, parseLayerId } from '../../src/resources/layer-features.js';
import { summariseLayerFeed } from '../../src/summarise/layer.js';
import { SERVER_ID } from '../../src/version.js';

const fixtureBytes = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const fixture206 = JSON.parse(fixtureBytes('layer-206.json').toString('utf8')) as {
  metadata: Record<string, unknown>;
};
const fixture2749 = JSON.parse(fixtureBytes('layer-2749-trimmed.json').toString('utf8')) as {
  metadata: Record<string, unknown>;
};

function entryFrom(layerId: number, body: Buffer): LayerEntry {
  const summary = summariseLayerFeed(body);
  const url = `https://tlcmap.org/layers/${layerId}/json`;
  return {
    layerId,
    body,
    summary,
    provenance: buildProvenance(
      { url, status: 200, body, fetchedAt: new Date('2026-11-03T00:00:00Z'), durationMs: 5 },
      summary.record_uids,
      SERVER_ID,
    ),
  };
}

const MULTIBYTE = 'Ngunnawal – ‘Canberra’ — Mparntwe &amp;';
const multibyteFeed = Buffer.from(
  JSON.stringify({
    type: 'FeatureCollection',
    metadata: { layer_id: 3001, name: MULTIBYTE, warning: MULTIBYTE },
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [149.13, -35.28] },
        properties: { id: 'tmb1', name: MULTIBYTE },
      },
    ],
  }),
  'utf8',
);

class StubLayers implements LayerService {
  calls = 0;
  peeks = 0;
  readonly entries = new Map<number, LayerEntry>();
  readonly cached = new Map<number, LayerEntry>();
  failWith: TlcmapError | undefined;
  outcome: CacheOutcome = 'miss';

  async getLayer(layerId: number) {
    this.calls++;
    if (this.failWith) throw this.failWith;
    const entry = this.entries.get(layerId);
    if (!entry) throw new TlcmapError('LAYER_NOT_FOUND', `No layer ${layerId}.`, { layer_id: layerId });
    this.cached.set(layerId, entry);
    return { entry, cache: this.outcome };
  }

  peekLayer(layerId: number) {
    this.peeks++;
    return this.cached.get(layerId);
  }

  stats() {
    return {
      upstream: { requests_total: 0, in_flight: 0, queued: 0, last_success_at: null, last_error: null },
      cache: { entries: this.cached.size, bytes: 0 },
    };
  }
}

type LogEvent = { level: string; event: string; fields: Record<string, unknown> };

let stubLayers: StubLayers;
let events: LogEvent[];
let logger: Logger;
let client: Client;
let server: McpServer;

async function connect(s: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await s.connect(serverSide);
  const c = new Client({ name: 'test-client', version: '0.0.0' });
  await c.connect(clientSide);
  return c;
}

beforeEach(async () => {
  stubLayers = new StubLayers();
  stubLayers.entries.set(206, entryFrom(206, fixtureBytes('layer-206.json')));
  stubLayers.entries.set(2749, entryFrom(2749, fixtureBytes('layer-2749-trimmed.json')));
  stubLayers.entries.set(3001, entryFrom(3001, multibyteFeed));
  events = [];
  logger = { log: (level, event, fields = {}) => events.push({ level, event, fields }) };
  const factory = createServerFactory({ layers: stubLayers, logger, scopes: ['read'] });
  server = await (factory as () => McpServer | Promise<McpServer>)();
  client = await connect(server);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown> & { metadata?: Record<string, unknown> };
  content: { type: string; text: string }[];
};
const call = async (args: Record<string, unknown>) =>
  (await client.callTool({ name: 'tlcmap_get_layer', arguments: args })) as unknown as ToolResult;

describe('tools', () => {
  test('tools/list has exactly tlcmap_get_layer', async () =>
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['tlcmap_get_layer']));

  test('input schema is layer_id integer ≥ 1 ≤ 2147483647, no other properties', async () => {
    const [tool] = (await client.listTools()).tools;
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['layer_id'],
      properties: { layer_id: { type: 'integer', minimum: 1, maximum: 2147483647 } },
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['layer_id']);
    expect(tool?.description).toMatch(/must be shown to the user, not paraphrased\.$/);
  });

  test('registerEnabled skips registrations outside the enabled scopes', async () => {
    const s = new McpServer({ name: 'scope-test', version: '0.0.0' });
    const registered: Scope[] = [];
    const reg = (scope: Scope, name: string): Registration => ({
      scope,
      register(target) {
        registered.push(scope);
        target.registerTool(name, { description: name }, async () => ({ content: [] }));
      },
    });
    registerEnabled(s, [reg('read', 'fake_read'), reg('write', 'fake_write')], ['read']);
    const c = await connect(s);
    try {
      expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['fake_read']);
      expect(registered).toEqual(['read']);
    } finally {
      await c.close();
      await s.close();
    }
  });

  test('get_layer returns the summary, resource_uri and provenance', async () => {
    const r = await call({ layer_id: 206 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      layer_id: 206,
      record_count: 52,
      undated_count: 52,
      ungeolocated_count: 0,
      date_range: null,
      resource_uri: 'tlcmap://layer/206/features',
      provenance: {
        request: expect.stringMatching(/^GET .*\/layers\/206\/json$/),
        cache: 'miss',
        record_uids: expect.arrayContaining(['ta4f5']),
        server: SERVER_ID,
      },
    });
    expect(r.structuredContent?.metadata).toEqual(fixture206.metadata);
    expect(Object.keys(r.structuredContent?.metadata ?? {})).toEqual(Object.keys(fixture206.metadata));
    expect(r.structuredContent?.metadata?.warning).toBe('None');
    expect('license' in (r.structuredContent?.metadata ?? {})).toBe(false);
    expect('record_uids' in (r.structuredContent ?? {})).toBe(false); // only inside provenance
    expect(r.content).toEqual([
      {
        type: 'text',
        text: 'Layer 206: 52 records, 52 undated, 0 without geometry. Features: tlcmap://layer/206/features',
      },
    ]);
    const toolEvents = events.filter((e) => e.event === 'tool');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.fields).toMatchObject({
      tool: 'tlcmap_get_layer',
      arguments: { layer_id: 206 },
      outcome: 'ok',
      cache: 'miss',
      duration_ms: expect.any(Number),
    });
  });

  test('the cache outcome from the service is reported per call', async () => {
    stubLayers.outcome = 'hit';
    const r = await call({ layer_id: 206 });
    expect((r.structuredContent?.provenance as { cache: string }).cache).toBe('hit');
  });

  test('2749 warning passes through unchanged', async () => {
    const r = await call({ layer_id: 2749 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.metadata?.warning).toBe(fixture2749.metadata.warning);
    expect(String(r.structuredContent?.metadata?.warning)).toMatch(/<[a-z]+[^>]*>/);
    expect(r.structuredContent?.metadata).toEqual(fixture2749.metadata);
  });

  test('a TlcmapError from the service becomes an isError result with structuredContent.error', async () => {
    stubLayers.failWith = new TlcmapError('UPSTREAM_UNAVAILABLE', 'TLCMap did not answer.', {
      status: 503,
    });
    const r = await call({ layer_id: 206 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'TLCMap did not answer.', details: { status: 503 } },
    });
    expect(r.content[0]?.text).toBe('UPSTREAM_UNAVAILABLE: TLCMap did not answer.');
    const toolEvents = events.filter((e) => e.event === 'tool');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.fields).toMatchObject({ outcome: 'UPSTREAM_UNAVAILABLE' });
  });

  test('invalid layer_id is rejected by the SDK before the handler runs', async () => {
    const r = await call({ layer_id: 'abc' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^Input validation error:/);
    expect(stubLayers.calls).toBe(0);
  });

  test('unknown arguments are rejected, not ignored', async () => {
    const r = await call({ layer_id: 206, extra: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^Input validation error:/);
    expect(stubLayers.calls).toBe(0);
  });
});

type ReadResult = {
  contents: { uri: string; mimeType?: string; text?: string }[];
  _meta?: { provenance?: Record<string, unknown> };
};
const read = async (uri: string) => (await client.readResource({ uri })) as unknown as ReadResult;

describe('resource', () => {
  test('resource read serves the cached bytes with provenance in _meta', async () => {
    await call({ layer_id: 206 });
    const entry = stubLayers.cached.get(206)!;
    const r = await read('tlcmap://layer/206/features');
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({
      uri: 'tlcmap://layer/206/features',
      mimeType: 'application/json',
    });
    expect(r.contents[0]?.text).toBe(entry.body.toString('utf8'));
    expect(r._meta?.provenance).toEqual({ ...entry.provenance, cache: 'hit' });
    expect(r._meta?.provenance?.sha256).toBe(entry.provenance.sha256);
    expect(stubLayers.calls).toBe(1); // the read itself never fetched
    const resourceEvents = events.filter((e) => e.event === 'resource');
    expect(resourceEvents).toHaveLength(1);
    expect(resourceEvents[0]?.fields).toMatchObject({
      uri: 'tlcmap://layer/206/features',
      outcome: 'ok',
      duration_ms: expect.any(Number),
    });
  });

  test('resource text round-trips multi-byte UTF-8 to the reported sha256', async () => {
    const tool = await call({ layer_id: 3001 });
    const r = await read('tlcmap://layer/3001/features');
    const text = r.contents[0]?.text ?? '';
    expect(text).toContain(MULTIBYTE);
    const digest = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(digest).toBe(r._meta?.provenance?.sha256);
    expect(digest).toBe((tool.structuredContent?.provenance as { sha256: string }).sha256);
  });

  test('resource read with no cached entry is RESOURCE_EXPIRED, naming the tool', async () => {
    const err = (await read('tlcmap://layer/206/features').catch((e: unknown) => e)) as {
      data?: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.data?.code).toBe('RESOURCE_EXPIRED');
    expect(err.data?.details).toEqual({ uri: 'tlcmap://layer/206/features', tool: 'tlcmap_get_layer' });
    expect(err.data?.message).toMatch(/tlcmap_get_layer/);
    expect(stubLayers.calls).toBe(0);
    expect(events.filter((e) => e.event === 'resource')[0]?.fields).toMatchObject({
      outcome: 'RESOURCE_EXPIRED',
    });
  });

  test.each(['007', '0', '-1', '1.5', 'abc', '99999999999'])(
    'resource rejects non-canonical layer ids: %s',
    async (id) => {
      stubLayers.cached.set(7, stubLayers.entries.get(206)!);
      const err = (await read(`tlcmap://layer/${id}/features`).catch((e: unknown) => e)) as {
        data?: { code: string; details: Record<string, unknown> };
      };
      expect(err).toBeInstanceOf(Error);
      expect(err.data?.code).toBe('INVALID_ARGUMENT');
      expect(err.data?.details).toMatchObject({ field: 'id', value: id });
      expect(stubLayers.peeks).toBe(0);
    },
  );

  test('resources/list is empty and the template is listed', async () => {
    expect((await client.listResources()).resources).toEqual([]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['tlcmap://layer/{id}/features']);
    expect(resourceTemplates[0]?.mimeType).toBe('application/json');
  });
});

describe('helpers', () => {
  test('layerFeaturesUri builds the handle', () => {
    expect(layerFeaturesUri(206)).toBe('tlcmap://layer/206/features');
  });

  test('parseLayerId accepts canonical ids up to 2147483647', () => {
    expect(parseLayerId('1')).toBe(1);
    expect(parseLayerId('2147483647')).toBe(2147483647);
    expect(() => parseLayerId('2147483648')).toThrow(TlcmapError);
    expect(() => parseLayerId('')).toThrow(TlcmapError);
    expect(() => parseLayerId(' 1')).toThrow(TlcmapError);
  });
});
