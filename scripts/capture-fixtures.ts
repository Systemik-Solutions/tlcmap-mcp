// Captures production fixtures from tlcmap.org. Four sequential GETs, no retries.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { SERVER_VERSION } from '../src/version.js';

const USER_AGENT = `tlcmap-mcp/${SERVER_VERSION} (+https://test-mcp.tlcmap.org)`;
const dir = new URL('../test/fixtures/', import.meta.url);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function fetchLayer(id: number): Promise<{ url: string; body: Buffer; at: Date; status: number }> {
  const url = `https://tlcmap.org/layers/${id}/json`;
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  return { url, body: Buffer.from(await res.arrayBuffer()), at: new Date(), status: res.status };
}

function featureCount(body: Buffer): string {
  const j = JSON.parse(body.toString('utf8')) as { features?: unknown[] };
  return Array.isArray(j.features) ? String(j.features.length) : 'no `features` key';
}

await mkdir(dir, { recursive: true });
const notes: string[] = [
  '# Captured fixtures',
  '',
  `Captured by \`npm run capture-fixtures\` with User-Agent \`${USER_AGENT}\`.`,
  'Bytes are stored exactly as received unless stated. Do not edit by hand.',
  '',
];

for (const [id, file, trim] of [
  [206, 'layer-206.json', false],
  [1125, 'layer-1125.json', false],
  [2749, 'layer-2749-trimmed.json', true],
  [99999999, 'layer-missing.json', false],
] as const) {
  const r = await fetchLayer(id);
  let out = r.body;
  const lines = [`## ${file}`, '', `- URL: ${r.url}`, `- HTTP status: ${r.status}`, `- Captured (UTC): ${r.at.toISOString()}`];
  if (trim) {
    const feed = JSON.parse(r.body.toString('utf8')) as { features: unknown[] };
    out = Buffer.from(JSON.stringify({ ...feed, features: feed.features.slice(0, 20) }) + '\n', 'utf8');
    lines.push(
      `- Original size: ${r.body.length} bytes, ${feed.features.length} features`,
      '- Trimming rule: `JSON.stringify({...feed, features: feed.features.slice(0, 20)})` plus a trailing newline',
      `- Trimmed features: 20`,
    );
  } else {
    lines.push(`- Features: ${featureCount(out)}`);
    if (id === 99999999) {
      lines.push('- Note: a missing layer is answered with HTTP 200, `metadata.warnnig` and an empty `features` array (not an absent key).');
    }
  }
  lines.push(`- Size: ${out.length} bytes`, `- sha256: ${sha256(out)}`, '');
  await writeFile(new URL(file, dir), out);
  notes.push(...lines);
  console.log(file, r.status, out.length);
}

await writeFile(new URL('CAPTURED.md', dir), notes.join('\n'));
