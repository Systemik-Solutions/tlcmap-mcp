import { afterEach, describe, expect, it } from 'vitest';
import { startFakeTlcmap, type FakeTlcmap } from '../fake-tlcmap.js';
import { MANIFEST, fixtureFetch, v2Bytes } from '../helpers/v2-fixtures.js';

let fake: FakeTlcmap | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function get(f: FakeTlcmap, path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(new URL(path, f.baseUrl));
  return { status: res.status, text: await res.text() };
}

describe('fake TLCMap routing', () => {
  it('serves a pathname + search route for exactly that query', async () => {
    fake = await startFakeTlcmap({
      '/api/v2/layers/206/features?per_page=30': { body: 'exact' },
      '/api/v2/layers/206/features': { body: 'pathname' },
    });
    expect((await get(fake, '/api/v2/layers/206/features?per_page=30')).text).toBe('exact');
    expect((await get(fake, '/api/v2/layers/206/features?per_page=31')).text).toBe('pathname');
  });

  it('serves a pathname-only route for any query', async () => {
    fake = await startFakeTlcmap({ '/api/v2/anything': { body: 'any' } });
    expect((await get(fake, '/api/v2/anything')).text).toBe('any');
    expect((await get(fake, '/api/v2/anything?x=1&y=2')).text).toBe('any');
  });

  it('serves every manifest entry by default with its status and JSON content type', async () => {
    fake = await startFakeTlcmap();
    expect(MANIFEST.length).toBe(19);
    for (const entry of MANIFEST) {
      const res = await fetch(new URL(entry.path, fake.baseUrl));
      expect(res.status, entry.file).toBe(entry.status);
      expect(res.headers.get('content-type'), entry.file).toBe('application/json; charset=utf-8');
      expect(Buffer.from(await res.arrayBuffer()).equals(v2Bytes(entry.file)), entry.file).toBe(true);
    }
  });

  it('fixtureFetch returns real Responses for the manifest, overrides and unknown paths', async () => {
    const f = fixtureFetch({ '/api/v2/x': { status: 500, body: 'boom' } });
    const e = MANIFEST[0]!;
    const ok = await f(new URL(e.path, 'http://example.invalid'));
    expect(ok.status).toBe(e.status);
    expect(ok.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(Buffer.from(await ok.arrayBuffer()).equals(v2Bytes(e.file))).toBe(true);
    const over = await f('http://example.invalid/api/v2/x');
    expect([over.status, await over.text()]).toEqual([500, 'boom']);
    const miss = await f('http://example.invalid/api/v2/none');
    expect([miss.status, await miss.text()]).toEqual([404, '']);
  });
});
