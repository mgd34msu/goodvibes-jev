import { discoverSkills, type SkillRecord } from '../agent/skill-discovery.ts';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '../agent/record-labels.ts';
import {
  buildAgentSkillRequirements,
  evaluateAgentSkillReadiness,
  formatAgentSkillRequirement,
  type AgentSkillRecord,
} from '../agent/skill-registry.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import { handleSkillBundleCommand, renderBundleList } from './skill-bundle-command.ts';
import { appendTemporalLabel } from './temporal-label.ts';
import {
  csvOption,
  errorOutput,
  failure,
  hasFlag,
  optionValue,
  parseOptions,
  requiredOption,
  shellPaths,
  skillRegistry,
  success,
  type ParsedOptions,
} from './local-library-command-shared.ts';

function summarizeSkill(skill: AgentSkillRecord): string {
  const enabled = skill.enabled ? 'enabled' : 'disabled';
  const tags = skill.tags.length > 0 ? `  tags ${skill.tags.join(', ')}` : '';
  const readiness = evaluateAgentSkillReadiness(skill);
  const ready = readiness.ready ? 'ready' : `needs ${readiness.missing.map(formatAgentSkillRequirement).join(',')}`;
  return `  ${skill.id}  ${enabled}  ${formatAgentRecordReviewState(skill.reviewState)}  ${ready}  ${skill.name} - ${skill.description}${tags}`;
}

function renderSkillList(title: string, path: string, skills: readonly AgentSkillRecord[], emptyMessage?: string): string {
  if (skills.length === 0) {
    return [
      title,
      emptyMessage ? '' : '  No local Agent skills yet.',
      `  ${emptyMessage ?? 'No Agent-local skills yet.'}`,
      emptyMessage ? '' : '  Create one with: goodvibes-agent skills create --name <name> --description <summary> --procedure <steps>',
    ].filter(Boolean).join('\n');
  }
  return [
    `${title} (${skills.length})`,
    `  store ${path}`,
    ...skills.map(summarizeSkill),
  ].join('\n');
}

function summarizeDiscoveredSkill(skill: SkillRecord): string {
  const description = skill.description ? ` - ${skill.description}` : '';
  const dependencies = skill.dependencies.length > 0 ? `  dependencies ${skill.dependencies.join(', ')}` : '';
  const includes = skill.includes.length > 0 ? `  includes ${skill.includes.join(', ')}` : '';
  return [
    `  ${skill.name}  ${skill.origin}${description}${dependencies}${includes}`,
    `    path ${skill.path}`,
  ].join('\n');
}

function renderDiscoveredSkillList(skills: readonly SkillRecord[]): string {
  if (skills.length === 0) {
    return [
      'Discovered Agent skill files',
      '  No SKILL.md or .md skill files found in Agent skill folders.',
      '  Search roots: .goodvibes/skills, .goodvibes/agent/skills, ~/.goodvibes/skills, ~/.goodvibes/agent/skills',
    ].join('\n');
  }
  return [
    `Discovered Agent skill files (${skills.length})`,
    ...skills.map(summarizeDiscoveredSkill),
    '',
    'Import one with: goodvibes-agent skills import-discovered <name> --yes',
  ].join('\n');
}

function discoveredSkillLookupValues(skill: SkillRecord): readonly string[] {
  const slug = skill.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = skill.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [skill.name, slug, skill.path, basename]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function findDiscoveredSkill(skills: readonly SkillRecord[], idOrName: string): SkillRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return skills.find((skill) => discoveredSkillLookupValues(skill).includes(lookup)) ?? null;
}

function discoveredFrontmatterList(skill: SkillRecord, key: string): readonly string[] {
  const value = skill.frontmatter[key];
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function discoveredFrontmatterAnyList(skill: SkillRecord, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const values = discoveredFrontmatterList(skill, key);
    if (values.length > 0) return values;
  }
  return [];
}

function renderSkill(skill: AgentSkillRecord): string {
  const readiness = evaluateAgentSkillReadiness(skill);
  return [
    `Skill ${skill.name}`,
    `  id ${skill.id}`,
    `  enabled: ${skill.enabled ? 'yes' : 'no'}`,
    `  readiness: ${readiness.ready ? 'ready' : 'needs setup'}`,
    `  requirements: ${skill.requirements.map(formatAgentSkillRequirement).join(', ') || '(none)'}`,
    readiness.missing.length > 0 ? `  missing: ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}` : '',
    `  review: ${formatAgentRecordReviewState(skill.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(skill.source, skill.provenance)}`,
    `  tags: ${skill.tags.join(', ') || '(none)'}`,
    `  triggers: ${skill.triggers.join(', ') || '(manual)'}`,
    `  created: ${appendTemporalLabel(skill.createdAt, skill.createdAt)}`,
    `  updated: ${appendTemporalLabel(skill.updatedAt, skill.updatedAt)}`,
    skill.staleReason ? `  stale reason: ${skill.staleReason}` : '',
    '',
    skill.description,
    '',
    skill.procedure,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function usageSkills(): string {
  return 'Usage: goodvibes-agent skills [list|enabled|active|attention|discover|import-discovered <name> --yes|search <query>|show <id>|create [--requires-env A,B] [--requires-command gh,jq]|update <id>|enable <id>|disable <id>|review <id>|stale <id> <reason>|delete <id> --yes|bundle ...]';
}

function skillPayloadFromOptions(options: ParsedOptions): {
  readonly name: string;
  readonly description: string;
  readonly procedure: string;
  readonly tags: readonly string[] | undefined;
  readonly triggers: readonly string[] | undefined;
  readonly requirements: ReturnType<typeof buildAgentSkillRequirements>;
  readonly enabled: boolean | undefined;
  readonly provenance: string;
} {
  const usage = 'Usage: goodvibes-agent skills create --name <name> --description <summary> --procedure <steps>';
  return {
    name: requiredOption(options, 'name', usage),
    description: requiredOption(options, 'description', usage),
    procedure: requiredOption(options, 'procedure', usage),
    tags: csvOption(options, 'tags'),
    triggers: csvOption(options, 'triggers'),
    requirements: buildAgentSkillRequirements({
      env: csvOption(options, 'requires-env'),
      commands: csvOption(options, 'requires-command') ?? csvOption(options, 'requires-commands'),
    }),
    enabled: hasFlag(options, 'enabled') ? true : undefined,
    provenance: optionValue(options, 'provenance') ?? 'Command',
  };
}

export async function handleSkillsCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  try {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const normalized = sub.toLowerCase();
    if (normalized === 'bundle' || normalized === 'bundles') return handleSkillBundleCommand(runtime, rest);
    const registry = skillRegistry(runtime);
    const snapshot = registry.snapshot();
    if (normalized === 'list' || normalized === 'ls') {
      return success(runtime, 'agent.skills.list', { path: snapshot.path, skills: snapshot.skills, enabledCount: snapshot.enabledSkills.length }, renderSkillList('Agent skills', snapshot.path, snapshot.skills));
    }
    if (normalized === 'enabled') {
      return success(runtime, 'agent.skills.enabled', { path: snapshot.path, skills: snapshot.enabledSkills }, renderSkillList('Enabled Agent skills', snapshot.path, snapshot.enabledSkills));
    }
    if (normalized === 'active') {
      return success(runtime, 'agent.skills.active', { path: snapshot.path, skills: snapshot.activeSkills, bundles: snapshot.enabledBundles }, [
        renderSkillList('Active Agent skills', snapshot.path, snapshot.activeSkills),
        snapshot.enabledBundles.length > 0 ? renderBundleList('Enabled Agent skill bundles', snapshot.path, snapshot.enabledBundles, snapshot.skills) : '',
      ].filter(Boolean).join('\n\n'));
    }
    if (normalized === 'attention' || normalized === 'needs-setup') {
      const skills = snapshot.skills.filter((skill) => !evaluateAgentSkillReadiness(skill).ready);
      return success(runtime, 'agent.skills.attention', { path: snapshot.path, skills }, renderSkillList('Agent skills needing setup', snapshot.path, skills, 'No Agent-local skills need setup.'));
    }
    if (normalized === 'discover') {
      const discovered = await discoverSkills(shellPaths(runtime));
      return success(runtime, 'agent.skills.discover', { skills: discovered }, renderDiscoveredSkillList(discovered));
    }
    if (normalized === 'import-discovered' || normalized === 'import-skill') {
      const options = parseOptions(rest);
      const name = options.positionals.join(' ').trim();
      if (!name) return failure(runtime, 'invalid_skill_command', 'Usage: goodvibes-agent skills import-discovered <name> [--enabled] --yes', 2);
      const discovered = findDiscoveredSkill(await discoverSkills(shellPaths(runtime)), name);
      if (!discovered) {
        return failure(runtime, 'skill_discovery_not_found', `Unknown discovered Agent skill ${name}\nRun goodvibes-agent skills discover to inspect available skill files.`, 1);
      }
      if (!hasFlag(options, 'yes')) {
        return success(runtime, 'agent.skills.import_discovered.preview', { skill: discovered }, [
          'Agent skill import preview',
          `  name ${discovered.name}`,
          `  origin ${discovered.origin}`,
          `  path ${discovered.path}`,
          `  description ${discovered.description || '(none)'}`,
          `  procedure characters ${discovered.body.length}`,
          '  next rerun with --yes to import into the Agent-local skill registry',
        ].join('\n'));
      }
      const skill = registry.create({
        name: discovered.name,
        description: discovered.description || `Imported skill from ${discovered.origin} skill file.`,
        procedure: discovered.body,
        tags: discoveredFrontmatterList(discovered, 'tags'),
        triggers: discoveredFrontmatterList(discovered, 'triggers'),
        requirements: buildAgentSkillRequirements({
          env: discoveredFrontmatterAnyList(discovered, ['requiresEnv', 'requires-env', 'requires_env']),
          commands: discoveredFrontmatterAnyList(discovered, ['requiresCommands', 'requires-commands', 'requires_commands', 'commands']),
        }),
        enabled: hasFlag(options, 'enabled'),
        source: 'imported',
        provenance: `discovered:${discovered.origin}:${discovered.path}`,
      });
      return success(runtime, 'agent.skills.import_discovered', skill, [
        `Imported Agent skill ${skill.id}: ${skill.name}${skill.enabled ? ' (enabled)' : ''}`,
        `  name ${skill.name}`,
        `  enabled ${skill.enabled ? 'yes' : 'no'}`,
      ].join('\n'));
    }
    if (normalized === 'search' || normalized === 'find') {
      const query = rest.join(' ').trim();
      const results = registry.search(query);
      return success(runtime, 'agent.skills.search', { query, results }, renderSkillList(`Agent skills matching "${query}"`, snapshot.path, results));
    }
    if (normalized === 'show' || normalized === 'get') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_command', 'Usage: goodvibes-agent skills show <id>', 2);
      const skill = registry.get(id);
      if (!skill) return failure(runtime, 'skill_not_found', `Unknown Agent skill ${id}`, 1);
      return success(runtime, 'agent.skills.show', skill, renderSkill(skill));
    }
    if (normalized === 'create') {
      const skill = registry.create(skillPayloadFromOptions(parseOptions(rest)));
      return success(runtime, 'agent.skills.create', skill, [
        'Agent skill created',
        `  id ${skill.id}`,
        skill.enabled ? '  (enabled)' : '',
        `  enabled ${skill.enabled ? 'yes' : 'no'}`,
      ].filter(Boolean).join('\n'));
    }
    if (normalized === 'update') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_command', 'Usage: goodvibes-agent skills update <id> [--name ...] [--description ...] [--procedure ...]', 2);
      const options = parseOptions(rest.slice(1));
      const skill = registry.update(id, {
        name: optionValue(options, 'name'),
        description: optionValue(options, 'description'),
        procedure: optionValue(options, 'procedure'),
        tags: csvOption(options, 'tags'),
        triggers: csvOption(options, 'triggers'),
        requirements: options.values.has('requires-env') || options.values.has('requires-command') || options.values.has('requires-commands')
          ? buildAgentSkillRequirements({
            env: csvOption(options, 'requires-env'),
            commands: csvOption(options, 'requires-command') ?? csvOption(options, 'requires-commands'),
          })
          : undefined,
        provenance: optionValue(options, 'provenance'),
      });
      return success(runtime, 'agent.skills.update', skill, [
        'Agent skill updated',
        `  id ${skill.id}`,
      ].join('\n'));
    }
    if (normalized === 'enable' || normalized === 'disable') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_command', `Usage: goodvibes-agent skills ${normalized} <id>`, 2);
      const skill = registry.setEnabled(id, normalized === 'enable');
      return success(runtime, `agent.skills.${normalized}`, skill, [
        `Agent skill ${normalized === 'enable' ? 'enabled' : 'disabled'}`,
        `  id ${skill.id}`,
      ].join('\n'));
    }
    if (normalized === 'review') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_skill_command', 'Usage: goodvibes-agent skills review <id>', 2);
      const skill = registry.markReviewed(id);
      return success(runtime, 'agent.skills.review', skill, [
        'Agent skill reviewed',
        `  id ${skill.id}`,
      ].join('\n'));
    }
    if (normalized === 'stale') {
      const id = rest[0];
      if (!id || rest.length < 2) return failure(runtime, 'invalid_skill_command', 'Usage: goodvibes-agent skills stale <id> <reason>', 2);
      const skill = registry.markStale(id, rest.slice(1).join(' '));
      return success(runtime, 'agent.skills.stale', skill, [
        'Agent skill marked stale',
        `  id ${skill.id}`,
      ].join('\n'));
    }
    if (normalized === 'delete' || normalized === 'remove' || normalized === 'rm') {
      const options = parseOptions(rest);
      const id = options.positionals[0];
      if (!id) return failure(runtime, 'invalid_skill_command', 'Usage: goodvibes-agent skills delete <id> --yes', 2);
      if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to delete Agent skill ${id} without --yes.`, 2);
      const skill = registry.deleteSkill(id);
      return success(runtime, 'agent.skills.delete', skill, [
        `Agent skill deleted: ${id}`,
        `  id ${skill.id}`,
      ].join('\n'));
    }
    return failure(runtime, 'invalid_skill_command', usageSkills(), 2);
  } catch (error) {
    return errorOutput(runtime, error, 'agent.skills.error');
  }
}
