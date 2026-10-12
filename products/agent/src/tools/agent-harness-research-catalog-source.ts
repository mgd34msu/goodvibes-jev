import type { CommandContext } from '../input/command-registry.ts';
import { observeImportFile, assertImportFileCurrent } from '@goodvibes-jev/engine/sdk/platform/config';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentResearchRunRegistry, researchRunStorePath } from '../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry, researchSourceStorePath } from '../agent/research-source-registry.ts';
import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import { captureCatalogMethods, captureCatalogSnapshot, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath, withModelReadingSource } from './agent-harness-model-reading-source.ts';

/** A native path is a restriction, never a provider-supplied owner. */
export function captureCatalogPath(root: object, keys: readonly string[]): { readonly value: unknown; readonly assertCurrent: () => void } {
  const guards: (() => void)[] = [];
  let current: unknown = root;
  for (const key of keys) {
    if (current == null) break;
    if (typeof current !== 'object') throw new ToolInputProjectionError('held');
    guards.push(captureCatalogMethods(current, [key]));
    current = modelReadingServicePath(current, [key]);
  }
  const value = modelReadingServicePath(root, keys);
  const assertCurrent = (): void => {
    for (const guard of guards) guard();
    if (modelReadingServicePath(root, keys) !== value) throw new ToolInputProjectionError('held');
  };
  assertCurrent(); return { value, assertCurrent };
}

/** Full native bytes are screened before any normalized catalog is read semantically. */
export async function withNativeCatalog<A, D, R>(rawArgs: A, options: CatalogRankingOptions, paths: readonly string[],
  read: () => D, consume: (args: A, data: D, options: CatalogRankingOptions) => Promise<R>): Promise<R> {
  const caller = captureAsyncHarnessInput(rawArgs, options);
  caller.retainSourceCurrent();
  const files = paths.map(path => ({ path, observation: observeImportFile(path) }));
  caller.assertCurrent();
  const raw = read(), snapshot = captureCatalogSnapshot(raw);
  const assertNative = (): void => {
    for (const file of files) assertImportFileCurrent(file.path, file.observation);
    snapshot.assertCurrent(raw); snapshot.assertCurrent(read()); snapshot.assertCurrent(raw);
    for (const file of files) assertImportFileCurrent(file.path, file.observation);
  };
  const assertCurrent = (): void => { caller.assertCurrent(); assertNative(); caller.assertCurrent(); };
  assertCurrent(); caller.options.retainCurrent?.(assertNative);
  return withModelReadingSource({ request: caller.args, files: files.map(file => ({ contents: file.observation.raw })), data: snapshot.captured },
    { ...caller.options, assertCurrent }, async (captured, scoped) => {
      const result = await consume(captured.request, captured.data, { ...scoped, requirePreservedSource: true });
      scoped.assertCurrent?.(); return result;
    });
}

export async function withResearchCatalog<A, D, R>(context: CommandContext, args: A, options: CatalogRankingOptions,
  read: () => D, consume: (args: A, data: D, options: CatalogRankingOptions) => Promise<R>): Promise<R> {
  const caller = captureAsyncHarnessInput(args, options);
  caller.retainSourceCurrent();
  const owner = captureCatalogPath(context, ['workspace', 'shellPaths']);
  const shellPaths = context.workspace?.shellPaths;
  const methodGuard = shellPaths ? captureCatalogMethods(shellPaths, ['resolveProjectPath']) : () => {};
  const registryGuards = [captureCatalogMethods(AgentResearchRunRegistry, ['fromShellPaths']), captureCatalogMethods(AgentResearchSourceRegistry, ['fromShellPaths']),
    captureCatalogMethods(AgentResearchRunRegistry.prototype, ['list', 'snapshot', 'readStore']), captureCatalogMethods(AgentResearchSourceRegistry.prototype, ['list', 'snapshot', 'readStore'])];
  const paths = shellPaths ? [researchRunStorePath(shellPaths), researchSourceStorePath(shellPaths)] : [];
  const assertMethods = (): void => { owner.assertCurrent(); methodGuard(); for (const guard of registryGuards) guard(); };
  const assertNative = (): void => {
    assertMethods();
    if (shellPaths && (researchRunStorePath(shellPaths) !== paths[0] || researchSourceStorePath(shellPaths) !== paths[1])) throw new ToolInputProjectionError('held');
    assertMethods();
  };
  caller.options.retainCurrent?.(assertNative);
  const assertCurrent = (): void => { caller.assertCurrent(); assertNative(); };
  assertCurrent();
  return withNativeCatalog(caller.args, { ...caller.options, assertCurrent }, paths, read, consume);
}

/** Unknown or held candidates cannot become an inclusion decision. */
export async function rankResearchRecords<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  options: CatalogRankingOptions, site: string, decisionName = 'engine.tools.registry-rank'): Promise<readonly T[]> {
  if (!query) { options.assertCurrent?.(); return entries; }
  const ids: string[] = [];
  const result = await rankHarnessCatalog(entries, query, entry => {
    options.assertCurrent?.(); const description = describe(entry); ids.push(description.id); options.assertCurrent?.(); return description;
  }, site, { ...options, requirePreservedSource: true }, decisionName);
  options.assertCurrent?.();
  if (result.judgments.some(judgment => judgment.reading.outcome !== 'act' || judgment.reading.verdict === 'uncertain')) throw new ToolInputProjectionError('held');
  const selected = result.matches.map(match => {
    const index = ids.indexOf(match.judgment.id), original = entries[index];
    if (index < 0 || original === undefined) throw new ToolInputProjectionError('held');
    return original;
  });
  options.assertCurrent?.(); return selected;
}
