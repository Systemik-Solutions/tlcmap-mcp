import { TlcmapError, type ErrorCode } from '../errors.js';
import { errorBodySchema } from '../v2/schemas.js';

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

/** The v2 error codes that belong with a status; any other pairing is a contract violation. */
const ALLOWED_CODES: Record<number, readonly ErrorCode[]> = {
  400: ['INVALID_PARAMETER', 'INVALID_GEOMETRY', 'FILTER_REJECTED'],
  403: ['LAYER_PRIVATE'],
  404: ['LAYER_NOT_FOUND'],
};

/**
 * Maps a non-2xx status to a typed error. Redirects, 429 and 5xx are decided by status alone; any
 * other status is decided by status and v2's `error.code` together (spec §9.2).
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
  if (status === 429) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) details.retry_after = retryAfter;
    return new TlcmapError('UPSTREAM_UNAVAILABLE', 'TLCMap is rate limiting requests (HTTP 429).', details);
  }
  if (status >= 500) {
    return new TlcmapError('UPSTREAM_UNAVAILABLE', `TLCMap failed to respond properly (HTTP ${status}).`, details);
  }
  let parsedJson: unknown;
  let isJson = false;
  try {
    parsedJson = JSON.parse(body.toString('utf8'));
    isJson = true;
  } catch {
    // Not JSON: no api_body.
  }
  const parsed = isJson ? errorBodySchema.safeParse(parsedJson) : undefined;
  const v2Error = parsed?.success ? parsed.data.error : undefined;
  if (v2Error && ALLOWED_CODES[status]?.includes(v2Error.code as ErrorCode)) {
    return new TlcmapError(v2Error.code as ErrorCode, v2Error.message, { ...v2Error.details, request, status });
  }
  if (isJson) details.api_body = parsedJson;
  return new TlcmapError(
    'UPSTREAM_CONTRACT_VIOLATION',
    `TLCMap answered HTTP ${status}${v2Error ? ` ${v2Error.code}` : ''}, which the server did not expect.`,
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
