import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config, Scope } from '../config.js';
import type { UpstreamStats } from '../pages/service.js';
import type { Logger } from '../log.js';

export interface HealthBody {
  status: 'ok';
  version: string;
  uptime_s: number;
  scopes: Scope[];
  cache: { entries: number; bytes: number };
  upstream: UpstreamStats;
}

const jsonRpcError = (message: string) => ({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/** One `http` line per response, written when the response has been sent. */
function httpLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      logger.log('info', 'http', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ip: req.ip,
        duration_ms: Math.round(performance.now() - started),
      });
    });
    next();
  };
}

/**
 * The final error handler: a JSON-RPC error body and one `http_error` line. Never the stack,
 * the request body or a file path, in the response or the log.
 */
function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const type =
      typeof err === 'object' && err !== null && typeof (err as { type?: unknown }).type === 'string'
        ? (err as { type: string }).type
        : undefined;
    const [status, code, message] =
      type === 'entity.parse.failed'
        ? [400, -32700, 'Parse error']
        : type === 'entity.too.large'
          ? [413, -32600, 'Request body too large']
          : [500, -32603, 'Internal error'];
    // A JSON.parse message quotes the input, so a parse failure is logged with a fixed message.
    const logged =
      type === 'entity.parse.failed'
        ? 'The request body is not valid JSON.'
        : err instanceof Error
          ? err.message
          : String(err);
    logger.log(status === 500 ? 'error' : 'warn', 'http_error', {
      type: type ?? null,
      message: logged,
      status,
    });
    res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
  };
}

export function createApp(deps: {
  config: Config;
  factory: McpServerFactory;
  logger: Logger;
  health: () => HealthBody;
}): { app: Express; close(): Promise<void> } {
  const { config, factory, logger, health } = deps;
  const onerror = (error: Error): void => {
    logger.log('warn', 'mcp_error', { message: error.message });
  };

  // The outer app logs every request, including those the MCP app's Host and Origin
  // validation rejects before any route runs. The MCP app inherits its settings on mount.
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(httpLog(logger));

  const mcp = createMcpExpressApp({
    host: config.host,
    allowedHosts: [config.publicUrl.hostname, 'localhost', '127.0.0.1'],
  });
  app.use(mcp);

  mcp.get('/healthz', (_req, res) => {
    res.json(health());
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMin,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: jsonRpcError('Too many requests; try again later.'),
  });

  const handler = createMcpHandler(factory, { responseMode: 'json', onerror });
  const node = toNodeHandler(handler, { onerror });
  mcp.post('/mcp', limiter, (req, res) => node(req, res, req.body));

  const notAllowed: RequestHandler = (_req, res) => {
    res.status(405).set('Allow', 'POST').json(jsonRpcError('Method not allowed.'));
  };
  mcp.get('/mcp', notAllowed);
  mcp.delete('/mcp', notAllowed);

  app.use(errorHandler(logger));

  return { app, close: () => handler.close() };
}
