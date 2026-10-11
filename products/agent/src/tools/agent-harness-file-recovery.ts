import { isAbsolute, relative } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { CommandContext } from '../input/command-registry.ts';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';

type FileRecoveryContext = Readonly<{ workspace: Readonly<Pick<CommandContext['workspace'], 'fileUndoManager'>> & {
  readonly shellPaths?: Readonly<Pick<NonNullable<CommandContext['workspace']['shellPaths']>, 'workingDirectory'>>;
} }>;

export interface AgentHarnessFileRecoveryArgs {
  readonly recoveryAction?: unknown;
  readonly actionId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

type FileRecoveryAction = 'undo' | 'redo';

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recoveryActionFromArgs(args: AgentHarnessFileRecoveryArgs): FileRecoveryAction | null {
  const input = readString(args.recoveryAction || args.actionId || args.target || args.query).toLowerCase();
  if (input === 'undo' || input === 'file undo' || input === 'undo file') return 'undo';
  if (input === 'redo' || input === 'file redo' || input === 'redo file') return 'redo';
  return null;
}

function workspacePath(context: FileRecoveryContext, filePath: string): string {
  const root = context.workspace?.shellPaths?.workingDirectory;
  if (!root) return filePath;
  const rel = relative(root, filePath);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  return '<outside-workspace>';
}

function managerStatus(context: FileRecoveryContext): {
  readonly available: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly nextUndo?: Record<string, unknown>;
} {
  const manager = context.workspace.fileUndoManager;
  if (!manager) return { available: false, undoDepth: 0, redoDepth: 0 };
  const nextUndo = manager.peekUndo();
  return {
    available: true,
    undoDepth: manager.undoDepth(),
    redoDepth: manager.redoDepth(),
    ...(nextUndo ? {
      nextUndo: {
        path: workspacePath(context, nextUndo.path),
        tool: nextUndo.tool,
        timestamp: nextUndo.timestamp,
      },
    } : {}),
  };
}

function recoveryActions(status: ReturnType<typeof managerStatus>): readonly Record<string, unknown>[] {
  return [
    {
      recoveryAction: 'undo',
      label: 'Undo last file edit/write',
      available: status.available && status.undoDepth > 0,
      modelRoute: 'agent_harness mode:"run_file_recovery"',
      requiresRecordedAdmission: true,
    },
    {
      recoveryAction: 'redo',
      label: 'Redo last undone file edit/write',
      available: status.available && status.redoDepth > 0,
      modelRoute: 'agent_harness mode:"run_file_recovery"',
      requiresRecordedAdmission: true,
    },
  ];
}

export function fileRecoveryCatalogStatus(context: FileRecoveryContext): Record<string, unknown> {
  const status = managerStatus(context);
  return {
    modes: ['file_recovery', 'run_file_recovery'],
    available: status.available,
    undoDepth: status.undoDepth,
    redoDepth: status.redoDepth,
    readOnly: true,
  };
}

export function fileRecoverySummary(context: FileRecoveryContext, args: AgentHarnessFileRecoveryArgs): Record<string, unknown> {
  const status = managerStatus(context);
  return {
    status: status.available ? 'available' : 'unavailable',
    summary: status,
    actions: recoveryActions(status),
    policy: 'Read-only file recovery posture. Recovery content is not exposed; run_file_recovery requires current recorded admission for the active workspace.',
    ...(args.includeParameters === true ? {
      modelAccess: {
        inspect: 'execution action:"recovery"',
        undo: 'agent_harness mode:"run_file_recovery" recoveryAction:"undo"',
        redo: 'agent_harness mode:"run_file_recovery" recoveryAction:"redo"',
      },
    } : {}),
  };
}

export function runFileRecovery(context: FileRecoveryContext, args: Record<string, unknown>, options?: Parameters<Tool['execute']>[1]): Record<string, unknown> {
  if (!harnessCatalogInvocationAuthority(args, options, 'write')) {
    return { status: 'held', error: 'File recovery requires current recorded effect admission.' };
  }
  const manager = context.workspace.fileUndoManager;
  if (!manager) {
    return {
      status: 'unavailable',
      error: 'No file recovery manager is available in this runtime.',
    };
  }
  const action = recoveryActionFromArgs(args);
  if (!action) {
    return {
      status: 'missing_action',
      usage: 'run_file_recovery requires recoveryAction:"undo" or recoveryAction:"redo". Use execution action:"recovery" first to inspect depth.',
    };
  }
  const next = action === 'undo' ? manager.peekUndo() : manager.peekRedo();
  if (!next) return { status: 'nothing_to_recover', recoveryAction: action, summary: managerStatus(context) };
  const root = context.workspace.shellPaths?.workingDirectory;
  if (!root) return { status: 'held', error: 'File recovery requires an active workspace.' };
  const captured = { ...next };
  if (!harnessCatalogInvocationAuthority(args, options, 'write')) {
    return { status: 'held', error: 'File recovery requires current recorded effect admission.' };
  }
  if (context.workspace.fileUndoManager !== manager || context.workspace.shellPaths?.workingDirectory !== root
    || (action === 'undo' ? manager.peekUndo() : manager.peekRedo()) !== next
    || next.path !== captured.path || next.tool !== captured.tool || next.timestamp !== captured.timestamp
    || next.beforeContent !== captured.beforeContent || next.afterContent !== captured.afterContent) {
    return { status: 'held', error: 'File recovery source or workspace changed.' };
  }
  try {
    const target = resolveAndValidatePath(captured.path, root);
    // A dangling symlink is absent to existsSync but writeFileSync follows it.
    // Inspect that final component independently before restoring any bytes.
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) realpathSync(target);
  } catch {
    return { status: 'held', error: 'File recovery target is outside or unavailable in the active workspace.' };
  }
  const result = action === 'undo' ? manager.undo() : manager.redo();
  if (!result) {
    return {
      status: 'nothing_to_recover',
      recoveryAction: action,
      summary: managerStatus(context),
    };
  }
  return {
    status: 'applied',
    recoveryAction: action,
    path: workspacePath(context, result.path),
    tool: result.tool,
    summary: managerStatus(context),
    policy: 'File recovery restored file bytes from the local FileUndoManager snapshot without exposing recovered content.',
  };
}
