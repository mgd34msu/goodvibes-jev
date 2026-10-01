import { memoryRecordTemporalStatus, type MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import type { AgentNoteRecord } from '../agent/note-registry.ts';
import type { AgentPersonaRecord } from '../agent/persona-registry.ts';
import { formatAgentRecordOrigin } from '../agent/record-labels.ts';
import { evaluateAgentRoutineReadiness, type AgentRoutineRecord } from '../agent/routine-registry.ts';
import { AgentResearchRunRegistry, researchRunLogTail } from '../agent/research-run-registry.ts';
import { RoutineScheduleReceiptStore } from '../agent/routine-schedule-receipts.ts';
import { evaluateAgentSkillBundleReadiness, evaluateAgentSkillReadiness, formatAgentSkillRequirement, type AgentSkillBundleRecord, type AgentSkillRecord } from '../agent/skill-registry.ts';
import type { listAgentRuntimeProfiles, listAgentRuntimeProfileTemplates } from '../agent/runtime-profile.ts';
import type { AgentWorkspaceLocalLibraryItem, AgentWorkspaceResearchRunSummary, AgentWorkspaceRoutineScheduleReceiptSummary, AgentWorkspaceRuntimeProfileItem, AgentWorkspaceRuntimeStarterTemplateItem } from './agent-workspace-types.ts';

export function summarizePersonaItem(persona: AgentPersonaRecord, activePersonaId: string | null): AgentWorkspaceLocalLibraryItem {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    reviewState: persona.reviewState,
    source: formatAgentRecordOrigin(persona.source, persona.provenance),
    tags: persona.tags,
    triggers: persona.triggers,
    active: persona.id === activePersonaId,
  };
}

export function summarizeSkillItem(skill: AgentSkillRecord): AgentWorkspaceLocalLibraryItem {
  const readiness = evaluateAgentSkillReadiness(skill);
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    reviewState: skill.reviewState,
    source: formatAgentRecordOrigin(skill.source, skill.provenance),
    tags: skill.tags,
    triggers: skill.triggers,
    enabled: skill.enabled,
    requirementCount: skill.requirements.length,
    missingRequirementCount: readiness.missing.length,
    missingRequirements: readiness.missing.map(formatAgentSkillRequirement),
  };
}

export function summarizeSkillBundleItem(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]): AgentWorkspaceLocalLibraryItem {
  const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
  ];
  return {
    id: bundle.id,
    name: bundle.name,
    description: `${bundle.description} Skills: ${bundle.skillIds.join(', ')}`,
    reviewState: bundle.reviewState,
    source: formatAgentRecordOrigin(bundle.source, bundle.provenance),
    tags: bundle.skillIds,
    triggers: [],
    enabled: bundle.enabled,
    requirementCount: readiness.includedSkills.reduce((total, skill) => total + skill.requirements.length, 0) + readiness.missingSkillIds.length,
    missingRequirementCount: missing.length,
    missingRequirements: missing,
  };
}

export function summarizeRoutineItem(routine: AgentRoutineRecord): AgentWorkspaceLocalLibraryItem {
  const readiness = evaluateAgentRoutineReadiness(routine);
  return {
    id: routine.id,
    name: routine.name,
    description: routine.description,
    reviewState: routine.reviewState,
    source: formatAgentRecordOrigin(routine.source, routine.provenance),
    tags: routine.tags,
    triggers: routine.triggers,
    enabled: routine.enabled,
    requirementCount: routine.requirements.length,
    missingRequirementCount: readiness.missing.length,
    missingRequirements: readiness.missing.map(formatAgentSkillRequirement),
    startCount: routine.startCount,
  };
}

export function summarizeRoutineScheduleReceipt(
  receipt: ReturnType<RoutineScheduleReceiptStore['snapshot']>['receipts'][number],
): AgentWorkspaceRoutineScheduleReceiptSummary {
  return {
    id: receipt.id,
    status: receipt.status,
    routineId: receipt.routineId,
    routineName: receipt.routineName,
    scheduleName: receipt.scheduleName,
    scheduleKind: receipt.scheduleKind,
    scheduleValue: receipt.scheduleValue,
    createdAt: receipt.createdAt,
  };
}

export function summarizeResearchRunItem(
  run: ReturnType<AgentResearchRunRegistry['snapshot']>['runs'][number],
): AgentWorkspaceResearchRunSummary {
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    sourceIds: run.sourceIds,
    nextSteps: run.nextSteps,
    checkpointCount: run.checkpoints.length,
    logTail: researchRunLogTail(run, 4),
    updatedAt: run.updatedAt,
    ...(run.note ? { note: run.note } : {}),
    ...(run.reportArtifactId ? { reportArtifactId: run.reportArtifactId } : {}),
  };
}

export function summarizeMemoryItem(record: MemoryRecord): AgentWorkspaceLocalLibraryItem {
  const detail = record.detail?.trim();
  return {
    id: record.id,
    name: record.summary,
    description: detail && detail.length > 0 ? detail : `${record.scope}/${record.cls}`,
    reviewState: record.reviewState,
    source: 'Agent memory',
    tags: record.tags,
    triggers: [],
    scope: record.scope,
    cls: record.cls,
    confidence: record.confidence,
    // Visible expiry: a record outside its [validFrom, validUntil) window is
    // still stored (not deleted) but not prompt-injected, see
    // memoryRecordTemporalStatus / describeMemoryPromptEligibility.
    temporalStatus: memoryRecordTemporalStatus(record),
  };
}

export function summarizeNoteItem(note: AgentNoteRecord): AgentWorkspaceLocalLibraryItem {
  const preview = note.body.replace(/\s+/g, ' ').trim();
  const description = note.sourceUrl
    ? `${preview.slice(0, 160)}${preview.length > 160 ? '...' : ''} Origin URL ${note.sourceUrl}`
    : preview;
  return {
    id: note.id,
    name: note.title,
    description,
    reviewState: note.reviewState,
    source: formatAgentRecordOrigin(note.source, note.provenance),
    tags: note.tags,
    triggers: [],
  };
}

export function summarizeRuntimeProfile(profile: ReturnType<typeof listAgentRuntimeProfiles>[number]): AgentWorkspaceRuntimeProfileItem {
  return {
    id: profile.id,
    homeDirectory: profile.homeDirectory,
    createdAt: profile.createdAt,
    starterTemplateId: profile.starterTemplateId,
    starterTemplateName: profile.starterTemplateName,
  };
}

export function summarizeStarterTemplate(template: ReturnType<typeof listAgentRuntimeProfileTemplates>[number]): AgentWorkspaceRuntimeStarterTemplateItem {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    personaName: template.personaName,
    skillNames: template.skillNames,
    routineNames: template.routineNames,
    source: template.source,
  };
}
