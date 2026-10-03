import type { CommandContext } from '../input/command-registry.ts';
import type { AgentVibeFile, BlockedAgentVibeFile } from '../agent/vibe-file.ts';
import { discoverVibeFiles } from '../agent/vibe-file.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessVibeHealthFile {
  readonly path: string;
  readonly scope: string;
  readonly truncated?: boolean;
}

export interface AgentHarnessVibeHealthBlockedFile {
  readonly path: string;
  readonly scope: string;
  readonly reason: string;
}

export interface AgentHarnessVibeHealth {
  readonly status: 'ready' | 'check' | 'recommended';
  readonly applied: number;
  readonly blocked: number;
  readonly truncated: number;
  readonly files: readonly AgentHarnessVibeHealthFile[];
  readonly blockedFiles: readonly AgentHarnessVibeHealthBlockedFile[];
  readonly searchedPaths: readonly string[];
  readonly projectInitPath: string;
  readonly globalInitPath: string;
  readonly nextAction: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly signals: readonly string[];
}

function describeVibeFile(file: AgentVibeFile): AgentHarnessVibeHealthFile {
  return {
    path: file.path,
    scope: file.scope,
    ...(file.truncated ? { truncated: true } : {}),
  };
}

function describeBlockedVibeFile(file: BlockedAgentVibeFile): AgentHarnessVibeHealthBlockedFile {
  return {
    path: file.path,
    scope: file.scope,
    reason: previewHarnessText(file.reason, 180),
  };
}

export function agentHarnessVibeHealth(context: CommandContext): AgentHarnessVibeHealth {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) {
    return {
      status: 'recommended',
      applied: 0,
      blocked: 0,
      truncated: 0,
      files: [],
      blockedFiles: [],
      searchedPaths: [],
      projectInitPath: '',
      globalInitPath: '',
      nextAction: 'VIBE.md discovery is unavailable because shell paths are not wired into this runtime.',
      userRoute: 'Agent Workspace -> Local Context -> Inspect VIBE.md; /vibe status',
      modelRoute: 'vibe action:"status"',
      signals: ['VIBE.md discovery unavailable: shell paths are not wired.'],
    };
  }
  const snapshot = discoverVibeFiles(shellPaths);
  const truncated = snapshot.files.filter((file) => file.truncated);
  const status = snapshot.blocked.length > 0 || truncated.length > 0
    ? 'check'
    : snapshot.files.length > 0
      ? 'ready'
      : 'recommended';
  const nextAction = snapshot.blocked.length > 0
    ? 'Run /vibe status, inspect blocked files, and edit or remove secret-looking content before relying on personality instructions.'
    : truncated.length > 0
      ? 'Run /vibe status and shorten the truncated VIBE.md file if the omitted content matters.'
      : snapshot.files.length > 0
        ? 'Review /vibe status when changing project or global personality instructions.'
        : 'Create a project VIBE.md or import a reviewed persona when the user wants a custom assistant feel.';
  const signals = [
    `applied VIBE.md files: ${snapshot.files.length}`,
    `blocked VIBE.md files: ${snapshot.blocked.length}`,
    `truncated VIBE.md files: ${truncated.length}`,
    ...(snapshot.files.slice(0, 3).map((file) => `${file.scope}: ${file.path}${file.truncated ? ' (truncated)' : ''}`)),
    ...(snapshot.blocked.slice(0, 3).map((file) => `blocked ${file.scope}: ${file.path} - ${previewHarnessText(file.reason, 96)}`)),
  ];
  return {
    status,
    applied: snapshot.files.length,
    blocked: snapshot.blocked.length,
    truncated: truncated.length,
    files: snapshot.files.map(describeVibeFile),
    blockedFiles: snapshot.blocked.map(describeBlockedVibeFile),
    searchedPaths: snapshot.searchedPaths,
    projectInitPath: snapshot.projectInitPath,
    globalInitPath: snapshot.globalInitPath,
    nextAction,
    userRoute: 'Agent Workspace -> Local Context -> Inspect VIBE.md; /vibe status',
    modelRoute: 'vibe action:"status"',
    signals,
  };
}
