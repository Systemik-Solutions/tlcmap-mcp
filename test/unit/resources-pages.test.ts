import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Logger } from '../../src/log.js';
import { registerEnabled } from '../../src/mcp/scopes.js';
import { createPageService, type PageService } from '../../src/pages/service.js';
import { layerPageUri, pageResources, searchPageUri } from '../../src/resources/pages.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import { Limiter } from '../../src/upstream/limiter.js';
import { layerFeaturesResponse, parseV2, withoutFeatures } from '../../src/v2/schemas.js';
import { SERVER_ID } from '../../src/version.js';
import { fixtureFetch, v2Bytes } from '../helpers/v2-fixtures.js';

const BASE = 'http://tlcmap-ghap.laragon.local';
type ErrShape = { data?: { code: string; details: Record<string, unknown> } };

let pages: PageService;
let client: Client;
let server: McpServer;
let uri: string;
let sha: string;

beforeEach(async () => {
  const logger: Logger = { log: () => {} };
  pages = createPageService({
    client: createUpstreamClient({ timeoutMs: 5000, maxBytes: 50_000_000, userAgent: 'test', fetch: fixtureFetch() }),
    limiter: new Limiter({ concurrency: 4, queueMax: 8, queueTimeoutMs: 1000 }),
    cache: { maxBytes: 50_000_000, ttlMs: 60_000 },
    serverId: SERVER_ID,
    logger,
  });
  const { entry } = await pages.fetch({
    url: new URL(`${BASE}/api/v2/layers/206/features?per_page=30`),
    parse: (body) => ({
      head: withoutFeatures(parseV2(body, layerFeaturesResponse)),
      ids: { layer_ids: [206] },
    }),
    resourceUri: (s) => layerPageUri(206, s),
  });
  sha = entry.provenance.sha256;
  uri = entry.resourceUri!;
  server = new McpServer({ name: 'test', version: '0.0.0' });
  registerEnabled(server, pageResources({ pages, logger }), ['read']);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(c);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

const readErr = async (u: string) => (await client.readResource({ uri: u }).catch((e: unknown) => e)) as ErrShape;

describe('page resources', () => {
  test('reads a held page with provenance', async () => {
    const r = (await client.readResource({ uri })) as unknown as {
      contents: { uri: string; mimeType: string; text: string }[];
      _meta: { provenance: Record<string, unknown> };
    };
    expect(r.contents[0]?.text).toBe(v2Bytes('layer-206-features-p1.json').toString('utf8'));
    expect(r.contents[0]?.mimeType).toBe('application/json');
    expect(r._meta.provenance).toMatchObject({ cache: 'hit', sha256: sha });
  });

  test('lists exactly the two templates and no resources', async () => {
    expect((await client.listResources()).resources).toEqual([]);
    const t = (await client.listResourceTemplates()).resourceTemplates.map((x) => x.uriTemplate);
    expect(t.sort()).toEqual(['tlcmap://layer/{id}/features/{sha256}', 'tlcmap://search/{sha256}']);
  });

  test('a well-formed URI not held is RESOURCE_EXPIRED naming the tool', async () => {
    const other = 'a'.repeat(64);
    const l = await readErr(layerPageUri(206, other));
    expect(l.data?.code).toBe('RESOURCE_EXPIRED');
    expect(l.data?.details.tool).toBe('tlcmap_get_layer');
    const s = await readErr(searchPageUri(other));
    expect(s.data?.code).toBe('RESOURCE_EXPIRED');
    expect(s.data?.details.tool).toBe('tlcmap_search_places');
  });

  test('the held hash under another layer id is RESOURCE_EXPIRED', async () => {
    expect((await readErr(`tlcmap://layer/207/features/${sha}`)).data?.code).toBe('RESOURCE_EXPIRED');
  });

  test.each([
    ['tlcmap://layer/007/features/H'],
    ['tlcmap://layer/0/features/H'],
    ['tlcmap://layer/-1/features/H'],
    ['tlcmap://layer/abc/features/H'],
    ['tlcmap://layer/2147483648/features/H'],
    [`tlcmap://layer/206/features/${'A'.repeat(64)}`],
    [`tlcmap://layer/206/features/${'a'.repeat(63)}`],
    ['tlcmap://layer/206/features/xyz'],
    [`tlcmap://search/${'A'.repeat(64)}`],
    ['tlcmap://search/xyz'],
  ])('rejects malformed %s', async (template) => {
    const peek = vi.spyOn(pages, 'peekResource');
    const e = await readErr(template.replace('/H', `/${sha}`));
    expect(e.data?.code).toBe('INVALID_ARGUMENT');
    expect(peek).not.toHaveBeenCalled();
  });
});
