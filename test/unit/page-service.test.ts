import { describe, expect, it } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import type { Logger } from '../../src/log.js';
import { createPageService, type PageRequest } from '../../src/pages/service.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import { Limiter } from '../../src/upstream/limiter.js';
import {
  checkFeaturesOfLayer,
  layerFeaturesResponse,
  parseV2,
  withoutFeatures,
} from '../../src/v2/schemas.js';
import { fixtureFetch, v2Bytes } from '../helpers/v2-fixtures.js';

const BASE = 'https://tlcmap.org';
const P1 = '/api/v2/layers/206/features?per_page=30';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function featuresRequest(path: string, layerId = 206): PageRequest {
  return {
    url: new URL(BASE + path),
    parse(body) {
      const doc = parseV2(body, layerFeaturesResponse);
      checkFeaturesOfLayer(doc.features, layerId);
      return { head: withoutFeatures(doc), ids: { layer_ids: [layerId] } };
    },
    resourceUri: (sha) => `tlcmap://features/${sha}`,
  };
}

function setup(
  overrides: Parameters<typeof fixtureFetch>[0] = {},
  cache: { maxBytes: number; ttlMs: number; now?: () => number } = { maxBytes: 50_000_000, ttlMs: 60_000 },
) {
  const inner = fixtureFetch(overrides);
  let calls = 0;
  const fetch = (async (...a: Parameters<typeof globalThis.fetch>) => {
    calls++;
    await sleep(5);
    return inner(...a);
  }) as typeof globalThis.fetch;
  const client = createUpstreamClient({ timeoutMs: 5000, maxBytes: 50_000_000, userAgent: 'test', fetch });
  const events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const logger: Logger = { log: (level, event, fields = {}) => events.push({ level, event, fields }) };
  const service = createPageService({
    client,
    limiter: new Limiter({ concurrency: 4, queueMax: 8, queueTimeoutMs: 1000 }),
    cache,
    serverId: 'tlcmap-mcp test',
    logger,
  });
  return { service, events, calls: () => calls };
}

describe('createPageService', () => {
  it('misses then hits with one upstream request and the same fetched_at', async () => {
    const { service, calls } = setup();
    const a = await service.fetch(featuresRequest(P1));
    const b = await service.fetch(featuresRequest(P1));
    expect(calls()).toBe(1);
    expect([a.cache, b.cache]).toEqual(['miss', 'hit']);
    expect(b.entry.provenance.fetched_at).toBe(a.entry.provenance.fetched_at);
    expect(a.entry.provenance).toMatchObject({ layer_ids: [206], server: 'tlcmap-mcp test' });
    expect(a.entry.provenance.request).toBe(`GET ${BASE}${P1}`);
  });

  it('shares concurrent identical fetches', async () => {
    const { service, calls } = setup();
    const [a, b] = await Promise.all([service.fetch(featuresRequest(P1)), service.fetch(featuresRequest(P1))]);
    expect(calls()).toBe(1);
    expect([a.cache, b.cache].sort()).toEqual(['miss', 'shared']);
  });

  it('names the resource by content hash and peeks it without a request', async () => {
    const { service, calls } = setup();
    const req = featuresRequest(P1);
    const { entry } = await service.fetch(req);
    expect(entry.resourceUri).toBe(req.resourceUri!(entry.provenance.sha256));
    expect(service.peekResource(entry.resourceUri!)).toBe(entry);
    expect(calls()).toBe(1);
    expect(service.peekResource('tlcmap://features/unknown')).toBeUndefined();
  });

  it('has no resource URI for a request without resourceUri', async () => {
    const { service } = setup();
    const { url, parse } = featuresRequest(P1);
    const { entry } = await service.fetch({ url, parse });
    expect(entry.resourceUri).toBeNull();
  });

  it('rejects a parse failure, caches nothing, and adds request and status but no body', async () => {
    const { service } = setup();
    const err = await service.fetch(featuresRequest(P1, 999)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TlcmapError);
    const e = err as TlcmapError;
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details).toMatchObject({ request: `GET ${BASE}${P1}`, status: 200 });
    expect(Object.keys(e.details).sort()).toEqual(['expected', 'request', 'status']);
    expect(service.stats().cache).toEqual({ entries: 0, bytes: 0 });
    const sha = (await setup().service.fetch(featuresRequest(P1))).entry.provenance.sha256;
    expect(service.peekResource(`tlcmap://features/${sha}`)).toBeUndefined();
  });

  it('drops the resource URI when its entry is evicted', async () => {
    // the full layer is the larger body; the cache holds one of the two, not both
    const big = v2Bytes('layer-206-features.json');
    const { service } = setup({}, { maxBytes: big.length + 10, ttlMs: 60_000 });
    const first = await service.fetch(featuresRequest('/api/v2/layers/206/features'));
    expect(service.peekResource(first.entry.resourceUri!)).toBeDefined();
    await service.fetch(featuresRequest(P1));
    expect(service.peekResource(first.entry.resourceUri!)).toBeUndefined();
  });

  it('keeps a URI shared by two entries when the older is evicted', async () => {
    const body = v2Bytes('layer-206-features-p1.json');
    const A = '/api/v2/layers/206/features?per_page=1';
    const B = '/api/v2/layers/206/features?per_page=2';
    const C = '/api/v2/layers/206/features?per_page=3';
    const same = { status: 200, body, headers: { 'Content-Type': 'application/json; charset=utf-8' } };
    const other = { ...same, body: v2Bytes('layer-206-features-p2.json') };
    const { service } = setup(
      { [A]: same, [B]: same, [C]: other },
      { maxBytes: body.length * 2 + 10, ttlMs: 60_000 },
    );
    const a = await service.fetch(featuresRequest(A));
    const b = await service.fetch(featuresRequest(B));
    expect(b.entry.resourceUri).toBe(a.entry.resourceUri);
    await service.fetch(featuresRequest(C)); // evicts A, the older
    expect(service.peekResource(b.entry.resourceUri!)).toBe(b.entry);
  });

  it('drops the URI on TTL expiry', async () => {
    let t = 0;
    const { service } = setup({}, { maxBytes: 50_000_000, ttlMs: 1000, now: () => t });
    const { entry } = await service.fetch(featuresRequest(P1));
    t = 1000;
    expect(service.peekResource(entry.resourceUri!)).toBeUndefined();
  });

  it('counts client calls only, and tracks last_success_at and last_error (spec 9.3)', async () => {
    const BAD = '/api/v2/layers/206/features?per_page=7';
    const { service } = setup({ [BAD]: { status: 503, body: '' } });
    await service.fetch(featuresRequest(P1));
    await service.fetch(featuresRequest(P1));
    expect(service.stats().upstream.requests_total).toBe(1);
    expect(service.stats().upstream.last_error).toBeNull();

    const fresh = setup({ [BAD]: { status: 503, body: '' } }).service;
    const nf = await fresh
      .fetch({ url: new URL(`${BASE}/api/v2/layers/99999999`), parse: () => ({ head: {}, ids: { layer_ids: [] } }) })
      .catch((e: unknown) => e);
    expect((nf as TlcmapError).code).toBe('LAYER_NOT_FOUND');
    const s1 = fresh.stats().upstream;
    expect(s1.last_success_at).not.toBeNull();
    expect(s1.last_error).toBeNull();

    const bad = await fresh.fetch(featuresRequest(BAD)).catch((e: unknown) => e);
    expect((bad as TlcmapError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fresh.stats().upstream.last_error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fresh.stats().upstream.requests_total).toBe(2);
  });

  it('logs one upstream event per client call', async () => {
    const { service, events } = setup();
    await service.fetch(featuresRequest(P1));
    await service.fetch(featuresRequest(P1));
    const up = events.filter((e) => e.event === 'upstream');
    expect(up).toHaveLength(1);
    expect(up[0]!.level).toBe('info');
    expect(Object.keys(up[0]!.fields).sort()).toEqual(['bytes', 'duration_ms', 'queue_wait_ms', 'status', 'url']);
  });
});
