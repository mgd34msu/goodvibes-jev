import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '../agent/record-labels.ts';
import {
  evaluateAgentSkillBundleReadiness,
  formatAgentSkillRequirement,
  type AgentSkillBundleRecord,
  type AgentSkillRecord,
} from '../agent/skill-registry.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import { appendTemporalLabel } from './temporal-label.ts';
import {
  csvOption,
  errorOutput,
  failure,
  hasFlag,
  optionValue,
  parseOptions,
  requiredOption,
  skillRegistry,
  success,
} from './local-library-command-shared.ts';

function summarizeBundle(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]): string {
  const enabled = bundle.enabled ? 'enabled' : 'disabled';
  const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
  ];
  const ready = readiness.ready ? 'ready' : `needs ${missing.join(',')}`;
  return `  ${bundle.id}  ${enabled}  ${formatAgentRecordReviewState(bundle.reviewState)}  ${ready}  ${bundle.name} - ${bundle.description} skills ${bundle.skillIds.join(',')}`;
}

export function renderBundleList(title: string, path: string, bundles: readonly AgentSkillBundleRecord[], skills: readonly AgentSkillRecord[], emptyMessage?: string): string {
  if (bundles.length === 0) {
    return [
      title,
      `  ${emptyMessage ?? 'No Agent-local skill bundles yet.'}`,
      emptyMessage ? '' : '  Create one with: goodvibes-agent skills bundle create --name <name> --description <summary> --skills <id,id>',
    ].filter(Boolean).join('\n');
  }
  return [
    `${title} (${bundles.length})`,
    `  store ${path}`,
    ...bundles.map((bundle) => summarizeBundle(bundle, skills)),
  ].join('\n');
}

function renderBundle(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]): string {
  const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
  ];
  return [
    `Skill bundle ${bundle.name}`,
    `  id ${bundle.id}`,
    `  enabled: ${bundle.enabled ? 'yes' : 'no'}`,
    `  readiness: ${readiness.ready ? 'ready' : 'needs setup'}`,
    missing.length > 0 ? `  missing: ${missing.join(', ')}` : '',
    `  review: ${formatAgentRecordReviewState(bundle.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(bundle.source, bundle.provenance)}`,
    `  skills: ${bundle.skillIds.join(', ')}`,
    `  created: ${appendTemporalLabel(bundle.createdAt, bundle.createdAt)}`,
    `  updated: ${appendTemporalLabel(bundle.updatedAt, bundle.updatedAt)}`,
    bundle.staleReason ? `  stale reason: ${bundle.staleReason}` : '',
    '',
    bundle.description,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function usageBundles(): string {
  return 'Usage: goodvibes-agent skills bundle [list|enabled|attention|search <query>|show <id>|create|update <id>|enable <id>|disable <id>|review <id>|stale <id> <reason>|delete <id> --yes]';
}

export async function handleSkillBundleCommand(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  try {
    const [sub = 'list', ...rest] = args;
    const normalized = sub.toLowerCase();
    const registry = skillRegistry(runtime);
    const snapshot = registry.snapshot();
    if (normalized === 'list' || normalized === 'ls') {
      return success(runtime, 'agent.skills.bundles.list', { path: snapshot.path, bundles: snapshot.bundles }, renderBundleList('Agent skill bundles', snapshot.path, snapshot.bundles, snapshot.skills));
    }
    if (normalized === 'enabled') {
      return success(runtime, 'agent.skills.bundles.enabled', { path: snapshot.path, bundles: snapshot.enabledBundles }, renderBundleList('Enabled Agent skill bundles', snapshot.path, snapshot.enabledBundles, snapshot.skills));
    }
    if (normalized === 'attention' || normalized === 'needs-setup') {
      const bundles = snapshot.bundles.filter((bundle) => !evaluateAgentSkillBundleReadiness(bundle, snapshot.skills).ready);
      return success(runtime, 'agent.skills.bundles.attention', { path: snapshot.path, bundles }, renderBundleList('Agent skill bundles needing setup', snapshot.path, bundles, snapshot.skills, 'No Agent-local skill bundles need setup.'));
    }
    if (normalized === 'search' || normalized === 'find') {
      const query = rest.join(' ').trim();
      const results = registry.searchBundles(query);
      return success(runtime, 'agent.skills.bundles.search', { query, results }, renderBundleList(`Agent skill bundles matching "${query}"`, snapshot.path, results, snapshot.skills));
    }
    if (normalized === 'show' || normalized === 'get') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_bundle_command', 'Usage: goodvibes-agent skills bundle show <id>', 2);
      const bundle = registry.getBundle(id);
      if (!bundle) return failure(runtime, 'skill_bundle_not_found', `Unknown Agent skill bundle ${id}`, 1);
      return success(runtime, 'agent.skills.bundles.show', bundle, renderBundle(bundle, snapshot.skills));
    }
    if (normalized === 'create') {
      const options = parseOptions(rest);
      const usage = 'Usage: goodvibes-agent skills bundle create --name <name> --description <summary> --skills <id,id>';
      const bundle = registry.createBundle({
        name: requiredOption(options, 'name', usage),
        description: requiredOption(options, 'description', usage),
        skillIds: requiredOption(options, 'skills', usage).split(',').map((entry) => entry.trim()).filter(Boolean),
        enabled: hasFlag(options, 'enabled'),
        provenance: optionValue(options, 'provenance') ?? 'Command',
      });
      return success(runtime, 'agent.skills.bundles.create', bundle, [
        'Agent skill bundle created',
        `  id ${bundle.id}`,
      ].join('\n'));
    }
    if (normalized === 'update') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_bundle_command', 'Usage: goodvibes-agent skills bundle update <id> [--name ...] [--description ...] [--skills id,id]', 2);
      const options = parseOptions(rest.slice(1));
      const bundle = registry.updateBundle(id, {
        name: optionValue(options, 'name'),
        description: optionValue(options, 'description'),
        skillIds: csvOption(options, 'skills'),
        provenance: optionValue(options, 'provenance'),
      });
      return success(runtime, 'agent.skills.bundles.update', bundle, [
        'Agent skill bundle updated',
        `  id ${bundle.id}`,
      ].join('\n'));
    }
    if (normalized === 'enable' || normalized === 'disable') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_bundle_command', `Usage: goodvibes-agent skills bundle ${normalized} <id>`, 2);
      const bundle = registry.setBundleEnabled(id, normalized === 'enable');
      return success(runtime, `agent.skills.bundles.${normalized}`, bundle, [
        `Agent skill bundle ${normalized === 'enable' ? 'enabled' : 'disabled'}`,
        `  id ${bundle.id}`,
      ].join('\n'));
    }
    if (normalized === 'review') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_bundle_command', 'Usage: goodvibes-agent skills bundle review <id>', 2);
      const bundle = registry.markBundleReviewed(id);
      return success(runtime, 'agent.skills.bundles.review', bundle, [
        'Agent skill bundle reviewed',
        `  id ${bundle.id}`,
      ].join('\n'));
    }
    if (normalized === 'stale') {
      const id = rest[0];
      if (!id || rest.length < 2) return failure(runtime, 'invalid_skill_bundle_command', 'Usage: goodvibes-agent skills bundle stale <id> <reason>', 2);
      const bundle = registry.markBundleStale(id, rest.slice(1).join(' '));
      return success(runtime, 'agent.skills.bundles.stale', bundle, [
        'Agent skill bundle marked stale',
        `  id ${bundle.id}`,
      ].join('\n'));
    }
    if (normalized === 'delete' || normalized === 'remove' || normalized === 'rm') {
      const options = parseOptions(rest);
      const id = options.positionals[0];
      if (!id) return failure(runtime, 'invalid_skill_bundle_command', 'Usage: goodvibes-agent skills bundle delete <id> --yes', 2);
      if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to delete Agent skill bundle ${id} without --yes.`, 2);
      const bundle = registry.deleteBundle(id);
      return success(runtime, 'agent.skills.bundles.delete', bundle, [
        'Agent skill bundle deleted',
        `  id ${bundle.id}`,
      ].join('\n'));
    }
    return failure(runtime, 'invalid_skill_bundle_command', usageBundles(), 2);
  } catch (error) {
    return errorOutput(runtime, error, 'agent.skills.bundles.error');
  }
}
