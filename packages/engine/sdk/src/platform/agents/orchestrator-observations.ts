/** Run-owned semantic observations. Neither reading grants tool authority. */
import { readFileSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, captureOwnedJson } from '../gate/judgment-input.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { AgentOrchestratorRunContext } from './orchestrator-run-context.js';
import { TEST_FRAMEWORK_OPTIONS } from '../tools/batteries/project-tooling.js';
import { projectTestFramework, repeatStuck } from './batteries/orchestrator-observations.js';

export class OrchestratorObservationHeldError extends Error {
  readonly recoverable = true;
  constructor() { super('Agent semantic observation is unavailable or stale; this run is held and may be retried when its source is current.'); this.name = 'OrchestratorObservationHeldError'; }
}
export interface ProjectFrameworkObservation { readonly framework?: string | undefined; readonly assertCurrent: () => void }
export interface RetainedToolObservation { readonly signature: string; readonly requested: unknown; readonly executed: { readonly name: string; readonly arguments: string }; readonly result: unknown }

/** Original run, request, project, signal and config owner survive every await. */
export function captureOrchestratorObservationOwner(context: AgentOrchestratorRunContext, record: AgentRecord): () => void {
  const cwd = context.workingDirectory, id = record.id, task = record.task, started = record.startedAt;
  const config = context.configManager, getSignal = context.getCancellationSignal, signal = getSignal?.(id);
  const beforeRequest = context.beforeProviderRequest;
  const getConfig = config?.get;
  const keys = ['agents.maxTurns', 'agents.maxTurnsCap'] as const;
  const settings = keys.map(key => config?.get(key));
  return () => {
    signal?.throwIfAborted();
    if (record.status !== 'running' || record.id !== id || record.task !== task || record.startedAt !== started
      || context.workingDirectory !== cwd || context.configManager !== config || config?.get !== getConfig
      || keys.some((key, i) => config?.get(key) !== settings[i]) || context.getCancellationSignal !== getSignal
      || getSignal?.(id) !== signal || context.beforeProviderRequest !== beforeRequest) throw new OrchestratorObservationHeldError();
  };
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function checkedPort(authority: JudgmentPortCapture): JudgmentPort {
  const base = authority.port, model = base.model;
  let actualModel: string | undefined;
  if (!model?.trim()) throw new OrchestratorObservationHeldError();
  return { model, ...(base.recorder ? { recorder: base.recorder } : {}), async ask(request) {
    const result = await base.ask({ ...request, model });
    authority.assertCurrent();
    if (!object(result) || !object(result.answers) || result.requestedModel !== model || typeof result.model !== 'string' || !result.model.trim()
      || (actualModel !== undefined && actualModel !== result.model)) throw new OrchestratorObservationHeldError();
    const answers = captureOwnedJson(result.answers);
    if (!object(answers)) throw new OrchestratorObservationHeldError();
    for (const [name, question] of Object.entries(request.questions)) {
      const answer = answers[name];
      if (!object(answer) || answer.type !== question.type) throw new OrchestratorObservationHeldError();
      if (question.type === 'noul' && (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)) throw new OrchestratorObservationHeldError();
      if (question.type === 'choice' && (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice))) throw new OrchestratorObservationHeldError();
    }
    if (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim())) throw new OrchestratorObservationHeldError();
    actualModel = result.model;
    return { ...result, answers: answers as typeof result.answers };
  } };
}
function manifest(path: string): { text: string | null; identity: string } {
  const identity = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  let before: BigIntStats;
  try { before = statSync(path, { bigint: true }); }
  catch (error) { return { text: null, identity: `unavailable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}` }; }
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch { return { text: null, identity: `unreadable:${identity(before)}` }; }
  let after: BigIntStats;
  try { after = statSync(path, { bigint: true }); } catch { throw new OrchestratorObservationHeldError(); }
  if (identity(before) !== identity(after)) throw new OrchestratorObservationHeldError();
  return { text, identity: identity(after) };
}
export async function prepareProjectFramework(context: AgentOrchestratorRunContext, record: AgentRecord): Promise<ProjectFrameworkObservation> {
  const owner = captureOrchestratorObservationOwner(context, record), path = join(context.workingDirectory, 'package.json');
  owner();
  const source = manifest(path);
  // Screen the entire manifest, including ignored fields and tails, before parsing or caps.
  assertJudgmentInput({ manifest: source.text });
  let authority: JudgmentPortCapture | undefined;
  const assertSourceCurrent = () => {
    owner(); const current = manifest(path);
    if (current.identity !== source.identity || current.text !== source.text) throw new OrchestratorObservationHeldError();
  };
  const assertCurrent = () => {
    assertSourceCurrent();
    try { authority?.assertCurrent(); } catch { throw new OrchestratorObservationHeldError(); }
  };
  if (source.text === null) return Object.freeze({ assertCurrent });
  if (source.text.length > 200_000) return Object.freeze({ assertCurrent });
  let parsed: unknown;
  try { parsed = JSON.parse(source.text); } catch { return Object.freeze({ assertCurrent }); }
  assertJudgmentInput(parsed);
  let state;
  try { state = captureOwnedJson(parsed); } catch { return Object.freeze({ assertCurrent }); }
  if (!object(state)) return Object.freeze({ assertCurrent });
  // Unknown is an honest optional prompt label, never the old dependency ladder.
  try {
    authority = captureJudgmentPort('agents.project-test-framework', { signal: context.getCancellationSignal?.(record.id), assertCurrent: assertSourceCurrent });
    const run = await projectTestFramework.run(checkedPort(authority), state as never, { site: 'agents.project-test-framework', signal: authority.signal, beforeAttempt: assertCurrent });
    assertCurrent();
    const reading = run.readings.framework;
    if (reading.outcome !== 'act' || !Object.hasOwn(TEST_FRAMEWORK_OPTIONS, reading.choice) || reading.choice === 'none') return Object.freeze({ assertCurrent });
    const framework = reading.choice === 'bun' ? 'bun:test' : reading.choice;
    run.recordAction('include project framework'); assertCurrent();
    return Object.freeze({ framework, assertCurrent });
  } catch {
    assertCurrent();
    return Object.freeze({ assertCurrent });
  }
}

export async function readRepeatedCalls(history: readonly RetainedToolObservation[], context: AgentOrchestratorRunContext, record: AgentRecord, repeatedSignature = history[0]?.signature) {
  const owner = captureOrchestratorObservationOwner(context, record);
  // Own and screen every retained call and full result before limits or port lookup.
  assertJudgmentInput({ calls: history, repeatedSignature });
  const state = captureOwnedJson({ calls: history, repeatedSignature });
  if (JSON.stringify(state).length > 750_000) throw new OrchestratorObservationHeldError();
  const source = JSON.stringify(history), retained = [...history];
  let toolsStarted = false;
  const current = () => { owner(); if (JSON.stringify(toolsStarted ? retained : history) !== source) throw new OrchestratorObservationHeldError(); };
  try {
    const authority = captureJudgmentPort('agents.repeat-stuck', { signal: context.getCancellationSignal?.(record.id), assertCurrent: current });
    const run = await repeatStuck.run(checkedPort(authority), state as never, { site: 'agents.repeat-stuck', signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent();
    const reading = run.readings.stuck;
    if (reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) throw new OrchestratorObservationHeldError();
    return Object.freeze({ stuck: reading.verdict === 'yes', assertCurrent: () => { try { authority.assertCurrent(); } catch { throw new OrchestratorObservationHeldError(); } }, retainForTools: () => { try { authority.assertCurrent(); toolsStarted = true; } catch { throw new OrchestratorObservationHeldError(); } }, recordAction: run.recordAction });
  } catch { throw new OrchestratorObservationHeldError(); }
}
