import * as z from 'zod';

export type Scope = 'read' | 'write';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  host: string;
  port: number;
  publicUrl: URL;
  tlcmapBaseUrl: URL;
  scopes: Scope[];
  logLevel: LogLevel;
  rateLimitPerMin: number;
  upstream: {
    concurrency: number;
    queueMax: number;
    queueTimeoutMs: number;
    timeoutMs: number;
    maxBytes: number;
  };
  cache: { maxBytes: number; ttlMs: number };
}

export class ConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

const positiveInt = z.coerce.number().int().min(1);
const port = z.coerce.number().int().min(1).max(65535);
const url = z.string().transform((s, ctx) => {
  try {
    return new URL(s);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' });
    return z.NEVER;
  }
});
const logLevel = z.enum(['debug', 'info', 'warn', 'error']);
const scopeList = z.string().transform((s, ctx) => {
  const parts = s.split(',').map((p) => p.trim()).filter((p) => p !== '');
  const bad = parts.find((p) => p !== 'read' && p !== 'write');
  if (bad !== undefined || parts.length === 0) {
    ctx.addIssue({ code: 'custom', message: `must be a comma list of read, write (got "${bad ?? s}")` });
    return z.NEVER;
  }
  return parts as Scope[];
});

interface Variable {
  schema: z.ZodType;
  default?: string;
}

const VARIABLES = {
  HOST: { schema: z.string().min(1), default: '127.0.0.1' },
  PORT: { schema: port, default: '3100' },
  PUBLIC_URL: { schema: url },
  TLCMAP_BASE_URL: { schema: url, default: 'https://tlcmap.org' },
  TLCMAP_MCP_SCOPES: { schema: scopeList, default: 'read' },
  LOG_LEVEL: { schema: logLevel, default: 'info' },
  RATE_LIMIT_PER_MIN: { schema: positiveInt, default: '60' },
  UPSTREAM_CONCURRENCY: { schema: positiveInt, default: '4' },
  UPSTREAM_QUEUE_MAX: { schema: positiveInt, default: '20' },
  UPSTREAM_QUEUE_TIMEOUT_MS: { schema: positiveInt, default: '20000' },
  UPSTREAM_TIMEOUT_MS: { schema: positiveInt, default: '60000' },
  UPSTREAM_MAX_BYTES: { schema: positiveInt, default: '67108864' },
  CACHE_MAX_BYTES: { schema: positiveInt, default: '1073741824' },
  CACHE_TTL_S: { schema: positiveInt, default: '3600' },
} satisfies Record<string, Variable>;

export const CONFIG_VARIABLES: readonly string[] = Object.keys(VARIABLES);

export function loadConfig(env: Record<string, string | undefined>): Config {
  const get = <T>(name: keyof typeof VARIABLES): T => {
    const spec: Variable = VARIABLES[name];
    const raw = env[name];
    const value = raw === undefined || raw === '' ? spec.default : raw;
    if (value === undefined) throw new ConfigError(name, 'is required');
    const parsed = spec.schema.safeParse(value);
    if (!parsed.success) {
      throw new ConfigError(name, parsed.error.issues.map((i) => i.message).join('; '));
    }
    return parsed.data as T;
  };

  const scopes = get<Scope[]>('TLCMAP_MCP_SCOPES');
  if (scopes.includes('write')) {
    throw new ConfigError(
      'TLCMAP_MCP_SCOPES',
      'write tools require Phase E token pass-through; enable read only',
    );
  }

  const upstreamMaxBytes = get<number>('UPSTREAM_MAX_BYTES');
  const cacheMaxBytes = get<number>('CACHE_MAX_BYTES');
  if (cacheMaxBytes < upstreamMaxBytes) {
    throw new ConfigError(
      'CACHE_MAX_BYTES',
      `must be at least UPSTREAM_MAX_BYTES (${upstreamMaxBytes}), or no upstream response could be cached`,
    );
  }

  return {
    host: get('HOST'),
    port: get('PORT'),
    publicUrl: get('PUBLIC_URL'),
    tlcmapBaseUrl: get('TLCMAP_BASE_URL'),
    scopes,
    logLevel: get('LOG_LEVEL'),
    rateLimitPerMin: get('RATE_LIMIT_PER_MIN'),
    upstream: {
      concurrency: get('UPSTREAM_CONCURRENCY'),
      queueMax: get('UPSTREAM_QUEUE_MAX'),
      queueTimeoutMs: get('UPSTREAM_QUEUE_TIMEOUT_MS'),
      timeoutMs: get('UPSTREAM_TIMEOUT_MS'),
      maxBytes: upstreamMaxBytes,
    },
    cache: { maxBytes: cacheMaxBytes, ttlMs: get<number>('CACHE_TTL_S') * 1000 },
  };
}
