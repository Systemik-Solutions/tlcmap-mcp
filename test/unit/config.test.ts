import { describe, expect, test } from 'vitest';
import { CONFIG_VARIABLES, ConfigError, loadConfig } from '../../src/config.js';

const base = { PUBLIC_URL: 'https://test-mcp.tlcmap.org' };

function expectConfigError(env: Record<string, string | undefined>, variable: string): void {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).variable).toBe(variable);
    expect((e as ConfigError).message.startsWith(variable)).toBe(true);
    return;
  }
  expect.unreachable('loadConfig did not throw');
}

describe('loadConfig', () => {
  test('defaults match spec §9', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 3100,
      scopes: ['read'],
      logLevel: 'info',
      rateLimitPerMin: 60,
      upstream: { concurrency: 4, queueMax: 20, queueTimeoutMs: 20000, timeoutMs: 60000, maxBytes: 67108864 },
      cache: { maxBytes: 1073741824, ttlMs: 3600000 },
    });
    expect(c.tlcmapBaseUrl.href).toBe('https://tlcmap.org/');
    expect(c.publicUrl.href).toBe('https://test-mcp.tlcmap.org/');
  });

  test('PUBLIC_URL is required', () => expectConfigError({}, 'PUBLIC_URL'));

  test('empty string counts as unset', () => {
    const c = loadConfig({ ...base, PORT: '', LOG_LEVEL: '', TLCMAP_MCP_SCOPES: '' });
    expect(c.port).toBe(3100);
    expect(c.logLevel).toBe('info');
    expect(c.scopes).toEqual(['read']);
    expectConfigError({ PUBLIC_URL: '' }, 'PUBLIC_URL');
  });

  test('reads overrides, converting CACHE_TTL_S to milliseconds', () => {
    const c = loadConfig({ ...base, PORT: '8080', CACHE_TTL_S: '10', LOG_LEVEL: 'debug', HOST: '0.0.0.0' });
    expect(c.port).toBe(8080);
    expect(c.cache.ttlMs).toBe(10000);
    expect(c.logLevel).toBe('debug');
    expect(c.host).toBe('0.0.0.0');
  });

  test.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '3.5'],
    ['UPSTREAM_CONCURRENCY', '0'],
    ['CACHE_TTL_S', '-1'],
    ['TLCMAP_BASE_URL', 'not a url'],
    ['LOG_LEVEL', 'loud'],
    ['TLCMAP_MCP_SCOPES', 'read,admin'],
  ])('rejects %s=%s', (k, v) => expectConfigError({ ...base, [k]: v }, k));

  test('write scope refuses to start', () =>
    expect(() => loadConfig({ ...base, TLCMAP_MCP_SCOPES: 'read,write' })).toThrow(/write tools require Phase E/));

  test('rejects CACHE_MAX_BYTES smaller than UPSTREAM_MAX_BYTES', () =>
    expectConfigError({ ...base, CACHE_MAX_BYTES: '1000', UPSTREAM_MAX_BYTES: '2000' }, 'CACHE_MAX_BYTES'));

  test('CONFIG_VARIABLES lists every variable', () =>
    expect([...CONFIG_VARIABLES].sort()).toEqual([
      'CACHE_MAX_BYTES', 'CACHE_TTL_S', 'HOST', 'LOG_LEVEL', 'PORT', 'PUBLIC_URL', 'RATE_LIMIT_PER_MIN',
      'TLCMAP_BASE_URL', 'TLCMAP_MCP_SCOPES', 'UPSTREAM_CONCURRENCY', 'UPSTREAM_MAX_BYTES',
      'UPSTREAM_QUEUE_MAX', 'UPSTREAM_QUEUE_TIMEOUT_MS', 'UPSTREAM_TIMEOUT_MS',
    ]));
});
