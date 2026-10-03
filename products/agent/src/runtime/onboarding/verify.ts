import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isSecretRefInput } from '@goodvibes-jev/engine/sdk/platform/config';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { readAgentRuntimeProfileSelection, resolveAgentRuntimeProfileHome } from '../../agent/runtime-profile.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { isFeatureEnabledInConfig, isLegacyFeatureConfigKey, legacyFeatureConfigTargets } from '../feature-enablement.ts';
import { readOnboardingRuntimeState } from './state.ts';
import type {
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingVerificationDependencies,
  OnboardingVerificationItem,
  OnboardingVerificationResult,
} from './types.ts';

function getNow(deps: Pick<OnboardingVerificationDependencies, 'clock'>): number {
  return deps.clock?.() ?? Date.now();
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => isDeepEqual(value, right[index]));
  }

  if (
    typeof left === 'object' && left !== null
    && typeof right === 'object' && right !== null
    && !Array.isArray(left)
    && !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) return false;

    return leftEntries.every(([key, value]) => isDeepEqual(value, Reflect.get(right, key)));
  }

  return false;
}

function isGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

function verifyConfigOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>,
): OnboardingVerificationItem {
  if (isLegacyFeatureConfigKey(operation.key)) {
    // Legacy featureFlags keys dissolved onto domain settings keys: verify the
    // DERIVED enablement of every addressed feature, not a category readback.
    const targets = legacyFeatureConfigTargets(operation.key, operation.value);
    const mismatched = targets.filter((target) => (
      (isFeatureEnabledInConfig(deps.config, target.featureId) ? 'enabled' : 'disabled') !== target.desired
    ));
    const ok = targets.length > 0 && mismatched.length === 0;
    return {
      id: `config:${operation.key}`,
      status: ok ? 'pass' : 'fail',
      message: ok
        ? `${operation.key} matches the requested onboarding value (derived from the domain settings keys).`
        : `${operation.key} does not match the requested onboarding value${
          mismatched.length > 0 ? ` (mismatched: ${mismatched.map((target) => target.featureId).join(', ')})` : ''
        }.`,
      target: operation.key,
    };
  }

  const actual = deps.config.get(operation.key);
  const ok = isDeepEqual(actual, operation.value);

  return {
    id: `config:${operation.key}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${operation.key} matches the requested onboarding value.`
      : `${operation.key} does not match the requested onboarding value.`,
    target: operation.key,
  };
}

function verifyAcknowledgementOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'acknowledge' }>,
): OnboardingVerificationItem {
  const state = readOnboardingRuntimeState(deps.shellPaths, deps.acknowledgementScope ?? 'project');
  if (state.parseError) {
    return {
      id: `acknowledge:${operation.target}`,
      status: 'fail',
      message: `Onboarding acknowledgement state could not be parsed: ${state.parseError}`,
      target: operation.target,
    };
  }

  const actual = state.payload?.acknowledgements[operation.target] ?? false;
  const ok = actual === operation.acknowledged;

  return {
    id: `acknowledge:${operation.target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${operation.target} acknowledgement matches the requested onboarding state.`
      : `${operation.target} acknowledgement does not match the requested onboarding state.`,
    target: operation.target,
  };
}

async function verifySecretOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): Promise<OnboardingVerificationItem> {
  if (!deps.secrets) {
    return {
      id: `secret:${operation.key}`,
      status: 'fail',
      message: 'Secret manager is unavailable.',
      target: operation.key,
    };
  }

  const actual = await deps.secrets.get(operation.key);
  const ok = isGoodVibesSecretRefInput(operation.value)
    ? actual !== null
    : actual === operation.value;
  return {
    id: `secret:${operation.key}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? isGoodVibesSecretRefInput(operation.value)
        ? `${operation.key} resolves through the stored GoodVibes secret reference.`
        : `${operation.key} was stored through the secret manager.`
      : `${operation.key} did not match the requested secret value.`,
    target: operation.key,
  };
}

function verifyAuthOperation(
  _deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): OnboardingVerificationItem {
  const username = operation.username.trim();
  return {
    id: `auth:${username}`,
    status: 'fail',
    message: 'Runtime auth user/session administration is external to GoodVibes Agent onboarding.',
    target: username,
  };
}

function verifyCreateAgentProfileOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-agent-profile' }>,
): OnboardingVerificationItem {
  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name);
  const ok = existsSync(join(resolution.homeDirectory, 'profile.json'));
  return {
    id: `agent-profile:${resolution.id}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${resolution.id} Agent profile exists.`
      : `${resolution.id} Agent profile was not created.`,
    target: resolution.id,
  };
}

function verifySelectAgentProfileOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'select-agent-profile' }>,
): OnboardingVerificationItem {
  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name);
  const selection = readAgentRuntimeProfileSelection(deps.shellPaths.homeDirectory);
  const ok = selection?.id === resolution.id && selection.exists;
  return {
    id: `selected-agent-profile:${resolution.id}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${resolution.id} Agent profile is selected for later plain goodvibes-agent runs.`
      : `${resolution.id} Agent profile is not selected for later plain goodvibes-agent runs.`,
    target: resolution.id,
  };
}

function verifyCreateLocalPersonaOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-persona' }>,
): OnboardingVerificationItem {
  const registry = AgentPersonaRegistry.fromShellPaths(deps.shellPaths);
  const persona = registry.get(operation.name);
  const activeOk = operation.activate === false || registry.snapshot().activePersonaId === persona?.id;
  const ok = persona !== null && activeOk;
  const target = persona?.id ?? operation.name.trim();
  return {
    id: `local-persona:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${target} Agent-local persona exists${operation.activate === false ? '' : ' and is active'}.`
      : `${target} Agent-local persona was not created${operation.activate === false ? '' : ' or activated'}.`,
    target,
  };
}

function verifyCreateLocalSkillOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-skill' }>,
): OnboardingVerificationItem {
  const skill = AgentSkillRegistry.fromShellPaths(deps.shellPaths).get(operation.name);
  const enabledOk = operation.enabled === false || skill?.enabled === true;
  const ok = skill !== null && enabledOk;
  const target = skill?.id ?? operation.name.trim();
  return {
    id: `local-skill:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${target} Agent-local skill exists${operation.enabled === false ? '' : ' and is enabled'}.`
      : `${target} Agent-local skill was not created${operation.enabled === false ? '' : ' or enabled'}.`,
    target,
  };
}

function verifyCreateLocalRoutineOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-routine' }>,
): OnboardingVerificationItem {
  const routine = AgentRoutineRegistry.fromShellPaths(deps.shellPaths).get(operation.name);
  const enabledOk = operation.enabled === false || routine?.enabled === true;
  const ok = routine !== null && enabledOk;
  const target = routine?.id ?? operation.name.trim();
  return {
    id: `local-routine:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${target} Agent-local routine exists${operation.enabled === false ? '' : ' and is enabled'}.`
      : `${target} Agent-local routine was not created${operation.enabled === false ? '' : ' or enabled'}.`,
    target,
  };
}

function verifyCreateLocalNoteOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-note' }>,
): OnboardingVerificationItem {
  const note = AgentNoteRegistry.fromShellPaths(deps.shellPaths).get(operation.title);
  const ok = note !== null && note.body.trim() === operation.body.trim();
  const target = note?.id ?? operation.title.trim();
  return {
    id: `local-note:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${target} Agent-local note exists.`
      : `${target} Agent-local note was not created.`,
    target,
  };
}

async function verifyOperation(
  deps: OnboardingVerificationDependencies,
  operation: OnboardingApplyOperation,
): Promise<OnboardingVerificationItem> {
  if (operation.kind === 'set-config') return verifyConfigOperation(deps, operation);
  if (operation.kind === 'set-secret') return verifySecretOperation(deps, operation);
  if (operation.kind === 'ensure-auth-user') return verifyAuthOperation(deps, operation);
  if (operation.kind === 'acknowledge') return verifyAcknowledgementOperation(deps, operation);
  if (operation.kind === 'create-agent-profile') return verifyCreateAgentProfileOperation(deps, operation);
  if (operation.kind === 'select-agent-profile') return verifySelectAgentProfileOperation(deps, operation);
  if (operation.kind === 'create-local-note') return verifyCreateLocalNoteOperation(deps, operation);
  if (operation.kind === 'create-local-persona') return verifyCreateLocalPersonaOperation(deps, operation);
  if (operation.kind === 'create-local-skill') return verifyCreateLocalSkillOperation(deps, operation);
  return verifyCreateLocalRoutineOperation(deps, operation);
}

export async function verifyOnboardingRequest(
  deps: OnboardingVerificationDependencies,
  request: OnboardingApplyRequest,
): Promise<OnboardingVerificationResult> {
  const items = await Promise.all(request.operations.map((operation) => verifyOperation(deps, operation)));

  return {
    verifiedAt: getNow(deps),
    ok: items.every((item) => item.status === 'pass'),
    items,
  };
}
