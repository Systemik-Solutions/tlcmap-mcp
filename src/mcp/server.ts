import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Scope } from '../config.js';
import { pageResources } from '../resources/pages.js';
import { getLayerMetadataTool } from '../tools/get-layer-metadata.js';
import { getLayerTool } from '../tools/get-layer.js';
import type { ToolDeps } from '../tools/common.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { registerEnabled } from './scopes.js';

/** A fresh McpServer per request, closing over the long-lived services. */
export function createServerFactory(deps: ToolDeps & { scopes: Scope[] }): McpServerFactory {
  return () => {
    // The tool and resource lists never change while the process runs. Without these flags
    // the SDK advertises listChanged, and a 2026-07-28 client's subscriptions/listen would
    // hold an SSE stream open with keep-alives; with them the stream ends after its ack.
    const s = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } },
    );
    registerEnabled(s, [getLayerTool(deps), getLayerMetadataTool(deps), ...pageResources(deps)], deps.scopes);
    return s;
  };
}
