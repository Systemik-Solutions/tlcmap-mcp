import { describe, expect, it } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import {
  catalogueResponse,
  checkFeaturesOfLayer,
  checkLayerIdentity,
  errorBodySchema,
  layerDetailResponse,
  layerFeaturesResponse,
  parseV2,
  placesResponse,
  placesSummaryOnlyResponse,
  withoutFeatures,
} from '../../src/v2/schemas.js';
import { MANIFEST, v2Bytes, v2Json } from '../helpers/v2-fixtures.js';

function schemaFor(path: string) {
  const url = new URL(path, 'http://x');
  const p = url.pathname;
  if (p === '/api/v2/places') {
    return url.searchParams.get('summary_only') === 'true' ? placesSummaryOnlyResponse : placesResponse;
  }
  if (p === '/api/v2/layers') return catalogueResponse;
  if (/^\/api\/v2\/layers\/\d+$/.test(p)) return layerDetailResponse;
  if (/^\/api\/v2\/layers\/\d+\/features$/.test(p)) return layerFeaturesResponse;
  throw new Error(`no schema for ${path}`);
}

function violation(fn: () => unknown): TlcmapError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TlcmapError);
    expect((e as TlcmapError).code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    return e as TlcmapError;
  }
  throw new Error('expected a throw');
}

type Obj = Record<string, Record<string, unknown>>;
type Feats = { features: { geometry: unknown; properties: Record<string, unknown> }[] };
const bytes = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');

describe('v2 fixtures', () => {
  for (const e of MANIFEST) {
    it(`${e.file} parses`, () => {
      const schema = e.status === 200 ? schemaFor(e.path) : errorBodySchema;
      expect(() => parseV2(v2Bytes(e.file), schema)).not.toThrow();
    });
  }
});

describe('parseV2', () => {
  it('keeps extra keys', () => {
    const doc = v2Json<Obj>('layer-206.json');
    doc.layer!.new_field = 1;
    const out = parseV2(bytes(doc), layerDetailResponse) as unknown as Obj;
    expect(out.layer!.new_field).toBe(1);
  });

  it('fails on a missing required key', () => {
    const doc = v2Json<Obj>('layer-206.json');
    delete doc.layer!.warning;
    const e = violation(() => parseV2(bytes(doc), layerDetailResponse));
    expect(String(e.details.expected)).toMatch(/^layer\.warning/);
  });

  it('fails on a wrong type', () => {
    const doc = v2Json<Obj>('layer-206.json');
    doc.summary!.total = '52';
    violation(() => parseV2(bytes(doc), layerDetailResponse));
  });

  it('rejects an empty feature id and accepts a null geometry', () => {
    const doc = v2Json<Feats>('layer-206-features.json');
    doc.features[0]!.properties.id = '';
    violation(() => parseV2(bytes(doc), layerFeaturesResponse));
    const ok = v2Json<Feats>('layer-206-features.json');
    ok.features[0]!.geometry = null;
    expect(() => parseV2(bytes(ok), layerFeaturesResponse)).not.toThrow();
  });

  it('keeps warning text verbatim', () => {
    expect(parseV2(v2Bytes('layer-206.json'), layerDetailResponse).layer.warning).toBe('None');
    expect(parseV2(v2Bytes('layer-472.json'), layerDetailResponse).layer.warning).toBe(
      '<p>Thus <strong>this</strong> is a <em>warning</em></p>',
    );
  });

  it('turns bad UTF-8 and non-JSON into contract violations', () => {
    expect(violation(() => parseV2(Buffer.from([0xff]), layerDetailResponse)).details.expected).toBe('UTF-8 JSON');
    violation(() => parseV2(Buffer.from('not json'), layerDetailResponse));
  });
});

describe('checks', () => {
  it('checkLayerIdentity', () => {
    expect(() => checkLayerIdentity({ id: 206 }, 206)).not.toThrow();
    const e = violation(() => checkLayerIdentity({ id: 206 }, 207));
    expect(e.details.expected).toBe('layer.id to equal 207');
  });

  it('checkFeaturesOfLayer', () => {
    const f = (layer_id: number | null) => ({ properties: { layer_id } });
    expect(() => checkFeaturesOfLayer([f(206), f(206)], 206)).not.toThrow();
    for (const bad of [207, null]) {
      const e = violation(() => checkFeaturesOfLayer([f(206), f(bad)], 206));
      expect(e.details.expected).toBe('every feature to have layer_id 206');
    }
  });

  it('withoutFeatures drops features only, without mutating', () => {
    const doc = { a: 1, features: [1] };
    expect(withoutFeatures(doc)).toEqual({ a: 1 });
    expect(doc).toEqual({ a: 1, features: [1] });
  });
});
