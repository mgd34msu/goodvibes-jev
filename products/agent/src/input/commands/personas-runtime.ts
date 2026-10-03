import { discoverPersonas, type DiscoveredPersonaRecord } from '../../agent/persona-discovery.ts';
import { AgentPersonaRegistry, type AgentPersonaRecord } from '../../agent/persona-registry.ts';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '../../agent/record-labels.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseAgentLocalLibraryArgs, type ParsedAgentLocalLibraryArgs } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';

const PERSONA_VALUE_FLAGS = ['name', 'description', 'body', 'tags', 'triggers'] as const;

function parsePersonaArgs(args: readonly string[]): ParsedAgentLocalLibraryArgs {
  return parseAgentLocalLibraryArgs(args, { valueFlags: PERSONA_VALUE_FLAGS });
}

function splitList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function registryFromContext(ctx: CommandContext): AgentPersonaRegistry {
  return AgentPersonaRegistry.fromShellPaths(requireShellPaths(ctx));
}

function formatPersonaReceipt(title: string, persona: Pick<AgentPersonaRecord, 'id' | 'name'>, extra: readonly string[] = []): string {
  const activeSuffix = extra.some((line) => line.includes('active yes') || line.includes('active: yes')) ? ' (active)' : '';
  const normalizedExtra = extra.map((line) => line.replace(/^  active /, '  active: '));
  return [
    `${title} ${persona.id}: ${persona.name}${activeSuffix}`,
    `  id ${persona.id}`,
    `  name ${persona.name}`,
    ...normalizedExtra,
  ].join('\n');
}

function summarizePersona(persona: AgentPersonaRecord, activePersonaId: string | null): string {
  const active = persona.id === activePersonaId ? 'active' : 'inactive';
  const review = formatAgentRecordReviewState(persona.reviewState);
  const tags = persona.tags.length > 0 ? ` tags ${persona.tags.join(', ')}` : '';
  return `  ${persona.id}  ${active}  ${review}  ${persona.name} - ${persona.description}${tags}`;
}

function renderList(title: string, registry: AgentPersonaRegistry, personas: readonly AgentPersonaRecord[]): string {
  const snapshot = registry.snapshot();
  if (personas.length === 0) {
    return `${title}\n  No local Agent personas yet. Create one with /personas create --name <name> --description <summary> --body <instructions>.`;
  }
  return [
    `${title} (${personas.length})`,
    `  store ${snapshot.path}`,
    `  active ${snapshot.activePersona?.name ?? '(none)'}`,
    ...personas.map((persona) => summarizePersona(persona, snapshot.activePersonaId)),
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
    `  triggers: ${persona.triggers.join(', ') || '(none)'}`,
    `  created: ${persona.createdAt}`,
    `  updated: ${persona.updatedAt}`,
    persona.staleReason ? `  stale reason: ${persona.staleReason}` : '',
    '',
    persona.description,
    '',
    persona.body,
  ].filter(Boolean).join('\n');
}

function summarizeDiscoveredPersona(persona: DiscoveredPersonaRecord): string {
  const description = persona.description ? ` - ${persona.description}` : '';
  return `  ${persona.name}  ${persona.origin}${description}\n    path ${persona.path}`;
}

function renderDiscoveredPersonas(personas: readonly DiscoveredPersonaRecord[]): string {
  if (personas.length === 0) {
    return [
      'Discovered Agent persona files',
      '  No persona markdown files found in project/global Agent persona folders.',
      '  Search roots: .goodvibes/personas, .goodvibes/agent/personas, ~/.goodvibes/personas, ~/.goodvibes/agent/personas',
    ].join('\n');
  }
  return [
    `Discovered Agent persona files (${personas.length})`,
    ...personas.map(summarizeDiscoveredPersona),
    '',
    'Import one with: /personas import-discovered <name> --yes',
  ].join('\n');
}

function discoveredPersonaLookupValues(persona: DiscoveredPersonaRecord): readonly string[] {
  const slug = persona.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = persona.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [persona.name, slug, persona.path, basename].map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function findDiscoveredPersona(personas: readonly DiscoveredPersonaRecord[], idOrName: string): DiscoveredPersonaRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return personas.find((persona) => discoveredPersonaLookupValues(persona).includes(lookup)) ?? null;
}

function frontmatterList(persona: DiscoveredPersonaRecord, key: string): readonly string[] {
  const value = persona.frontmatter[key];
  if (!value) return [];
  return splitList(value);
}

async function importDiscoveredPersona(args: readonly string[], ctx: CommandContext, personaRegistry: AgentPersonaRegistry): Promise<void> {
  const parsed = parsePersonaArgs(args);
  const name = parsed.rest.join(' ').trim();
  if (!name) {
    ctx.print('Usage: /personas import-discovered <name> [--use] --yes');
    return;
  }
  const discovered = findDiscoveredPersona(await discoverPersonas(requireShellPaths(ctx)), name);
  if (!discovered) {
    ctx.print(`Unknown discovered Agent persona ${name}\nRun /personas discover to inspect available persona files.`);
    return;
  }
  if (!parsed.yes) {
    ctx.print([
      'Agent persona import preview',
      `  name ${discovered.name}`,
      `  origin ${discovered.origin}`,
      `  path ${discovered.path}`,
      `  description ${discovered.description || '(none)'}`,
      `  body characters ${discovered.body.length}`,
      '  next rerun with --yes to import into the Agent-local persona registry',
    ].join('\n'));
    return;
  }
  const persona = personaRegistry.create({
    name: discovered.name,
    description: discovered.description || `Imported persona from ${discovered.origin} markdown file.`,
    body: discovered.body,
    tags: frontmatterList(discovered, 'tags'),
    triggers: frontmatterList(discovered, 'triggers'),
    source: 'imported',
    provenance: `Imported file (${discovered.origin}): ${discovered.path}`,
  });
  if (parsed.flags.get('use') === 'true') personaRegistry.setActive(persona.id);
  ctx.print(formatPersonaReceipt('Imported Agent persona', persona, [`  active ${parsed.flags.get('use') === 'true' ? 'yes' : 'no'}`]));
}

function requiredFlag(flags: ReadonlyMap<string, string>, key: string): string {
  const value = flags.get(key)?.trim();
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

function printError(ctx: CommandContext, error: unknown): void {
  ctx.print([
    'Error',
    `  message ${error instanceof Error ? error.message : String(error)}`,
  ].join('\n'));
}

export function registerPersonasRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'personas',
    aliases: ['persona'],
    description: 'Manage Agent-local personas',
    hidden: true,
    usage: '[list|discover|import-discovered <name> --yes|search <query>|show <id>|create --name <name> --description <summary> --body <instructions>|update <id> [--name ...] [--description ...] [--body ...]|use <id>|active|clear|review <id>|stale <id> <reason...>|delete <id> --yes]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'list').toLowerCase();
      const registryStore = registryFromContext(ctx);
      try {
        if (sub === 'list' || sub === 'open') {
          ctx.print(renderList('Agent Personas', registryStore, registryStore.list()));
          return;
        }
        if (sub === 'discover' || sub === 'discovered') {
          ctx.print(renderDiscoveredPersonas(await discoverPersonas(requireShellPaths(ctx))));
          return;
        }
        if (sub === 'import-discovered' || sub === 'import-persona') {
          await importDiscoveredPersona(args.slice(1), ctx, registryStore);
          return;
        }
        if (sub === 'search') {
          const query = args.slice(1).join(' ').trim();
          ctx.print(renderList(query ? `Agent Personas matching "${query}"` : 'Agent Personas', registryStore, registryStore.search(query)));
          return;
        }
        if (sub === 'show') {
          const id = args[1];
          if (!id) {
            ctx.print('Usage: /personas show <id>');
            return;
          }
          const snapshot = registryStore.snapshot();
          const persona = registryStore.get(id);
          ctx.print(persona ? renderPersona(persona, snapshot.activePersonaId) : `Unknown Agent persona ${id}`);
          return;
        }
        if (sub === 'create') {
          const parsed = parsePersonaArgs(args.slice(1));
          const body = parsed.flags.get('body')?.trim() || parsed.rest.join(' ').trim();
          const persona = registryStore.create({
            name: requiredFlag(parsed.flags, 'name'),
            description: requiredFlag(parsed.flags, 'description'),
            body,
            tags: splitList(parsed.flags.get('tags')),
            triggers: splitList(parsed.flags.get('triggers')),
            source: 'user',
            provenance: 'Command',
          });
          ctx.print(formatPersonaReceipt('Created Agent persona', persona));
          return;
        }
        if (sub === 'update') {
          const id = args[1];
          if (!id) {
            ctx.print('Usage: /personas update <id> [--name ...] [--description ...] [--body ...]');
            return;
          }
          const parsed = parsePersonaArgs(args.slice(2));
          const updated = registryStore.update(id, {
            name: parsed.flags.get('name'),
            description: parsed.flags.get('description'),
            body: parsed.flags.get('body'),
            tags: parsed.flags.has('tags') ? splitList(parsed.flags.get('tags')) : undefined,
            triggers: parsed.flags.has('triggers') ? splitList(parsed.flags.get('triggers')) : undefined,
            provenance: 'Command',
          });
          ctx.print(formatPersonaReceipt('Updated Agent persona', updated));
          return;
        }
        if (sub === 'use') {
          const id = args[1];
          if (!id) {
            ctx.print('Usage: /personas use <id>');
            return;
          }
          const persona = registryStore.setActive(id);
          ctx.print(`Active Agent persona: ${persona.name}\n${formatPersonaReceipt('Active Agent persona', persona)}`);
          return;
        }
        if (sub === 'active') {
          const snapshot = registryStore.snapshot();
          ctx.print(snapshot.activePersona ? renderPersona(snapshot.activePersona, snapshot.activePersonaId) : 'No active Agent persona.');
          return;
        }
        if (sub === 'clear') {
          registryStore.clearActive();
          ctx.print('Cleared active Agent persona.');
          return;
        }
        if (sub === 'review') {
          const id = args[1];
          if (!id) {
            ctx.print('Usage: /personas review <id>');
            return;
          }
          const persona = registryStore.markReviewed(id);
          ctx.print(formatPersonaReceipt('Reviewed Agent persona', persona));
          return;
        }
        if (sub === 'stale') {
          const id = args[1];
          if (!id) {
            ctx.print('Usage: /personas stale <id> <reason...>');
            return;
          }
          const persona = registryStore.markStale(id, args.slice(2).join(' '));
          ctx.print(formatPersonaReceipt('Marked Agent persona stale', persona));
          return;
        }
        if (sub === 'delete' || sub === 'remove') {
          const parsed = parsePersonaArgs(args.slice(1));
          const id = parsed.rest[0];
          if (!id) {
            ctx.print('Usage: /personas delete <id> --yes');
            return;
          }
          if (!parsed.yes) {
            ctx.print(`Refusing to delete Agent persona ${id} without --yes.`);
            return;
          }
          const removed = registryStore.deletePersona(id);
          ctx.print(formatPersonaReceipt('Deleted Agent persona', removed));
          return;
        }
        ctx.print('Usage: /personas [list|discover|import-discovered|search <query>|show <id>|create|update|use|active|clear|review|stale|delete]');
      } catch (error) {
        printError(ctx, error);
      }
    },
  });
}
