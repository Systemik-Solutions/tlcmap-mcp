import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import express, { type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config, Scope } from '../config.js';
import type { UpstreamStats } from '../layers/service.js';
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

  return { app, close: () => handler.close() };
}
