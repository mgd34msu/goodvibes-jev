import type { CommandRegistry, SlashCommand } from '../input/command-registry.ts';
import { parseSlashCommand } from '../input/slash-command-parser.ts';
import { describeCommandPolicy } from './agent-harness-metadata.ts';
import { catalogTextMatches, searchCatalog, type CatalogSearchResult } from './agent-harness-catalog-search.ts';

export interface AgentHarnessCommandCatalogArgs {
  readonly query?: unknown;
  readonly command?: unknown;
  readonly commandName?: unknown;
  readonly args?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface CommandDetailLookup {
  readonly source: 'command' | 'commandName' | 'target' | 'query';
  readonly input: string;
  readonly parsedName: string;
  readonly parsedArgs: readonly string[];
  readonly resolvedBy: 'name' | 'alias' | 'case-insensitive-name' | 'case-insensitive-alias' | 'description' | 'prefix';
}

export type CommandDetailResolution =
  | { readonly status: 'found'; readonly command: SlashCommand; readonly lookup: CommandDetailLookup }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => typeof entry === 'string' ? entry : String(entry));
}

function previewText(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function commandSearchText(command: SlashCommand): string {
  return [
    command.name,
    ...(command.aliases ?? []),
    command.description,
    command.usage ?? '',
    command.argsHint ?? '',
  ].join('\n').toLowerCase();
}

function commandMatches(command: SlashCommand, query: string): boolean {
  return catalogTextMatches(commandSearchText(command), query);
}

function describeCommand(command: SlashCommand, lookup?: CommandDetailLookup): Record<string, unknown> {
  const policy = describeCommandPolicy(command.name);
  const modelRoute = previewText(policy.preferredModelTool ?? `workspace action:"command" commandName:"${command.name}"`);
  return {
    name: command.name,
    slash: `/${command.name}`,
    aliases: command.aliases ?? [],
    description: command.description,
    usage: command.usage ?? '',
    argsHint: command.argsHint ?? command.usage ?? '',
    modelRoute,
    modelAccess: {
      inspect: `agent_harness mode:"command" commandName:"${command.name}"`,
      run: `agent_harness mode:"run_command" commandName:"${command.name}" confirm:true explicitUserRequest:"..."`,
      preferred: modelRoute,
      directInspect: `workspace action:"command" commandName:"${command.name}"`,
      directRun: `workspace action:"run_command" commandName:"${command.name}" confirm:true explicitUserRequest:"..."`,
    },
    ...(lookup ? {
      lookup: {
        source: lookup.source,
        input: lookup.input,
        parsedName: lookup.parsedName,
        parsedArgs: lookup.parsedArgs,
        resolvedBy: lookup.resolvedBy,
      },
    } : {}),
    policy,
  };
}

function describeCommandCandidate(command: SlashCommand): Record<string, unknown> {
  const policy = describeCommandPolicy(command.name);
  return {
    name: command.name,
    slash: `/${command.name}`,
    aliases: command.aliases ?? [],
    summary: previewText(command.description),
    effect: policy.effect,
    modelRoute: previewText(policy.preferredModelTool ?? `workspace action:"command" commandName:"${command.name}"`),
    ...(command.argsHint ? { argsHint: command.argsHint } : {}),
  };
}

function commandDetailLookupFromArgs(args: AgentHarnessCommandCatalogArgs): Omit<CommandDetailLookup, 'resolvedBy'> | null {
  const rawCommand = readString(args.command);
  if (rawCommand) {
    const parsed = parseSlashCommand(rawCommand);
    return { source: 'command', input: rawCommand, parsedName: parsed.name, parsedArgs: parsed.args };
  }
  const rawCommandName = readString(args.commandName);
  if (rawCommandName) {
    const parsed = parseSlashCommand(rawCommandName);
    const explicitArgs = readStringArray(args.args);
    return {
      source: 'commandName',
      input: rawCommandName,
      parsedName: parsed.name,
      parsedArgs: explicitArgs.length > 0 ? explicitArgs : parsed.args,
    };
  }
  const rawTarget = readString(args.target);
  if (rawTarget) {
    const parsed = parseSlashCommand(rawTarget);
    return { source: 'target', input: rawTarget, parsedName: parsed.name, parsedArgs: parsed.args };
  }
  const rawQuery = readString(args.query);
  if (rawQuery) {
    const parsed = parseSlashCommand(rawQuery);
    return { source: 'query', input: rawQuery, parsedName: parsed.name, parsedArgs: parsed.args };
  }
  return null;
}

export function resolveHarnessCommandDetail(commandRegistry: CommandRegistry, args: AgentHarnessCommandCatalogArgs): CommandDetailResolution | null {
  const lookup = commandDetailLookupFromArgs(args);
  if (!lookup?.parsedName) return null;
  const direct = commandRegistry.get(lookup.parsedName);
  if (direct) {
    return {
      status: 'found',
      command: direct,
      lookup: {
        ...lookup,
        resolvedBy: direct.name === lookup.parsedName ? 'name' : 'alias',
      },
    };
  }

  const normalized = lookup.parsedName.toLowerCase();
  for (const command of commandRegistry.list()) {
    if (command.name.toLowerCase() === normalized) {
      return { status: 'found', command, lookup: { ...lookup, resolvedBy: 'case-insensitive-name' } };
    }
    if ((command.aliases ?? []).some((alias) => alias.toLowerCase() === normalized)) {
      return { status: 'found', command, lookup: { ...lookup, resolvedBy: 'case-insensitive-alias' } };
    }
  }

  const descriptionMatches = commandRegistry.list().filter((command) => commandMatches(command, lookup.input));
  if (descriptionMatches.length === 1) {
    return { status: 'found', command: descriptionMatches[0]!, lookup: { ...lookup, resolvedBy: 'description' } };
  }
  if (descriptionMatches.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: descriptionMatches.map(describeCommandCandidate).slice(0, 8),
    };
  }

  const prefixMatches = commandRegistry.fuzzyMatch(lookup.parsedName).filter((entry) => entry.score >= 80);
  if (prefixMatches.length === 1) {
    return { status: 'found', command: prefixMatches[0]!.command, lookup: { ...lookup, resolvedBy: 'prefix' } };
  }
  if (prefixMatches.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: prefixMatches.map((entry) => describeCommandCandidate(entry.command)).slice(0, 8),
    };
  }
  return null;
}

export function searchHarnessCommands(
  commandRegistry: CommandRegistry,
  args: AgentHarnessCommandCatalogArgs,
): CatalogSearchResult<Record<string, unknown>> {
  const query = readString(args.query);
  const limit = readLimit(args.limit, 500);
  const includeParameters = args.includeParameters === true;
  const found = searchCatalog(commandRegistry.list(), query, commandSearchText);
  return {
    matches: found.matches
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((command) => includeParameters ? describeCommand(command) : describeCommandCandidate(command)),
    relaxed: found.relaxed,
  };
}

export function describeHarnessCommand(commandRegistry: CommandRegistry, args: AgentHarnessCommandCatalogArgs): Record<string, unknown> | null {
  const detail = resolveHarnessCommandDetail(commandRegistry, args);
  if (detail?.status === 'found') return describeCommand(detail.command, detail.lookup);
  if (detail?.status === 'ambiguous') return { status: 'ambiguous', input: detail.input, candidates: detail.candidates };
  return null;
}
