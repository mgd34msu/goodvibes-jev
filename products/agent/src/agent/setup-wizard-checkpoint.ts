import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreFile } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

export type AgentSetupWizardCheckpointSource = 'workspace' | 'harness';

export interface AgentSetupWizardCheckpointRecord {
  readonly version: 1;
  readonly currentStepId: string;
  readonly currentStepLabel: string;
  readonly savedAt: string;
  readonly source: AgentSetupWizardCheckpointSource;
  readonly note?: string;
}

export interface AgentSetupWizardCheckpointSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly checkpoint: AgentSetupWizardCheckpointRecord | null;
  readonly parseError?: string;
}

export interface SaveAgentSetupWizardCheckpointInput {
  readonly currentStepId: string;
  readonly currentStepLabel: string;
  readonly source: AgentSetupWizardCheckpointSource;
  readonly note?: string;
}

type AgentSetupWizardCheckpointShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const CHECKPOINT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isCheckpointSource(value: unknown): value is AgentSetupWizardCheckpointSource {
  return value === 'workspace' || value === 'harness';
}

function normalizeStepId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
}

function parseCheckpoint(value: unknown): AgentSetupWizardCheckpointRecord | null {
  if (!isRecord(value) || value.version !== CHECKPOINT_VERSION) return null;
  const currentStepId = normalizeStepId(readString(value.currentStepId));
  const currentStepLabel = readString(value.currentStepLabel).replace(/\s+/g, ' ');
  const savedAt = readString(value.savedAt);
  if (!currentStepId || !currentStepLabel || !savedAt || Number.isNaN(Date.parse(savedAt))) return null;
  const source = isCheckpointSource(value.source) ? value.source : 'workspace';
  const note = readString(value.note);
  return {
    version: CHECKPOINT_VERSION,
    currentStepId,
    currentStepLabel,
    savedAt,
    source,
    ...(note ? { note } : {}),
  };
}

function formatCheckpoint(checkpoint: AgentSetupWizardCheckpointRecord): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

export function setupWizardCheckpointPath(shellPaths: AgentSetupWizardCheckpointShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'setup', 'wizard-checkpoint.json');
}

export function readSetupWizardCheckpoint(shellPaths: AgentSetupWizardCheckpointShellPaths): AgentSetupWizardCheckpointSnapshot {
  const path = setupWizardCheckpointPath(shellPaths);
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      checkpoint: null,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const checkpoint = parseCheckpoint(parsed);
    if (!checkpoint) {
      return {
        path,
        exists: true,
        checkpoint: null,
        parseError: 'Invalid setup wizard checkpoint payload.',
      };
    }
    return {
      path,
      exists: true,
      checkpoint,
    };
  } catch (error) {
    return {
      path,
      exists: true,
      checkpoint: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function saveSetupWizardCheckpoint(
  shellPaths: AgentSetupWizardCheckpointShellPaths,
  input: SaveAgentSetupWizardCheckpointInput,
): AgentSetupWizardCheckpointSnapshot {
  const currentStepId = normalizeStepId(input.currentStepId);
  const currentStepLabel = input.currentStepLabel.trim().replace(/\s+/g, ' ');
  if (!currentStepId) throw new Error('Setup wizard checkpoint requires a current step id.');
  if (!currentStepLabel) throw new Error('Setup wizard checkpoint requires a current step label.');
  const path = setupWizardCheckpointPath(shellPaths);
  const checkpoint: AgentSetupWizardCheckpointRecord = {
    version: CHECKPOINT_VERSION,
    currentStepId,
    currentStepLabel,
    savedAt: new Date().toISOString(),
    source: input.source,
    ...(input.note?.trim() ? { note: input.note.trim().replace(/\s+/g, ' ') } : {}),
  };
  writeStoreFile(path, formatCheckpoint(checkpoint));
  return readSetupWizardCheckpoint(shellPaths);
}

export function clearSetupWizardCheckpoint(shellPaths: AgentSetupWizardCheckpointShellPaths): AgentSetupWizardCheckpointSnapshot {
  const path = setupWizardCheckpointPath(shellPaths);
  if (existsSync(path)) rmSync(path, { force: true });
  return readSetupWizardCheckpoint(shellPaths);
}
