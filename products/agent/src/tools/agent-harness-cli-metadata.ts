import type { GoodVibesCliCommand } from '../cli/types.ts';
import { describeGoodVibesCommandHelp } from '../cli/help.ts';
import {
  listBlockedGoodVibesCliCommandTokens,
  listGoodVibesCliCommandTokens,
  listGoodVibesCliCommands,
  parseGoodVibesCli,
} from '../cli/parser.ts';
import { describeCliCommandPolicy } from './agent-harness-metadata.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { shellSplit } from '@goodvibes-jev/engine/sdk/platform/utils';

export interface AgentHarnessCliArgs {
  readonly query?: unknown;
  readonly command?: unknown;
  readonly cliCommand?: unknown;
  readonly commandName?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface CliCommandLookup {
  readonly source: 'cliCommand' | 'command' | 'commandName' | 'target' | 'query' | 'default';
  readonly input: string;
  readonly resolvedBy: 'invocation' | 'command-name' | 'default' | 'search';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function previewText(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function redactConfigOverride(override: string): string {
  const equals = override.indexOf('=');
  return equals < 0 ? '<redacted>' : `${override.slice(0, equals)}=<redacted>`;
}

function redactCliLookupInput(input: string): string {
  const tokens = shellSplit(input);
  let changed = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') break;
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (flag !== '--config' && flag !== '-c') continue;
    if (equals >= 0) {
      tokens[index] = `${flag}=${redactConfigOverride(token.slice(equals + 1))}`;
      changed = true;
    } else {
      const value = tokens[index + 1];
      if (value !== undefined && (!value.startsWith('-') || value === '-')) {
        tokens[++index] = redactConfigOverride(value);
        changed = true;
      }
    }
  }
  return changed ? tokens.map(token => /\s/.test(token) ? JSON.stringify(token) : token).join(' ') : input;
}

function cliCommandTokens(command: GoodVibesCliCommand): readonly string[] {
  if (command === 'unknown') return [];
  if (command === 'tui') return ['(no command)'];
  return listGoodVibesCliCommandTokens()
    .filter((token) => parseGoodVibesCli([token]).command === command)
    .sort();
}

function fallbackCliSummary(command: GoodVibesCliCommand): string {
  if (command === 'tui') return 'Launch the interactive Agent TUI.';
  if (command === 'help') return 'Print top-level or command-specific help.';
  if (command === 'version') return 'Print the installed Agent package version.';
  return 'Inspect the CLI help for this Agent package command.';
}

function describeCliCommand(command: GoodVibesCliCommand, lookup?: CliCommandLookup): Record<string, unknown> {
  const help = describeGoodVibesCommandHelp(command);
  const tokens = cliCommandTokens(command);
  const policy = describeCliCommandPolicy(command);
  const modelRoute = previewText(policy.preferredModelTool ?? 'agent_harness mode:"cli_command"');
  return {
    name: command,
    tokens,
    invocation: command === 'tui' ? 'goodvibes-agent' : `goodvibes-agent ${tokens[0] ?? command}`,
    ...(lookup ? { lookup } : {}),
    helpTopic: help?.command ?? command,
    summary: help?.summary ?? fallbackCliSummary(command),
    usage: help?.usage ?? (command === 'tui' ? ['goodvibes-agent [OPTIONS]'] : [`goodvibes-agent ${command} [ARGS]`]),
    aliases: help?.aliases ?? tokens.filter((token) => token !== command),
    subcommands: help?.subcommands ?? [],
    examples: help?.examples ?? [],
    modelRoute,
    modelAccess: {
      inspect: `agent_harness mode:"cli_command" cliCommand:"${command}"`,
      executeEquivalent: policy.preferredModelTool ?? 'Use the current conversation or an explicit user-requested shell command.',
      preferred: modelRoute,
    },
    policy,
  };
}

function captureCliSources(args: AgentHarnessCliArgs, options: CatalogRankingOptions) {
  const signal = options.signal, owner = options.sourceOwner, outerCurrent = options.assertCurrent;
  const retainCurrent = options.retainCurrent, preserved = options.requirePreservedSource;
  signal?.throwIfAborted(); outerCurrent?.();
  const readCommands = () => listGoodVibesCliCommands().filter(command => command !== 'unknown').map(name => ({ name, descriptor: describeCliCommand(name) }));
  const commands = captureCatalogData(readCommands());
  const input = captureCatalogData(args);
  const revision = JSON.stringify({ commands, input });
  const assertCurrent = () => {
    if (options.signal !== signal || options.sourceOwner !== owner || options.assertCurrent !== outerCurrent
      || options.retainCurrent !== retainCurrent || options.requirePreservedSource !== preserved) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted(); outerCurrent?.();
    if (JSON.stringify(captureCatalogData({ commands: readCommands(), input: args })) !== revision) throw new ToolInputProjectionError('stale');
  };
  assertCurrent();
  retainCurrent?.(assertCurrent, 'agent.harness.cli-commands.sources');
  assertCurrent();
  return { commands, input, assertCurrent };
}

async function rankCliCommands(sources: ReturnType<typeof captureCliSources>, query: string, options: CatalogRankingOptions) {
  sources.assertCurrent();
  if (!query) return { matches: sources.commands.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  return rankHarnessCatalog(sources.commands, query, entry => ({ id: entry.name, description: JSON.stringify(entry.descriptor), evidence: entry.descriptor }),
    'agent.harness.cli-commands', { ...options, requirePreservedSource: true, assertCurrent: sources.assertCurrent });
}

function cliCommandCandidate(command: Record<string, unknown>): Record<string, unknown> {
  const policy = typeof command.policy === 'object' && command.policy !== null
    ? command.policy as { readonly effect?: unknown; readonly preferredModelTool?: unknown }
    : {};
  return {
    name: command.name,
    tokens: command.tokens,
    invocation: command.invocation,
    summary: command.summary,
    effect: typeof policy.effect === 'string' ? policy.effect : 'unknown',
    ...(typeof policy.preferredModelTool === 'string' ? { modelRoute: previewText(policy.preferredModelTool) } : {}),
  };
}

export function totalHarnessCliCommands(): number {
  return listGoodVibesCliCommands().filter((command) => command !== 'unknown').length;
}

export function blockedHarnessCliCommandTokens(): readonly string[] {
  return listBlockedGoodVibesCliCommandTokens();
}

export async function listHarnessCliCommands(args: AgentHarnessCliArgs, options: CatalogRankingOptions = {}): Promise<readonly Record<string, unknown>[]> {
  const sources = captureCliSources(args, options);
  const query = readString(sources.input.query);
  const limit = readLimit(sources.input.limit, 200);
  const includeParameters = sources.input.includeParameters === true;
  const selected = await rankCliCommands(sources, query, options);
  sources.assertCurrent();
  return selected.matches
    .slice(0, limit)
    .map(({ entry, judgment }) => ({ ...(includeParameters ? entry.descriptor : cliCommandCandidate(entry.descriptor)), ...(judgment ? { judgment } : {}) }));
}

function cliInputFromArgs(args: AgentHarnessCliArgs): { readonly source: CliCommandLookup['source']; readonly input: string } | null {
  const cliCommand = readString(args.cliCommand);
  if (cliCommand) return { source: 'cliCommand', input: cliCommand };
  const command = readString(args.command);
  if (command) return { source: 'command', input: command };
  const commandName = readString(args.commandName);
  if (commandName) return { source: 'commandName', input: commandName };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  if (query) return { source: 'query', input: query };
  return null;
}

function cliTokensFromRaw(raw: string): readonly string[] {
  const tokens = shellSplit(raw);
  if (tokens[0] === 'goodvibes-agent' || tokens[0]?.endsWith('/goodvibes-agent')) return tokens.slice(1);
  return tokens;
}

function isConcreteCliSource(source: CliCommandLookup['source']): boolean {
  return source === 'cliCommand' || source === 'command' || source === 'commandName';
}

export async function describeHarnessCliCommand(args: AgentHarnessCliArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const sources = captureCliSources(args, options);
  const input = cliInputFromArgs(sources.input);
  if (!input) return describeCliCommand('tui', { source: 'default', input: '', resolvedBy: 'default' });
  const lookupInput = redactCliLookupInput(input.input);
  if (input.source === 'commandName') {
    const name = input.input.toLowerCase();
    const exact = listGoodVibesCliCommands().find(command => command === name);
    const command = exact ?? (listGoodVibesCliCommandTokens().includes(name) ? parseGoodVibesCli([name]).command : undefined);
    sources.assertCurrent();
    return command === undefined || command === 'unknown'
      ? { supported: false, status: 'missing_lookup', token: lookupInput, blockedTokens: blockedHarnessCliCommandTokens() }
      : describeCliCommand(command, { source: input.source, input: lookupInput, resolvedBy: 'command-name' });
  }
  const tokens = cliTokensFromRaw(input.input);
  const parsed = parseGoodVibesCli(tokens);
  const firstToken = tokens[0]?.toLowerCase();
  const directInvocation = isConcreteCliSource(input.source)
    || (firstToken !== undefined && [...listGoodVibesCliCommandTokens(), ...blockedHarnessCliCommandTokens()].includes(firstToken))
    || input.input === 'goodvibes-agent' || input.input.startsWith('goodvibes-agent ')
    || (tokens.every(token => token.startsWith('-')) && parsed.errors.length === 0);
  if (!directInvocation) {
    const selected = await rankCliCommands(sources, input.input, options);
    const matches = selected.matches;
    sources.assertCurrent();
    if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment.reading.outcome === 'act') {
      return {
        ...matches[0]!.entry.descriptor,
        judgment: matches[0]!.judgment,
        lookup: { source: input.source, input: lookupInput, resolvedBy: 'search' },
      };
    }
    if (matches.length > 0) {
      return {
        supported: false,
        status: 'ambiguous',
        input: lookupInput,
        candidates: matches.map(({ entry, judgment }) => ({ ...cliCommandCandidate(entry.descriptor), judgment })).slice(0, 8),
        note: 'The catalog reading did not settle one top-level CLI mirror. Provide cliCommand or commandName with one concrete command token.',
      };
    }
  }
  if (parsed.command === 'unknown' || !directInvocation) {
    sources.assertCurrent();
    return {
      supported: false,
      token: parsed.rawCommand ?? tokens[0],
      errors: parsed.errors,
      blockedTokens: blockedHarnessCliCommandTokens(),
      policy: describeCliCommandPolicy(parsed.rawCommand ?? tokens[0] ?? 'unknown'),
    };
  }
  sources.assertCurrent();
  return {
    ...describeCliCommand(parsed.command, { source: input.source, input: lookupInput, resolvedBy: 'invocation' }),
    parsed: {
      command: parsed.command,
      rawCommand: parsed.rawCommand,
      commandArgs: parsed.commandArgs,
      positionals: parsed.positionals,
      flags: {
        provider: parsed.flags.provider,
        model: parsed.flags.model,
        agentProfile: parsed.flags.agentProfile,
        runtimeUrl: parsed.flags.runtimeUrl,
        workingDir: parsed.flags.workingDir,
        help: parsed.flags.help,
        version: parsed.flags.version,
        print: parsed.flags.print,
        outputFormat: parsed.flags.outputFormat,
        configOverrides: parsed.flags.configOverrides.map(redactConfigOverride),
        enableFeatures: parsed.flags.enableFeatures,
        disableFeatures: parsed.flags.disableFeatures,
        noAltScreen: parsed.flags.noAltScreen,
        port: parsed.flags.port,
        hostname: parsed.flags.hostname,
        open: parsed.flags.open,
        continueLast: parsed.flags.continueLast,
        resume: parsed.flags.resume,
        session: parsed.flags.session,
        fork: parsed.flags.fork,
        rawOutput: parsed.flags.rawOutput,
        acceptRawOutputRisk: parsed.flags.acceptRawOutputRisk,
      },
      errors: parsed.errors,
    },
  };
}
