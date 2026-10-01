/**
 * settings-modal-mcp-entries.ts, the MCP trust rows the settings modal renders.
 *
 * A pure projection of `McpRegistry.listServerSecurity()`, copied out rather than
 * held by reference so an edit in the modal cannot reach back into the registry's
 * own arrays. Split out of settings-modal.ts, which is at the line cap
 * check-architecture.ts enforces, and it sits beside the subscription-entry
 * builder that was split out the same way.
 */
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { McpEntry } from './settings-modal-types.ts';

/** Empty with no registry wired, an honest "nothing to show", not a failure. */
export function buildMcpEntries(mcpRegistry: McpRegistry | null): McpEntry[] {
  if (!mcpRegistry) return [];
  return mcpRegistry.listServerSecurity().map((entry) => ({
    name: entry.name,
    connected: entry.connected,
    role: entry.role,
    trustMode: entry.trustMode,
    allowedPaths: [...entry.allowedPaths],
    allowedHosts: [...entry.allowedHosts],
  }));
}
