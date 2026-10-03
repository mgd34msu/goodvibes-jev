import { existsSync, readFileSync } from 'node:fs';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { writeStoreJson } from '@/utils/store-file.ts';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { MemoryBundle, MemoryRecord, MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { AgentPersonaRegistry, type AgentPersonaRecord } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry, type AgentRoutineRecord } from '../agent/routine-registry.ts';
import { AgentSkillRegistry, type AgentSkillRecord } from '../agent/skill-registry.ts';
import {
  resolveLearningConsolidationCandidate,
  type LearningCandidate,
  type LearningConsolidationFields,
} from './agent-harness-learning-curator.ts';

export type AgentLearningConsolidationMode = 'preview' | 'merge' | 'stale' | 'delete' | 'rollback' | 'recreate' | 'receipts';
export type AgentLearningConsolidationDomain = 'memory' | 'persona' | 'skill' | 'routine';
export type AgentLearningConsolidationWriteMode = 'merge' | 'stale' | 'delete' | 'rollback' | 'recreate';

export interface AgentLearningConsolidationToolArgs {
  readonly mode?: unknown;
  readonly candidateId?: unknown;
  readonly query?: unknown;
  readonly receiptId?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface LearningConsolidationReceipt {
  readonly id: string;
  readonly createdAt: string;
  readonly domain: AgentLearningConsolidationDomain;
  readonly candidateId: string;
  readonly phase: AgentLearningConsolidationWriteMode;
  readonly explicitUserRequest: string;
  readonly survivorId: string;
  readonly duplicateIds: readonly string[];
  readonly beforeSurvivor?: Record<string, unknown>;
  readonly beforeDuplicates: readonly Record<string, unknown>[];
}

export interface LearningConsolidationReceiptFile {
  readonly version: 1;
  readonly receipts: readonly LearningConsolidationReceipt[];
}

export const MODES: readonly AgentLearningConsolidationMode[] = ['preview', 'merge', 'stale', 'delete', 'rollback', 'recreate', 'receipts'];
export const WRITE_MODES = new Set<AgentLearningConsolidationMode>(['merge', 'stale', 'delete', 'rollback', 'recreate']);
export const RECEIPT_LIMIT = 100;
export const MEMORY_CLASSES = new Set(['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership']);
export const MEMORY_SCOPES = new Set(['session', 'project', 'team']);
export const MEMORY_REVIEW_STATES = new Set(['fresh', 'reviewed', 'stale', 'contradicted']);

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readMode(value: unknown): AgentLearningConsolidationMode {
  return typeof value === 'string' && MODES.includes(value as AgentLearningConsolidationMode)
    ? value as AgentLearningConsolidationMode
    : 'preview';
}

export function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(RECEIPT_LIMIT, Math.trunc(parsed)));
}

function slugifyForDomain(value: string, fallback: AgentLearningConsolidationDomain): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function nextGeneratedId(name: string, occupiedIds: Set<string>, fallback: AgentLearningConsolidationDomain): string {
  const base = slugifyForDomain(name, fallback);
  if (!occupiedIds.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!occupiedIds.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate ${fallback} id for ${name}.`);
}

export function output(value: unknown): { readonly success: true; readonly output: string } {
  return { success: true, output: JSON.stringify(value, null, 2) };
}

export function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

export function requireConfirmedWrite(args: AgentLearningConsolidationToolArgs, mode: AgentLearningConsolidationWriteMode): string {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) throw new Error(`${mode} requires explicitUserRequest with the user's exact request or a short faithful summary.`);
  if (args.confirm !== true) throw new Error(`${mode} requires confirm:true after an explicit user request.`);
  return explicitUserRequest;
}

function isDomain(value: string): value is AgentLearningConsolidationDomain {
  return value === 'memory' || value === 'persona' || value === 'skill' || value === 'routine';
}

export function receiptPath(shellPaths: ShellPathService): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'consolidation-receipts.json');
}

function parseReceipt(value: unknown): LearningConsolidationReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const createdAt = readString(record.createdAt);
  const domain = readString(record.domain);
  const candidateId = readString(record.candidateId);
  const phase = readString(record.phase);
  const explicitUserRequest = readString(record.explicitUserRequest);
  const survivorId = readString(record.survivorId);
  const duplicateIds = Array.isArray(record.duplicateIds)
    ? record.duplicateIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const beforeDuplicates = Array.isArray(record.beforeDuplicates)
    ? record.beforeDuplicates.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
  if (
    !id
    || !createdAt
    || !isDomain(domain)
    || !candidateId
    || !['merge', 'stale', 'delete', 'rollback', 'recreate'].includes(phase)
    || !explicitUserRequest
    || !survivorId
  ) return null;
  const beforeSurvivor = typeof record.beforeSurvivor === 'object' && record.beforeSurvivor !== null && !Array.isArray(record.beforeSurvivor)
    ? record.beforeSurvivor as Record<string, unknown>
    : undefined;
  return {
    id,
    createdAt,
    domain,
    candidateId,
    phase: phase as AgentLearningConsolidationWriteMode,
    explicitUserRequest,
    survivorId,
    duplicateIds,
    ...(beforeSurvivor ? { beforeSurvivor } : {}),
    beforeDuplicates,
  };
}

export function readReceiptFile(shellPaths: ShellPathService): LearningConsolidationReceiptFile {
  const path = receiptPath(shellPaths);
  if (!existsSync(path)) return { version: 1, receipts: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 1, receipts: [] };
    const receipts = Array.isArray((parsed as Record<string, unknown>).receipts)
      ? ((parsed as Record<string, unknown>).receipts as unknown[]).map(parseReceipt).filter((entry): entry is LearningConsolidationReceipt => entry !== null)
      : [];
    return { version: 1, receipts };
  } catch {
    return { version: 1, receipts: [] };
  }
}

export function writeReceipt(shellPaths: ShellPathService, receipt: LearningConsolidationReceipt): void {
  const path = receiptPath(shellPaths);
  const current = readReceiptFile(shellPaths).receipts;
  const next: LearningConsolidationReceiptFile = {
    version: 1,
    receipts: [receipt, ...current.filter((entry) => entry.id !== receipt.id)].slice(0, RECEIPT_LIMIT),
  };
  writeStoreJson(path, next);
}

export function receiptId(candidate: LearningCandidate, phase: AgentLearningConsolidationWriteMode): string {
  const slug = candidate.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'candidate';
  return `lcon-${phase}-${Date.now().toString(36)}-${slug}`;
}

export function receiptIdFromReceipt(receipt: LearningConsolidationReceipt, phase: AgentLearningConsolidationWriteMode): string {
  const slug = receipt.candidateId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'receipt';
  return `lcon-${phase}-${Date.now().toString(36)}-${slug}`;
}

function minimalContext(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry): CommandContext {
  return {
    workspace: { shellPaths },
    clients: { agentKnowledgeApi: { memory: memoryRegistry } },
  } as unknown as CommandContext;
}

export function resolveCandidate(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  args: AgentLearningConsolidationToolArgs,
): LearningCandidate {
  const input = readString(args.candidateId) || readString(args.query);
  const resolved = resolveLearningConsolidationCandidate(minimalContext(shellPaths, memoryRegistry), input);
  if (resolved.status === 'found') return resolved.candidate;
  if (resolved.status === 'ambiguous') {
    throw new Error(`Ambiguous learning consolidation candidate ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  }
  throw new Error(resolved.usage);
}

export function domainForCandidate(candidate: LearningCandidate): AgentLearningConsolidationDomain {
  const domain = String(candidate.domain);
  if (!isDomain(domain)) throw new Error(`Candidate ${candidate.id} is not an applyable consolidation domain.`);
  return domain;
}

export function cloneRecord(record: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

export function getRecord(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  domain: AgentLearningConsolidationDomain,
  id: string,
): MemoryRecord | AgentPersonaRecord | AgentSkillRecord | AgentRoutineRecord {
  if (domain === 'memory') {
    const record = memoryRegistry.get(id);
    if (!record) throw new Error(`Unknown Agent-local memory ${id}`);
    return record;
  }
  if (domain === 'persona') {
    const record = AgentPersonaRegistry.fromShellPaths(shellPaths).get(id);
    if (!record) throw new Error(`Unknown Agent-local persona ${id}`);
    return record;
  }
  if (domain === 'skill') {
    const record = AgentSkillRegistry.fromShellPaths(shellPaths).get(id);
    if (!record) throw new Error(`Unknown Agent-local skill ${id}`);
    return record;
  }
  const record = AgentRoutineRegistry.fromShellPaths(shellPaths).get(id);
  if (!record) throw new Error(`Unknown Agent-local routine ${id}`);
  return record;
}

export function updateSurvivor(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  domain: AgentLearningConsolidationDomain,
  survivorId: string,
  fields: LearningConsolidationFields,
): Record<string, unknown> {
  if (domain === 'memory') {
    const record = memoryRegistry.update(survivorId, {
      ...(fields.detail === undefined ? {} : { detail: fields.detail }),
      ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
    });
    if (!record) throw new Error(`Unknown Agent-local memory ${survivorId}`);
    return cloneRecord(record);
  }
  if (domain === 'persona') {
    const record = AgentPersonaRegistry.fromShellPaths(shellPaths).update(survivorId, {
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
      ...(fields.triggers === undefined ? {} : { triggers: [...fields.triggers] }),
      provenance: 'learning-curator-consolidation',
    });
    return cloneRecord(record);
  }
  if (domain === 'skill') {
    const record = AgentSkillRegistry.fromShellPaths(shellPaths).update(survivorId, {
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
      ...(fields.triggers === undefined ? {} : { triggers: [...fields.triggers] }),
      provenance: 'learning-curator-consolidation',
    });
    return cloneRecord(record);
  }
  const record = AgentRoutineRegistry.fromShellPaths(shellPaths).update(survivorId, {
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
    ...(fields.triggers === undefined ? {} : { triggers: [...fields.triggers] }),
    provenance: 'learning-curator-consolidation',
  });
  return cloneRecord(record);
}

export function markDuplicateStale(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  domain: AgentLearningConsolidationDomain,
  duplicateId: string,
  survivorId: string,
): Record<string, unknown> {
  const reason = `Duplicate of ${survivorId}; staged by learning curator consolidation.`;
  if (domain === 'memory') {
    const record = memoryRegistry.review(duplicateId, { state: 'stale', staleReason: reason, reviewedBy: 'agent' });
    if (!record) throw new Error(`Unknown Agent-local memory ${duplicateId}`);
    return cloneRecord(record);
  }
  if (domain === 'persona') return cloneRecord(AgentPersonaRegistry.fromShellPaths(shellPaths).markStale(duplicateId, reason));
  if (domain === 'skill') return cloneRecord(AgentSkillRegistry.fromShellPaths(shellPaths).markStale(duplicateId, reason));
  return cloneRecord(AgentRoutineRegistry.fromShellPaths(shellPaths).markStale(duplicateId, reason));
}

export function deleteDuplicate(
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  domain: AgentLearningConsolidationDomain,
  duplicateId: string,
): void {
  if (domain === 'memory') {
    if (!memoryRegistry.delete(duplicateId)) throw new Error(`Unknown Agent-local memory ${duplicateId}`);
    return;
  }
  if (domain === 'persona') {
    AgentPersonaRegistry.fromShellPaths(shellPaths).deletePersona(duplicateId);
    return;
  }
  if (domain === 'skill') {
    AgentSkillRegistry.fromShellPaths(shellPaths).deleteSkill(duplicateId);
    return;
  }
  AgentRoutineRegistry.fromShellPaths(shellPaths).deleteRoutine(duplicateId);
}
