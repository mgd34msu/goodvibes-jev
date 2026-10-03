import type { CommandContext } from '../input/command-registry.ts';
import { isInvokableContractMethod, operatorContractMethods } from '../tools/agent-harness-personal-ops-discovery.ts';
import type { ProbeContext } from './capability-probe-runner.ts';

/**
 * Adapters that turn this app's live state into probe inputs.
 *
 * Each one fails closed and quietly: a source that cannot be read contributes
 * nothing rather than throwing, because a capability check must never be the
 * reason a session fails to start. What it must never do is turn "I could not
 * read this" into "this is not available" without saying so, that distinction
 * lives in the index, which reports an unresolved prerequisite with its reason.
 */

interface ConfigManagerLike {
  readonly get: (key: string) => unknown;
}

/**
 * Whether a config key holds a usable value.
 *
 * Returns a boolean and never the value itself, so a probe result can be shown
 * to the model or written to a log without leaking a password or a token.
 */
export function configValueIsPresent(configManager: unknown, key: string): boolean {
  const manager = configManager as ConfigManagerLike | null;
  if (!manager || typeof manager.get !== 'function') return false;
  try {
    const value = manager.get(key);
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
    return false;
  } catch {
    return false;
  }
}

/** Live MCP server posture, or nothing when this session has no MCP client. */
export function safeMcpServerPosture(context: CommandContext): ProbeContext['mcpServers'] {
  try {
    const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
    const servers = api?.listServerSecurity?.() ?? [];
    return servers.map((server) => ({
      name: server.name,
      connected: server.connected,
      trustMode: server.trustMode,
      schemaFreshness: server.schemaFreshness,
    }));
  } catch {
    return [];
  }
}

/**
 * Operator methods the daemon actually serves.
 *
 * The contract catalogs more methods than the daemon routes; the ones it does
 * not route carry invokable:false and cannot be called. Only served methods
 * count as a capability's invocation route, which is why every `email.*` entry
 * is correctly absent here today.
 */
export function servedOperatorMethodIds(): readonly string[] {
  try {
    return operatorContractMethods()
      .filter(isInvokableContractMethod)
      .map((method) => method.id);
  } catch {
    return [];
  }
}
