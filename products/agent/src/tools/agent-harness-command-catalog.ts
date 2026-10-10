import type { CommandRegistry, SlashCommand } from '../input/command-registry.ts';
import { parseSlashCommand } from '../input/slash-command-parser.ts';
import { describeCommandPolicy } from './agent-harness-metadata.ts';
import type { CatalogSearchResult } from './agent-harness-catalog-search.ts';
import { rankHarnessCatalog, captureCatalogData, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { types as nodeTypes } from 'node:util';

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
  readonly resolvedBy: 'name' | 'alias' | 'case-insensitive-name' | 'case-insensitive-alias' | 'description';
}

export type CommandDetailResolution =
  | { readonly status: 'found'; readonly command: SlashCommand; readonly lookup: CommandDetailLookup; readonly assertCurrent?: () => void }
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

function commandSearchText(command: CatalogCommand): string {
  return [
    command.name,
    ...(command.aliases ?? []),
    command.description,
    command.usage ?? '',
    command.argsHint ?? '',
  ].join('\n');
}

type CatalogCommand = Omit<SlashCommand, 'handler'>;

/** The executable handler is an identity capability, never semantic evidence. */
function captureCommands(commands: readonly SlashCommand[]): readonly CatalogCommand[] {
  const budget = { nodes: 0, characters: 0, slots: 0 };
  return commands.map((command) => {
    if (nodeTypes.isProxy(command) || ![Object.prototype, null].includes(Object.getPrototypeOf(command))) throw new ToolInputProjectionError('invalid');
    const descriptors = Object.getOwnPropertyDescriptors(command);
    if (Object.getOwnPropertySymbols(command).length || !('value' in (descriptors.handler ?? {}))
      || typeof descriptors.handler!.value !== 'function') throw new ToolInputProjectionError('invalid');
    const { handler: _handler, ...data } = descriptors;
    return captureCatalogData(Object.defineProperties({}, data), budget) as CatalogCommand;
  });
}

function captureCommandCatalog(commandRegistry: CommandRegistry, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const commands = commandRegistry.list();
  const catalog = captureCommands(commands);
  const handlers = commands.map((command) => Object.getOwnPropertyDescriptor(command, 'handler')?.value);
  const revision = JSON.stringify(catalog);
  const assertCurrent = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const current = commandRegistry.list();
    const currentData = captureCommands(current);
    if (current.length !== commands.length || current.some((command, index) => command !== commands[index]
      || Object.getOwnPropertyDescriptor(command, 'handler')?.value !== handlers[index])
      || JSON.stringify(currentData) !== revision) throw new ToolInputProjectionError('stale');
  };
  return { commands, catalog, assertCurrent };
}

async function matchingCommands(commandRegistry: CommandRegistry, query: string, options: CatalogRankingOptions) {
  const { catalog, assertCurrent } = captureCommandCatalog(commandRegistry, options);
  if (!query) return { matches: catalog.slice().sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ entry, judgment: undefined })), assertCurrent };
  const result = await rankHarnessCatalog(catalog, query, (entry) => ({ id: entry.name, description: commandSearchText(entry), evidence: entry }), 'agent.harness.commands', { ...options, requirePreservedSource: true, assertCurrent });
  assertCurrent();
  return { ...result, assertCurrent };
}

function describeCommand(command: CatalogCommand, lookup?: CommandDetailLookup): Record<string, unknown> {
  const policy = describeCommandPolicy(command.name);
  const modelRoute = previewText(policy.preferredModelTool ?? `workspace action:"command" commandName:"${command.name}"`);
  const confirmationArgs = policy.requiresConfirmation === false ? '' : ' confirm:true explicitUserRequest:"..."';
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
      run: `agent_harness mode:"run_command" commandName:"${command.name}"${confirmationArgs}`,
      preferred: modelRoute,
      directInspect: `workspace action:"command" commandName:"${command.name}"`,
      directRun: `workspace action:"run_command" commandName:"${command.name}"${confirmationArgs}`,
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

function describeCommandCandidate(command: CatalogCommand): Record<string, unknown> {
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

export async function resolveHarnessCommandDetail(commandRegistry: CommandRegistry, args: AgentHarnessCommandCatalogArgs, options: CatalogRankingOptions = {}): Promise<CommandDetailResolution | null> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const lookup = commandDetailLookupFromArgs(args);
  if (!lookup?.parsedName) return null;
  const captured = captureCommandCatalog(commandRegistry, options);
  const direct = commandRegistry.get(lookup.parsedName);
  if (direct) {
    return {
      status: 'found',
      command: direct,
      assertCurrent: captured.assertCurrent,
      lookup: {
        ...lookup,
        resolvedBy: direct.name === lookup.parsedName ? 'name' : 'alias',
      },
    };
  }

  const normalized = lookup.parsedName.toLowerCase();
  for (const [index, data] of captured.catalog.entries()) {
    const command = captured.commands[index]!;
    if (data.name.toLowerCase() === normalized) {
      return { status: 'found', command, lookup: { ...lookup, resolvedBy: 'case-insensitive-name' }, assertCurrent: captured.assertCurrent };
    }
    if ((data.aliases ?? []).some((alias) => alias.toLowerCase() === normalized)) {
      return { status: 'found', command, lookup: { ...lookup, resolvedBy: 'case-insensitive-alias' }, assertCurrent: captured.assertCurrent };
    }
  }

  // Explicit command names and parsed invocations never become guessed effects.
  if (lookup.source === 'commandName' || lookup.source === 'command') return null;
  const found = await matchingCommands(commandRegistry, lookup.input, options);
  found.assertCurrent();
  if (found.matches.length === 1 && found.matches[0]!.judgment?.reading.verdict === 'yes') {
    const selected = commandRegistry.get(found.matches[0]!.entry.name);
    if (!selected) throw new ToolInputProjectionError('stale');
    return { status: 'found', command: selected, lookup: { ...lookup, resolvedBy: 'description' }, assertCurrent: found.assertCurrent };
  }
  if (found.matches.length > 0) return { status: 'ambiguous', input: lookup.input,
    candidates: found.matches.slice(0, 8).map(({ entry, judgment }) => ({ ...describeCommandCandidate(entry), judgment })),
  };
  return null;
}

export async function searchHarnessCommands(
  commandRegistry: CommandRegistry,
  args: AgentHarnessCommandCatalogArgs,
  options: CatalogRankingOptions = {},
): Promise<CatalogSearchResult<Record<string, unknown>>> {
  const query = readString(args.query);
  const limit = readLimit(args.limit, 500);
  const includeParameters = args.includeParameters === true;
  const found = await matchingCommands(commandRegistry, query, options);
  found.assertCurrent();
  return {
    matches: found.matches
      .slice(0, limit)
      .map(({ entry, judgment }) => ({ ...(includeParameters ? describeCommand(entry) : describeCommandCandidate(entry)), ...(judgment ? { judgment } : {}) })),
    relaxed: false,
  };
}

export async function describeHarnessCommand(commandRegistry: CommandRegistry, args: AgentHarnessCommandCatalogArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown> | null> {
  const detail = await resolveHarnessCommandDetail(commandRegistry, args, options);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (detail?.status === 'found') { detail.assertCurrent?.(); return describeCommand(detail.command, detail.lookup); }
  if (detail?.status === 'ambiguous') return { status: 'ambiguous', input: detail.input, candidates: detail.candidates };
  return null;
}
