import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import {
  checkLayerIdentity,
  createLayerService,
  layerUrl,
  type LayerEntry,
} from '../../src/layers/service.js';
import type { Logger } from '../../src/log.js';
import { summariseLayerFeed } from '../../src/summarise/layer.js';
import { ByteLruCache } from '../../src/upstream/cache.js';
import type { UpstreamClient, UpstreamResponse } from '../../src/upstream/client.js';
import { Limiter } from '../../src/upstream/limiter.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const BASE = new URL('https://tlcmap.org');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function respond(url: URL, body: Buffer): UpstreamResponse {
  return { url: url.href, status: 200, body, fetchedAt: new Date(), durationMs: 5 };
}

function setup(
  handler: (url: URL, n: number) => Promise<UpstreamResponse> | UpstreamResponse,
  limiter = new Limiter({ concurrency: 4, queueMax: 8, queueTimeoutMs: 1000 }),
) {
  let calls = 0;
  const client: UpstreamClient = {
    get: async (url) => handler(url, ++calls),
  };
  const events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const logger: Logger = {
    log: (level, event, fields = {}) => events.push({ level, event, fields }),
  };
  const cache = new ByteLruCache<LayerEntry>({
    maxBytes: 10_000_000,
    ttlMs: 60_000,
    sizeOf: (e) => e.body.length,
  });
  const service = createLayerService({
    client,
    cache,
    limiter,
    baseUrl: BASE,
    serverId: 'tlcmap-mcp test',
    logger,
  });
  return { service, events, calls: () => calls, cache };
}

const ok206 = (url: URL) => respond(url, fixture('layer-206.json'));

describe('layerUrl', () => {
  it('builds {base}/layers/{id}/json', () => {
    expect(layerUrl(BASE, 206).href).toBe('https://tlcmap.org/layers/206/json');
  });
});

describe('checkLayerIdentity', () => {
  const summary = (metadata: Record<string, unknown>) => ({
    ...summariseLayerFeed(fixture('layer-206.json')),
    metadata,
  });

  it('passes when layer_id matches', () => {
    expect(() => checkLayerIdentity(summary({ layer_id: 206 }), 206)).not.toThrow();
  });

  it.each([[{}], [{ layer_id: '206' }], [{ layer_id: 207 }]])('throws for %j', (md) => {
    let caught: unknown;
    try {
      checkLayerIdentity(summary(md), 206);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TlcmapError);
    const err = caught as TlcmapError;
    expect(err.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    // The layer service adds request, status and api_metadata (see getLayer below).
    expect(err.details).toEqual({ expected: 'metadata.layer_id to equal 206' });
  });
});

describe('getLayer', () => {
  it('misses, then hits with unchanged provenance', async () => {
    const { service, calls } = setup(ok206);
    const first = await service.getLayer(206);
    expect(first.cache).toBe('miss');
    expect(first.entry.summary.record_count).toBe(52);
    const second = await service.getLayer(206);
    expect(second.cache).toBe('hit');
    expect(calls()).toBe(1);
    expect(second.entry.provenance.fetched_at).toBe(first.entry.provenance.fetched_at);
    expect(first.entry.provenance.record_uids).toEqual(first.entry.summary.record_uids);
  });

  it('shares one fetch between concurrent callers', async () => {
    const { service, calls } = setup(async (url) => {
      await sleep(10);
      return ok206(url);
    });
    const [a, b] = await Promise.all([service.getLayer(206), service.getLayer(206)]);
    expect(calls()).toBe(1);
    expect([a.cache, b.cache].sort()).toEqual(['miss', 'shared']);
    expect(a.entry).toBe(b.entry);
  });

  it('rejects every joiner on failure and caches nothing', async () => {
    let fail = true;
    const { service, calls } = setup(async (url) => {
      await sleep(10);
      if (fail) throw new TlcmapError('UPSTREAM_UNAVAILABLE', 'down');
      return ok206(url);
    });
    const results = await Promise.allSettled([service.getLayer(206), service.getLayer(206)]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect(((r as PromiseRejectedResult).reason as TlcmapError).code).toBe(
        'UPSTREAM_UNAVAILABLE',
      );
    }
    expect(calls()).toBe(1);
    expect(service.peekLayer(206)).toBeUndefined();
    fail = false;
    await service.getLayer(206);
    expect(calls()).toBe(2);
  });

  it('rejects an unsummarisable body and does not cache it', async () => {
    const { service } = setup((url) => respond(url, fixture('synthetic/no-features.json')));
    await expect(service.getLayer(206)).rejects.toMatchObject({
      code: 'UPSTREAM_CONTRACT_VIOLATION',
    });
    expect(service.peekLayer(206)).toBeUndefined();
  });

  it('rejects the missing-layer response and does not cache it', async () => {
    const { service } = setup((url) => respond(url, fixture('layer-missing.json')));
    const body = JSON.parse(fixture('layer-missing.json').toString('utf8')) as {
      metadata: unknown;
    };
    const caught: unknown = await service.getLayer(99999999).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(TlcmapError);
    const err = caught as TlcmapError;
    expect(err.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(err.details).toEqual({
      request: 'GET https://tlcmap.org/layers/99999999/json',
      status: 200,
      expected: 'metadata.layer_id to equal 99999999',
      api_metadata: body.metadata,
    });
    expect(service.peekLayer(99999999)).toBeUndefined();
  });

  it('a shape violation carries the request, status and API metadata verbatim', async () => {
    const metadata = { layer_id: 206, name: 'A layer', license: '  CC BY 4.0  ', extra: [1, { a: null }] };
    const feed = JSON.stringify({
      type: 'FeatureCollection',
      metadata,
      features: [
        { type: 'Feature', geometry: null, properties: { id: 't1' } },
        { type: 'Feature', geometry: null, properties: {} },
      ],
    });
    const { service } = setup((url) => respond(url, Buffer.from(feed)));
    const caught: unknown = await service.getLayer(206).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(TlcmapError);
    const err = caught as TlcmapError;
    expect(err.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(err.message).toBe(
      'The layer feed from TLCMap did not have the expected shape: feature properties.id to be a non-empty string.',
    );
    expect(err.details).toEqual({
      request: 'GET https://tlcmap.org/layers/206/json',
      status: 200,
      expected: 'feature properties.id to be a non-empty string',
      feature_index: 1,
      api_metadata: metadata,
    });
  });

  it('a body that is not JSON carries the request and status but no api_metadata', async () => {
    const { service } = setup((url) => respond(url, fixture('synthetic/not-json.json')));
    const caught = (await service.getLayer(206).catch((e: unknown) => e)) as TlcmapError;
    expect(caught.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(caught.details).toEqual({
      request: 'GET https://tlcmap.org/layers/206/json',
      status: 200,
      expected: 'a UTF-8 JSON document',
    });
  });

  it('a non-object metadata is not passed on as api_metadata', async () => {
    const { service } = setup((url) => respond(url, fixture('synthetic/metadata-not-object.json')));
    const caught = (await service.getLayer(206).catch((e: unknown) => e)) as TlcmapError;
    expect(caught.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(caught.details).toEqual({
      request: 'GET https://tlcmap.org/layers/206/json',
      status: 200,
      expected: 'metadata to be an object',
    });
  });

  it('summarises a real layer with zero features', async () => {
    const feed = JSON.stringify({
      type: 'FeatureCollection',
      metadata: { layer_id: 5 },
      features: [],
    });
    const { service } = setup((url) => respond(url, Buffer.from(feed)));
    const { entry } = await service.getLayer(5);
    expect(entry.summary.record_count).toBe(0);
  });

  it('lets non-TlcmapErrors propagate unchanged', async () => {
    const bug = new TypeError('bug');
    const { service } = setup(() => {
      throw bug;
    });
    await expect(service.getLayer(206)).rejects.toBe(bug);
  });
});

describe('peekLayer', () => {
  it('returns the cached entry without calling the client', async () => {
    const { service, calls } = setup(ok206);
    expect(service.peekLayer(206)).toBeUndefined();
    const { entry } = await service.getLayer(206);
    expect(service.peekLayer(206)).toBe(entry);
    expect(calls()).toBe(1);
  });
});

describe('stats and logging', () => {
  it('counts client calls only and records success and error', async () => {
    let fail = false;
    const { service } = setup((url) => {
      if (fail) throw new TlcmapError('UPSTREAM_UNAVAILABLE', 'down');
      return ok206(url);
    });
    expect(service.stats().upstream).toEqual({
      requests_total: 0,
      in_flight: 0,
      queued: 0,
      last_success_at: null,
      last_error: null,
    });
    await service.getLayer(206);
    await service.getLayer(206);
    let s = service.stats();
    expect(s.upstream.requests_total).toBe(1);
    expect(s.upstream.last_success_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(s.cache.entries).toBe(1);
    expect(s.cache.bytes).toBeGreaterThan(0);
    fail = true;
    await expect(service.getLayer(207)).rejects.toBeInstanceOf(TlcmapError);
    s = service.stats();
    expect(s.upstream.requests_total).toBe(2);
    expect(s.upstream.last_error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(s.upstream.last_error?.at).toMatch(/Z$/);
  });

  it('logs one upstream event per client call', async () => {
    let fail = false;
    const { service, events } = setup((url) => {
      if (fail) throw new TlcmapError('UPSTREAM_UNAVAILABLE', 'down');
      return ok206(url);
    });
    await service.getLayer(206);
    await service.getLayer(206);
    const ups = events.filter((e) => e.event === 'upstream');
    expect(ups).toHaveLength(1);
    expect(ups[0]!.level).toBe('info');
    expect(ups[0]!.fields).toMatchObject({
      url: 'https://tlcmap.org/layers/206/json',
      status: 200,
      bytes: fixture('layer-206.json').length,
      queue_wait_ms: 0,
      duration_ms: 5,
    });
    fail = true;
    await expect(service.getLayer(300)).rejects.toBeInstanceOf(TlcmapError);
    const failed = events.filter((e) => e.event === 'upstream')[1]!;
    expect(failed.level).toBe('warn');
    expect(failed.fields).toMatchObject({
      url: 'https://tlcmap.org/layers/300/json',
      outcome: 'UPSTREAM_UNAVAILABLE',
    });
    expect(typeof failed.fields.duration_ms).toBe('number');
  });

  it('records SERVER_BUSY in last_error without counting a request', async () => {
    const limiter = new Limiter({ concurrency: 1, queueMax: 0, queueTimeoutMs: 1000 });
    let release!: () => void;
    const { service, events } = setup(
      (url) =>
        new Promise((resolve) => {
          release = () => resolve(ok206(url));
        }),
      limiter,
    );
    const first = service.getLayer(206);
    await sleep(5);
    expect(service.stats().upstream.requests_total).toBe(1);
    await expect(service.getLayer(207)).rejects.toMatchObject({ code: 'SERVER_BUSY' });
    const s = service.stats().upstream;
    expect(s.requests_total).toBe(1);
    expect(s.in_flight).toBe(1);
    expect(s.last_error?.code).toBe('SERVER_BUSY');
    expect(events.filter((e) => e.event === 'upstream')).toHaveLength(0);
    release();
    await first;
  });
});
