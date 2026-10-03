/**
 * post-build-smoke, proves a freshly compiled binary boots.
 *
 * Runs `<binary> --version`, asserts the expected banner prefix, and rejects
 * output containing packaging-failure sentinels (e.g. `sqlite-vec`,
 * `$bunfs/root`) that mean a native addon or module failed to bundle.
 *
 * Also scans the artifact itself for top-level eager namespace-object reads
 * (`var X = exports_Y.Z;` at column 0 of the embedded bundle). Bun's bundler
 * emits module bodies in a nondeterministic order build-to-build; an eager
 * module-scope read off a lazy namespace object can therefore land before the
 * module that defines the binding, and the binary dies at load with a
 * ReferenceError, on SOME builds and not others. A binary that boots once is
 * safe forever (the order is baked at build time), but the pattern itself is a
 * per-build lottery, so an unproven read fails even if this build boots.
 * Constructor calls are exempt only when emitted synchronous initializer
 * dominance is proven; direct aliases keep the conservative original policy.
 */

import { readFileSync } from 'node:fs';
import type { Exec, ExecResult, Logger } from './effects.js';
import { realExec, consoleLogger } from './effects.js';
import type { SmokeConfig } from '../config.js';

/**
 * Top-level (column-0) eager read off a bundler lazy-namespace object. Reads
 * nested inside `__esm` init closures are indented and therefore not matched:
 * those run after the graph settles and are safe.
 */
const EAGER_NAMESPACE_READ = /(?:^|\n)var ([A-Za-z_$][\w$]*) = (exports_[A-Za-z_$][\w$]*)\.([\w$]+)/g;

interface EmittedModule {
  readonly start: number;
  readonly end: number;
  readonly prefixCalls: readonly { name: string; offset: number }[];
}

interface EmittedInitializer {
  readonly end: number;
  readonly body: string;
}

/**
 * A deliberately small proof for Bun's unminified emitted ESM format, not a
 * general JavaScript control-flow analysis. A namespace constructor call is
 * safe when its module's unconditional import prefix has already completed
 * the namespace's synchronous initializer through pure re-export wrappers.
 *
 * Ownership comes from an adjacent namespace/getter table and __esm closure
 * in ONE emitted source module, never from matching their generated names.
 * Each getter must resolve to a declared function whose own module initializer
 * also completes through that import prefix. Merely calling an unrelated
 * function inside the namespace owner cannot prove its bindings initialized.
 * Unsupported formatting/control flow fails closed to the original scanner.
 */
function namespaceCallProof(artifactText: string): (namespace: string, member: string, offset: number) => boolean {
  // The proof depends on __esm synchronously completing its callback. Do not
  // interpret similarly named functions or async wrappers as this helper.
  const helper = /^var __esm = \(fn, res\) => \(\) => \(fn && \(res = fn\(fn = 0\)\), res\);$/m.exec(artifactText);
  if (!helper || [...artifactText.matchAll(/^var __esm = /gm)].length !== 1
    || /^__esm\s*=/m.test(artifactText)) return () => false;

  const headers = [...artifactText.matchAll(/^\/\/ [^\r\n]+\.[cm]?[jt]sx?\n/gm)];
  const modules: EmittedModule[] = headers.map((header, index) => {
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? artifactText.length;
    const prefix = /^(?:\n)*(?:init_[\w$]+\(\);\n)+/.exec(artifactText.slice(start, end))?.[0] ?? '';
    return {
      start, end,
      prefixCalls: [...prefix.matchAll(/^(init_[\w$]+)\(\);$/gm)]
        .map((call) => ({ name: call[1]!, offset: start + call.index })),
    };
  });

  const initializers = new Map<string, EmittedInitializer>();
  const duplicateInitializers = new Set<string>();
  const namespaces = new Map<string, { owner: string; end: number; members: ReadonlyMap<string, string> }>();
  const functions = new Map<string, { owner: string; start: number }>();
  const duplicateFunctions = new Set<string>();
  const duplicateNamespaces = new Set<string>();
  for (const module of modules) {
    if (module.start < helper.index) continue;
    const text = artifactText.slice(module.start, module.end);
    const moduleInitializers: string[] = [];
    for (const init of text.matchAll(/^var (init_[\w$]+) = __esm\(\(\) => \{\n([\s\S]*?)^\}\);$/gm)) {
      const name = init[1]!;
      moduleInitializers.push(name);
      if (initializers.has(name)) duplicateInitializers.add(name);
      initializers.set(name, { end: module.start + init.index + init[0].length, body: init[2]! });
    }
    if (moduleInitializers.length === 1) {
      for (const declaration of text.matchAll(/^function ([A-Za-z_$][\w$]*)\(/gm)) {
        const name = declaration[1]!;
        if (functions.has(name)) duplicateFunctions.add(name);
        functions.set(name, { owner: moduleInitializers[0]!, start: module.start + declaration.index });
      }
    }
    for (const table of text.matchAll(/^var (exports_[\w$]+) = \{\};\n__export\(\1, \{\n((?:  [\w$]+: \(\) => [\w$]+,?\n)+)\}\);\nvar (init_[\w$]+) = __esm\(\(\) => \{\n/gm)) {
      const name = table[1]!;
      if (namespaces.has(name)) duplicateNamespaces.add(name);
      namespaces.set(name, {
        owner: table[3]!,
        end: module.start + table.index + table[0].length,
        members: new Map([...table[2]!.matchAll(/^  ([\w$]+): \(\) => ([\w$]+)/gm)]
          .map((member) => [member[1]!, member[2]!])),
      });
    }
  }
  for (const name of duplicateInitializers) initializers.delete(name);
  for (const name of duplicateNamespaces) namespaces.delete(name);
  for (const name of duplicateFunctions) functions.delete(name);

  // Only direct call statements are accepted in the owning re-export module.
  // Its dependency internals may contain legitimate ESM cycles: completion of
  // this synchronous owner still dominates a subsequent module-scope call.
  // Cycles in the wrapper proof itself are rejected below.
  const ownerBody = /^(?:  [A-Za-z_$][\w$]*\((?:[A-Za-z_$][\w$]*\(\))?\);\n)+$/;
  const wrapperBody = /^(?:  init_[\w$]+\(\);\n)+$/;
  const proves = (name: string, owner: string, before: number, visiting: Set<string>, namespaceOwner = true, mutationBefore = before): boolean => {
    const init = initializers.get(name);
    if (!init || init.end >= before || visiting.has(name) || firstMutation(name, init.end) < mutationBefore) return false;
    if (name === owner) {
      if (!namespaceOwner) return true;
      if (!ownerBody.test(init.body)) return false;
      return [...init.body.matchAll(/^  (init_[\w$]+)\(\);$/gm)].every((call) => {
        const dependency = initializers.get(call[1]!);
        return dependency !== undefined && dependency.end < before && firstMutation(call[1]!, dependency.end) >= mutationBefore
          && call[1] !== name && !visiting.has(call[1]!);
      });
    }
    if (!wrapperBody.test(init.body)) return false;
    visiting.add(name);
    // Every branch must reach the owner. This intentionally declines more
    // complex mixed wrappers rather than claiming arbitrary graph dominance.
    const result = [...init.body.matchAll(/  (init_[\w$]+)\(\);/g)]
      .every((call) => proves(call[1]!, owner, before, visiting, namespaceOwner, mutationBefore));
    visiting.delete(name);
    return result;
  };

  // Index writes once, including redeclarations and member writes. Searching
  // the entire compiled binary again for each graph binding is quadratic.
  const mutations = new Map<string, number[]>();
  for (const write of artifactText.matchAll(/^[ \t]*(?:(?:var|let|const)[ \t]+)?([A-Za-z_$][\w$]*)(?:\.[\w$]+|\[[^\n]*\])?[ \t]*(?:=(?!=|>)|(?:\*\*|&&|\|\||\?\?|[+*/%&|^~-])=|\+\+|--)/gm)) {
    const offsets = mutations.get(write[1]!) ?? [];
    offsets.push(write.index);
    mutations.set(write[1]!, offsets);
  }
  if (mutations.get('__esm')?.length !== 1) return () => false;
  const firstMutation = (name: string, after: number): number => {
    const offsets = mutations.get(name) ?? [];
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle]! < after) low = middle + 1;
      else high = middle;
    }
    return offsets[low] ?? Infinity;
  };
  return (namespace, member, offset) => {
    const table = namespaces.get(namespace);
    const binding = table?.members.get(member);
    const callable = binding ? functions.get(binding) : undefined;
    if (!table || !binding || !callable || firstMutation(namespace, table.end) < offset
      || firstMutation(binding, callable.start) < offset) return false;
    const owner = initializers.get(table.owner);
    if (!owner) return false;
    const completesBinding = (before: number): boolean => table.owner === callable.owner
      || [...owner.body.matchAll(/^  (init_[\w$]+)\(\);$/gm)]
        .some((call) => proves(call[1]!, callable.owner, before, new Set([table.owner]), false, offset));
    // Binary search keeps the compiled-binary path linear in artifact size,
    // rather than rescanning all module headers for each constructor call.
    let low = 0;
    let high = modules.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const module = modules[middle]!;
      if (offset < module.start) high = middle - 1;
      else if (offset >= module.end) low = middle + 1;
      else return module.prefixCalls.some((call) => call.offset < offset
        && proves(call.name, table.owner, call.offset, new Set(), true, offset) && completesBinding(call.offset));
    }
    return false;
  };
}

/**
 * Scan bundler output (a plain bundle or the JS embedded in a compiled
 * binary) for top-level eager namespace reads. Returns one human-readable
 * description per offending read, capped at `limit`. Pure.
 */
export function scanArtifactForEagerNamespaceReads(artifactText: string, limit = 8): string[] {
  const hits: string[] = [];
  let provesCall: ReturnType<typeof namespaceCallProof> | undefined;
  for (const match of artifactText.matchAll(EAGER_NAMESPACE_READ)) {
    // Preserve the original direct-alias policy even after a proven init.
    // A call alone is not an exemption: emitted initializer dominance is.
    const isCall = artifactText.slice(match.index + match[0].length).match(/^\s*\(/) !== null;
    if (isCall) {
      provesCall ??= namespaceCallProof(artifactText);
      if (provesCall(match[2]!, match[3]!, match.index + (match[0].startsWith('\n') ? 1 : 0))) continue;
    }
    hits.push(`var ${match[1]} = ${match[2]}.${match[3]}`);
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** Evaluate a captured `--version` run against the smoke policy. Pure. */
export function evaluateSmokeOutput(result: ExecResult, config: Pick<SmokeConfig, 'bannerPrefix' | 'forbiddenStrings'>): SmokeResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    return { ok: false, detail: `binary exited ${result.status}: ${combined.trim().slice(0, 400)}` };
  }
  const forbidden = config.forbiddenStrings.find((s) => combined.includes(s));
  if (forbidden) {
    return { ok: false, detail: `output contains packaging-failure sentinel "${forbidden}"` };
  }
  if (!result.stdout.trimStart().startsWith(config.bannerPrefix)) {
    return { ok: false, detail: `version banner does not start with "${config.bannerPrefix}": ${result.stdout.trim().slice(0, 200)}` };
  }
  return { ok: true, detail: `version banner OK: ${result.stdout.trim().slice(0, 120)}` };
}

export interface RunSmokeOptions {
  readonly binary: string;
  readonly config: SmokeConfig;
  readonly exec?: Exec;
  readonly logger?: Logger;
  /** Reads the artifact bytes for the eager-namespace-read scan. Injectable for tests. */
  readonly readArtifact?: (path: string) => string;
}

/** Run the version smoke against a binary path. */
export function runPostBuildSmoke(options: RunSmokeOptions): SmokeResult {
  const exec = options.exec ?? realExec;
  const logger = options.logger ?? consoleLogger;
  const readArtifact = options.readArtifact ?? ((path: string) => readFileSync(path, 'latin1'));
  logger.info(`[post-build-smoke] ${options.binary} --version`);
  const result = exec(options.binary, ['--version']);
  const evaluated = evaluateSmokeOutput(result, options.config);
  if (!evaluated.ok) {
    logger.error(`[post-build-smoke] ${evaluated.detail}`);
    return evaluated;
  }
  let eagerReads: string[];
  try {
    eagerReads = scanArtifactForEagerNamespaceReads(readArtifact(options.binary));
  } catch (error) {
    const failed: SmokeResult = { ok: false, detail: `artifact scan could not read ${options.binary}: ${error instanceof Error ? error.message : String(error)}` };
    logger.error(`[post-build-smoke] ${failed.detail}`);
    return failed;
  }
  if (eagerReads.length > 0) {
    const failed: SmokeResult = {
      ok: false,
      detail: `artifact contains ${eagerReads.length}${eagerReads.length >= 8 ? '+' : ''} top-level eager namespace read(s), a build-order lottery that can die at load on the next rebuild: ${eagerReads.slice(0, 3).join('; ')}`,
    };
    logger.error(`[post-build-smoke] ${failed.detail}`);
    return failed;
  }
  logger.info(`[post-build-smoke] ${evaluated.detail}`);
  return evaluated;
}
