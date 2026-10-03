import type { GoodVibesCliCommand } from '../cli/types.ts';
import { describeGoodVibesCommandHelp } from '../cli/help.ts';
import {
  listBlockedGoodVibesCliCommandTokens,
  listGoodVibesCliCommandTokens,
  listGoodVibesCliCommands,
  parseGoodVibesCli,
} from '../cli/parser.ts';
import { describeCliCommandPolicy } from './agent-harness-metadata.ts';

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
  readonly resolvedBy: 'invocation' | 'default' | 'search';
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

function redactCliLookupInput(input: string): string {
  return input
    .replace(/(--config=)([^=\s]+)=\S+/g, '$1$2=<redacted>')
    .replace(/(--config\s+)([^=\s]+)=\S+/g, '$1$2=<redacted>');
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

function cliCommandMatches(command: Record<string, unknown>, query: string): boolean {
  if (!query) return true;
  return [
    command.name,
    command.tokens,
    command.summary,
    command.usage,
    command.aliases,
    command.subcommands,
    command.examples,
    command.policy,
  ].map((value) => JSON.stringify(value)).join('\n').toLowerCase().includes(query.toLowerCase());
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

export function listHarnessCliCommands(args: AgentHarnessCliArgs): readonly Record<string, unknown>[] {
  const query = readString(args.query);
  const limit = readLimit(args.limit, 200);
  const includeParameters = args.includeParameters === true;
  return listGoodVibesCliCommands()
    .filter((command) => command !== 'unknown')
    .map((command) => describeCliCommand(command))
    .filter((command) => cliCommandMatches(command, query))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map((command) => includeParameters ? command : cliCommandCandidate(command));
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
  const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
  if (tokens[0] === 'goodvibes-agent' || tokens[0]?.endsWith('/goodvibes-agent')) return tokens.slice(1);
  return tokens;
}

function isConcreteCliSource(source: CliCommandLookup['source']): boolean {
  return source === 'cliCommand' || source === 'command' || source === 'commandName';
}

export function describeHarnessCliCommand(args: AgentHarnessCliArgs): Record<string, unknown> {
  const input = cliInputFromArgs(args);
  if (!input) return describeCliCommand('tui', { source: 'default', input: '', resolvedBy: 'default' });
  const lookupInput = redactCliLookupInput(input.input);
  const tokens = cliTokensFromRaw(input.input);
  const parsed = parseGoodVibesCli(tokens);
  const directInvocation = parsed.command !== 'unknown' && (
    isConcreteCliSource(input.source)
    || String(parsed.rawCommand ?? '').toLowerCase() === String(tokens[0] ?? '').toLowerCase()
  );
  if (!directInvocation) {
    const matches = listGoodVibesCliCommands()
      .filter((command) => command !== 'unknown')
      .map((command) => describeCliCommand(command))
      .filter((command) => cliCommandMatches(command, input.input))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (matches.length === 1) {
      return {
        ...matches[0]!,
        lookup: { source: input.source, input: lookupInput, resolvedBy: 'search' },
      };
    }
    if (matches.length > 1) {
      return {
        supported: false,
        status: 'ambiguous',
        input: lookupInput,
        candidates: matches.map(cliCommandCandidate).slice(0, 8),
        note: 'Multiple top-level CLI mirrors matched this lookup. Provide cliCommand or commandName with one concrete command token.',
      };
    }
    return {
      supported: false,
      token: parsed.rawCommand ?? tokens[0],
      errors: parsed.errors,
      blockedTokens: blockedHarnessCliCommandTokens(),
      policy: describeCliCommandPolicy(parsed.rawCommand ?? tokens[0] ?? 'unknown'),
    };
  }
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
        configOverrides: parsed.flags.configOverrides.map((override) => {
          const index = override.indexOf('=');
          return index < 0 ? override : `${override.slice(0, index)}=<redacted>`;
        }),
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
