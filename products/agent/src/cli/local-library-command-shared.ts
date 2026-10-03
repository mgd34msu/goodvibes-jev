import { createShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

/**
 * Shared prelude for the Agent-local library CLI commands (personas, skills,
 * skill bundles): option parsing, success/failure envelopes, and registry
 * accessors. Split out of local-library-command.ts (the file
 * cleanly contained three independent command handlers glued together) so
 * personas-command.ts, skills-command.ts, and skill-bundle-command.ts can
 * share one option-parsing/output prelude without duplicating it.
 */

export interface CommandSuccess<TData> {
  readonly ok: true;
  readonly kind: string;
  readonly data: TData;
}

export interface CommandFailure {
  readonly ok: false;
  readonly kind: string;
  readonly error: string;
}

export interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

export const LOCAL_LIBRARY_VALUE_OPTIONS = [
  'name',
  'description',
  'body',
  'procedure',
  'tags',
  'triggers',
  'requires-env',
  'requires-command',
  'requires-commands',
  'skills',
  'provenance',
] as const;

export function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

export function success<TData>(runtime: CliCommandRuntime, kind: string, data: TData, text: string): CliCommandOutput {
  const value: CommandSuccess<TData> = { ok: true, kind, data };
  return { output: jsonOrText(runtime, value, text), exitCode: 0 };
}

export function failure(runtime: CliCommandRuntime, kind: string, error: string, exitCode: number): CliCommandOutput {
  const value: CommandFailure = { ok: false, kind, error };
  return {
    output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : error,
    exitCode,
  };
}

export function parseOptions(args: readonly string[], valueOptions: readonly string[] = LOCAL_LIBRARY_VALUE_OPTIONS): ParsedOptions {
  const valued = new Set(valueOptions);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const equalIndex = raw.indexOf('=');
    if (equalIndex >= 0) {
      values.set(raw.slice(0, equalIndex), raw.slice(equalIndex + 1));
      continue;
    }
    const name = raw;
    const next = args[index + 1];
    if (next !== undefined && (valued.has(name) || !next.startsWith('--'))) {
      values.set(name, next);
      index += 1;
      continue;
    }
    flags.add(name);
  }
  return { values, flags, positionals };
}

export function optionValue(options: ParsedOptions, name: string): string | undefined {
  const value = options.values.get(name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requiredOption(options: ParsedOptions, name: string, usage: string): string {
  const value = optionValue(options, name);
  if (!value) throw new Error(`${usage}\nMissing --${name}.`);
  return value;
}

export function csvOption(options: ParsedOptions, name: string): readonly string[] | undefined {
  const value = optionValue(options, name);
  if (value === undefined) return undefined;
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function hasFlag(options: ParsedOptions, name: string): boolean {
  return options.flags.has(name);
}

export function personaRegistry(runtime: CliCommandRuntime): AgentPersonaRegistry {
  return AgentPersonaRegistry.fromShellPaths(createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  }));
}

export function skillRegistry(runtime: CliCommandRuntime): AgentSkillRegistry {
  return AgentSkillRegistry.fromShellPaths(createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  }));
}

export function shellPaths(runtime: CliCommandRuntime): ReturnType<typeof createShellPathService> {
  return createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
}

export function errorOutput(runtime: CliCommandRuntime, error: unknown, kind: string): CliCommandOutput {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = message.startsWith('Usage:') || message.includes('\nMissing --') ? 2 : 1;
  return failure(runtime, kind, message, exitCode);
}
