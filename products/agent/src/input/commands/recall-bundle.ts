import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import type { MemoryBundle, MemorySearchFilter } from '@goodvibes-jev/engine/sdk/platform/state';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope, resolveBundlePath } from './recall-shared.ts';
import { requireShellPaths } from './runtime-services.ts';
import { getMemoryApi } from './recall-query.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

export function handleRecallExport(args: string[], context: CommandContext): void {
  const parsed = stripYesFlag(args);
  const commandArgs = [...parsed.rest];
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }

  const pathArg = commandArgs[0];
  if (!pathArg) {
    context.print('[memory] Usage: /memory export <path> [--scope <scope>] [--cls <class>] --yes');
    return;
  }
  if (!parsed.yes) {
    requireYesFlag(context, `export durable memory bundle to ${pathArg}`, '/memory export <path> [--scope <scope>] [--cls <class>] --yes');
    return;
  }

  const filter: MemorySearchFilter = {};
  const scopeIdx = commandArgs.indexOf('--scope');
  if (scopeIdx !== -1 && commandArgs[scopeIdx + 1]) {
    const scope = commandArgs[scopeIdx + 1];
    if (!isValidScope(scope)) {
      context.print(`[memory] Unknown scope "${scope}". Valid values ${VALID_SCOPES.join(', ')}.`);
      return;
    }
    filter.scope = scope;
  }

  const clsIdx = commandArgs.indexOf('--cls');
  if (clsIdx !== -1 && commandArgs[clsIdx + 1]) {
    const cls = commandArgs[clsIdx + 1];
    if (!isValidClass(cls)) {
      context.print(`[memory] Unknown class "${cls}". Valid values ${VALID_CLASSES.join(', ')}.`);
      return;
    }
    filter.cls = cls;
  }

  const bundle = memory.exportBundle(filter);
  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  context.print(`[memory] Exported ${bundle.recordCount} record(s) and ${bundle.linkCount} link(s) to ${targetPath}`);
}

export async function handleRecallImport(args: string[], context: CommandContext): Promise<void> {
  const parsed = stripYesFlag(args);
  const commandArgs = [...parsed.rest];
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }

  const pathArg = commandArgs[0];
  if (!pathArg) {
    context.print('[memory] Usage: /memory import <path> --yes');
    return;
  }
  if (!parsed.yes) {
    requireYesFlag(context, `import durable memory bundle from ${pathArg}`, '/memory import <path> --yes');
    return;
  }

  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  let bundle: MemoryBundle;
  try {
    bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as MemoryBundle;
  } catch (error) {
    context.print(`[memory] Failed to read memory bundle ${summarizeError(error)}`);
    return;
  }

  const result = await memory.importBundle(bundle);
  context.print(`[memory] Imported bundle from ${targetPath}`);
  context.print(`  records imported=${result.importedRecords} skipped=${result.skippedRecords}`);
  context.print(`  links imported=${result.importedLinks}`);
}

function inspectBundle(bundle: MemoryBundle): string {
  return [
    'Memory Handoff Review',
    `  scope ${bundle.scope}`,
    `  records ${bundle.recordCount}`,
    `  links ${bundle.linkCount}`,
    `  exportedAt ${new Date(bundle.exportedAt).toISOString()}`,
  ].join('\n');
}

export function handleRecallHandoffExport(args: string[], context: CommandContext): void {
  const parsed = stripYesFlag(args);
  const commandArgs = [...parsed.rest];
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const pathArg = commandArgs[0];
  if (!pathArg) {
    context.print('[memory] Usage: /memory handoff-export <path> [--scope <scope>] --yes');
    return;
  }
  if (!parsed.yes) {
    requireYesFlag(context, `export memory handoff bundle to ${pathArg}`, '/memory handoff-export <path> [--scope <scope>] --yes');
    return;
  }
  const scopeIdx = commandArgs.indexOf('--scope');
  const scopeRaw = scopeIdx !== -1 ? commandArgs[scopeIdx + 1] : 'team';
  if (!scopeRaw || !isValidScope(scopeRaw)) {
    context.print(`[memory] Unknown scope "${scopeRaw ?? ''}". Valid values ${VALID_SCOPES.join(', ')}.`);
    return;
  }
  const bundle = memory.exportBundle({ scope: scopeRaw });
  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  context.print(`[memory] Exported ${scopeRaw} handoff bundle to ${targetPath}`);
}

export function handleRecallHandoffInspect(args: string[], context: CommandContext): void {
  const pathArg = args[0];
  if (!pathArg) {
    context.print('[memory] Usage: /memory handoff-inspect <path>');
    return;
  }
  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  try {
    const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as MemoryBundle;
    context.print(inspectBundle(bundle));
  } catch (error) {
    context.print(`[memory] Failed to inspect handoff bundle ${summarizeError(error)}`);
  }
}

export async function handleRecallHandoffImport(args: string[], context: CommandContext): Promise<void> {
  const parsed = stripYesFlag(args);
  const commandArgs = [...parsed.rest];
  const pathArg = commandArgs[0];
  if (!pathArg) {
    context.print('[memory] Usage: /memory handoff-import <path> --yes');
    return;
  }
  await handleRecallImport([pathArg, ...(parsed.yes ? ['--yes'] : [])], context);
}
