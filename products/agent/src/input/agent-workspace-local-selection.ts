import type {
  AgentWorkspaceActionResult,
  AgentWorkspaceLocalEditorKind,
  AgentWorkspaceLocalLibraryItem,
  AgentWorkspaceRuntimeSnapshot,
} from './agent-workspace-types.ts';

export type AgentWorkspaceLocalSelectionIndexes = Record<AgentWorkspaceLocalEditorKind, number>;

export interface AgentWorkspaceLocalSelectionHost {
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  readonly selectedLibraryItemIndexes: AgentWorkspaceLocalSelectionIndexes;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  selectedLocalLibraryItem(kind: AgentWorkspaceLocalEditorKind): AgentWorkspaceLocalLibraryItem | null;
}

export function agentWorkspaceLocalLibraryItems(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  kind: AgentWorkspaceLocalEditorKind,
): readonly AgentWorkspaceLocalLibraryItem[] {
  if (kind === 'memory') return snapshot?.localMemories ?? [];
  if (kind === 'note') return snapshot?.localNotes ?? [];
  if (kind === 'persona') return snapshot?.localPersonas ?? [];
  if (kind === 'skill') return snapshot?.localSkills ?? [];
  if (kind === 'profile') return [];
  return snapshot?.localRoutines ?? [];
}

export function selectedAgentWorkspaceLocalLibraryItem(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  indexes: AgentWorkspaceLocalSelectionIndexes,
  kind: AgentWorkspaceLocalEditorKind,
): AgentWorkspaceLocalLibraryItem | null {
  const items = agentWorkspaceLocalLibraryItems(snapshot, kind);
  if (items.length === 0) return null;
  const index = Math.max(0, Math.min(indexes[kind], items.length - 1));
  return items[index] ?? null;
}

export function clampAgentWorkspaceLocalLibrarySelection(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  indexes: AgentWorkspaceLocalSelectionIndexes,
  kind: AgentWorkspaceLocalEditorKind,
): void {
  const length = agentWorkspaceLocalLibraryItems(snapshot, kind).length;
  indexes[kind] = length === 0 ? 0 : Math.max(0, Math.min(indexes[kind], length - 1));
}

export function moveAgentWorkspaceLocalLibraryItemSelection(
  host: AgentWorkspaceLocalSelectionHost,
  kind: AgentWorkspaceLocalEditorKind,
  delta: number,
): void {
  const items = agentWorkspaceLocalLibraryItems(host.runtimeSnapshot, kind);
  if (items.length === 0) {
    host.status = `No local ${kind} records to select.`;
    host.lastActionResult = {
      kind: 'guidance',
      title: `No ${kind} records`,
      detail: `Create a local ${kind} before using selection actions.`,
      safety: 'safe',
    };
    return;
  }
  host.selectedLibraryItemIndexes[kind] = Math.max(0, Math.min(items.length - 1, host.selectedLibraryItemIndexes[kind] + delta));
  const selected = host.selectedLocalLibraryItem(kind);
  host.status = selected ? `Selected ${kind}: ${selected.name}.` : `Selected ${kind} updated.`;
  host.lastActionResult = {
    kind: 'guidance',
    title: selected ? `Selected ${selected.name}` : `Selected ${kind}`,
    detail: selected ? `${selected.name} (${selected.id}) is now the selected local ${kind}.` : `Selection changed for ${kind}.`,
    safety: 'safe',
  };
}
