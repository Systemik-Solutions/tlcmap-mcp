import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { CONFIG_VARIABLES, loadConfig } from '../../src/config.js';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

test('deploy/env.example names every config variable and loads', () => {
  const parsed = parseEnv(readFileSync(new URL('../../deploy/env.example', import.meta.url), 'utf8'));
  expect(Object.keys(parsed).sort()).toEqual([...CONFIG_VARIABLES].sort());
  expect(loadConfig(parsed).publicUrl.href).toBe('https://test-mcp.tlcmap.org/');
});
