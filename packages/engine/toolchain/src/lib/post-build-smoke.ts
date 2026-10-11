/**
 * post-build-smoke, proves a freshly compiled binary boots.
 *
 * Runs `<binary> --version` and checks the documented version protocol.
 * Additional diagnostics require a current Jev load-failure observation of
 * both complete, privacy-screened output streams.
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

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { snapshotJudgmentInput, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { ProtectedSourceOwner } from '@goodvibes-jev/engine/sdk/platform/security';
import { smokeLoadFailure } from '../batteries/smoke-load-failure.js';
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

const observationBrand = Symbol('smoke-output-observation');
/** A process-local observation of one complete captured output, never execution permission. */
export interface SmokeOutputObservation { readonly [observationBrand]: true; }
const observations = new WeakMap<SmokeOutputObservation, {
  readonly output: ExecResult;
  readonly admitted: boolean;
  readonly assertCurrent: () => void;
}>();

function capturedOutput(result: ExecResult): ExecResult {
  const fields = Object.getOwnPropertyDescriptors(result);
  if (Reflect.ownKeys(fields).some(key => key !== 'status' && key !== 'stdout' && key !== 'stderr')
    || Object.values(fields).some(field => !('value' in field))) throw new Error('Invalid smoke output.');
  const status: unknown = fields.status?.value, stdout: unknown = fields.stdout?.value, stderr: unknown = fields.stderr?.value;
  if (typeof status !== 'number' || !Number.isInteger(status) || typeof stdout !== 'string' || typeof stderr !== 'string') throw new Error('Invalid smoke output.');
  return Object.freeze({ status, stdout, stderr });
}
function sameOutput(left: ExecResult, right: ExecResult): boolean {
  return left.status === right.status && left.stdout === right.stdout && left.stderr === right.stderr;
}
function versionProtocol(output: ExecResult, bannerPrefix: string): 'clean' | 'diagnostic' | 'invalid' {
  const lineEnd = output.stdout.indexOf('\n');
  const firstLine = (lineEnd < 0 ? output.stdout : output.stdout.slice(0, lineEnd)).replace(/\r$/, '');
  if (!firstLine.startsWith(bannerPrefix)) return 'invalid';
  const version = firstLine.slice(bannerPrefix.length);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return 'invalid';
  return output.stderr === '' && (lineEnd < 0 || lineEnd === output.stdout.length - 1) ? 'clean' : 'diagnostic';
}

/** Deterministic protocol checks; diagnostics pass only with their current complete observation. */
export function evaluateSmokeOutput(result: ExecResult, config: Pick<SmokeConfig, 'bannerPrefix'>, observation?: SmokeOutputObservation): SmokeResult {
  let output: ExecResult;
  try { output = capturedOutput(result); } catch { return { ok: false, detail: 'invalid captured smoke output' }; }
  if (output.status !== 0) {
    return { ok: false, detail: `binary exited ${output.status}` };
  }
  const protocol = versionProtocol(output, config.bannerPrefix);
  if (protocol === 'invalid') return { ok: false, detail: 'version banner does not match the configured version protocol' };
  if (protocol === 'diagnostic') {
    const owned = observation && observations.get(observation);
    if (!owned || !sameOutput(output, owned.output)) return { ok: false, detail: 'additional smoke output requires a current load-failure reading' };
    try { owned.assertCurrent(); } catch { return { ok: false, detail: 'smoke output observation is no longer current' }; }
    if (!owned.admitted) return { ok: false, detail: 'smoke load-failure reading refused or held qualification' };
  }
  return { ok: true, detail: 'version protocol and module-load evidence accepted' };
}

export interface RunSmokeOptions {
  readonly binary: string;
  readonly config: SmokeConfig;
  readonly exec?: Exec;
  readonly logger?: Logger;
  /** Custom readers must supply source incarnation protection through assertCurrent. */
  readonly readArtifact?: (path: string) => string;
  /** Trusted composition only. Without a protected source owner, diagnostics are withheld offline. */
  readonly diagnosticSourceOwner?: ProtectedSourceOwner;
  readonly signal?: AbortSignal;
  /** Synchronous ownership fence for the selected artifact and invocation. */
  readonly assertCurrent?: () => void;
}

/** Run the version smoke against a binary path. */
export async function runPostBuildSmoke(options: RunSmokeOptions): Promise<SmokeResult> {
  const exec = options.exec ?? realExec;
  const logger = options.logger ?? consoleLogger;
  const readArtifact = options.readArtifact ?? ((path: string) => readFileSync(path, 'latin1'));
  const { binary, config, signal, assertCurrent, diagnosticSourceOwner: sourceOwner } = options;
  const sourceMethods = sourceOwner && { capture: sourceOwner.capture, screen: sourceOwner.screen, project: sourceOwner.project, release: sourceOwner.release };
  const bannerPrefix = config.bannerPrefix;
  const current = () => {
    signal?.throwIfAborted();
    const checked: unknown = assertCurrent?.();
    if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); throw new Error('Smoke source owner must be synchronous.'); }
    if (options.binary !== binary || options.config !== config || config.bannerPrefix !== bannerPrefix
      || options.signal !== signal || options.assertCurrent !== assertCurrent || options.diagnosticSourceOwner !== sourceOwner) throw new Error('Smoke source owner changed.');
    if (sourceOwner && sourceMethods && (sourceOwner.capture !== sourceMethods.capture || sourceOwner.screen !== sourceMethods.screen
      || sourceOwner.project !== sourceMethods.project || sourceOwner.release !== sourceMethods.release)) throw new Error('Smoke diagnostic source owner changed.');
    signal?.throwIfAborted();
  };
  const failed = (detail: string): SmokeResult => { const result = { ok: false, detail }; logger.error(`[post-build-smoke] ${detail}`); return result; };
  const fileIdentity = () => [lstatSync(binary, { bigint: true }), statSync(binary, { bigint: true })]
    .flatMap(stat => [stat.dev, stat.ino, stat.ctimeNs, stat.mtimeNs, stat.size]);
  let originalFile: readonly bigint[] | undefined;
  const fileCurrent = () => {
    if (!originalFile) return;
    const present = fileIdentity();
    if (present.length !== originalFile.length || present.some((value, index) => value !== originalFile?.[index])) throw new Error('Smoke artifact incarnation changed.');
  };
  let artifact: string;
  try { current(); originalFile = options.readArtifact ? undefined : fileIdentity(); artifact = readArtifact(binary); fileCurrent(); current(); }
  catch { return failed('artifact scan could not read a current binary'); }
  const artifactIdentity = createHash('sha256').update(artifact, 'latin1').digest('hex');
  const artifactCurrent = () => {
    current();
    fileCurrent();
    if (createHash('sha256').update(readArtifact(binary), 'latin1').digest('hex') !== artifactIdentity) throw new Error('Smoke artifact changed.');
    fileCurrent();
    current();
  };
  let result: ExecResult;
  try {
    artifactCurrent(); logger.info(`[post-build-smoke] ${binary} --version`);
    result = capturedOutput(exec(binary, ['--version'], { timeoutMs: 30_000 })); artifactCurrent();
  } catch { return failed('smoke process or its artifact ownership failed'); }
  const finish = (evaluated: SmokeResult, readingCurrent: () => void = current): SmokeResult => {
    if (!evaluated.ok) return failed(evaluated.detail);
    let eagerReads: string[];
    try {
      readingCurrent(); artifactCurrent(); eagerReads = scanArtifactForEagerNamespaceReads(artifact); artifactCurrent(); readingCurrent();
    } catch { return failed('artifact or smoke observation is no longer current'); }
    if (eagerReads.length > 0) return failed(`artifact contains ${eagerReads.length}${eagerReads.length >= 8 ? '+' : ''} top-level eager namespace read(s), a build-order lottery that can die at load on the next rebuild: ${eagerReads.slice(0, 3).join('; ')}`);
    logger.info(`[post-build-smoke] ${evaluated.detail}`);
    try { readingCurrent(); artifactCurrent(); } catch { return failed('artifact or smoke observation is no longer current'); }
    return evaluated;
  };
  let evaluated = evaluateSmokeOutput(result, { bannerPrefix });
  if (!evaluated.ok && result.status === 0 && versionProtocol(result, bannerPrefix) === 'diagnostic' && sourceOwner) {
    let source: ReturnType<ProtectedSourceOwner['capture']> | undefined;
    const cancelSource = () => { if (source && sourceMethods) void sourceMethods.release.call(sourceOwner, source).catch(() => {}); };
    signal?.addEventListener('abort', cancelSource, { once: true });
    try {
      artifactCurrent(); source = sourceOwner.capture([result.stdout, result.stderr]);
      const screened = await sourceOwner.screen(source); artifactCurrent();
      if (screened.status !== 'settled') return failed('smoke diagnostic privacy screening held qualification');
      const parts = sourceOwner.project(screened.receipt);
      const stdout = parts[0], stderr = parts[1];
      if (parts.length !== 2 || typeof stdout !== 'string' || typeof stderr !== 'string') return failed('smoke diagnostic projection is incomplete');
      const evidence = Object.freeze({ stdout, stderr });
      snapshotJudgmentInput(evidence);
      const screenedCurrent = () => {
        artifactCurrent();
        const projected = sourceOwner.project(screened.receipt);
        if (projected.length !== 2 || projected[0] !== stdout || projected[1] !== stderr) throw new Error('Smoke diagnostic projection changed.');
        artifactCurrent();
      };
      const authority = captureJudgmentPort(smokeLoadFailure.name, { signal, assertCurrent: screenedCurrent, prepareResultCapture: questions => {
        const prepared = prepareJudgmentResult(questions);
        return { ...prepared, capture(original) {
          const admitted = prepared.capture(original);
          if (admitted.model !== smokeLoadFailure.model || admitted.requestedModel !== smokeLoadFailure.model) throw new Error('Smoke judgment model did not match the pinned contract.');
          return admitted;
        } };
      } });
      const run = await smokeLoadFailure.run(authority.port, evidence, { site: smokeLoadFailure.name, signal: authority.signal });
      authority.assertCurrent();
      const reading = run.readings.load_failure;
      const admitted = reading.outcome === 'act' && reading.verdict === 'no';
      run.recordAction(admitted ? 'accept-smoke-load-evidence' : 'hold-smoke-load-evidence'); authority.assertCurrent();
      const observation = Object.freeze({ [observationBrand]: true } satisfies SmokeOutputObservation);
      observations.set(observation, { output: result, admitted, assertCurrent: authority.assertCurrent });
      evaluated = evaluateSmokeOutput(result, { bannerPrefix }, observation);
      authority.assertCurrent();
      const finished = finish(evaluated, authority.assertCurrent);
      const restriction = authority.consumeObservation();
      await sourceOwner.release(source); source = undefined;
      restriction.assertCurrent(); artifactCurrent();
      return finished;
    } catch { return failed('smoke diagnostic reading unavailable, malformed, or no longer current'); }
    finally {
      signal?.removeEventListener('abort', cancelSource);
      if (source && sourceMethods) await sourceMethods.release.call(sourceOwner, source);
    }
  }
  return finish(evaluated);
}
