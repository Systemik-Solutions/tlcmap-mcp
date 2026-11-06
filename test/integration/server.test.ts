import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthBody } from '../../src/http/app.js';
import { SERVER_VERSION } from '../../src/version.js';
import type { FakeRoute } from '../fake-tlcmap.js';
import { startTestServer, type TestServer } from '../helpers/client.js';
import { v2Bytes, v2Json } from '../helpers/v2-fixtures.js';

const fixtureBytes = (name: string) => v2Bytes(name);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown> & {
    layer?: Record<string, unknown>;
    page?: { next_cursor: string | null };
    summary?: { total: number };
    resource_uri?: string;
    provenance?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
};

let running: TestServer[] = [];

async function start(
  env?: Record<string, string>,
  routes?: Record<string, FakeRoute>,
  connect = true,
  negotiation?: 'legacy' | 'auto',
) {
  const s = await startTestServer(env, { routes, connect, negotiation });
  running.push(s);
  return s;
}

const startIn = (negotiation: 'legacy' | 'auto', env?: Record<string, string>, routes?: Record<string, FakeRoute>) =>
  start(env, routes, true, negotiation);

afterEach(async () => {
  await Promise.all(running.map((s) => s.close()));
  running = [];
});

const call = async (s: TestServer, layer_id: number, options: Record<string, unknown> = {}) =>
  (await s.client.callTool({
    name: 'tlcmap_get_layer',
    arguments: { layer_id, ...options },
  })) as unknown as ToolResult;

const FEATURES = '/api/v2/layers/206/features';

const errorCode = (r: ToolResult) => r.structuredContent?.error?.code;

/** A raw HTTP request; node:http rather than fetch so the Host header can be set. */
function raw(
  url: URL,
  opts: { method: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: opts.path ?? url.pathname,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const POST_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function health(s: TestServer): Promise<HealthBody> {
  const r = await raw(s.url, { method: 'GET', path: '/healthz' });
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as HealthBody;
}

// `legacy` is a 2025-11-25 client, answered by the SDK's stateless SSE fallback; `auto`
// negotiates 2026-07-28 and is answered with plain JSON.
describe.each(['legacy', 'auto'] as const)('tlcmap_get_layer end to end (%s negotiation)', (negotiation) => {
  const start = (env?: Record<string, string>, routes?: Record<string, FakeRoute>) =>
    startIn(negotiation, env, routes);

  it('negotiates the expected protocol revision', async () => {
    const s = await start();
    if (negotiation === 'auto') expect(s.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    else expect(s.client.getNegotiatedProtocolVersion()).not.toBe('2026-07-28');
  });

  it('tools/list names exactly the four tools', async () => {
    const s = await start();
    const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'tlcmap_get_layer',
      'tlcmap_get_layer_metadata',
      'tlcmap_list_layers',
      'tlcmap_search_places',
    ]);
  });

  it('resources/templates/list names exactly the two templates', async () => {
    const s = await start();
    const t = (await s.client.listResourceTemplates()).resourceTemplates.map((x) => x.uriTemplate).sort();
    expect(t).toEqual(['tlcmap://layer/{id}/features/{sha256}', 'tlcmap://search/{sha256}']);
  });

  it('a places search is one v2 request and its resource is readable', async () => {
    const s = await start();
    const r = (await s.client.callTool({
      name: 'tlcmap_search_places',
      arguments: { bbox: [150.8, -33.1, 151.4, -32.6], per_page: 20 },
    })) as { isError?: boolean; structuredContent?: { resource_uri: string; summary: { total: number } } };
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.summary.total).toBe(1318);
    const read = (await s.client.readResource({ uri: r.structuredContent!.resource_uri })) as unknown as {
      contents: { text: string }[];
    };
    expect(read.contents[0]?.text).toContain('FeatureCollection');
  });

  it('layer 206 returns its fixture objects and one v2 request', async () => {
    const s = await start();
    const fx = v2Json<{ layer: unknown; summary: unknown }>('layer-206-features.json');
    const r = await call(s, 206);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ layer: fx.layer, summary: fx.summary });
    expect(s.fake.requests.map((q) => q.path)).toEqual([FEATURES]);
  });

  it('layer 258 carries its licence and warning verbatim', async () => {
    const s = await start();
    const fx = v2Json<{ layer: { warning: string; license: string } }>('layer-258-features.json');
    const r = await call(s, 258);
    expect(r.structuredContent?.layer?.warning).toBe(fx.layer.warning);
    expect(r.structuredContent?.layer?.license).toBe(fx.layer.license);
  });

  it('follows the cursor to a second page', async () => {
    const s = await start();
    const one = await call(s, 206, { per_page: 30 });
    const cursor = one.structuredContent?.page?.next_cursor;
    expect(typeof cursor).toBe('string');
    const two = await call(s, 206, { per_page: 30, cursor });
    expect(two.isError).toBeFalsy();
    expect(two.structuredContent?.page?.next_cursor).toBeNull();
    expect(two.structuredContent?.summary?.total).toBe(52);
  });

  it('the resource read hashes to the provenance sha256', async () => {
    const s = await start();
    const r = await call(s, 206);
    const uri = r.structuredContent?.resource_uri as string;
    const read = (await s.client.readResource({ uri })) as unknown as { contents: { text: string }[] };
    expect(sha256(read.contents[0]!.text)).toBe(r.structuredContent?.provenance?.sha256);
    expect(read.contents[0]!.text).toBe(fixtureBytes('layer-206-features.json').toString('utf8'));
  });

  it('a second call is a cache hit with the same fetched_at and no new upstream request', async () => {
    const s = await start();
    const first = await call(s, 206);
    const second = await call(s, 206);
    expect(first.structuredContent?.provenance?.cache).toBe('miss');
    expect(second.structuredContent?.provenance?.cache).toBe('hit');
    expect(second.structuredContent?.provenance?.fetched_at).toBe(
      first.structuredContent?.provenance?.fetched_at,
    );
    expect(s.fake.requests).toHaveLength(1);
  });

  it('a private layer is LAYER_PRIVATE (403) and a missing one LAYER_NOT_FOUND (404)', async () => {
    const route = (file: string, status: number): FakeRoute => ({
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: v2Bytes(file),
    });
    const s = await start(
      undefined,
      {
        '/api/v2/layers/33/features': route('layer-33.json', 403),
        '/api/v2/layers/99999999/features': route('layer-99999999.json', 404),
      },
    );
    expect(errorCode(await call(s, 33))).toBe('LAYER_PRIVATE');
    expect(errorCode(await call(s, 99999999))).toBe('LAYER_NOT_FOUND');
  });

  it('an out-of-range per_page is INVALID_PARAMETER', async () => {
    const s = await start();
    const r = await call(s, 206, { per_page: 6000 });
    expect(r.isError).toBe(true);
    expect(errorCode(r)).toBe('INVALID_PARAMETER');
    expect(r.structuredContent?.error?.details?.['parameter']).toBe('per_page');
  });

  it('a resource URI is RESOURCE_EXPIRED after a fresh server start', async () => {
    const first = await start();
    const r = await call(first, 206);
    const uri = r.structuredContent?.resource_uri as string;
    const second = await start();
    await expect(second.client.readResource({ uri })).rejects.toMatchObject({
      data: { code: 'RESOURCE_EXPIRED' },
    });
  });
});

describe('subscriptions/listen (2026-07-28)', () => {
  it('advertises no list changes, so a listen stream closes right after its acknowledgement', async () => {
    const s = await startIn('auto');
    const sub = await s.client.listen({ toolsListChanged: true, resourcesListChanged: true });
    const timeout = new Promise<'still open'>((resolve) => setTimeout(() => resolve('still open'), 2000));
    const outcome = await Promise.race([sub.closed, timeout]);
    if (outcome === 'still open') await sub.close();
    expect(outcome).toBe('graceful');
    expect(sub.honoredFilter).toEqual({});
    expect(s.client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
  });
});

describe('upstream failures', () => {
  it('a redirect is a contract violation', async () => {
    const s = await start({}, { [FEATURES]: { status: 302, headers: { Location: '/elsewhere' } } });
    expect(errorCode(await call(s, 206))).toBe('UPSTREAM_CONTRACT_VIOLATION');
  });

  it('a 503 is upstream unavailable', async () => {
    const s = await start({}, { [FEATURES]: { status: 503 } });
    expect(errorCode(await call(s, 206))).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('a slow response times out as upstream unavailable', async () => {
    const s = await start(
      { UPSTREAM_TIMEOUT_MS: '200' },
      { [FEATURES]: { delayMs: 1000, body: '{}' } },
    );
    expect(errorCode(await call(s, 206))).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('an oversized response is too large', async () => {
    const s = await start(
      { UPSTREAM_MAX_BYTES: '1024', CACHE_MAX_BYTES: '1024' },
      { [FEATURES]: { streamBytes: 4096 } },
    );
    expect(errorCode(await call(s, 206))).toBe('RESPONSE_TOO_LARGE');
  });

  it('a full upstream queue answers SERVER_BUSY', async () => {
    const slow: FakeRoute = { delayMs: 1000, body: '{}' };
    const s = await start(
      { UPSTREAM_CONCURRENCY: '1', UPSTREAM_QUEUE_MAX: '1' },
      { [FEATURES]: slow },
    );
    const first = call(s, 206, { per_page: 1 });
    await vi.waitFor(async () => expect((await health(s)).upstream.in_flight).toBe(1));
    const second = call(s, 206, { per_page: 2 });
    await vi.waitFor(async () => expect((await health(s)).upstream.queued).toBe(1));
    const third = await call(s, 206, { per_page: 3 });
    expect(errorCode(third)).toBe('SERVER_BUSY');
    expect(errorCode(await first)).not.toBe('SERVER_BUSY');
    expect(errorCode(await second)).not.toBe('SERVER_BUSY');
  });
});

describe('HTTP surface', () => {
  it('the fourth POST /mcp in a minute is rate limited; /healthz is not', async () => {
    // No MCP client: its connect would spend requests against the limit.
    const s = await start({ RATE_LIMIT_PER_MIN: '3' }, {}, false);
    const send = () => fetch(s.url, { method: 'POST', headers: POST_HEADERS, body: PING });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 4; i++) {
      last = await send();
      statuses.push(last.status);
      await last.text();
    }
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
    expect(last?.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await raw(s.url, { method: 'GET', path: '/healthz' })).status).toBe(200);
  });

  it('trusts the loopback proxy only', async () => {
    const s = await start();
    const trust = s.app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('203.0.113.5', 0)).toBe(false);
  });

  it('rejects a foreign Host header and accepts the public one', async () => {
    const s = await start();
    const evil = await raw(s.url, {
      method: 'POST',
      headers: { ...POST_HEADERS, Host: 'evil.example' },
      body: PING,
    });
    // The SDK's Host validation answers 403 (createMcpExpressApp, @modelcontextprotocol/express 2.0.2).
    expect(evil.status).toBe(403);
    const ok = await raw(s.url, {
      method: 'POST',
      headers: { ...POST_HEADERS, Host: 'test-mcp.tlcmap.org' },
      body: PING,
    });
    expect(ok.status).toBe(200);
  });

  it.each(['GET', 'DELETE'])('%s /mcp is 405', async (method) => {
    const s = await start();
    const r = await raw(s.url, { method });
    expect(r.status).toBe(405);
    expect(r.headers['allow']).toBe('POST');
  });

  it('/healthz reports passive state and never calls TLCMap', async () => {
    const s = await start();
    await call(s, 206);
    await call(s, 258);
    const before = s.fake.requests.length;
    const h = await health(s);
    expect(Object.keys(h).sort()).toEqual(['cache', 'scopes', 'status', 'upstream', 'uptime_s', 'version']);
    expect(h).toMatchObject({ status: 'ok', version: SERVER_VERSION, scopes: ['read'] });
    expect(Number.isInteger(h.uptime_s)).toBe(true);
    expect(h.cache.entries).toBe(2);
    expect(h.cache.bytes).toBe(fixtureBytes('layer-206-features.json').length + fixtureBytes('layer-258-features.json').length);
    expect(h.upstream).toMatchObject({ requests_total: before, in_flight: 0, queued: 0, last_error: null });
    expect(h.upstream.last_success_at).toEqual(expect.any(String));
    expect(s.fake.requests).toHaveLength(before);
  });
});

describe('logs', () => {
  const events = (s: TestServer, event: string) => s.logs.filter((l) => l['event'] === event);

  it('a miss logs one tool and one upstream line; a hit logs only a tool line', async () => {
    const s = await start();
    await call(s, 206);
    expect(events(s, 'tool')).toHaveLength(1);
    expect(events(s, 'upstream')).toHaveLength(1);
    expect(events(s, 'upstream')[0]).toMatchObject({ url: new URL(FEATURES, s.fake.baseUrl).href });
    await call(s, 206);
    expect(events(s, 'tool')).toHaveLength(2);
    expect(events(s, 'upstream')).toHaveLength(1);
  });

  it('each HTTP request logs one http line', async () => {
    const s = await start();
    // After connect the client also opens (and is refused) a GET stream, asynchronously,
    // so count only the POSTs a tool call makes.
    const posts = () => events(s, 'http').filter((l) => l['method'] === 'POST');
    const before = posts().length;
    await call(s, 206);
    await vi.waitFor(() => expect(posts()).toHaveLength(before + 1));
    expect(posts().at(-1)).toMatchObject({
      method: 'POST',
      path: '/mcp',
      status: 200,
      ip: expect.stringMatching(/127\.0\.0\.1$/),
      duration_ms: expect.any(Number),
    });
    // Requests answered outside /mcp's handler are logged too: /healthz, and a Host rejection.
    await raw(s.url, { method: 'GET', path: '/healthz' });
    await raw(s.url, { method: 'POST', headers: { ...POST_HEADERS, Host: 'evil.example' }, body: PING });
    const matching = (m: Record<string, unknown>) =>
      events(s, 'http').filter((l) => Object.entries(m).every(([k, v]) => l[k] === v));
    await vi.waitFor(() => {
      expect(matching({ method: 'GET', path: '/healthz', status: 200 })).toHaveLength(1);
      expect(matching({ method: 'POST', path: '/mcp', status: 403 })).toHaveLength(1);
    });
  });
});

describe('bad request bodies', () => {
  const noInternals = (body: string) => {
    expect(body).not.toMatch(/at \S+ \(/); // a stack frame: `at fn (file:line)`
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain('SyntaxError');
  };

  it('a malformed body is a JSON-RPC parse error, logged as JSON lines', async () => {
    const s = await start();
    const stderr = vi.spyOn(console, 'error');
    const r = await raw(s.url, { method: 'POST', headers: POST_HEADERS, body: '{not json' });
    expect(r.status).toBe(400);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(r.body)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    noInternals(r.body);
    await vi.waitFor(() =>
      expect(s.logs.filter((l) => l['event'] === 'http' && l['status'] === 400)).toHaveLength(1),
    );
    const errors = s.logs.filter((l) => l['event'] === 'http_error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: 'warn', type: 'entity.parse.failed', status: 400 });
    expect(Object.keys(errors[0]!).sort()).toEqual(['event', 'level', 'message', 'status', 'ts', 'type']);
    expect(JSON.stringify(errors[0])).not.toContain('{not json');
    // The logger's write captures each line through JSON.parse; check every line round-trips.
    for (const line of s.logs) expect(JSON.parse(JSON.stringify(line))).toEqual(line);
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('a parse error never logs the request body', async () => {
    // V8's JSON.parse message quotes the input: `Unexpected token 's', "{"a": secretvalue}" is not valid JSON`.
    const s = await start();
    const r = await raw(s.url, { method: 'POST', headers: POST_HEADERS, body: '{"a": secretvalue}' });
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('secretvalue');
    await vi.waitFor(() => expect(s.logs.filter((l) => l['event'] === 'http_error')).toHaveLength(1));
    expect(JSON.stringify(s.logs)).not.toContain('secretvalue');
  });

  it('a body over the JSON limit is 413 with a JSON-RPC error', async () => {
    const s = await start();
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(150_000) } });
    const r = await raw(s.url, { method: 'POST', headers: POST_HEADERS, body: big });
    expect(r.status).toBe(413);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(r.body)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Request body too large' },
    });
    noInternals(r.body);
    await vi.waitFor(() =>
      expect(s.logs.filter((l) => l['event'] === 'http' && l['status'] === 413)).toHaveLength(1),
    );
    expect(s.logs.filter((l) => l['event'] === 'http_error')).toMatchObject([
      { level: 'warn', type: 'entity.too.large', status: 413 },
    ]);
  });
});

describe('proxy', () => {
  it('a client-supplied X-Forwarded-For entry is not trusted', async () => {
    const s = await start({}, {}, false);
    await raw(s.url, {
      method: 'POST',
      headers: { ...POST_HEADERS, 'X-Forwarded-For': '203.0.113.5, 198.51.100.7' },
      body: PING,
    });
    await vi.waitFor(() =>
      expect(s.logs.filter((l) => l['event'] === 'http')).toMatchObject([
        { method: 'POST', path: '/mcp', ip: '198.51.100.7' },
      ]),
    );
  });
});

describe('entry point', () => {
  it('a configuration error is one line on stderr and exit code 1', () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env['PUBLIC_URL'];
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('config error: PUBLIC_URL: is required\n');
    expect(r.stdout).toBe('');
  });
});
