import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isSecretRefInput } from '@goodvibes-jev/engine/sdk/platform/config';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../../config/index.ts';
import {
  createAgentRuntimeProfile,
  getAgentRuntimeProfileTemplate,
  getAgentRuntimeProfileSelectionPath,
  readAgentRuntimeProfileSelection,
  resolveAgentRuntimeProfileHome,
  setAgentRuntimeProfileSelection,
} from '../../agent/runtime-profile.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry, assertNoSecretLikeText } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import {
  expandLegacyFeatureConfigValue,
  isLegacyFeatureConfigKey,
} from '../feature-enablement.ts';
import {
  getOnboardingRuntimeStatePath,
  readOnboardingRuntimeState,
  writeOnboardingAcknowledgementState,
} from './state.ts';
import { verifyOnboardingRequest } from './verify.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import type {
  OnboardingApplyDependencies,
  OnboardingAppliedOperation,
  OnboardingApplyError,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingApplyResult,
} from './types.ts';
import { isPlainObject, readJsonObject, restoreFile, runRollbacks, setNestedValue, snapshotFileRollback, writeJsonObject, type RollbackAction } from './apply-file-helpers.ts';

function getNow(deps: Pick<OnboardingApplyDependencies, 'clock'>): number {
  return deps.clock?.() ?? Date.now();
}

function isGoodVibesSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

function isMalformedGoodVibesSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isGoodVibesSecretReferenceValue(normalized);
}

function validateLegacyFeatureConfigValue(operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>): boolean {
  if (!isLegacyFeatureConfigKey(operation.key)) return false;
  // Throws with real guidance on malformed shapes, unknown feature ids, and
  // always-available (constant-binding) features. The legacy featureFlags
  // namespace dissolved onto domain settings keys; the expansion below is
  // exactly what apply will write.
  expandLegacyFeatureConfigValue(operation.key, operation.value);
  return true;
}

function validateConfigValue(operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>): void {
  if (typeof operation.value === 'string' && isMalformedGoodVibesSecretReferenceValue(operation.value)) {
    throw new Error(`Config key ${operation.key} only accepts goodvibes://secrets/... secret references.`);
  }

  if (validateLegacyFeatureConfigValue(operation)) return;

  const schema = CONFIG_SCHEMA.find((entry) => entry.key === operation.key);
  if (!schema) {
    const defaultValue = operation.key.split('.').reduce<unknown>((cursor, part) => (
      isPlainObject(cursor) ? cursor[part] : undefined
    ), DEFAULT_CONFIG);
    if (defaultValue === undefined) throw new Error(`Unknown config key ${operation.key}`);
    if (typeof defaultValue === 'boolean' && typeof operation.value !== 'boolean') {
      throw new Error(`Config key ${operation.key} expects a boolean value.`);
    }
    if (typeof defaultValue === 'number' && typeof operation.value !== 'number') {
      throw new Error(`Config key ${operation.key} expects a numeric value.`);
    }
    if (typeof defaultValue === 'string' && typeof operation.value !== 'string') {
      throw new Error(`Config key ${operation.key} expects a string value.`);
    }
    return;
  }
  const stringValue = typeof operation.value === 'string' ? operation.value : null;

  if (schema.type === 'boolean' && typeof operation.value !== 'boolean') {
    throw new Error(`Config key ${operation.key} expects a boolean value.`);
  }

  if (schema.type === 'number' && typeof operation.value !== 'number') {
    throw new Error(`Config key ${operation.key} expects a numeric value.`);
  }

  if ((schema.type === 'string' || schema.type === 'enum') && stringValue === null) {
    throw new Error(`Config key ${operation.key} expects a string value.`);
  }

  if (schema.type === 'enum' && schema.enumValues && stringValue !== null && !schema.enumValues.includes(stringValue)) {
    throw new Error(`Invalid value for ${operation.key} ${String(operation.value)}.`);
  }

  if (schema.validate && !schema.validate(operation.value)) {
    throw new Error(`Invalid value for ${operation.key} ${String(operation.value)}.`);
  }
}

function validateSecretOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): void {
  if (!deps.secrets) throw new Error('Secret persistence is unavailable.');
  if (operation.key.trim().length === 0) throw new Error('Secret key is required.');
  if (operation.value.length === 0) throw new Error(`Secret value for ${operation.key} is required.`);
  if (!operation.medium) throw new Error(`Secret storage medium for ${operation.key} is required.`);
  if (isMalformedGoodVibesSecretReferenceValue(operation.value)) {
    throw new Error(`Secret value for ${operation.key} only accepts goodvibes://secrets/... secret references.`);
  }
}

function validateAuthOperation(
  _deps: OnboardingApplyDependencies,
  _operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): void {
  throw new Error('Runtime auth user/session administration is external to GoodVibes Agent onboarding.');
}

function validateAcknowledgementOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'acknowledge' }>,
): void {
  if (typeof operation.acknowledged !== 'boolean') {
    throw new Error(`${operation.target} acknowledgement must be boolean.`);
  }

  const state = readOnboardingRuntimeState(deps.shellPaths, deps.acknowledgementScope ?? 'project');
  if (state.parseError) {
    throw new Error(`Existing onboarding acknowledgement state could not be parsed: ${state.parseError}`);
  }
}

function validateCreateAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-agent-profile' }>,
): void {
  const name = operation.name.trim();
  if (name.length === 0) throw new Error('Agent profile name is required.');

  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, name);
  if (existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile already exists: ${resolution.id}`);
  }

  const templateId = operation.templateId?.trim();
  if (templateId) getAgentRuntimeProfileTemplate(templateId, deps.shellPaths.homeDirectory);
}

function validateSelectAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'select-agent-profile' }>,
): void {
  const name = operation.name.trim();
  if (name.length === 0) throw new Error('Agent profile name is required.');
  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, name);
  if (!existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile does not exist: ${resolution.id}`);
  }
}

function validateCreateLocalPersonaOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-persona' }>,
): void {
  const name = operation.name.trim();
  const description = operation.description.trim();
  const body = operation.body.trim();
  if (!name) throw new Error('Persona name is required.');
  if (!description) throw new Error('Persona description is required.');
  if (!body) throw new Error('Persona body is required.');
  assertNoSecretLikeText([name, description, body]);
  const duplicate = AgentPersonaRegistry.fromShellPaths(deps.shellPaths).get(name);
  if (duplicate) throw new Error(`Persona already exists: ${duplicate.id}`);
}

function validateCreateLocalSkillOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-skill' }>,
): void {
  const registry = AgentSkillRegistry.fromShellPaths(deps.shellPaths);
  const name = operation.name.trim();
  const description = operation.description.trim();
  const procedure = operation.procedure.trim();
  if (!name) throw new Error('Skill name is required.');
  if (!description) throw new Error('Skill description is required.');
  if (!procedure) throw new Error('Skill procedure is required.');
  assertNoSecretLikeText([name, description, procedure]);
  const duplicate = registry.get(name);
  if (duplicate) throw new Error(`Skill already exists: ${duplicate.id}`);
}

function validateCreateLocalRoutineOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-routine' }>,
): void {
  const registry = AgentRoutineRegistry.fromShellPaths(deps.shellPaths);
  const name = operation.name.trim();
  const description = operation.description.trim();
  const steps = operation.steps.trim();
  if (!name) throw new Error('Routine name is required.');
  if (!description) throw new Error('Routine description is required.');
  if (!steps) throw new Error('Routine steps are required.');
  assertNoSecretLikeText([name, description, steps]);
  const duplicate = registry.get(name);
  if (duplicate) throw new Error(`Routine already exists: ${duplicate.id}`);
}

function validateCreateLocalNoteOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-note' }>,
): void {
  const registry = AgentNoteRegistry.fromShellPaths(deps.shellPaths);
  const title = operation.title.trim();
  const body = operation.body.trim();
  const tags = operation.tags ?? [];
  if (!title) throw new Error('Note title is required.');
  if (!body) throw new Error('Note body is required.');
  assertNoSecretLikeText([title, body, ...tags]);
  const duplicate = registry.get(title);
  if (duplicate) throw new Error(`Note already exists: ${duplicate.id}`);
}

function applyConfigOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>,
): OnboardingAppliedOperation {
  validateConfigValue(operation);

  if ((operation.scope ?? 'global') === 'project') {
    const path = deps.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json');
    const existing = readJsonObject(path);
    if (isLegacyFeatureConfigKey(operation.key)) {
      // Legacy featureFlags keys dissolved onto domain settings keys: persist
      // the translated domain-key writes, never a featureFlags record.
      const writes = expandLegacyFeatureConfigValue(operation.key, operation.value);
      let updated = existing;
      for (const write of writes) {
        updated = setNestedValue(updated, write.key, write.value);
      }
      writeJsonObject(path, updated);
      deps.config.load();
      return {
        kind: operation.kind,
        summary: `Persisted ${writes.map((write) => write.key).join(', ')} (legacy ${operation.key}) in project onboarding settings.`,
      };
    }
    const updated = setNestedValue(existing, operation.key, operation.value);
    writeJsonObject(path, updated);
    deps.config.load();

    return {
      kind: operation.kind,
      summary: `Persisted ${operation.key} in project onboarding settings.`,
    };
  }

  if (isLegacyFeatureConfigKey(operation.key)) {
    const writes = expandLegacyFeatureConfigValue(operation.key, operation.value);
    for (const write of writes) {
      deps.config.setDynamic(write.key, write.value);
    }
    return {
      kind: operation.kind,
      summary: `Updated ${writes.map((write) => write.key).join(', ')} (legacy ${operation.key}) in global onboarding settings.`,
    };
  }
  deps.config.setDynamic(operation.key, operation.value);
  return {
    kind: operation.kind,
    summary: `Updated ${operation.key} in global onboarding settings.`,
  };
}

async function applySecretOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): Promise<OnboardingAppliedOperation> {
  validateSecretOperation(deps, operation);
  await deps.secrets!.set(operation.key, operation.value, {
    scope: operation.scope ?? 'project',
    ...(operation.medium ? { medium: operation.medium } : {}),
  });

  return {
    kind: operation.kind,
    summary: `Stored ${operation.key} through the configured secret manager.`,
  };
}

async function buildSecretRollbackAction(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): Promise<RollbackAction> {
  validateSecretOperation(deps, operation);
  const scope = operation.scope ?? 'project';
  const review = await deps.secrets!.inspect();
  const locations = review.locations.filter((entry) => entry.source.startsWith(`${scope}-`));
  if (locations.length === 0) throw new Error(`Secret storage locations for ${scope} scope are unavailable.`);
  const snapshots = locations.map((location) => ({
    path: location.path,
    previous: existsSync(location.path) ? readFileSync(location.path, 'utf-8') : null,
  }));
  return () => {
    for (const snapshot of snapshots) restoreFile(snapshot.path, snapshot.previous);
  };
}

async function buildRollbackAction(
  deps: OnboardingApplyDependencies,
  operation: OnboardingApplyOperation,
): Promise<RollbackAction> {
  if (operation.kind === 'set-config') {
    if ((operation.scope ?? 'global') === 'project') {
      return snapshotFileRollback(
        deps.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json'),
        () => deps.config.load(),
      );
    }

    const operationKey = operation.key;
    if (isLegacyFeatureConfigKey(operationKey)) {
      // Snapshot the domain settings keys the translated writes will touch and
      // restore those exact values, no featureFlags category exists to merge.
      const writes = expandLegacyFeatureConfigValue(operationKey, operation.value);
      const previousValues = writes.map((write) => ({ key: write.key, previous: deps.config.get(write.key) }));
      return () => {
        for (const entry of previousValues) {
          deps.config.setDynamic(entry.key, entry.previous);
        }
      };
    }
    const previous = deps.config.get(operationKey);
    return () => {
      deps.config.setDynamic(operationKey, previous);
    };
  }

  if (operation.kind === 'set-secret') {
    return buildSecretRollbackAction(deps, operation);
  }

  if (operation.kind === 'ensure-auth-user') {
    validateAuthOperation(deps, operation);
    return () => {};
  }

  if (operation.kind === 'acknowledge') {
    return snapshotFileRollback(
      getOnboardingRuntimeStatePath(deps.shellPaths, deps.acknowledgementScope ?? 'project'),
    );
  }

  if (operation.kind === 'create-agent-profile') {
    const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name);
    return () => {
      if (existsSync(resolution.homeDirectory)) rmSync(resolution.homeDirectory, { recursive: true, force: true });
    };
  }

  if (operation.kind === 'select-agent-profile') {
    const path = getAgentRuntimeProfileSelectionPath(deps.shellPaths.homeDirectory);
    return snapshotFileRollback(path);
  }

  if (operation.kind === 'create-local-note') {
    const registry = AgentNoteRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  if (operation.kind === 'create-local-persona') {
    const registry = AgentPersonaRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  if (operation.kind === 'create-local-skill') {
    const registry = AgentSkillRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  if (operation.kind === 'create-local-routine') {
    const registry = AgentRoutineRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  const neverOperation: never = operation;
  throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
}

function applyAcknowledgementOperation(
  deps: OnboardingApplyDependencies,
  request: OnboardingApplyRequest,
  operation: Extract<OnboardingApplyOperation, { kind: 'acknowledge' }>,
): OnboardingAppliedOperation {
  writeOnboardingAcknowledgementState(deps.shellPaths, {
    scope: deps.acknowledgementScope ?? 'project',
    target: operation.target,
    acknowledged: operation.acknowledged,
    updatedAt: getNow(deps),
    source: request.source,
    mode: request.mode,
  });

  return {
    kind: operation.kind,
    summary: `${operation.target} acknowledgement set to ${operation.acknowledged ? 'accepted' : 'pending'}.`,
  };
}

function applyCreateAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-agent-profile' }>,
): OnboardingAppliedOperation {
  validateCreateAgentProfileOperation(deps, operation);
  const templateId = operation.templateId?.trim();
  const profile = createAgentRuntimeProfile(deps.shellPaths.homeDirectory, operation.name, {
    ...(templateId ? { templateId } : {}),
  });

  return {
    kind: operation.kind,
    summary: profile.starterTemplateId
      ? `Created Agent profile ${profile.id} from ${profile.starterTemplateId}.`
      : `Created Agent profile ${profile.id}.`,
  };
}

function applySelectAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'select-agent-profile' }>,
): OnboardingAppliedOperation {
  validateSelectAgentProfileOperation(deps, operation);
  const selection = setAgentRuntimeProfileSelection(deps.shellPaths.homeDirectory, operation.name);
  return {
    kind: operation.kind,
    summary: `Selected Agent profile ${selection.id} for later plain goodvibes-agent runs.`,
  };
}

function applyCreateLocalPersonaOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-persona' }>,
): OnboardingAppliedOperation {
  const registry = AgentPersonaRegistry.fromShellPaths(deps.shellPaths);
  const persona = registry.create({
    name: operation.name,
    description: operation.description,
    body: operation.body,
    source: 'user',
    provenance: 'onboarding',
  });
  if (operation.activate !== false) registry.setActive(persona.id);
  return {
    kind: operation.kind,
    summary: `Created Agent-local persona ${persona.id}.`,
  };
}

function applyCreateLocalSkillOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-skill' }>,
): OnboardingAppliedOperation {
  const skill = AgentSkillRegistry.fromShellPaths(deps.shellPaths).create({
    name: operation.name,
    description: operation.description,
    procedure: operation.procedure,
    enabled: operation.enabled !== false,
    source: 'user',
    provenance: 'onboarding',
  });
  return {
    kind: operation.kind,
    summary: `Created Agent-local skill ${skill.id}.`,
  };
}

function applyCreateLocalRoutineOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-routine' }>,
): OnboardingAppliedOperation {
  const routine = AgentRoutineRegistry.fromShellPaths(deps.shellPaths).create({
    name: operation.name,
    description: operation.description,
    steps: operation.steps,
    enabled: operation.enabled !== false,
    source: 'user',
    provenance: 'onboarding',
  });
  return {
    kind: operation.kind,
    summary: `Created Agent-local routine ${routine.id}.`,
  };
}

function applyCreateLocalNoteOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-note' }>,
): OnboardingAppliedOperation {
  const note = AgentNoteRegistry.fromShellPaths(deps.shellPaths).create({
    title: operation.title,
    body: operation.body,
    tags: operation.tags ?? [],
    source: 'user',
    provenance: 'onboarding',
  });
  return {
    kind: operation.kind,
    summary: `Created Agent-local note ${note.id}.`,
  };
}

function orderApplyOperations(
  operations: readonly OnboardingApplyOperation[],
): readonly OnboardingApplyOperation[] {
  const secretPolicyOperations = operations.filter((operation) => (
    operation.kind === 'set-config' && operation.key === 'storage.secretPolicy'
  ));
  const authOperations = operations.filter((operation) => operation.kind === 'ensure-auth-user');
  const secretOperations = operations.filter((operation) => operation.kind === 'set-secret');
  const configOperations = operations.filter((operation) => (
    operation.kind === 'set-config' && operation.key !== 'storage.secretPolicy'
  ));
  const agentProfileOperations = operations.filter((operation) => operation.kind === 'create-agent-profile');
  const agentProfileSelectionOperations = operations.filter((operation) => operation.kind === 'select-agent-profile');
  const localBehaviorOperations = operations.filter((operation) => (
    operation.kind === 'create-local-note'
    || operation.kind === 'create-local-persona'
    || operation.kind === 'create-local-skill'
    || operation.kind === 'create-local-routine'
  ));
  const finalOperations = operations.filter((operation) => (
    operation.kind === 'acknowledge'
  ));

  return [
    ...secretPolicyOperations,
    ...authOperations,
    ...secretOperations,
    ...configOperations,
    ...agentProfileOperations,
    ...agentProfileSelectionOperations,
    ...localBehaviorOperations,
    ...finalOperations,
  ];
}

function prevalidateApplyRequest(
  deps: OnboardingApplyDependencies,
  request: OnboardingApplyRequest,
): OnboardingApplyError[] {
  const errors: OnboardingApplyError[] = [];
  const orderedOperations = orderApplyOperations(request.operations);

  for (const operation of orderedOperations) {
    try {
      if (operation.kind === 'set-config') {
        validateConfigValue(operation);
        if ((operation.scope ?? 'global') === 'project') {
          readJsonObject(deps.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json'));
        }
        continue;
      }

      if (operation.kind === 'set-secret') {
        validateSecretOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'ensure-auth-user') {
        validateAuthOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'acknowledge') {
        validateAcknowledgementOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'create-agent-profile') {
        validateCreateAgentProfileOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'select-agent-profile') {
        const createdEarlier = orderedOperations.some((candidate) => (
          candidate.kind === 'create-agent-profile'
          && resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, candidate.name).id
            === resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name).id
        ));
        if (!createdEarlier) validateSelectAgentProfileOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'create-local-persona') {
        validateCreateLocalPersonaOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'create-local-note') {
        validateCreateLocalNoteOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'create-local-skill') {
        validateCreateLocalSkillOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'create-local-routine') {
        validateCreateLocalRoutineOperation(deps, operation);
        continue;
      }

      const neverOperation: never = operation;
      throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
    } catch (error) {
      errors.push({
        kind: operation.kind,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return errors;
}

function getVerificationFailureKind(itemId: string): OnboardingApplyOperation['kind'] {
  if (itemId.startsWith('config:')) return 'set-config';
  if (itemId.startsWith('secret:')) return 'set-secret';
  if (itemId.startsWith('auth:')) return 'ensure-auth-user';
  if (itemId.startsWith('acknowledge:')) return 'acknowledge';
  if (itemId.startsWith('agent-profile:')) return 'create-agent-profile';
  if (itemId.startsWith('selected-agent-profile:')) return 'select-agent-profile';
  if (itemId.startsWith('local-note:')) return 'create-local-note';
  if (itemId.startsWith('local-persona:')) return 'create-local-persona';
  if (itemId.startsWith('local-skill:')) return 'create-local-skill';
  if (itemId.startsWith('local-routine:')) return 'create-local-routine';
  return 'set-config';
}

export async function applyOnboardingRequest(
  deps: OnboardingApplyDependencies,
  request: OnboardingApplyRequest,
): Promise<OnboardingApplyResult> {
  const applied: OnboardingAppliedOperation[] = [];
  const skipped: never[] = [];
  const errors: OnboardingApplyError[] = prevalidateApplyRequest(deps, request);
  if (errors.length > 0) {
    return {
      ok: false,
      applied,
      skipped,
      errors,
    };
  }

  const orderedOperations = orderApplyOperations(request.operations);
  const rollbacks: RollbackAction[] = [];

  const applyOperations = async (operations: readonly OnboardingApplyOperation[]): Promise<boolean> => {
    for (const operation of operations) {
      let rollback: RollbackAction = () => {};
      try {
        rollback = await buildRollbackAction(deps, operation);
        if (operation.kind === 'set-config') {
          applied.push(applyConfigOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'set-secret') {
          applied.push(await applySecretOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'ensure-auth-user') {
          validateAuthOperation(deps, operation);
          continue;
        }

        if (operation.kind === 'acknowledge') {
          applied.push(applyAcknowledgementOperation(deps, request, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'create-agent-profile') {
          applied.push(applyCreateAgentProfileOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'select-agent-profile') {
          applied.push(applySelectAgentProfileOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'create-local-persona') {
          applied.push(applyCreateLocalPersonaOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'create-local-note') {
          applied.push(applyCreateLocalNoteOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'create-local-skill') {
          applied.push(applyCreateLocalSkillOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'create-local-routine') {
          applied.push(applyCreateLocalRoutineOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        const neverOperation: never = operation;
        throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
      } catch (error) {
        const rollbackErrors = await runRollbacks([...rollbacks, rollback]);
        applied.length = 0;
        errors.push({
          kind: operation.kind,
          message: [
            error instanceof Error ? error.message : String(error),
            ...rollbackErrors.map((rollbackError) => `rollback: ${rollbackError}`),
          ].join('; '),
        });
        return false;
      }
    }
    return true;
  };

  const verifyOrRollback = async (operations: readonly OnboardingApplyOperation[]): Promise<boolean> => {
    const verification = await verifyOnboardingRequest(deps, { ...request, operations });
    const failures = verification.items.filter((item) => item.status !== 'pass');
    if (failures.length === 0) return true;

    const rollbackErrors = await runRollbacks(rollbacks);
    applied.length = 0;
    errors.push(...failures.map((item, index) => ({
      kind: getVerificationFailureKind(item.id),
      message: [
        `verify ${item.id}: ${item.message}`,
        ...(index === 0 ? rollbackErrors.map((rollbackError) => `rollback: ${rollbackError}`) : []),
      ].join('; '),
    })));
    return false;
  };

  if (!await applyOperations(orderedOperations)) {
    return { ok: false, applied, skipped, errors };
  }

  if (!await verifyOrRollback(orderedOperations)) {
    return { ok: false, applied, skipped, errors };
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
  };
}
