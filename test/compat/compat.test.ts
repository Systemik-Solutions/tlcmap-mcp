import { describe, expect, it } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import { createUpstreamClient } from '../../src/upstream/client.js';
import {
  checkFeaturesOfLayer,
  checkLayerIdentity,
  layerDetailResponse,
  layerFeaturesResponse,
  parseV2,
} from '../../src/v2/schemas.js';
import { layerFeaturesUrl, layerUrl } from '../../src/v2/url.js';
import { SERVER_VERSION } from '../../src/version.js';

const base = new URL(process.env.TLCMAP_BASE_URL ?? 'https://tlcmap.org');
const client = createUpstreamClient({
  timeoutMs: 60_000,
  maxBytes: 20_000_000,
  userAgent: `tlcmap-mcp/${SERVER_VERSION} (+compat-check)`,
});

async function rejection(promise: Promise<unknown>): Promise<TlcmapError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TlcmapError);
    return e as TlcmapError;
  }
  throw new Error('expected the request to be rejected');
}

describe(`API v2 compatibility at ${base.origin}`, () => {
  it('serves layer 206 detail', async () => {
    const res = await client.get(layerUrl(base, 206));
    const doc = parseV2(res.body, layerDetailResponse);
    expect(doc.layer.id).toBe(206);
    expect(doc.layer.warning).toBe('None');
  });

  it('serves layer 206 features', async () => {
    const res = await client.get(layerFeaturesUrl(base, 206, { per_page: 5 }));
    const doc = parseV2(res.body, layerFeaturesResponse);
    checkLayerIdentity(doc.layer, 206);
    checkFeaturesOfLayer(doc.features, 206);
    for (const f of doc.features) {
      expect(typeof f.properties.id).toBe('string');
      expect(f.properties.id).not.toBe('');
    }
  });

  it('rejects an unknown layer with LAYER_NOT_FOUND', async () => {
    const e = await rejection(client.get(layerUrl(base, 99999999)));
    expect(e.code).toBe('LAYER_NOT_FOUND');
  });

  it('rejects per_page 0 with INVALID_PARAMETER', async () => {
    const e = await rejection(client.get(layerFeaturesUrl(base, 206, { per_page: 0 })));
    expect(e.code).toBe('INVALID_PARAMETER');
    expect(e.details).toMatchObject({ parameter: 'per_page' });
  });
});
