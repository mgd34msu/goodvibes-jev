import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ConfigManagerLike } from '../../runtime/sandbox/manager.js';
import { SandboxSessionRegistry } from '../../runtime/sandbox/session-registry.js';
import { requireSurfaceRoot } from '../../runtime/surface-root.js';
import type { Tool } from '../../types/tools.js';
import { REPL_TOOL_SCHEMA, type ReplToolInput } from './schema.js';

/**
 * Why every eval refuses. The only sandbox backend is local host execution,
 * which runs a command directly on the host and does not isolate what it runs,
 * so evaluating arbitrary code there would be evaluating it on the host. The
 * refusal is a fixed security boundary, not a judgment.
 */
export const REPL_NO_ISOLATING_BACKEND_ERROR =
  'REPL eval needs an isolating sandbox backend, and none is available: the only sandbox backend is local host execution (sandbox.vmBackend "local"), which does not isolate evaluated code.';

interface ReplHistoryEntry {
  readonly ts: number;
  readonly runtime: 'javascript' | 'typescript' | 'python' | 'sql' | 'graphql';
  readonly expression: string;
  readonly sessionId?: string | undefined;
  readonly backend?: string | undefined;
  readonly launchSummary?: string | undefined;
  readonly result?: string | undefined;
  readonly error?: string | undefined;
}

type ReplExecutionInput = ReplToolInput & {
  readonly workspaceRoot?: string | undefined;
};

export interface ReplToolOptions {
  readonly surfaceRoot: string;
}

function resolveHistoryPath(workspaceRoot: string, surfaceRoot: string): string {
  return join(workspaceRoot, '.goodvibes', surfaceRoot, 'repl-history.json');
}

async function loadHistory(historyPath: string): Promise<ReplHistoryEntry[]> {
  try {
    return JSON.parse(await readFile(historyPath, 'utf-8')) as ReplHistoryEntry[];
  } catch {
    return [];
  }
}

async function saveHistory(historyPath: string, entries: readonly ReplHistoryEntry[]): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
}

function mapRuntimeToSandboxProfile(runtime: NonNullable<ReplToolInput['runtime']>) {
  switch (runtime) {
    case 'javascript': return 'eval-js' as const;
    case 'typescript': return 'eval-ts' as const;
    case 'python': return 'eval-py' as const;
    case 'sql': return 'eval-sql' as const;
    case 'graphql': return 'eval-graphql' as const;
  }
}

export function createReplTool(
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  options: ReplToolOptions,
): Tool {
  const surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'ReplTool surfaceRoot');
  return {
    definition: {
      name: 'repl',
      description: REPL_TOOL_SCHEMA.description,
      parameters: REPL_TOOL_SCHEMA.parameters,
      sideEffects: ['exec', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as ReplExecutionInput;
      if (!input.workspaceRoot || input.workspaceRoot.trim().length === 0) {
        return { success: false, error: 'repl requires workspaceRoot.' };
      }
      const historyPath = resolveHistoryPath(input.workspaceRoot, surfaceRoot);
      const history = await loadHistory(historyPath);

      if (input.mode === 'history') {
        return { success: true, output: JSON.stringify({ count: history.length, history }) };
      }

      if (!input.expression) return { success: false, error: 'eval requires expression.' };
      const runtime = input.runtime ?? 'javascript';
      const sandboxSession = await sandboxSessionRegistry.start(
        mapRuntimeToSandboxProfile(runtime),
        `repl:${runtime}`,
        configManager,
      );
      await saveHistory(historyPath, [...history, {
        ts: Date.now(),
        runtime,
        expression: input.expression,
        sessionId: sandboxSession.id,
        backend: sandboxSession.resolvedBackend ?? sandboxSession.backend,
        launchSummary: sandboxSession.launchPlan?.summary,
        error: REPL_NO_ISOLATING_BACKEND_ERROR,
      }]);
      return { success: false, error: REPL_NO_ISOLATING_BACKEND_ERROR };
    },
  };
}
