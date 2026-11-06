import { describe, expect, test } from 'vitest';
import {
  formatNumber,
  layerFeaturesUrl,
  layersUrl,
  layerUrl,
  placesUrl,
} from '../../src/v2/url.js';

const base = new URL('https://tlcmap.org/');

describe('v2 URL builder', () => {
  test('formatNumber writes plain decimals', () => {
    expect(formatNumber(150.8)).toBe('150.8');
    expect(formatNumber(-33.1)).toBe('-33.1');
    expect(formatNumber(0.0000001)).toBe('0.0000001');
    expect(formatNumber(-2.5e-7)).toBe('-0.00000025');
    expect(formatNumber(1.5e-10)).toBe('0.00000000015');
    expect(formatNumber(1e21)).toBe('1000000000000000000000');
    expect(formatNumber(-0)).toBe('0');
    expect(() => formatNumber(NaN)).toThrow(RangeError);
  });

  test('parameters follow v2 echo order whatever the input order', () => {
    expect(placesUrl(base, { per_page: 20, bbox: [150.8, -33.1, 151.4, -32.6] }).href).toBe(
      'https://tlcmap.org/api/v2/places?bbox=150.8,-33.1,151.4,-32.6&per_page=20',
    );
  });

  test('absent inputs are omitted; no query string when none given', () => {
    expect(layersUrl(base, { q: undefined }).href).toBe('https://tlcmap.org/api/v2/layers');
  });

  test('false is sent, not omitted', () => {
    expect(
      placesUrl(base, { date_from: '1820', include_undated: false, summary_only: false }).href,
    ).toBe('https://tlcmap.org/api/v2/places?date_from=1820&include_undated=false&summary_only=false');
  });

  test('lists join with literal commas; polygon vertices are "lon lat"', () => {
    expect(placesUrl(base, { sources: ['anps', 'ncg'], layers: [206, 258] }).search).toBe(
      '?sources=anps,ncg&layers=206,258',
    );
    expect(
      placesUrl(base, {
        polygon: [
          [0, 0],
          [1, 1],
          [0, 1],
          [1, 0],
        ],
      }).search,
    ).toBe('?polygon=0%200,1%201,0%201,1%200');
  });

  test('encodes non-ASCII, quotes and spaces once', () => {
    expect(placesUrl(base, { name: 'Ngunnawal – ‘Canberra’' }).search).toBe(
      '?name=Ngunnawal%20%E2%80%93%20%E2%80%98Canberra%E2%80%99',
    );
    expect(
      placesUrl(base, { extended_data: '"Years" > 50 AND Name textmatch \'a&b\'' }).search,
    ).toBe('?extended_data=%22Years%22%20%3E%2050%20AND%20Name%20textmatch%20%27a%26b%27');
  });

  test('a cursor passes through untouched', () => {
    expect(placesUrl(base, { cursor: 'eyJ2IjoxfQ' }).search).toBe('?cursor=eyJ2IjoxfQ');
  });

  test('trailing slashes on the base are removed', () => {
    expect(layerUrl(new URL('http://tlcmap-ghap.laragon.local///'), 206).href).toBe(
      'http://tlcmap-ghap.laragon.local/api/v2/layers/206',
    );
  });

  test('layer features path', () => {
    expect(layerFeaturesUrl(base, 206, { per_page: 30 }).href).toBe(
      'https://tlcmap.org/api/v2/layers/206/features?per_page=30',
    );
  });

  test('a parameter not in the endpoint order is a programming error', () => {
    expect(() => layersUrl(base, { nulls: 'last' })).toThrow();
  });
});
