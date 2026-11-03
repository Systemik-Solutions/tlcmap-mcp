import { createHash } from 'node:crypto';
import type { UpstreamResponse } from './upstream/client.js';

export type CacheOutcome = 'miss' | 'hit' | 'shared';

export interface Provenance {
  request: string;
  fetched_at: string;
  cache: CacheOutcome;
  sha256: string;
  bytes: number;
  record_uids: string[];
  server: string;
}

/** What is true of the fetch itself; `cache` describes one particular call and is added per call. */
export type FetchProvenance = Omit<Provenance, 'cache'>;

export function buildProvenance(
  r: UpstreamResponse,
  recordUids: string[],
  server: string,
): FetchProvenance {
  return {
    request: `GET ${r.url}`,
    fetched_at: r.fetchedAt.toISOString(),
    sha256: createHash('sha256').update(r.body).digest('hex'),
    bytes: r.body.length,
    record_uids: recordUids,
    server,
  };
}
