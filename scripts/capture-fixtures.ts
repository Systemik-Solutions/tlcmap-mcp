// Captures API v2 fixtures from a TLCMap application named by TLCMAP_BASE_URL.
// Sequential GETs, no retries. Bodies are stored byte for byte.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { SERVER_VERSION } from '../src/version.js';
import { layerFeaturesUrl, layersUrl, layerUrl, placesUrl } from '../src/v2/url.js';

const rawBase = process.env['TLCMAP_BASE_URL'];
if (!rawBase) {
  console.error('TLCMAP_BASE_URL is required (for example http://tlcmap-ghap.laragon.local). It has no default.');
  process.exit(1);
}
const base = new URL(rawBase);
const USER_AGENT = `tlcmap-mcp/${SERVER_VERSION} (+capture-fixtures)`;
const dir = new URL('../test/fixtures/v2/', import.meta.url);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface Captured {
  file: string;
  path: string;
  status: number;
  url: string;
  at: Date;
  size: number;
  sha: string;
  body: Buffer;
}
const captured: Captured[] = [];

async function capture(file: string, url: URL, expected: number): Promise<Buffer> {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  const body = Buffer.from(await res.arrayBuffer());
  const at = new Date();
  if (res.status !== expected) {
    console.error(`${file}: expected HTTP ${expected}, got ${res.status} for ${url.toString()}`);
    process.exit(1);
  }
  captured.push({ file, path: url.pathname + url.search, status: res.status, url: url.toString(), at, size: body.length, sha: sha256(body), body });
  console.log(file, res.status, body.length);
  return body;
}

const nextCursor = (body: Buffer, file: string): string => {
  const cursor = (JSON.parse(body.toString('utf8')) as { page?: { next_cursor?: unknown } }).page?.next_cursor;
  if (typeof cursor !== 'string') {
    console.error(`${file}: expected page.next_cursor to be a string`);
    process.exit(1);
  }
  return cursor;
};

const bbox: [number, number, number, number] = [150.8, -33.1, 151.4, -32.6];

await capture('layer-206.json', layerUrl(base, 206), 200);
await capture('layer-206-features.json', layerFeaturesUrl(base, 206, {}), 200);
const p1 = await capture('layer-206-features-p1.json', layerFeaturesUrl(base, 206, { per_page: 30 }), 200);
await capture(
  'layer-206-features-p2.json',
  layerFeaturesUrl(base, 206, { cursor: nextCursor(p1, 'layer-206-features-p1.json'), per_page: 30 }),
  200,
);
await capture('layer-258.json', layerUrl(base, 258), 200);
await capture('layer-258-features.json', layerFeaturesUrl(base, 258, {}), 200);
await capture('layer-472.json', layerUrl(base, 472), 200);
await capture('layer-257-features.json', layerFeaturesUrl(base, 257, {}), 200);
await capture('layer-33.json', layerUrl(base, 33), 403);
await capture('layer-99999999.json', layerUrl(base, 99999999), 404);
await capture('layers-hunter.json', layersUrl(base, { bbox }), 200);
const hunter = await capture('places-hunter.json', placesUrl(base, { bbox, per_page: 20 }), 200);
await capture('places-hunter-summary.json', placesUrl(base, { bbox, summary_only: true }), 200);
await capture('places-layers-33.json', placesUrl(base, { layers: [33] }), 403);
await capture('error-per-page.json', layerFeaturesUrl(base, 206, { per_page: 6000 }), 400);
await capture('error-filter.json', placesUrl(base, { extended_data: 'Years > many' }), 400);
await capture('error-geometry.json', placesUrl(base, { polygon: [[0, 0], [1, 1], [0, 1], [1, 0]] }), 400);
await capture(
  'error-cursor.json',
  placesUrl(base, { bbox: [150, -33, 151, -32], cursor: nextCursor(hunter, 'places-hunter.json'), per_page: 20 }),
  400,
);
await capture('route-not-found.json', new URL(`${base.origin}/api/v2/nowhere`), 404);

await mkdir(dir, { recursive: true });
for (const c of captured) await writeFile(new URL(c.file, dir), c.body);
await writeFile(
  new URL('manifest.json', dir),
  JSON.stringify(captured.map(({ file, path, status }) => ({ file, path, status })), null, 2) + '\n',
);

const notes: string[] = [
  '# Captured v2 fixtures',
  '',
  `Captured by \`npm run capture-fixtures\` from ${base.origin} with User-Agent \`${USER_AGENT}\`.`,
  '',
  'The data is the local `temp_tlcmap` database on the capture date. It is **not production data**.',
  'Bytes are stored exactly as received. Do not edit by hand.',
  '',
];
for (const c of captured) {
  notes.push(
    `## ${c.file}`,
    '',
    `- URL: ${c.url}`,
    `- HTTP status: ${c.status}`,
    `- Captured (UTC): ${c.at.toISOString()}`,
    `- Size: ${c.size} bytes`,
    `- sha256: ${c.sha}`,
    '',
  );
}
await writeFile(new URL('CAPTURED.md', dir), notes.join('\n'));
