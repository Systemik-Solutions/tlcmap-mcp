import { afterEach, describe, expect, it } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import { fixtureFetch, v2Bytes, v2Json } from '../helpers/v2-fixtures.js';
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
    const url = new URL('/api/v2/layers/206', f.baseUrl);
    const before = Date.now();
    const r = await client().get(url);
    expect(r.status).toBe(200);
    expect(r.url).toBe(url.toString());
    expect(r.body.equals(v2Bytes('layer-206.json'))).toBe(true);
    expect(r.fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the configured User-Agent', async () => {
    const f = await start();
    await client().get(new URL('/api/v2/layers/206', f.baseUrl));
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

  it('maps 429 to UPSTREAM_UNAVAILABLE with retry_after', async () => {
    const f = await start({ '/t': { status: 429, headers: { 'Retry-After': '30' } } });
    const e = await failure(client().get(new URL('/t', f.baseUrl)));
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details).toMatchObject({ status: 429, retry_after: '30' });
    expect(e.details.elapsed_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('maps 503 to UPSTREAM_UNAVAILABLE', async () => {
    const f = await start({ '/s': { status: 503 } });
    const e = await failure(client().get(new URL('/s', f.baseUrl)));
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details.status).toBe(503);
    expect(e.details.elapsed_ms as number).toBeGreaterThanOrEqual(0);
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
    const url = new URL('/api/v2/layers/206', f.baseUrl);
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

describe('v2 error responses', () => {
  const BASE = 'https://tlcmap.test';
  type Body = { error: { message: string; details: Record<string, unknown> } };
  const viaFixtures = (overrides: Parameters<typeof fixtureFetch>[0] = {}) =>
    createUpstreamClient({ timeoutMs: 2000, maxBytes: 10_000_000, userAgent: UA, fetch: fixtureFetch(overrides) });
  const getErr = (path: string, overrides?: Parameters<typeof fixtureFetch>[0]) =>
    failure(viaFixtures(overrides).get(new URL(path, BASE)));
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });

  it('maps INVALID_PARAMETER with the message and details plus request and status', async () => {
    const path = '/api/v2/layers/206/features?per_page=6000';
    const fx = v2Json<Body>('error-per-page.json');
    const e = await getErr(path);
    expect(e.code).toBe('INVALID_PARAMETER');
    expect(e.message).toBe(fx.error.message);
    expect(e.details).toEqual({ ...fx.error.details, request: `GET ${BASE}${path}`, status: 400 });
  });

  it('maps INVALID_GEOMETRY', async () => {
    const e = await getErr('/api/v2/places?polygon=0%200,1%201,0%201,1%200');
    expect(e.code).toBe('INVALID_GEOMETRY');
    expect(e.details.reason).toBe(v2Json<Body>('error-geometry.json').error.details.reason);
  });

  it('maps FILTER_REJECTED', async () => {
    const e = await getErr('/api/v2/places?extended_data=Years%20%3E%20many');
    expect(e.code).toBe('FILTER_REJECTED');
    expect(e.details).toMatchObject({ expression: 'Years > many', position: 8 });
  });

  it('maps 403 LAYER_PRIVATE', async () => {
    const e = await getErr('/api/v2/layers/33');
    expect(e.code).toBe('LAYER_PRIVATE');
    expect(e.details.layer_id).toBe(33);
  });

  it('maps 404 LAYER_NOT_FOUND', async () => {
    const e = await getErr('/api/v2/layers/99999999');
    expect(e.code).toBe('LAYER_NOT_FOUND');
    expect(e.details.layer_id).toBe(99999999);
  });

  it('treats a 404 NOT_FOUND route error as a contract violation carrying api_body', async () => {
    const e = await getErr('/api/v2/nowhere');
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details.api_body).toEqual(v2Json('route-not-found.json'));
  });

  it('treats a 405 as a contract violation', async () => {
    const body = { error: { code: 'METHOD_NOT_ALLOWED', message: 'no', details: {} } };
    const e = await getErr('/x', { '/x': json(405, body) });
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.message).toContain('HTTP 405 METHOD_NOT_ALLOWED');
    expect(e.details.api_body).toEqual(body);
  });

  it('treats a code that does not belong with its status as a contract violation', async () => {
    const body = { error: { code: 'LAYER_PRIVATE', message: 'no', details: {} } };
    const e = await getErr('/x', { '/x': json(400, body) });
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details.api_body).toEqual(body);
  });

  it('treats a non-JSON 404 as a contract violation without api_body', async () => {
    const e = await getErr('/x', { '/x': { status: 404, body: '<html>' } });
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details).not.toHaveProperty('api_body');
  });

  it('treats a 418 with a JSON body as a contract violation with api_body', async () => {
    const body = { teapot: true };
    const e = await getErr('/x', { '/x': json(418, body) });
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details.api_body).toEqual(body);
  });

  it('maps a 429 RATE_LIMITED to UPSTREAM_UNAVAILABLE with retry_after', async () => {
    const body = { error: { code: 'RATE_LIMITED', message: 'slow', details: {} } };
    const e = await getErr('/x', { '/x': json(429, body, { 'Retry-After': '30' }) });
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details.retry_after).toBe('30');
    expect(e.details.elapsed_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('maps a 503 to UPSTREAM_UNAVAILABLE', async () => {
    const e = await getErr('/x', { '/x': { status: 503, body: '' } });
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details.status).toBe(503);
    expect(e.details.elapsed_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('treats a 302 as a contract violation with its location', async () => {
    const e = await getErr('/x', { '/x': { status: 302, body: '', headers: { Location: '/y' } } });
    expect(e.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(e.details.location).toBe('/y');
  });
});
