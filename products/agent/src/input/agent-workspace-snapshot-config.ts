// Small config-read helpers shared by agent-workspace-snapshot.ts and
// agent-workspace-snapshot-builders.ts (split out of the runtime-snapshot giant
// assembler). Each never throws: config reads fall back to the given default on any
// error, matching the original inline behavior exactly.
import type { CommandContext } from './command-registry.ts';
import { getAgentWorkspaceConfigReader } from './agent-workspace-config-reader.ts';

export function readConfigString(context: CommandContext, key: string, fallback: string): string {
  try {
    const configManager = getAgentWorkspaceConfigReader(context);
    const value = configManager?.get(key);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  } catch {
    return fallback;
  }
}

export function readConfigNumber(context: CommandContext, key: string, fallback: number): number {
  try {
    const configManager = getAgentWorkspaceConfigReader(context);
    const value = configManager?.get(key);
    const numberValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  } catch {
    return fallback;
  }
}

export function readConfigBoolean(context: CommandContext, key: string, fallback: boolean): boolean {
  try {
    const configManager = getAgentWorkspaceConfigReader(context);
    const value = configManager?.get(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
