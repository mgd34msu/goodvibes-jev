/**
 * LastSeenStore, persists the timestamp of the user's last TUI session.
 *
 * Used by the away-digest feature to know what happened since the user was
 * last present. Follows the same file-backed JSON pattern as the agent
 * registries (see src/agent/routine-registry.ts).
 *
 * File layout:
 *   { version: 1, lastSeenAt: <epoch-ms> }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

interface LastSeenFile {
  readonly version: 1;
  readonly lastSeenAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFile(raw: string): LastSeenFile | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed['version'] !== 1) return null;
    const ts = parsed['lastSeenAt'];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
    return { version: 1, lastSeenAt: ts };
  } catch {
    return null;
  }
}

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function lastSeenStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'last-seen.json');
}

export class LastSeenStore {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: AgentLocalStorePaths): LastSeenStore {
    return new LastSeenStore(lastSeenStorePath(shellPaths));
  }

  /**
   * Read the persisted lastSeenAt value.
   * Returns null when the file doesn't exist or is corrupt (first run).
   */
  public read(): number | null {
    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      return parseFile(raw)?.lastSeenAt ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Persist the current time as the new lastSeenAt.
   * Silently ignores write errors to avoid crashing on shutdown.
   */
  public save(at: number = Date.now()): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const data: LastSeenFile = { version: 1, lastSeenAt: at };
      writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Silently ignore, last-seen is a best-effort hint, not critical state.
    }
  }
}
