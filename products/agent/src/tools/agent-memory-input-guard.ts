import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { containsSecretLikeText } from '../agent/memory-safety.ts';

const INSTALLED = Symbol.for('goodvibes-agent.memory-input-guard');
type GuardedRegistry = ToolRegistry & { [INSTALLED]?: true };

function containsProtectedText(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return containsSecretLikeText(value);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => containsSecretLikeText(key) || containsProtectedText(item, seen));
}

/** Protect the complete repair input, including malformed or spare arguments.
 * Tool.execute wrappers run too late: engine parameter repair precedes them.
 * Snapshot once so the inspected values are the ones repair and execution use.
 */
export function installAgentMemoryInputGuard(registry: ToolRegistry): void {
  const guarded = registry as GuardedRegistry;
  if (guarded[INSTALLED]) return;
  guarded[INSTALLED] = true;
  const execute = registry.execute.bind(registry);
  registry.execute = async (callId, name, args, options) => {
    if (name !== 'accounts' && name !== 'agent_local_registry') return execute(callId, name, args, options);
    if (options?.signal?.aborted) throw new DOMException('Memory action cancelled.', 'AbortError');
    let snapshot: Record<string, unknown>;
    try {
      snapshot = structuredClone(args);
      if (containsProtectedText(snapshot)) return { callId, success: false, error: 'Agent memory cannot store secret-looking values. Store the secret in the secret store and record only its key name.' };
    } catch {
      return { callId, success: false, error: 'Memory action requires plain serializable arguments.' };
    }
    return execute(callId, name, snapshot, options);
  };
}
