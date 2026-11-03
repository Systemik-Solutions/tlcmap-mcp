import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { summariseLayerFeed } from '../../src/summarise/layer.js';

const dir = new URL('../fixtures/synthetic/', import.meta.url);
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(`${name}.json`, dir)));
const raw = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'));
const summarise = (name: string) => summariseLayerFeed(bytes(name));
const inline = (features: unknown[]) =>
  summariseLayerFeed(
    new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: {}, features })),
  );
const detailsOf = (fn: () => unknown): Record<string, unknown> => {
  try {
    fn();
  } catch (e) {
    return (e as { details: Record<string, unknown> }).details;
  }
  throw new Error('expected a throw');
};

describe('summariseLayerFeed', () => {
  test('extent covers every position of every geometry type', () =>
    expect(summarise('mixed-geometry').extent).toEqual([129, -38, 152, -11]));

  test('extent is null and ungeolocated counts when no geometry', () => {
    const s = summarise('no-geometry');
    expect(s.extent).toBeNull();
    expect(s.ungeolocated_count).toBe(3);
  });

  test('date_range takes min udatestart and max udateend, first in feed order on ties', () => {
    const s = summarise('dates');
    expect(s.date_range?.start).toEqual({ udate: 100, as_written: '1826-09-01' });
    expect(s.date_range?.end).toEqual({ udate: 900, as_written: '1900' });
  });

  test("as_written is the same record's datestart/dateend verbatim, or null if absent", () => {
    const s = inline([{ geometry: null, properties: { id: 'a', udatestart: 5, udateend: 9, dateend: '9 BC' } }]);
    expect(s.date_range).toEqual({
      start: { udate: 5, as_written: null },
      end: { udate: 9, as_written: '9 BC' },
    });
  });

  test('one-sided range: end null when no udateend anywhere', () => {
    const s = inline([{ geometry: null, properties: { id: 'a', udatestart: 5 } }]);
    expect(s.date_range).toEqual({ start: { udate: 5, as_written: null }, end: null });
    expect(s.undated_count).toBe(0);
  });

  test('date_range null and undated_count = record_count when no udate fields', () => {
    const s = summarise('no-geometry');
    expect(s.date_range).toBeNull();
    expect(s.undated_count).toBe(s.record_count);
  });

  test('undated_count counts records with neither bound', () => {
    expect(summarise('dates').undated_count).toBe(1);
  });

  test('empty layer: record_count 0, extent null, date_range null, record_uids []', () => {
    expect(summarise('empty')).toMatchObject({
      record_count: 0,
      extent: null,
      date_range: null,
      record_uids: [],
      undated_count: 0,
      ungeolocated_count: 0,
    });
  });

  test('empty MultiPoint is valid and contributes nothing', () => {
    const s = inline([{ geometry: { type: 'MultiPoint', coordinates: [] }, properties: { id: 'a' } }]);
    expect(s.extent).toBeNull();
    expect(s.record_count).toBe(1);
  });

  test('ungeolocated counts any record with no positions, wherever it falls in the feed', () => {
    const s = inline([
      { geometry: { type: 'Point', coordinates: [1, 2] }, properties: { id: 'a' } },
      { geometry: { type: 'MultiPoint', coordinates: [] }, properties: { id: 'b' } },
      { geometry: null, properties: { id: 'c' } },
    ]);
    expect(s.ungeolocated_count).toBe(2);
    expect(s.extent).toEqual([1, 2, 1, 2]);
  });

  test('metadata deep-equals the feed metadata, absent keys stay absent', () => {
    const s = summarise('dates');
    expect(s.metadata).toEqual(raw('dates').metadata);
    expect('license' in s.metadata).toBe(false);
  });

  test('record_uids are properties.id in feed order', () => {
    expect(summarise('dates').record_uids).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  describe('malformed features', () => {
    test.each([
      'not-json',
      'no-features',
      'features-not-array',
      'properties-null',
      'id-missing',
      'id-empty',
      'udatestart-string',
      'coordinates-missing',
      'coordinates-empty',
      'coordinate-not-number',
      'metadata-not-object',
    ])('%s is UPSTREAM_CONTRACT_VIOLATION', (name) => {
      expect(() => summarise(name)).toThrow(
        expect.objectContaining({ code: 'UPSTREAM_CONTRACT_VIOLATION' }),
      );
    });

    test('no-features passes on the API metadata verbatim in details.api_metadata', () => {
      expect(detailsOf(() => summarise('no-features')).api_metadata).toEqual(raw('no-features').metadata);
    });

    test('details name the faulty feature', () => {
      const d = detailsOf(() => summarise('id-missing'));
      expect(d.feature_index).toBe(0);
      expect(typeof d.expected).toBe('string');
    });

    test('invalid UTF-8 and unknown geometry type are violations', () => {
      expect(() => summariseLayerFeed(new Uint8Array([0xff, 0xfe]))).toThrow(
        expect.objectContaining({ code: 'UPSTREAM_CONTRACT_VIOLATION' }),
      );
      expect(() =>
        inline([{ geometry: { type: 'Circle', coordinates: [1, 2] }, properties: { id: 'a' } }]),
      ).toThrow(expect.objectContaining({ code: 'UPSTREAM_CONTRACT_VIOLATION' }));
    });
  });
});
