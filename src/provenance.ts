import { createHash } from 'node:crypto';
import type { UpstreamResponse } from './upstream/client.js';

export type CacheOutcome = 'miss' | 'hit' | 'shared';

export type Ids = { record_uids: string[] } | { layer_ids: number[] };

/** What is true of the fetch itself; `cache` describes one particular call and is added per call. */
export type FetchProvenance = {
  request: string;
  fetched_at: string;
  sha256: string;
  bytes: number;
  server: string;
} & Ids;

export type Provenance = FetchProvenance & { cache: CacheOutcome };

export function buildProvenance<I extends Ids>(
  r: UpstreamResponse,
  ids: I,
  server: string,
): FetchProvenance & I {
  const fetchPart = {
    request: `GET ${r.url}`,
    fetched_at: r.fetchedAt.toISOString(),
    sha256: createHash('sha256').update(r.body).digest('hex'),
    bytes: r.body.length,
    server,
  };
  return { ...fetchPart, ...ids } as FetchProvenance & I;
}
