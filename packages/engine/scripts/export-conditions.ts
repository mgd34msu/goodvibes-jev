/**
 * The workspace packages' export conditions.
 *
 * Every subpath of the engine and judgment manifests lists the `bun` condition
 * first, naming its source file, then `types` and `import`, naming the built
 * output. Bun matches `bun` at runtime and the typechecker matches it through
 * `customConditions`, so the monorepo runs and checks against source. The
 * release stage drops the condition, so a published package resolves only
 * dist, the way the old per-package manifests did.
 */
export const SOURCE_CONDITION = 'bun';

/** One condition's target in an export entry, or undefined when the entry has none. */
export function exportCondition(value: unknown, condition: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const target = (value as Record<string, unknown>)[condition];
  return typeof target === 'string' ? target : undefined;
}

/** The exports map as published: every entry without its source condition. */
export function withoutSourceCondition(exports: unknown): unknown {
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return exports;
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, value];
      return [key, Object.fromEntries(Object.entries(value).filter(([condition]) => condition !== SOURCE_CONDITION))];
    }),
  );
}

/**
 * One old package's export map, read from the engine's `./<pkg>` subpaths:
 * keys become relative to the old package (`./sdk/auth` is `./auth`), targets
 * under `./<pkg>/` become relative to it (`./sdk/dist/auth.js` is
 * `./dist/auth.js`), the source condition is dropped, and JSON assets outside
 * the old package keep their engine-relative path.
 */
export function subpackageExports(exports: Record<string, unknown>, pkg: string): Record<string, unknown> {
  const prefix = `./${pkg}`;
  const rebase = (target: string): string => (target.startsWith(`${prefix}/`) ? `.${target.slice(prefix.length)}` : target);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exports)) {
    if (key !== prefix && !key.startsWith(`${prefix}/`)) continue;
    const subpath = key === prefix ? '.' : `.${key.slice(prefix.length)}`;
    if (typeof value === 'string') {
      out[subpath] = rebase(value);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    out[subpath] = Object.fromEntries(
      Object.entries(value)
        .filter(([condition]) => condition !== SOURCE_CONDITION)
        .map(([condition, target]) => [condition, typeof target === 'string' ? rebase(target) : target]),
    );
  }
  return out;
}
