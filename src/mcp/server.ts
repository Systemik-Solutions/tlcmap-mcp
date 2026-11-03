import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Scope } from '../config.js';
import type { LayerService } from '../layers/service.js';
import type { Logger } from '../log.js';
import { layerFeaturesResource } from '../resources/layer-features.js';
import { getLayerTool } from '../tools/get-layer.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { registerEnabled } from './scopes.js';

/** A fresh McpServer per request, closing over the long-lived services. */
export function createServerFactory(deps: {
  layers: LayerService;
  logger: Logger;
  scopes: Scope[];
}): McpServerFactory {
  return () => {
    const s = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerEnabled(s, [getLayerTool(deps), layerFeaturesResource(deps)], deps.scopes);
    return s;
  };
}
