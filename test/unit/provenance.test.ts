import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProvenance } from '../../src/provenance.js';
import type { UpstreamResponse } from '../../src/upstream/client.js';

describe('buildProvenance', () => {
  it('describes the fetched bytes', () => {
    const body = readFileSync(new URL('../fixtures/layer-206.json', import.meta.url));
    const r: UpstreamResponse = {
      url: 'https://tlcmap.org/layers/206/json',
      status: 200,
      body,
      fetchedAt: new Date('2026-05-01T02:03:04.567Z'),
      durationMs: 12,
    };
    const p = buildProvenance(r, { record_uids: ['a', 'b'] }, 'tlcmap-mcp 0.1.0');
    expect(p).toEqual({
      request: 'GET https://tlcmap.org/layers/206/json',
      fetched_at: '2026-05-01T02:03:04.567Z',
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
      record_uids: ['a', 'b'],
      server: 'tlcmap-mcp 0.1.0',
    });
  });

  it('passes layer_ids through, and the envelope has exactly one of the two id lists', () => {
    const r: UpstreamResponse = {
      url: 'https://tlcmap.org/api/v2/layers?per_page=2',
      status: 200,
      body: Buffer.from('{}'),
      fetchedAt: new Date('2026-05-01T02:03:04.567Z'),
      durationMs: 1,
    };
    const layers = buildProvenance(r, { layer_ids: [206, 258] }, 's');
    expect(layers).toMatchObject({ layer_ids: [206, 258] });
    expect('record_uids' in layers).toBe(false);
    const records = buildProvenance(r, { record_uids: ['a'] }, 's');
    expect(records).toMatchObject({ record_uids: ['a'] });
    expect('layer_ids' in records).toBe(false);
  });
});
