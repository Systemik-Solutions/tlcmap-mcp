import type { LogLevel } from './config.js';

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A field value that JSON cannot carry (a BigInt, a cycle) is written as a string. */
function safeValue(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserialisable]';
    }
  }
}

export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => Date = () => new Date(),
): Logger {
  return {
    log(lvl, event, fields = {}) {
      if (ORDER[lvl] < ORDER[level]) return;
      const record: Record<string, unknown> = { ts: now().toISOString(), level: lvl, event };
      for (const [k, v] of Object.entries(fields)) record[k] = safeValue(v);
      write(JSON.stringify(record));
    },
  };
}
