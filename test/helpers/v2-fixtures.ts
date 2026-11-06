import { readFileSync } from 'node:fs';

export interface ManifestEntry {
  file: string;
  /** pathname + search of the request that captured the file. */
  path: string;
  status: number;
}

const dir = new URL('../fixtures/v2/', import.meta.url);

export const MANIFEST: readonly ManifestEntry[] = JSON.parse(
  readFileSync(new URL('manifest.json', dir), 'utf8'),
) as ManifestEntry[];

export function v2Bytes(file: string): Buffer {
  return readFileSync(new URL(file, dir));
}

export function v2Json<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(v2Bytes(file).toString('utf8')) as T;
}

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

type Override = { status: number; body: string | Buffer; headers?: Record<string, string> };

/** A fetch that serves the manifest by pathname + search; overrides win; unknown gives 404 with an empty body. */
export function fixtureFetch(overrides: Record<string, Override> = {}): typeof globalThis.fetch {
  const table = new Map<string, Override>();
  for (const e of MANIFEST) {
    table.set(e.path, { status: e.status, body: v2Bytes(e.file), headers: { 'Content-Type': JSON_CONTENT_TYPE } });
  }
  for (const [path, o] of Object.entries(overrides)) table.set(path, o);
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const hit = table.get(url.pathname + url.search);
    if (!hit) return new Response(null, { status: 404 });
    return new Response(typeof hit.body === 'string' ? hit.body : new Uint8Array(hit.body), { status: hit.status, headers: hit.headers ?? {} });
  }) as typeof globalThis.fetch;
}
