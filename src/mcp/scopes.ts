import type { McpServer } from '@modelcontextprotocol/server';
import type { Scope } from '../config.js';

/** One tool or resource, with the scope a deployment must enable for it to be registered. */
export interface Registration {
  scope: Scope;
  register(server: McpServer): void;
}

/**
 * Registers only what the enabled scopes allow. A disabled registration is never made, so it
 * does not appear in a listing at all rather than appearing and refusing.
 */
export function registerEnabled(
  server: McpServer,
  registrations: Registration[],
  enabled: Scope[],
): void {
  for (const r of registrations) {
    if (enabled.includes(r.scope)) r.register(server);
  }
}
