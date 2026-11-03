import { TlcmapError } from '../errors.js';

export interface UpstreamResponse {
  url: string;
  status: number;
  body: Buffer;
  fetchedAt: Date;
  durationMs: number;
}

/** 2xx only; anything else throws a TlcmapError. */
export interface UpstreamClient {
  get(url: URL): Promise<UpstreamResponse>;
}

export interface UpstreamClientOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
}

class BodyTooLarge extends Error {
  constructor(readonly bytesRead: number) {
    super('body too large');
  }
}

async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function isTimeout(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
}

function reasonOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : undefined;
  return cause ? `${e.message} (${cause})` : e.message;
}

/**
 * Maps a non-2xx status to a typed error. The 403 and 404 codes are specific to the layer
 * endpoint (`/layers/{id}/json`), the only endpoint A0 calls; a later endpoint needs its own map.
 */
function errorForStatus(status: number, request: string, response: Response, body: Buffer): TlcmapError {
  const details: Record<string, unknown> = { request, status };
  if (status >= 300 && status < 400) {
    details.location = response.headers.get('location');
    return new TlcmapError(
      'UPSTREAM_CONTRACT_VIOLATION',
      `TLCMap answered with a redirect (HTTP ${status}), which the server does not follow.`,
      details,
    );
  }
  if (status === 403 || status === 404) {
    try {
      details.api_body = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      // Not JSON: no api_body.
    }
    return status === 403
      ? new TlcmapError('LAYER_PRIVATE', 'TLCMap reports that this layer is private (HTTP 403).', details)
      : new TlcmapError('LAYER_NOT_FOUND', 'TLCMap reports that this layer does not exist (HTTP 404).', details);
  }
  if (status === 429) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) details.retry_after = retryAfter;
    return new TlcmapError('UPSTREAM_UNAVAILABLE', 'TLCMap is rate limiting requests (HTTP 429).', details);
  }
  if (status >= 500) {
    return new TlcmapError('UPSTREAM_UNAVAILABLE', `TLCMap failed to respond properly (HTTP ${status}).`, details);
  }
  return new TlcmapError(
    'UPSTREAM_CONTRACT_VIOLATION',
    `TLCMap rejected the request (HTTP ${status}), which the server did not expect.`,
    details,
  );
}

export function createUpstreamClient(opts: UpstreamClientOptions): UpstreamClient {
  const doFetch = opts.fetch ?? globalThis.fetch;

  return {
    async get(url: URL): Promise<UpstreamResponse> {
      const request = `GET ${url.toString()}`;
      const started = performance.now();
      const signal = AbortSignal.timeout(opts.timeoutMs);
      const elapsed = (): number => Math.round(performance.now() - started);

      let response: Response;
      try {
        response = await doFetch(url, {
          redirect: 'manual',
          headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
          signal,
        });
      } catch (e) {
        const timedOut = isTimeout(e, signal);
        throw new TlcmapError(
          'UPSTREAM_UNAVAILABLE',
          timedOut
            ? `TLCMap did not respond within ${opts.timeoutMs} ms (request timed out).`
            : `Could not reach TLCMap: ${reasonOf(e)}.`,
          { request, elapsed_ms: elapsed() },
        );
      }

      const status = response.status;
      const ok = status >= 200 && status < 300;

      let body: Buffer;
      try {
        body = await readBody(response, opts.maxBytes);
      } catch (e) {
        // An unreadable error body is treated as absent; the status still decides the code.
        if (!ok) {
          body = Buffer.alloc(0);
        } else if (e instanceof BodyTooLarge) {
          throw new TlcmapError(
            'RESPONSE_TOO_LARGE',
            `The TLCMap response is larger than the ${opts.maxBytes}-byte limit.`,
            { request, limit: opts.maxBytes, bytes_read: e.bytesRead },
          );
        } else {
          throw new TlcmapError(
            'UPSTREAM_UNAVAILABLE',
            isTimeout(e, signal)
              ? `TLCMap did not finish sending the response within ${opts.timeoutMs} ms (request timed out).`
              : `The connection to TLCMap failed while reading the response: ${reasonOf(e)}.`,
            { request, status, elapsed_ms: elapsed() },
          );
        }
      }

      if (!ok) throw errorForStatus(status, request, response, body);
      return {
        url: url.toString(),
        status,
        body,
        fetchedAt: new Date(),
        durationMs: elapsed(),
      };
    },
  };
}
