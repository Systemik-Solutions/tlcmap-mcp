import { describe, expect, it } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import { checkLayerIdentity, layerUrl } from '../../src/layers/service.js';
import { summariseLayerFeed } from '../../src/summarise/layer.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import { SERVER_VERSION } from '../../src/version.js';

// Runs by hand against production (`npm run test:prod`), never in CI. Three requests, one per test.
const BASE_URL = new URL('https://tlcmap.org');

const client = createUpstreamClient({
  timeoutMs: 60_000,
  maxBytes: 67_108_864,
  userAgent: `tlcmap-mcp/${SERVER_VERSION} (+https://test-mcp.tlcmap.org)`,
});

type Obj = Record<string, unknown>;

describe('production tlcmap.org compatibility', () => {
  it('layer 206 has the documented top-level shape and metadata', async () => {
    const response = await client.get(layerUrl(BASE_URL, 206));
    const feed = JSON.parse(response.body.toString('utf8')) as Obj;
    expect(Object.keys(feed)).toEqual(expect.arrayContaining(['type', 'metadata', 'features']));
    const metadata = feed['metadata'] as Obj;
    expect(Object.keys(metadata)).toEqual(expect.arrayContaining(['layer_id', 'name', 'warning']));
    const summary = summariseLayerFeed(response.body);
    expect(summary.record_count).toBeGreaterThan(0);
    checkLayerIdentity(summary, 206);
  });

  it('layer 1125 features carry string ids and numeric udates', async () => {
    const response = await client.get(layerUrl(BASE_URL, 1125));
    const feed = JSON.parse(response.body.toString('utf8')) as { features: { properties: Obj }[] };
    expect(feed.features.length).toBeGreaterThan(0);
    for (const feature of feed.features) {
      const id = feature.properties['id'];
      expect(typeof id).toBe('string');
      expect((id as string).length).toBeGreaterThan(0);
    }
    expect(
      feed.features.some(
        (f) => typeof f.properties['udatestart'] === 'number' && typeof f.properties['udateend'] === 'number',
      ),
    ).toBe(true);
  });

  // Fails when DESIGN.md §5.1 ② lands. Then expect client.get to throw LAYER_NOT_FOUND, and update spec §14.
  it('a missing layer is a 200 with an empty feed that fails the identity check', async () => {
    const response = await client.get(layerUrl(BASE_URL, 99999999));
    expect(response.status).toBe(200);
    const summary = summariseLayerFeed(response.body);
    expect(summary.record_count).toBe(0);
    let thrown: unknown;
    try {
      checkLayerIdentity(summary, 99999999);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TlcmapError);
    expect((thrown as TlcmapError).code).toBe('UPSTREAM_CONTRACT_VIOLATION');
  });
});
