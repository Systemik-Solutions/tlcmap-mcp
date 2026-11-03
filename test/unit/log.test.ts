import { describe, expect, test } from 'vitest';
import { createLogger } from '../../src/log.js';

const fixed = () => new Date('2026-01-02T03:04:05.678Z');

function capture(level: Parameters<typeof createLogger>[0]) {
  const lines: string[] = [];
  return { lines, logger: createLogger(level, (l) => lines.push(l), fixed) };
}

describe('createLogger', () => {
  test('writes one JSON object per line with ts, level, event and fields', () => {
    const { lines, logger } = capture('info');
    logger.log('info', 'request', { status: 200 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0]!)).toEqual({ ts: '2026-01-02T03:04:05.678Z', level: 'info', event: 'request', status: 200 });
  });

  test('omits lines below the configured level', () => {
    const { lines, logger } = capture('warn');
    logger.log('debug', 'a');
    logger.log('info', 'b');
    logger.log('warn', 'c');
    logger.log('error', 'd');
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(['c', 'd']);
  });

  test('writes unserialisable values as strings rather than throwing', () => {
    const { lines, logger } = capture('info');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => logger.log('info', 'odd', { big: 10n, cycle })).not.toThrow();
    const out = JSON.parse(lines[0]!);
    expect(out.event).toBe('odd');
    expect(out.big).toBe('10');
    expect(typeof out.cycle).toBe('string');
  });

  test('default writer appends a newline to stdout', () => {
    const chunks: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      createLogger('info', undefined, fixed).log('info', 'x');
    } finally {
      process.stdout.write = orig;
    }
    expect(chunks.join('')).toMatch(/^\{.*\}\n$/);
  });
});
