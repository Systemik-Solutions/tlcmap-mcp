import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import { startFakeTlcmap, type FakeRoute, type FakeTlcmap } from '../fake-tlcmap.js';

const UA = 'tlcmap-mcp/test (+https://example.invalid)';
let fake: FakeTlcmap | undefined;

async function start(routes?: Record<string, FakeRoute>): Promise<FakeTlcmap> {
  fake = await startFakeTlcmap(routes);
  return fake;
}
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const client = (o: { timeoutMs?: number; maxBytes?: number } = {}) =>
  createUpstreamClient({ timeoutMs: 2000, maxBytes: 10_000_000, userAgent: UA, ...o });

async function failure(p: Promise<unknown>): Promise<TlcmapError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TlcmapError);
    return e as TlcmapError;
  }
  throw new Error('expected rejection');
}

describe('upstream client', () => {
  it('returns the body bytes of a 2xx response', async () => {
    const f = await start();
    const url = new URL('/layers/206/json', f.baseUrl);
    const before = Date.now();
    const r = await client().get(url);
    expect(r.status).toBe(200);
    expect(r.url).toBe(url.toString());
    expect(r.body.equals(readFileSync(new URL('../fixtures/layer-206.json', import.meta.url)))).toBe(true);
    expect(r.fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the configured User-Agent', async () => {
    const f = await start();
    await client().get(new URL('/layers/206/json', f.baseUrl));
    expect(f.requests[0]?.headers['user-agent']).toBe(UA);
  });

  it('does not follow a redirect', async () => {
    const f = await start({ '/r': { status: 302, headers: { Location: '/maxpaging' } } });
    const url = new URL('/r', f.baseUrl);
    const e = await failure(client().get(url));
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details).toMatchObject({ status: 302, location: '/maxpaging', request: `GET ${url}` });
    expect(f.requests).toHaveLength(1);
  });

  it('maps 403 to LAYER_PRIVATE with the parsed API body', async () => {
    const f = await start({ '/p': { status: 403, body: '{"error":"private"}' } });
    const e = await failure(client().get(new URL('/p', f.baseUrl)));
    expect(e.code).toBe('LAYER_PRIVATE');
    expect(e.details).toMatchObject({ status: 403, api_body: { error: 'private' } });
  });

  it('maps 404 to LAYER_NOT_FOUND without an api_body for an empty body', async () => {
    const f = await start();
    const url = new URL('/nothing', f.baseUrl);
    const e = await failure(client().get(url));
    expect(e.code).toBe('LAYER_NOT_FOUND');
    expect(e.details).not.toHaveProperty('api_body');
    expect(e.details.request).toBe(`GET ${url}`);
  });

  it('maps 400 to UPSTREAM_CONTRACT_VIOLATION', async () => {
    const f = await start({ '/b': { status: 400, body: 'bad' } });
    const e = await failure(client().get(new URL('/b', f.baseUrl)));
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details.status).toBe(400);
  });

  it('maps 429 to UPSTREAM_UNAVAILABLE with retry_after', async () => {
    const f = await start({ '/t': { status: 429, headers: { 'Retry-After': '30' } } });
    const e = await failure(client().get(new URL('/t', f.baseUrl)));
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details).toMatchObject({ status: 429, retry_after: '30' });
  });

  it('maps 503 to UPSTREAM_UNAVAILABLE', async () => {
    const f = await start({ '/s': { status: 503 } });
    const e = await failure(client().get(new URL('/s', f.baseUrl)));
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details.status).toBe(503);
  });

  it('times out when the response is slower than timeoutMs', async () => {
    const f = await start({ '/slow': { body: 'x', delayMs: 600 } });
    const e = await failure(client({ timeoutMs: 150 }).get(new URL('/slow', f.baseUrl)));
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details.elapsed_ms as number).toBeGreaterThanOrEqual(140);
    expect(e.message).toMatch(/timed out/);
  });

  it('times out while reading a body that never finishes', async () => {
    const f = await start({ '/stall': { headers: { 'Content-Length': '100' }, body: 'x'.repeat(10) } });
    const e = await failure(client({ timeoutMs: 200 }).get(new URL('/stall', f.baseUrl)));
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('reports a refused connection as UPSTREAM_UNAVAILABLE', async () => {
    const f = await start();
    const url = new URL('/layers/206/json', f.baseUrl);
    await f.close();
    fake = undefined;
    const e = await failure(client().get(url));
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details.request).toBe(`GET ${url}`);
  });

  it('rejects as soon as the body exceeds maxBytes', async () => {
    const total = 50 * 1024 * 1024;
    const f = await start({ '/big': { streamBytes: total } });
    const e = await failure(client({ maxBytes: 100_000 }).get(new URL('/big', f.baseUrl)));
    expect(e.code).toBe('RESPONSE_TOO_LARGE');
    expect(e.details.limit).toBe(100_000);
    const read = e.details.bytes_read as number;
    expect(read).toBeGreaterThan(100_000);
    expect(read).toBeLessThan(total);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const f = await start({ '/ok': { body: 'x'.repeat(1000) } });
    const r = await client({ maxBytes: 1000 }).get(new URL('/ok', f.baseUrl));
    expect(r.body.length).toBe(1000);
  });
});
