import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthBody } from '../../src/http/app.js';
import { summariseLayerFeed } from '../../src/summarise/layer.js';
import { SERVER_VERSION } from '../../src/version.js';
import type { FakeRoute } from '../fake-tlcmap.js';
import { startTestServer, type TestServer } from '../helpers/client.js';

const fixtureBytes = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const missingFixture = JSON.parse(fixtureBytes('layer-missing.json').toString('utf8')) as {
  metadata: Record<string, unknown>;
};
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown> & {
    metadata?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
};

let running: TestServer[] = [];

async function start(env?: Record<string, string>, routes?: Record<string, FakeRoute>, connect = true) {
  const s = await startTestServer(env, { routes, connect });
  running.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(running.map((s) => s.close()));
  running = [];
});

const call = async (s: TestServer, layer_id: number) =>
  (await s.client.callTool({ name: 'tlcmap_get_layer', arguments: { layer_id } })) as unknown as ToolResult;

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

describe('tlcmap_get_layer end to end', () => {
  it.each([
    [206, 'layer-206.json'],
    [1125, 'layer-1125.json'],
    [2749, 'layer-2749-trimmed.json'],
  ])('layer %i returns the summary of its fixture', async (id, file) => {
    const s = await start();
    const expected = summariseLayerFeed(fixtureBytes(file));
    const r = await call(s, id);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      layer_id: id,
      metadata: expected.metadata,
      record_count: expected.record_count,
      extent: expected.extent,
      date_range: expected.date_range,
      undated_count: expected.undated_count,
      ungeolocated_count: expected.ungeolocated_count,
      resource_uri: `tlcmap://layer/${id}/features`,
    });
    expect(s.fake.requests.map((q) => q.path)).toEqual([`/layers/${id}/json`]);
  });

  it('layer 1125 has 94 records, none undated, and a date range', async () => {
    const s = await start();
    const r = await call(s, 1125);
    expect(r.structuredContent).toMatchObject({ record_count: 94, undated_count: 0 });
    expect(r.structuredContent?.date_range).not.toBeNull();
  });

  it('layer 2749 carries its warning verbatim', async () => {
    const s = await start();
    const fixture = JSON.parse(fixtureBytes('layer-2749-trimmed.json').toString('utf8')) as {
      metadata: { warning: string };
    };
    const r = await call(s, 2749);
    expect(r.structuredContent?.metadata?.warning).toBe(fixture.metadata.warning);
  });

  it('the resource read hashes to the provenance sha256', async () => {
    const s = await start();
    const r = await call(s, 206);
    const uri = r.structuredContent?.resource_uri as string;
    const read = (await s.client.readResource({ uri })) as unknown as { contents: { text: string }[] };
    expect(sha256(read.contents[0]!.text)).toBe(r.structuredContent?.provenance?.sha256);
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

  it('a missing layer is a contract violation carrying the API metadata', async () => {
    const s = await start();
    const r = await call(s, 99999999);
    expect(r.isError).toBe(true);
    expect(errorCode(r)).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(r.structuredContent?.error?.details?.api_metadata).toEqual(missingFixture.metadata);
  });
});

describe('upstream failures', () => {
  it('a redirect is a contract violation', async () => {
    const s = await start({}, { '/layers/302/json': { status: 302, headers: { Location: '/elsewhere' } } });
    expect(errorCode(await call(s, 302))).toBe('UPSTREAM_CONTRACT_VIOLATION');
  });

  it('a 503 is upstream unavailable', async () => {
    const s = await start({}, { '/layers/503/json': { status: 503 } });
    expect(errorCode(await call(s, 503))).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('a slow response times out as upstream unavailable', async () => {
    const s = await start(
      { UPSTREAM_TIMEOUT_MS: '200' },
      { '/layers/7001/json': { delayMs: 1000, body: '{}' } },
    );
    expect(errorCode(await call(s, 7001))).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('an oversized response is too large', async () => {
    const s = await start(
      { UPSTREAM_MAX_BYTES: '1024', CACHE_MAX_BYTES: '1024' },
      { '/layers/7002/json': { streamBytes: 4096 } },
    );
    expect(errorCode(await call(s, 7002))).toBe('RESPONSE_TOO_LARGE');
  });

  it('a full upstream queue answers SERVER_BUSY', async () => {
    const slow: FakeRoute = { delayMs: 1000, body: '{}' };
    const s = await start(
      { UPSTREAM_CONCURRENCY: '1', UPSTREAM_QUEUE_MAX: '1' },
      { '/layers/8001/json': slow, '/layers/8002/json': slow, '/layers/8003/json': slow },
    );
    const first = call(s, 8001);
    await vi.waitFor(async () => expect((await health(s)).upstream.in_flight).toBe(1));
    const second = call(s, 8002);
    await vi.waitFor(async () => expect((await health(s)).upstream.queued).toBe(1));
    const third = await call(s, 8003);
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
    await call(s, 1125);
    const before = s.fake.requests.length;
    const h = await health(s);
    expect(Object.keys(h).sort()).toEqual(['cache', 'scopes', 'status', 'upstream', 'uptime_s', 'version']);
    expect(h).toMatchObject({ status: 'ok', version: SERVER_VERSION, scopes: ['read'] });
    expect(Number.isInteger(h.uptime_s)).toBe(true);
    expect(h.cache.entries).toBe(2);
    expect(h.cache.bytes).toBe(fixtureBytes('layer-206.json').length + fixtureBytes('layer-1125.json').length);
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
    expect(events(s, 'upstream')[0]).toMatchObject({ url: new URL('/layers/206/json', s.fake.baseUrl).href });
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
