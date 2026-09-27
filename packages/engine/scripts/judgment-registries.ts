// judgment-registries.ts
//
// Finds and loads every judgment registry in packages/engine (each
// `judgment-registry.ts` exports a BatteryRegistry named `registry`), so the
// judgment lint and the observe report see every registered decision,
// including registries added after these scripts were written.

import { resolve } from 'node:path';
import { BatteryRegistry, type NamedDecision } from '@goodvibes-jev/judgment';

export const ENGINE_ROOT = resolve(import.meta.dir, '..');

const REGISTRY_FILE = '**/judgment-registry.ts';
const SKIPPED = /(^|\/)(node_modules|dist|test)\//;

/** Every registry file under the engine, repo-relative to packages/engine, sorted. */
export function registryFiles(root: string = ENGINE_ROOT): string[] {
  return [...new Bun.Glob(REGISTRY_FILE).scanSync({ cwd: root })].filter((file) => !SKIPPED.test(file)).sort();
}

export interface LoadedRegistries {
  readonly files: readonly string[];
  /** The decisions each registry file registers, in file order. */
  readonly byFile: readonly { readonly file: string; readonly decisions: readonly NamedDecision[] }[];
  /** Every registered decision, by name, in name order. */
  readonly decisions: readonly NamedDecision[];
  /** Names two registries register as different decisions. */
  readonly conflicts: readonly string[];
}

/**
 * Imports every registry and merges them by name. A decision registered in
 * two registries (a sub-registry merged into its parent) counts once; two
 * different decisions under one name are a conflict.
 */
export async function loadEngineRegistries(root: string = ENGINE_ROOT): Promise<LoadedRegistries> {
  const files = registryFiles(root);
  const byName = new Map<string, NamedDecision>();
  const conflicts = new Set<string>();
  const byFile: { file: string; decisions: readonly NamedDecision[] }[] = [];
  for (const file of files) {
    const loaded = (await import(resolve(root, file))) as { registry?: unknown };
    if (!(loaded.registry instanceof BatteryRegistry)) throw new Error(`${file} does not export a BatteryRegistry named "registry"`);
    byFile.push({ file, decisions: loaded.registry.list() });
    for (const decision of loaded.registry.list()) {
      const known = byName.get(decision.name);
      if (known !== undefined && known !== decision) conflicts.add(decision.name);
      byName.set(decision.name, known ?? decision);
    }
  }
  return {
    files,
    byFile,
    decisions: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    conflicts: [...conflicts].sort(),
  };
}
