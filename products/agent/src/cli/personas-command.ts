import { discoverPersonas, type DiscoveredPersonaRecord } from '../agent/persona-discovery.ts';
import type { AgentPersonaRecord } from '../agent/persona-registry.ts';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '../agent/record-labels.ts';
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
  personaRegistry,
  requiredOption,
  shellPaths,
  success,
} from './local-library-command-shared.ts';

function summarizePersona(persona: AgentPersonaRecord, activePersonaId: string | null): string {
  const active = persona.id === activePersonaId ? 'active' : 'available';
  const tags = persona.tags.length > 0 ? `  tags ${persona.tags.join(', ')}` : '';
  return `  ${persona.id}  ${active}  ${formatAgentRecordReviewState(persona.reviewState)}  ${persona.name} - ${persona.description}${tags}`;
}

function renderPersonaList(title: string, path: string, personas: readonly AgentPersonaRecord[], activePersonaId: string | null): string {
  if (personas.length === 0) {
    return [
      title,
      '  No local Agent personas yet. Create one with: goodvibes-agent personas create --name <name> --description <summary> --body <instructions>',
    ].join('\n');
  }
  return [
    `${title} (${personas.length})`,
    `  store ${path}`,
    ...personas.map((persona) => summarizePersona(persona, activePersonaId)),
  ].join('\n');
}

function renderPersona(persona: AgentPersonaRecord, activePersonaId: string | null): string {
  return [
    `Persona ${persona.name}`,
    `  id ${persona.id}`,
    `  active: ${persona.id === activePersonaId ? 'yes' : 'no'}`,
    `  review: ${formatAgentRecordReviewState(persona.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(persona.source, persona.provenance)}`,
    `  tags: ${persona.tags.join(', ') || '(none)'}`,
    `  triggers: ${persona.triggers.join(', ') || '(manual)'}`,
    `  created: ${appendTemporalLabel(persona.createdAt, persona.createdAt)}`,
    `  updated: ${appendTemporalLabel(persona.updatedAt, persona.updatedAt)}`,
    persona.staleReason ? `  stale reason: ${persona.staleReason}` : '',
    '',
    persona.description,
    '',
    persona.body,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function summarizeDiscoveredPersona(persona: DiscoveredPersonaRecord): string {
  const description = persona.description ? ` - ${persona.description}` : '';
  return [
    `  ${persona.name}  ${persona.origin}${description}`,
    `    path ${persona.path}`,
  ].join('\n');
}

function renderDiscoveredPersonaList(personas: readonly DiscoveredPersonaRecord[]): string {
  if (personas.length === 0) {
    return [
      'Discovered Agent persona files',
      '  No persona markdown files found in Agent persona folders.',
      '  Search roots: .goodvibes/personas, .goodvibes/agent/personas, ~/.goodvibes/personas, ~/.goodvibes/agent/personas',
    ].join('\n');
  }
  return [
    `Discovered Agent persona files (${personas.length})`,
    ...personas.map(summarizeDiscoveredPersona),
    '',
    'Import one with: goodvibes-agent personas import-discovered <name> --yes',
  ].join('\n');
}

function discoveredPersonaLookupValues(persona: DiscoveredPersonaRecord): readonly string[] {
  const slug = persona.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = persona.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [persona.name, slug, persona.path, basename]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function findDiscoveredPersona(personas: readonly DiscoveredPersonaRecord[], idOrName: string): DiscoveredPersonaRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return personas.find((persona) => discoveredPersonaLookupValues(persona).includes(lookup)) ?? null;
}

function discoveredPersonaFrontmatterList(persona: DiscoveredPersonaRecord, key: string): readonly string[] {
  const value = persona.frontmatter[key];
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function usagePersonas(): string {
  return 'Usage: goodvibes-agent personas [list|active|discover|import-discovered <name> --yes|search <query>|show <id>|create|update <id>|use <id>|clear|review <id>|stale <id> <reason>|delete <id> --yes]';
}

export async function handlePersonasCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  try {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const normalized = sub.toLowerCase();
    const registry = personaRegistry(runtime);
    const snapshot = registry.snapshot();
    if (normalized === 'list' || normalized === 'ls') {
      return success(runtime, 'agent.personas.list', snapshot, renderPersonaList('Agent personas', snapshot.path, snapshot.personas, snapshot.activePersonaId));
    }
    if (normalized === 'active') {
      const active = snapshot.activePersona;
      if (!active) return failure(runtime, 'agent.personas.active_missing', 'No active Agent persona.', 1);
      return success(runtime, 'agent.personas.active', active, renderPersona(active, active.id));
    }
    if (normalized === 'discover') {
      const discovered = await discoverPersonas(shellPaths(runtime));
      return success(runtime, 'agent.personas.discover', { personas: discovered }, renderDiscoveredPersonaList(discovered));
    }
    if (normalized === 'import-discovered' || normalized === 'import-persona') {
      const options = parseOptions(rest);
      const name = options.positionals.join(' ').trim();
      if (!name) return failure(runtime, 'invalid_persona_command', 'Usage: goodvibes-agent personas import-discovered <name> [--use] --yes', 2);
      const discovered = findDiscoveredPersona(await discoverPersonas(shellPaths(runtime)), name);
      if (!discovered) {
        return failure(runtime, 'persona_discovery_not_found', `Unknown discovered Agent persona ${name}\nRun goodvibes-agent personas discover to inspect available persona files.`, 1);
      }
      if (!hasFlag(options, 'yes')) {
        return success(runtime, 'agent.personas.import_discovered.preview', { persona: discovered }, [
          'Agent persona import preview',
          `  name ${discovered.name}`,
          `  origin ${discovered.origin}`,
          `  path ${discovered.path}`,
          `  description ${discovered.description || '(none)'}`,
          `  body characters ${discovered.body.length}`,
          '  next rerun with --yes to import into the Agent-local persona registry',
        ].join('\n'));
      }
      const persona = registry.create({
        name: discovered.name,
        description: discovered.description || `Imported persona from ${discovered.origin} markdown file.`,
        body: discovered.body,
        tags: discoveredPersonaFrontmatterList(discovered, 'tags'),
        triggers: discoveredPersonaFrontmatterList(discovered, 'triggers'),
        source: 'imported',
        provenance: `discovered:${discovered.origin}:${discovered.path}`,
      });
      if (hasFlag(options, 'use')) registry.setActive(persona.id);
      return success(runtime, 'agent.personas.import_discovered', persona, [
        `Imported Agent persona ${persona.id}: ${persona.name}${hasFlag(options, 'use') ? ' (active)' : ''}`,
        `  name ${persona.name}`,
        `  active ${hasFlag(options, 'use') ? 'yes' : 'no'}`,
      ].join('\n'));
    }
    if (normalized === 'search' || normalized === 'find') {
      const query = rest.join(' ').trim();
      const results = registry.search(query);
      return success(runtime, 'agent.personas.search', { query, results }, renderPersonaList(`Agent personas matching "${query}"`, snapshot.path, results, snapshot.activePersonaId));
    }
    if (normalized === 'show' || normalized === 'get') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_persona_command', 'Usage: goodvibes-agent personas show <id>', 2);
      const persona = registry.get(id);
      if (!persona) return failure(runtime, 'persona_not_found', `Unknown Agent persona ${id}`, 1);
      return success(runtime, 'agent.personas.show', persona, renderPersona(persona, snapshot.activePersonaId));
    }
    if (normalized === 'create') {
      const options = parseOptions(rest);
      const persona = registry.create({
        name: requiredOption(options, 'name', 'Usage: goodvibes-agent personas create --name <name> --description <summary> --body <instructions>'),
        description: requiredOption(options, 'description', 'Usage: goodvibes-agent personas create --name <name> --description <summary> --body <instructions>'),
        body: requiredOption(options, 'body', 'Usage: goodvibes-agent personas create --name <name> --description <summary> --body <instructions>'),
        tags: csvOption(options, 'tags'),
        triggers: csvOption(options, 'triggers'),
        provenance: optionValue(options, 'provenance') ?? 'Command',
      });
      if (hasFlag(options, 'use')) registry.setActive(persona.id);
      return success(runtime, 'agent.personas.create', persona, [
        'Agent persona created',
        `  id ${persona.id}`,
        hasFlag(options, 'use') ? '  (active)' : '',
        `  active ${hasFlag(options, 'use') ? 'yes' : 'no'}`,
      ].filter(Boolean).join('\n'));
    }
    if (normalized === 'update') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_persona_command', 'Usage: goodvibes-agent personas update <id> [--name ...] [--description ...] [--body ...]', 2);
      const options = parseOptions(rest.slice(1));
      const persona = registry.update(id, {
        name: optionValue(options, 'name'),
        description: optionValue(options, 'description'),
        body: optionValue(options, 'body'),
        tags: csvOption(options, 'tags'),
        triggers: csvOption(options, 'triggers'),
        provenance: optionValue(options, 'provenance'),
      });
      return success(runtime, 'agent.personas.update', persona, [
        'Agent persona updated',
        `  id ${persona.id}`,
      ].join('\n'));
    }
    if (normalized === 'use') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_persona_command', 'Usage: goodvibes-agent personas use <id>', 2);
      const persona = registry.setActive(id);
      return success(runtime, 'agent.personas.use', persona, [
        'Active Agent persona',
        `  id ${persona.id}`,
      ].join('\n'));
    }
    if (normalized === 'clear') {
      registry.clearActive();
      return success(runtime, 'agent.personas.clear', { activePersonaId: null }, 'Active Agent persona cleared.');
    }
    if (normalized === 'review') {
      const id = rest[0];
      if (!id) return failure(runtime, 'invalid_persona_command', 'Usage: goodvibes-agent personas review <id>', 2);
      const persona = registry.markReviewed(id);
      return success(runtime, 'agent.personas.review', persona, [
        'Agent persona reviewed',
        `  id ${persona.id}`,
      ].join('\n'));
    }
    if (normalized === 'stale') {
      const id = rest[0];
      if (!id || rest.length < 2) return failure(runtime, 'invalid_persona_command', 'Usage: goodvibes-agent personas stale <id> <reason>', 2);
      const persona = registry.markStale(id, rest.slice(1).join(' '));
      return success(runtime, 'agent.personas.stale', persona, [
        'Agent persona marked stale',
        `  id ${persona.id}`,
      ].join('\n'));
    }
    if (normalized === 'delete' || normalized === 'remove' || normalized === 'rm') {
      const options = parseOptions(rest);
      const id = options.positionals[0];
      if (!id) return failure(runtime, 'invalid_persona_command', 'Usage: goodvibes-agent personas delete <id> --yes', 2);
      if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to delete Agent persona ${id} without --yes.`, 2);
      const persona = registry.deletePersona(id);
      return success(runtime, 'agent.personas.delete', persona, [
        `Agent persona deleted: ${id}`,
        `  id ${persona.id}`,
      ].join('\n'));
    }
    return failure(runtime, 'invalid_persona_command', usagePersonas(), 2);
  } catch (error) {
    return errorOutput(runtime, error, 'agent.personas.error');
  }
}
