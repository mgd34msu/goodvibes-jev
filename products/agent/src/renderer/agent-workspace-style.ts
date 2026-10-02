import type {
  AgentWorkspaceAction,
  AgentWorkspaceActionResult,
  AgentWorkspaceRuntimeSnapshot,
} from '../input/agent-workspace.ts';
import { WORKSPACE_PALETTE as PALETTE } from './fullscreen-workspace.ts';

export type AgentWorkspaceContextLine = {
  readonly text: string;
  readonly fg?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
};

export function safetyColor(action: AgentWorkspaceAction): string {
  if (action.safety === 'safe') return PALETTE.good;
  if (action.safety === 'read-only') return PALETTE.info;
  if (action.safety === 'delegates') return PALETTE.warn;
  return PALETTE.bad;
}

export function actionResultColor(result: AgentWorkspaceActionResult): string {
  if (result.kind === 'blocked' || result.kind === 'error') return PALETTE.bad;
  if (result.kind === 'dispatched') return PALETTE.info;
  if (result.kind === 'refreshed' || result.kind === 'recap') return PALETTE.good;
  return PALETTE.muted;
}

export function setupStatusColor(status: AgentWorkspaceRuntimeSnapshot['setupChecklist'][number]['status']): string {
  if (status === 'ready') return PALETTE.good;
  if (status === 'recommended') return PALETTE.warn;
  if (status === 'blocked') return PALETTE.bad;
  return PALETTE.muted;
}
