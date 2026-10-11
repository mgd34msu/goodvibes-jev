import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
/** Captured repair: contained candidates, then the existing parser/Jev acceptance. */
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { assertContractInputAuthority } from '../../contract/input-authority.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { runCapturedCommand, type CapturedExecAuthority } from '../exec/captured-exec.js';
import { AutoHealer, type HealResult } from './auto-heal.js';
import { assertCapturedPublicationOwner } from './captured-publication.js';
import { assertCapturedWriteRevision } from './captured-write-revision.js';
import { assertCapturedToolAccessCurrent, assertCapturedToolMutationCurrent, assertCapturedToolReadAccess, capturedToolPublicationContext, captureCapturedToolWriteRevision, hasCapturedToolInvocation } from './captured-input-tools.js';

export interface CapturedAutoHealBackend { readonly kind: 'captured-auto-heal-backend' }
const backends = new WeakMap<CapturedAutoHealBackend, CapturedExecAuthority>();
export function createCapturedAutoHealBackend(binding: CapturedExecAuthority): CapturedAutoHealBackend {
  const backend = Object.freeze({ kind: 'captured-auto-heal-backend' as const });
  backends.set(backend, Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined }));
  return backend;
}
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Returning a repair never itself authorizes a write. Recheck immediately before publication. */
export async function healToolFile(
  config: Pick<ConfigManager, 'get'>,
  llm: Pick<ToolLLM, 'chat'>,
  path: string,
  content: string,
  errors: string[],
  backend?: CapturedAutoHealBackend,
  assertInvocation?: () => void,
  invocationSignal?: AbortSignal,
): Promise<HealResult & { assertCurrent: () => Promise<void>; assertCurrentSynchronous: () => void }> {
  assertInvocation?.();
  if (!hasCapturedToolInvocation()) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(invocationSignal ? [invocationSignal] : [])]);
    const assertSource = () => { signal.throwIfAborted(); assertInvocation?.(); };
    const reading = assertInvocation && config.get('tools.autoHeal') && errors.length ? captureJudgmentPort('tools.auto-heal.acceptance', { signal, assertCurrent: assertSource }) : undefined;
    const check = () => { assertSource(); reading?.assertCurrent(); };
    const monitor = setInterval(() => { try { check(); } catch (error) { controller.abort(error); } }, 50);
    monitor.unref?.();
    try {
      const result = await executePolicyCheck(() => new AutoHealer(config, llm, undefined, check, signal, reading).heal(path, content, errors), signal);
      check();
      return { ...result, assertCurrent: async () => { check(); }, assertCurrentSynchronous: check };
    } finally { clearInterval(monitor); }
  }
  if (!config.get('tools.autoHeal')) return { healed: false, content, assertCurrent: async () => {}, assertCurrentSynchronous: () => {} };
  const binding = backend && backends.get(backend);
  if (!binding) throw new Error('Captured auto-heal requires its construction-owned backend');
  const context = capturedToolPublicationContext();
  const operation = new AbortController();
  const signal = AbortSignal.any([operation.signal, ...[binding.signal, context.signal, invocationSignal].filter((value): value is AbortSignal => value !== undefined)]);
  const target = resolve(path);
  await executePolicyCheck(() => assertCapturedToolReadAccess(target), signal);
  assertCapturedPublicationOwner(context.lease, binding.authority);
  const revision = captureCapturedToolWriteRevision(target, Buffer.from(content, 'utf8'));
  const checkSynchronous = (): void => {
    assertInvocation?.();
    signal.throwIfAborted();
    assertCapturedToolMutationCurrent(target);
    assertCapturedWriteRevision(revision, binding.authority, context.lease, target);
  };
  const check = async (): Promise<void> => {
    await executePolicyCheck(() => assertContractInputAuthority(binding.authority, binding.root, signal), signal);
    await executePolicyCheck(() => assertCapturedToolAccessCurrent(), signal);
    await executePolicyCheck(() => assertCapturedToolReadAccess(target), signal);
    checkSynchronous();
  };
  const reading = assertInvocation ? captureJudgmentPort('tools.auto-heal.acceptance', { signal, assertCurrent: checkSynchronous }) : undefined;
  await check();
  const transform = async (stage: 'formatter' | 'linter', file: string, candidate: string, warnings: string[]): Promise<string> => {
    await check();
    if (!binding.dependencyInputs?.length && !existsSync(join(binding.root, 'node_modules'))) {
      warnings.push(`Captured auto-heal ${stage} unavailable: no admitted project-local tool dependencies.`);
      return candidate;
    }
    const fileArg = quote(relative(binding.root, file));
    // Exact project-local binaries only. No PATH discovery, npm resolution,
    // project configuration, network, or publication of the command's writes.
    const command = stage === 'formatter'
      ? `if [ -x ./node_modules/.bin/prettier ]; then ./node_modules/.bin/prettier --no-config --no-editorconfig --ignore-path /dev/null --write --log-level silent -- ${fileArg}; elif [ -x ./node_modules/.bin/biome ]; then printf '%s' '{"root":true,"formatter":{"enabled":true},"linter":{"enabled":false},"assist":{"enabled":false},"vcs":{"enabled":false}}' > /tmp/biome.json; ./node_modules/.bin/biome format --config-path=/tmp/biome.json --write -- ${fileArg}; else exit 127; fi`
      : `if [ -x ./node_modules/.bin/eslint ]; then ./node_modules/.bin/eslint --no-config-lookup --no-ignore --no-cache --fix --rule 'no-extra-semi:error' -- ${fileArg}; else exit 127; fi`;
    let transformed: string | undefined;
    const result = await runCapturedCommand(binding, command, {}, binding.root, 30_000, signal, 'disabled', {}, {
      publicationLease: context.lease, beforeSpawn: checkSynchronous,
      repairCandidate: { path: target, content: candidate, receive: (value) => { transformed = value; } },
    });
    await check();
    if (result.cancelled) throw new Error('Captured repair execution held');
    if (result.denied || result.timed_out || (stage === 'formatter' ? !result.success : result.exit_code !== 0 && result.exit_code !== 1) || transformed === undefined) {
      warnings.push(`Captured auto-heal ${stage} unavailable or unsuccessful: requires an admitted project-local binary supporting fixed config-free repair; ambient tools and project configuration are not used.`);
      return candidate;
    }
    return transformed;
  };
  // Providers/judgments can await or retry internally. Carry an owned signal
  // and revoke it when the live authority changes, as contained exec does.
  // This cannot retract an already-started transmission; it prevents late
  // stages/publication and lets cooperative providers stop pending retries.
  let checking = false;
  let pending: Promise<void> = Promise.resolve();
  const monitor = setInterval(() => {
    if (checking || signal.aborted) return;
    checking = true;
    pending = check().catch((error: unknown) => { operation.abort(error); }).finally(() => { checking = false; });
  }, 50);
  monitor.unref?.();
  let result: HealResult;
  try {
    result = await new AutoHealer(config, llm, { check, checkSynchronous, transform, signal }, assertInvocation, signal, reading).heal(target, content, errors);
  } finally {
    clearInterval(monitor);
    await pending;
  }
  await check();
  return { ...result, assertCurrent: check, assertCurrentSynchronous: checkSynchronous };
}
