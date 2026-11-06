import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { TlcmapError, toToolErrorResult } from '../errors.js';
import type { Logger } from '../log.js';
import type { PageService } from '../pages/service.js';
import type { CacheOutcome } from '../provenance.js';

const fetchPart = {
  request: z.string(),
  fetched_at: z.string(),
  cache: z.enum(['miss', 'hit', 'shared']),
  sha256: z.string(),
  bytes: z.number().int(),
  server: z.string(),
};

/** Provenance names either the records or the layers a response was drawn from. */
export const provenanceSchema = z.union([
  z.object({ ...fetchPart, record_uids: z.array(z.string()) }),
  z.object({ ...fetchPart, layer_ids: z.array(z.number().int()) }),
]);

export const layerIdSchema = z.number().int().min(1).max(2147483647);

export interface ToolDeps {
  pages: PageService;
  baseUrl: URL;
  logger: Logger;
}

/** Runs a tool body with one `tool` log event; a TlcmapError becomes an isError result. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  logger: Logger,
  body: () => Promise<{ structured: Record<string, unknown>; cache: CacheOutcome }>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const { structured, cache } = await body();
    logger.log('info', 'tool', {
      tool: name,
      arguments: args,
      outcome: 'ok',
      cache,
      duration_ms: Date.now() - started,
    });
    return { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(structured) }] };
  } catch (e) {
    if (!(e instanceof TlcmapError)) throw e;
    logger.log('warn', 'tool', {
      tool: name,
      arguments: args,
      outcome: e.code,
      duration_ms: Date.now() - started,
    });
    return toToolErrorResult(e);
  }
}
