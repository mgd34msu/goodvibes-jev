import type { MemoryPreparedAdd } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MemoryAddOptions, MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { AgentPersonaCreateInput, AgentPersonaUpdateInput, AgentPersonaRecord, AgentPersonaSnapshot } from '../agent/persona-registry.ts';
import { normalizeAgentSkillRequirements, type AgentSkillCreateInput, type AgentSkillUpdateInput, type AgentSkillRecord, type AgentSkillSnapshot } from '../agent/skill-registry.ts';
import type { AgentRoutineCreateInput, AgentRoutineUpdateInput, AgentRoutineRecord, AgentRoutineSnapshot } from '../agent/routine-registry.ts';
import { captureCatalogData, captureCatalogSnapshotGuard } from './agent-harness-catalog-ranking.ts';

export type LearningTransitionIntent =
  | { readonly kind: 'create'; readonly domain: 'persona'; readonly input: AgentPersonaCreateInput }
  | { readonly kind: 'create'; readonly domain: 'skill'; readonly input: AgentSkillCreateInput }
  | { readonly kind: 'create'; readonly domain: 'routine'; readonly input: AgentRoutineCreateInput }
  | { readonly kind: 'create'; readonly domain: 'memory'; readonly input: MemoryAddOptions; readonly preparedRecord: MemoryPreparedAdd['record'] }
  | { readonly kind: 'update'; readonly domain: 'persona'; readonly id: string; readonly input: AgentPersonaUpdateInput }
  | { readonly kind: 'update'; readonly domain: 'skill'; readonly id: string; readonly input: AgentSkillUpdateInput }
  | { readonly kind: 'update'; readonly domain: 'routine'; readonly id: string; readonly input: AgentRoutineUpdateInput }
  | { readonly kind: 'stale'; readonly domain: 'persona' | 'skill' | 'routine'; readonly id: string; readonly reason: string }
  | { readonly kind: 'delete'; readonly domain: 'persona' | 'skill' | 'routine'; readonly id: string };

export interface LearningSourceTransition {
  readonly effects: { readonly assertCurrent: () => void; readonly onEffect: (published?: boolean) => void };
  readonly commit: (record: unknown) => void;
  readonly abort: () => void;
}

interface NativeState {
  readonly memoryRecords: readonly MemoryRecord[];
  readonly personaSnapshot: AgentPersonaSnapshot | undefined;
  readonly skillSnapshot: AgentSkillSnapshot | undefined;
  readonly routineSnapshot: AgentRoutineSnapshot | undefined;
}

type LocalRecord = AgentPersonaRecord | AgentSkillRecord | AgentRoutineRecord;
const held = (): never => { throw new ToolInputProjectionError('held'); };
const name = (value: string) => value.trim().replace(/\s+/g, ' ');
function list(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (values ?? []).map(value => value.trim()).filter(value => {
    if (!value || seen.has(value.toLowerCase())) return false;
    seen.add(value.toLowerCase()); return true;
  });
}
function nextId(value: string, records: readonly LocalRecord[], domain: string): string {
  const base = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || domain;
  const ids = new Set(records.map(record => record.id));
  if (!ids.has(base)) return base;
  for (let index = 2; index < 1000; index++) if (!ids.has(`${base}-${index}`)) return `${base}-${index}`;
  return held();
}
function timestamp(record: unknown, earliest: number): string {
  const captured = captureCatalogData(record);
  if (!captured || typeof captured !== 'object' || !('updatedAt' in captured) || typeof captured.updatedAt !== 'string') return held();
  const value = captured.updatedAt, time = Date.parse(value);
  if (!Number.isFinite(time) || time < earliest || time > Date.now() || new Date(time).toISOString() !== value) return held();
  return value;
}
function replace<T extends LocalRecord>(records: readonly T[], intent: LearningTransitionIntent, record: T): readonly T[] {
  if (intent.kind === 'create') return [...records, record];
  if (intent.kind === 'delete') return records.filter(existing => existing.id !== intent.id);
  return records.map(existing => existing.id === intent.id ? record : existing);
}
function original<T extends LocalRecord>(records: readonly T[], intent: LearningTransitionIntent): T {
  if (intent.kind === 'create') return held();
  return records.find(record => record.id === intent.id) ?? held();
}
/** Predict only native mechanical normalization. Semantic choices are already settled. */
export function prepareLearningNativeTransition(state: NativeState, intent: LearningTransitionIntent) {
  const earliest = Date.now();
  if (intent.domain === 'memory') {
    const record = intent.preparedRecord, input = intent.input;
    const confidence = Math.max(0, Math.min(100, Math.round(input.review?.confidence ?? 60)));
    const expected: MemoryRecord = {
      id: record.id, scope: input.scope ?? 'project', cls: input.cls, summary: input.summary,
      ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
      tags: input.tags ?? [], provenance: input.provenance ?? [],
      reviewState: input.review?.state ?? 'fresh', confidence,
      ...(input.review?.reviewedAt !== undefined ? { reviewedAt: input.review.reviewedAt } : {}),
      ...(input.review?.reviewedBy?.trim() ? { reviewedBy: input.review.reviewedBy.trim() } : {}),
      ...(input.review?.staleReason?.trim() ? { staleReason: input.review.staleReason.trim() } : {}),
      createdAt: record.createdAt, updatedAt: record.createdAt,
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    };
    if (!Number.isFinite(record.createdAt) || record.createdAt > earliest || !/^mem_[a-z0-9]+_[a-f0-9]{8}$/.test(record.id)
      || state.memoryRecords.some(existing => existing.id === record.id)) return held();
    captureCatalogSnapshotGuard(expected)(record);
    const mutable: MemoryRecord = { ...record, tags: [...record.tags], provenance: record.provenance.map(link => ({ ...link })) };
    const flagged = (record: MemoryRecord) => record.reviewState === 'stale' || record.reviewState === 'contradicted';
    return (returned: unknown) => {
      captureCatalogSnapshotGuard(record)(returned);
      return { domain: 'memory' as const,
        memoryRecords: [...state.memoryRecords, mutable].sort((left, right) => Number(flagged(left)) - Number(flagged(right)) || right.confidence - left.confidence || right.updatedAt - left.updatedAt || right.createdAt - left.createdAt) };
    };
  }
  if (intent.domain === 'persona') {
    const snapshot = state.personaSnapshot ?? held();
    return (returned: unknown) => {
      const updatedAt = intent.kind === 'delete' ? '' : timestamp(returned, earliest);
      let record: AgentPersonaRecord;
      if (intent.kind === 'create') {
        const input = intent.input;
        record = { id: nextId(input.name, snapshot.personas, 'persona'), name: name(input.name), description: input.description.trim(), body: input.body.trim(),
          tags: list(input.tags), triggers: list(input.triggers), source: input.source ?? 'user', provenance: input.provenance?.trim() || input.source || 'user',
          reviewState: 'fresh', createdAt: updatedAt, updatedAt };
      } else {
        const existing = original(snapshot.personas, intent);
        if (intent.kind === 'update') {
          const input = intent.input;
          record = { ...existing, name: input.name === undefined ? existing.name : name(input.name), description: input.description === undefined ? existing.description : input.description.trim(),
            body: input.body === undefined ? existing.body : input.body.trim(), tags: input.tags === undefined ? existing.tags : list(input.tags),
            triggers: input.triggers === undefined ? existing.triggers : list(input.triggers), provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
            reviewState: 'fresh', staleReason: undefined, reviewedAt: undefined, updatedAt };
        } else record = intent.kind === 'delete' ? existing : { ...existing, reviewState: 'stale', staleReason: intent.reason.trim() || 'Marked stale by user.', updatedAt };
      }
      captureCatalogSnapshotGuard(record)(returned);
      const personas = replace(snapshot.personas, intent, record);
      const activePersonaId = intent.kind === 'delete' && snapshot.activePersonaId === intent.id ? null : snapshot.activePersonaId;
      return { domain: 'persona' as const, bytes: `${JSON.stringify({ version: 1, activePersonaId, personas }, null, 2)}\n` };
    };
  }
  if (intent.domain === 'skill') {
    const snapshot = state.skillSnapshot ?? held();
    return (returned: unknown) => {
      const updatedAt = intent.kind === 'delete' ? '' : timestamp(returned, earliest);
      let record: AgentSkillRecord;
      if (intent.kind === 'create') {
        const input = intent.input;
        record = { id: nextId(input.name, snapshot.skills, 'skill'), name: name(input.name), description: input.description.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(), procedure: input.procedure.trim(),
          triggers: list(input.triggers), tags: list(input.tags), requirements: normalizeAgentSkillRequirements(input.requirements), enabled: input.enabled === true,
          source: input.source ?? 'user', provenance: input.provenance?.trim() || input.source || 'user', reviewState: 'fresh', createdAt: updatedAt, updatedAt };
      } else {
        const existing = original(snapshot.skills, intent);
        if (intent.kind === 'update') {
          const input = intent.input;
          record = { ...existing, name: input.name === undefined ? existing.name : name(input.name), description: input.description === undefined ? existing.description : input.description.trim(),
            procedure: input.procedure === undefined ? existing.procedure : input.procedure.trim(), triggers: input.triggers === undefined ? existing.triggers : list(input.triggers),
            tags: input.tags === undefined ? existing.tags : list(input.tags), requirements: input.requirements === undefined ? existing.requirements : normalizeAgentSkillRequirements(input.requirements),
            provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
            reviewState: 'fresh', staleReason: undefined, reviewedAt: undefined, updatedAt };
        } else record = intent.kind === 'delete' ? existing : { ...existing, reviewState: 'stale', staleReason: intent.reason.trim() || 'Marked stale by user.', updatedAt };
      }
      captureCatalogSnapshotGuard(record)(returned);
      const skills = replace(snapshot.skills, intent, record);
      const bundles = intent.kind === 'delete' ? snapshot.bundles.map(bundle => ({ ...bundle, skillIds: bundle.skillIds.filter(id => id !== intent.id) })).filter(bundle => bundle.skillIds.length > 0) : snapshot.bundles;
      return { domain: 'skill' as const, bytes: `${JSON.stringify({ version: 1, skills, bundles }, null, 2)}\n` };
    };
  }
  const snapshot = state.routineSnapshot ?? held();
  return (returned: unknown) => {
    const updatedAt = intent.kind === 'delete' ? '' : timestamp(returned, earliest);
    let record: AgentRoutineRecord;
    if (intent.kind === 'create') {
      const input = intent.input;
      record = { id: nextId(input.name, snapshot.routines, 'routine'), name: name(input.name), description: input.description.trim(), steps: input.steps.trim(),
        triggers: list(input.triggers), tags: list(input.tags), requirements: normalizeAgentSkillRequirements(input.requirements), enabled: input.enabled === true,
        source: input.source ?? 'user', provenance: input.provenance?.trim() || input.source || 'user', reviewState: 'fresh', createdAt: updatedAt, updatedAt, startCount: 0 };
    } else {
      const existing = original(snapshot.routines, intent);
      if (intent.kind === 'update') {
        const input = intent.input;
        record = { ...existing, name: input.name === undefined ? existing.name : name(input.name), description: input.description === undefined ? existing.description : input.description.trim(),
          steps: input.steps === undefined ? existing.steps : input.steps.trim(), triggers: input.triggers === undefined ? existing.triggers : list(input.triggers),
          tags: input.tags === undefined ? existing.tags : list(input.tags), requirements: input.requirements === undefined ? existing.requirements : normalizeAgentSkillRequirements(input.requirements),
          provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
          reviewState: 'fresh', staleReason: undefined, reviewedAt: undefined, updatedAt };
      } else record = intent.kind === 'delete' ? existing : { ...existing, reviewState: 'stale', staleReason: intent.reason.trim() || 'Marked stale by user.', updatedAt };
    }
    captureCatalogSnapshotGuard(record)(returned);
    const routines = replace(snapshot.routines, intent, record);
    return { domain: 'routine' as const, bytes: `${JSON.stringify({ version: 1, routines }, null, 2)}\n` };
  };
}
