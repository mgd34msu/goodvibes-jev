/**
 * Load optional dependencies when their feature is used, so a missing package
 * reports that feature as unavailable without preventing daemon startup.
 * Cache both successful and failed resolutions for this process. Keep literal
 * dynamic imports in the load callbacks so compiled builds can bundle the
 * optional packages that are installed.
 */

import { summarizeError } from './error-display.js';

/** What happened when the SDK tried to reach an optional package. */
export type OptionalDependencyLoad<T> =
  | { readonly available: true; readonly module: T }
  | { readonly available: false; readonly reason: string };

/** A stable, operator-readable statement of why a feature is unavailable. */
export function optionalDependencyUnavailable(name: string, error: unknown): string {
  return (
    `${name} is not installed, so the feature that needs it is unavailable: ${summarizeError(error)}. `
    + `It is an optional dependency of @goodvibes-jev/engine, install it to enable this feature.`
  );
}

const cache = new Map<string, Promise<OptionalDependencyLoad<unknown>>>();

/**
 * Load an optional package once per process and remember the outcome.
 *
 * `name` is the package as declared in `optionalDependencies` and is what the
 * unavailability message names; `load` is the dynamic import itself, written
 * out at the call site so a bundler can still see and bundle the specifier.
 */
export function loadOptionalDependency<T>(
  name: string,
  load: () => Promise<T>,
): Promise<OptionalDependencyLoad<T>> {
  const cached = cache.get(name);
  if (cached) return cached as Promise<OptionalDependencyLoad<T>>;
  const attempt = load().then(
    (module): OptionalDependencyLoad<T> => ({ available: true, module }),
    (error: unknown): OptionalDependencyLoad<T> => ({
      available: false,
      reason: optionalDependencyUnavailable(name, error),
    }),
  );
  cache.set(name, attempt as Promise<OptionalDependencyLoad<unknown>>);
  return attempt;
}

/**
 * Forget every cached outcome. For tests that install or hide a package
 * between cases; nothing in the running platform calls this.
 */
export function resetOptionalDependencyCache(): void {
  cache.clear();
}
