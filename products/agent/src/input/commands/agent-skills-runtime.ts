import { readFileSync } from 'node:fs';
import {
  AgentSkillRegistry,
  buildAgentSkillRequirements,
  evaluateAgentSkillBundleReadiness,
  evaluateAgentSkillReadiness,
  formatAgentSkillRequirement,
  type AgentSkillBundleRecord,
  type AgentSkillRecord,
} from '../../agent/skill-registry.ts';
import { discoverSkills, type SkillRecord } from '../../agent/skill-discovery.ts';
import { parseSkillStandardMarkdown } from '../../agent/skill-standard.ts';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '../../agent/record-labels.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseAgentLocalLibraryArgs, type ParsedAgentLocalLibraryArgs } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';

const SKILL_VALUE_FLAGS = ['name', 'description', 'procedure', 'tags', 'triggers', 'requires-env', 'requires-command', 'requires-commands', 'skills'] as const;

function parseSkillArgs(args: readonly string[]): ParsedAgentLocalLibraryArgs {
  return parseAgentLocalLibraryArgs(args, { valueFlags: SKILL_VALUE_FLAGS });
}

function splitList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function registryFromContext(ctx: CommandContext): AgentSkillRegistry {
  return AgentSkillRegistry.fromShellPaths(requireShellPaths(ctx));
}

function requiredFlag(flags: ReadonlyMap<string, string>, key: string): string {
  const value = flags.get(key)?.trim();
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

function formatSkillReceipt(title: string, record: { readonly id: string; readonly name: string }, extra: readonly string[] = []): string {
  return [
    `${title} ${record.id}`,
    `  id ${record.id}`,
    `  name ${record.name}`,
    ...extra,
  ].join('\n');
}

function summarizeSkill(skill: AgentSkillRecord): string {
  const enabled = skill.enabled ? 'enabled' : 'disabled';
  const tags = skill.tags.length > 0 ? ` tags ${skill.tags.join(', ')}` : '';
  const readiness = evaluateAgentSkillReadiness(skill);
  const review = formatAgentRecordReviewState(skill.reviewState);
  const ready = readiness.ready ? 'ready' : `needs ${readiness.missing.map(formatAgentSkillRequirement).join(',')}`;
  return `  ${skill.id}  ${enabled}  ${review}  ${ready}  ${skill.name} - ${skill.description}${tags}`;
}

function summarizeBundle(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]): string {
  const enabled = bundle.enabled ? 'enabled' : 'disabled';
  const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
  const review = formatAgentRecordReviewState(bundle.reviewState);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill ${skillId}`),
  ];
  const ready = readiness.ready ? 'ready' : `needs ${missing.join(',')}`;
  return `  ${bundle.id}  ${enabled}  ${review}  ${ready}  ${bundle.name} - ${bundle.description}  skills ${bundle.skillIds.join(', ')}`;
}

function renderList(title: string, registry: AgentSkillRegistry, skills: readonly AgentSkillRecord[], emptyMessage?: string): string {
  const snapshot = registry.snapshot();
  if (skills.length === 0) {
    return emptyMessage
      ? `${title}\n  ${emptyMessage}`
      : `${title}\n  No Agent-local skills yet. Create one with /skills create --name <name> --description <summary> --procedure <steps>.`;
  }
  return [
    `${title} (${skills.length})`,
    `  store ${snapshot.path}`,
    `  enabled ${snapshot.enabledSkills.length}`,
    ...skills.map(summarizeSkill),
  ].join('\n');
}

function summarizeDiscoveredSkill(skill: SkillRecord): string {
  const description = skill.description ? ` - ${skill.description}` : '';
  const dependencies = skill.dependencies.length > 0 ? ` deps ${skill.dependencies.join(', ')}` : '';
  const includes = skill.includes.length > 0 ? ` includes ${skill.includes.join(', ')}` : '';
  return `  ${skill.name}  ${skill.origin}${description}${dependencies}${includes}\n    path ${skill.path}`;
}

function renderDiscoveredSkills(skills: readonly SkillRecord[]): string {
  if (skills.length === 0) {
    return [
      'Discovered Agent skill files',
      '  No SKILL.md or .md skill files found in project/global Agent skill folders.',
      '  Search roots: .goodvibes/skills, .goodvibes/agent/skills, ~/.goodvibes/skills, ~/.goodvibes/agent/skills',
    ].join('\n');
  }
  return [
    `Discovered Agent skill files (${skills.length})`,
    ...skills.map(summarizeDiscoveredSkill),
    '',
    'Import one with: /skills import-discovered <name> --yes',
  ].join('\n');
}

function discoveredSkillLookupValues(skill: SkillRecord): readonly string[] {
  const slug = skill.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = skill.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [
    skill.name,
    slug,
    skill.path,
    basename,
  ].map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function findDiscoveredSkill(skills: readonly SkillRecord[], idOrName: string): SkillRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return skills.find((skill) => discoveredSkillLookupValues(skill).includes(lookup)) ?? null;
}

function frontmatterList(skill: SkillRecord, key: string): readonly string[] {
  const value = skill.frontmatter[key];
  if (!value) return [];
  return splitList(value);
}

function frontmatterAnyList(skill: SkillRecord, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const values = frontmatterList(skill, key);
    if (values.length > 0) return values;
  }
  return [];
}

async function importDiscoveredSkill(args: readonly string[], ctx: CommandContext, skillRegistry: AgentSkillRegistry): Promise<void> {
  const parsed = parseSkillArgs(args);
  const name = parsed.rest.join(' ').trim();
  if (!name) {
    ctx.print('Usage: /skills import-discovered <name> --yes\n  Note: discovered skills import disabled; review then enable via /skills enable <name>.');
    return;
  }
  const discovered = findDiscoveredSkill(await discoverSkills(requireShellPaths(ctx)), name);
  if (!discovered) {
    ctx.print(`Unknown discovered Agent skill ${name}\nRun /skills discover to inspect available skill files.`);
    return;
  }
  if (!parsed.yes) {
    ctx.print([
      'Agent skill import preview',
      `  name ${discovered.name}`,
      `  origin ${discovered.origin}`,
      `  path ${discovered.path}`,
      `  description ${discovered.description || '(none)'}`,
      `  procedure characters ${discovered.body.length}`,
      '  next rerun with --yes to import into the Agent-local skill registry',
    ].join('\n'));
    return;
  }
  const skill = skillRegistry.create({
    name: discovered.name,
    description: discovered.description || `Imported skill from ${discovered.origin} skill file.`,
    procedure: discovered.body,
    triggers: frontmatterList(discovered, 'triggers'),
    tags: frontmatterList(discovered, 'tags'),
    requirements: buildAgentSkillRequirements({
      env: frontmatterAnyList(discovered, ['requiresEnv', 'requires-env', 'requires_env']),
      commands: frontmatterAnyList(discovered, ['requiresCommands', 'requires-commands', 'requires_commands', 'commands']),
    }),
    enabled: false,
    source: 'imported',
    provenance: `Imported file (${discovered.origin}): ${discovered.path}`,
  });
  ctx.print(formatSkillReceipt('Imported Agent skill', skill, [
    '  enabled no, imported disabled (review it, then enable it)',
    '  review pending',
  ]));
}

function renderBundleList(title: string, registry: AgentSkillRegistry, bundles: readonly AgentSkillBundleRecord[], emptyMessage?: string): string {
  const snapshot = registry.snapshot();
  if (bundles.length === 0) {
    return emptyMessage
      ? `${title}\n  ${emptyMessage}`
      : `${title}\n  No Agent-local skill bundles yet. Create one with /skills bundle create --name <name> --description <summary> --skills <id,id>.`;
  }
  return [
    `${title} (${bundles.length})`,
    `  store ${snapshot.path}`,
    `  enabled bundles: ${snapshot.enabledBundles.length}`,
    `  active skills: ${snapshot.activeSkills.length}`,
    ...bundles.map((bundle) => summarizeBundle(bundle, snapshot.skills)),
  ].join('\n');
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
    `  created: ${skill.createdAt}`,
    `  updated: ${skill.updatedAt}`,
    skill.staleReason ? `  stale reason: ${skill.staleReason}` : '',
    '',
    skill.description,
    '',
    skill.procedure,
  ].filter(Boolean).join('\n');
}

function renderBundle(bundle: AgentSkillBundleRecord, registry: AgentSkillRegistry): string {
  const skills = bundle.skillIds
    .map((skillId) => registry.get(skillId))
    .filter((skill): skill is AgentSkillRecord => skill !== null);
  const readiness = evaluateAgentSkillBundleReadiness(bundle, registry.snapshot().skills);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill ${skillId}`),
  ];
  return [
    `Skill Bundle ${bundle.name}`,
    `  id ${bundle.id}`,
    `  enabled: ${bundle.enabled ? 'yes' : 'no'}`,
    `  readiness: ${readiness.ready ? 'ready' : 'needs setup'}`,
    missing.length > 0 ? `  missing: ${missing.join(', ')}` : '',
    `  review: ${formatAgentRecordReviewState(bundle.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(bundle.source, bundle.provenance)}`,
    `  skills: ${bundle.skillIds.join(', ')}`,
    `  created: ${bundle.createdAt}`,
    `  updated: ${bundle.updatedAt}`,
    bundle.staleReason ? `  stale reason: ${bundle.staleReason}` : '',
    '',
    bundle.description,
    '',
    ...skills.map((skill) => `- ${skill.id}: ${skill.name} - ${skill.description}`),
  ].filter(Boolean).join('\n');
}

function printError(ctx: CommandContext, error: unknown): void {
  ctx.print([
    'Error',
    `  message ${error instanceof Error ? error.message : String(error)}`,
  ].join('\n'));
}

function runBundleCommand(args: readonly string[], ctx: CommandContext, skillRegistry: AgentSkillRegistry): void {
  const sub = (args[0] ?? 'list').toLowerCase();
  if (sub === 'list' || sub === 'open') {
    ctx.print(renderBundleList('Agent Skill Bundles', skillRegistry, skillRegistry.listBundles()));
    return;
  }
  if (sub === 'enabled') {
    const snapshot = skillRegistry.snapshot();
    ctx.print(renderBundleList('Enabled Agent Skill Bundles', skillRegistry, snapshot.enabledBundles));
    return;
  }
  if (sub === 'attention' || sub === 'needs-setup') {
    const snapshot = skillRegistry.snapshot();
    const bundles = snapshot.bundles.filter((bundle) => !evaluateAgentSkillBundleReadiness(bundle, snapshot.skills).ready);
    ctx.print(renderBundleList('Agent Skill Bundles needing setup', skillRegistry, bundles, 'No Agent-local skill bundles need setup.'));
    return;
  }
  if (sub === 'search') {
    const query = args.slice(1).join(' ').trim();
    ctx.print(renderBundleList(query ? `Agent Skill Bundles matching "${query}"` : 'Agent Skill Bundles', skillRegistry, skillRegistry.searchBundles(query)));
    return;
  }
  if (sub === 'show') {
    const id = args[1];
    if (!id) {
      ctx.print('Usage: /skills bundle show <id>');
      return;
    }
    const bundle = skillRegistry.getBundle(id);
    ctx.print(bundle ? renderBundle(bundle, skillRegistry) : `Unknown Agent skill bundle ${id}`);
    return;
  }
  if (sub === 'create') {
    const parsed = parseSkillArgs(args.slice(1));
    const bundle = skillRegistry.createBundle({
      name: requiredFlag(parsed.flags, 'name'),
      description: requiredFlag(parsed.flags, 'description'),
      skillIds: splitList(requiredFlag(parsed.flags, 'skills')),
      enabled: parsed.flags.get('enabled') === 'true',
      source: 'user',
      provenance: 'Command',
    });
    ctx.print(formatSkillReceipt('Created Agent skill bundle', bundle));
    return;
  }
  if (sub === 'update') {
    const id = args[1];
    if (!id) {
      ctx.print('Usage: /skills bundle update <id> [--name ...] [--description ...] [--skills id,id]');
      return;
    }
    const parsed = parseSkillArgs(args.slice(2));
    const updated = skillRegistry.updateBundle(id, {
      name: parsed.flags.get('name'),
      description: parsed.flags.get('description'),
      skillIds: parsed.flags.has('skills') ? splitList(parsed.flags.get('skills')) : undefined,
      provenance: 'Command',
    });
    ctx.print(formatSkillReceipt('Updated Agent skill bundle', updated));
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = args[1];
    if (!id) {
      ctx.print(`Usage: /skills bundle ${sub} <id>`);
      return;
    }
    const bundle = skillRegistry.setBundleEnabled(id, sub === 'enable');
    ctx.print(formatSkillReceipt(`${sub === 'enable' ? 'Enabled' : 'Disabled'} Agent skill bundle`, bundle));
    return;
  }
  if (sub === 'review') {
    const id = args[1];
    if (!id) {
      ctx.print('Usage: /skills bundle review <id>');
      return;
    }
    const bundle = skillRegistry.markBundleReviewed(id);
    ctx.print(formatSkillReceipt('Reviewed Agent skill bundle', bundle));
    return;
  }
  if (sub === 'stale') {
    const id = args[1];
    if (!id) {
      ctx.print('Usage: /skills bundle stale <id> <reason...>');
      return;
    }
    const bundle = skillRegistry.markBundleStale(id, args.slice(2).join(' '));
    ctx.print(formatSkillReceipt('Marked Agent skill bundle stale', bundle));
    return;
  }
  if (sub === 'delete' || sub === 'remove') {
    const parsed = parseSkillArgs(args.slice(1));
    const id = parsed.rest[0];
    if (!id) {
      ctx.print('Usage: /skills bundle delete <id> --yes');
      return;
    }
    if (!parsed.yes) {
      ctx.print(`Refusing to delete Agent skill bundle ${id} without --yes.`);
      return;
    }
    const removed = skillRegistry.deleteBundle(id);
    ctx.print(formatSkillReceipt('Deleted Agent skill bundle', removed));
    return;
  }
  ctx.print('Usage: /skills bundle [list|enabled|attention|search|show|create|update|enable|disable|review|stale|delete]');
}

export async function runAgentSkillsRuntimeCommand(args: readonly string[], ctx: CommandContext): Promise<void> {
  const sub = (args[0] ?? 'list').toLowerCase();
  if (sub === 'local' || sub === 'agent') {
    await runAgentSkillsRuntimeCommand(args.slice(1), ctx);
    return;
  }
  const skillRegistry = registryFromContext(ctx);
  try {
    if (sub === 'bundle' || sub === 'bundles') {
      runBundleCommand(args.slice(1), ctx, skillRegistry);
      return;
    }
    if (sub === 'discover' || sub === 'discovered') {
      ctx.print(renderDiscoveredSkills(await discoverSkills(requireShellPaths(ctx))));
      return;
    }
    if (sub === 'import-discovered' || sub === 'import-skill') {
      await importDiscoveredSkill(args.slice(1), ctx, skillRegistry);
      return;
    }
    if (sub === 'import-standard') {
      const parsed = parseSkillArgs(args.slice(1));
      const filePath = parsed.rest[0];
      if (!filePath) {
        ctx.print('Usage: /skills import-standard <path/to/SKILL.md> --yes');
        return;
      }
      if (!parsed.yes) {
        ctx.print([
          'Agent skill standard import preview',
          `  path ${filePath}`,
          '  next rerun with --yes to import into the Agent-local skill registry',
        ].join('\n'));
        return;
      }
      const content = readFileSync(filePath, 'utf-8');
      const parseResult = parseSkillStandardMarkdown(content);
      if ('error' in parseResult) {
        ctx.print(`Skill standard import rejected: ${parseResult.error}`);
        return;
      }
      const skill = skillRegistry.importFromStandard(content);
      ctx.print(formatSkillReceipt('Imported shared skill', skill, [`  source ${filePath}`, `  review-state ${skill.reviewState}`]));
      return;
    }
    if (sub === 'export-standard') {
      const parsed = parseSkillArgs(args.slice(1));
      const skillId = parsed.rest[0];
      const destDir = parsed.rest[1];
      if (!skillId || !destDir) {
        ctx.print('Usage: /skills export-standard <id> <dest-directory> --yes');
        return;
      }
      if (!parsed.yes) {
        const skill = skillRegistry.get(skillId);
        if (!skill) {
          ctx.print(`Unknown Agent skill ${skillId}`);
          return;
        }
        ctx.print([
          'Agent skill standard export preview',
          `  skill ${skill.id} (${skill.name})`,
          `  dest ${destDir}/${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}/SKILL.md`,
          '  next rerun with --yes to write the file',
        ].join('\n'));
        return;
      }
      const written = skillRegistry.exportToStandard(skillId, destDir);
      ctx.print(`Exported skill to ${written}`);
      return;
    }
    if (sub === 'list' || sub === 'open') {
      ctx.print(renderList('Agent Skills', skillRegistry, skillRegistry.list()));
      return;
    }
    if (sub === 'enabled') {
      const snapshot = skillRegistry.snapshot();
      ctx.print(renderList('Enabled Agent Skills', skillRegistry, snapshot.enabledSkills));
      return;
    }
    if (sub === 'attention' || sub === 'needs-setup') {
      const skills = skillRegistry.list().filter((skill) => !evaluateAgentSkillReadiness(skill).ready);
      ctx.print(renderList('Agent Skills needing setup', skillRegistry, skills, 'No Agent-local skills need setup.'));
      return;
    }
    if (sub === 'search') {
      const query = args.slice(1).join(' ').trim();
      ctx.print(renderList(query ? `Agent Skills matching "${query}"` : 'Agent Skills', skillRegistry, skillRegistry.search(query)));
      return;
    }
    if (sub === 'show') {
      const id = args[1];
      if (!id) {
        ctx.print('Usage: /skills show <id>');
        return;
      }
      const skill = skillRegistry.get(id);
      ctx.print(skill ? renderSkill(skill) : `Unknown Agent skill ${id}`);
      return;
    }
    if (sub === 'create') {
      const parsed = parseSkillArgs(args.slice(1));
      const procedure = parsed.flags.get('procedure')?.trim() || parsed.rest.join(' ').trim();
      const skill = skillRegistry.create({
        name: requiredFlag(parsed.flags, 'name'),
        description: requiredFlag(parsed.flags, 'description'),
        procedure,
        triggers: splitList(parsed.flags.get('triggers')),
        tags: splitList(parsed.flags.get('tags')),
        requirements: buildAgentSkillRequirements({
          env: splitList(parsed.flags.get('requires-env')),
          commands: splitList(parsed.flags.get('requires-command') ?? parsed.flags.get('requires-commands')),
        }),
        enabled: parsed.flags.get('enabled') === 'true',
        source: 'user',
        provenance: 'Command',
      });
      ctx.print(formatSkillReceipt('Created Agent skill', skill));
      return;
    }
    if (sub === 'update') {
      const id = args[1];
      if (!id) {
        ctx.print('Usage: /skills update <id> [--name ...] [--description ...] [--procedure ...]');
        return;
      }
      const parsed = parseSkillArgs(args.slice(2));
      const updated = skillRegistry.update(id, {
        name: parsed.flags.get('name'),
        description: parsed.flags.get('description'),
        procedure: parsed.flags.get('procedure'),
        triggers: parsed.flags.has('triggers') ? splitList(parsed.flags.get('triggers')) : undefined,
        tags: parsed.flags.has('tags') ? splitList(parsed.flags.get('tags')) : undefined,
        requirements: parsed.flags.has('requires-env') || parsed.flags.has('requires-command') || parsed.flags.has('requires-commands')
          ? buildAgentSkillRequirements({
            env: splitList(parsed.flags.get('requires-env')),
            commands: splitList(parsed.flags.get('requires-command') ?? parsed.flags.get('requires-commands')),
          })
          : undefined,
        provenance: 'Command',
      });
      ctx.print(formatSkillReceipt('Updated Agent skill', updated));
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = args[1];
      if (!id) {
        ctx.print(`Usage: /skills ${sub} <id>`);
        return;
      }
      const skill = skillRegistry.setEnabled(id, sub === 'enable');
      ctx.print(formatSkillReceipt(`${sub === 'enable' ? 'Enabled' : 'Disabled'} Agent skill`, skill));
      return;
    }
    if (sub === 'review') {
      const id = args[1];
      if (!id) {
        ctx.print('Usage: /skills review <id>');
        return;
      }
      const skill = skillRegistry.markReviewed(id);
      ctx.print(formatSkillReceipt('Reviewed Agent skill', skill));
      return;
    }
    if (sub === 'stale') {
      const id = args[1];
      if (!id) {
        ctx.print('Usage: /skills stale <id> <reason...>');
        return;
      }
      const skill = skillRegistry.markStale(id, args.slice(2).join(' '));
      ctx.print(formatSkillReceipt('Marked Agent skill stale', skill));
      return;
    }
    if (sub === 'delete' || sub === 'remove') {
      const parsed = parseSkillArgs(args.slice(1));
      const id = parsed.rest[0];
      if (!id) {
        ctx.print('Usage: /skills delete <id> --yes');
        return;
      }
      if (!parsed.yes) {
        ctx.print(`Refusing to delete Agent skill ${id} without --yes.`);
        return;
      }
      const removed = skillRegistry.deleteSkill(id);
      ctx.print(formatSkillReceipt('Deleted Agent skill', removed));
      return;
    }
    ctx.print('Usage: /skills [list|enabled|attention|discover|import-discovered|search|show|create|update|enable|disable|review|stale|delete|bundle]');
  } catch (error) {
    printError(ctx, error);
  }
}

export function registerAgentSkillsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'skills',
    aliases: ['skill', 'agent-skills', 'askills', 'local-skills'],
    description: 'Manage Agent-local skills',
    hidden: true,
    usage: '[list|enabled|attention|discover|import-discovered <name> --yes|search <query>|show <id>|create --name <name> --description <summary> --procedure <steps> [--requires-env A,B] [--requires-command gh,jq]|update <id> [--name ...] [--description ...] [--procedure ...]|enable <id>|disable <id>|review <id>|stale <id> <reason...>|delete <id> --yes|bundle ...]',
    handler: runAgentSkillsRuntimeCommand,
  });
}
