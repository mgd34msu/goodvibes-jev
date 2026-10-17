#!/usr/bin/env bun
/** Explicit genuine source preparation; ordinary validation never contacts a provider. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSystemOnePort, judgmentConfigFromEnv, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { collectInternalIdentifierCandidates, INTERNAL_ID_ROOT, scanTargetsFromEnvironment } from './check-internal-identifiers.ts';
import { isInternalIdentifierExempt } from './internal-identifier-rule.ts';
import { collectDeferredSourceCandidates, TODO_ROOT } from './no-todo-markers.ts';
import { sourceMarkerAnchors } from './no-todo-marker-rules.ts';
import { captureStaticInputs, loadStaticSourceCheckpoint, loadStaticSourceJournal, loadStaticSourceReadings, openStaticSourceJournal, projectCurrentStaticSourceReadings, readStaticInput, revalidateStaticInput, saveStaticSourceReadings, sha256, STATIC_READINGS_PATH, STATIC_SOURCE_READING_PLAN_VERSION, staticDecisionSourceHash, staticDecisionSourceManifest, staticInputCaptureComplete, staticInputKey, staticInputStanding, type StaticSourceInput, type StaticSourceReadings, type StaticSourceReceipt } from './static-source-readings.ts';

export function collectStaticInputs(): StaticSourceInput[] {
  const internal = collectInternalIdentifierCandidates(INTERNAL_ID_ROOT, scanTargetsFromEnvironment(process.env.INTERNAL_ID_DIRS_JSON))
    .filter(candidate => !isInternalIdentifierExempt(candidate.relPath))
    .flatMap(candidate => captureStaticInputs('internal-identifier', candidate.relPath, candidate.text));
  const deferred = collectDeferredSourceCandidates(TODO_ROOT, scanTargetsFromEnvironment(process.env.TODO_DIRS_JSON))
    .flatMap(candidate => captureStaticInputs('deferred-work', candidate.relPath, candidate.text, sourceMarkerAnchors(candidate.relPath, candidate.text)));
  return [...internal, ...deferred].sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path) || a.firstLine - b.firstLine);
}

/** Canonical publication must never replace its private evidence stores. */
export function assertStaticCapturePathsDistinct(paths: Readonly<Record<string, string>>): void {
  const destination = (path: string): string => {
    let parent = resolve(path);
    const missing: string[] = [];
    while (!lstatSync(parent, { throwIfNoEntry: false })) {
      missing.unshift(basename(parent));
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return join(realpathSync(parent), ...missing);
  };
  const resolved = Object.entries(paths).map(([name, path]) => ({ name, path: destination(path),
    stat: existsSync(path) ? statSync(path) : undefined }));
  for (const [index, entry] of resolved.entries()) {
    for (const prior of resolved.slice(0, index)) {
      if (entry.path === prior.path || (entry.stat?.isFile() && prior.stat?.isFile()
        && entry.stat.dev === prior.stat.dev && entry.stat.ino === prior.stat.ino)) {
        throw new Error(`${entry.name} and ${prior.name} must point to distinct files`);
      }
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    out: { type: 'string' }, log: { type: 'string' }, inputs: { type: 'string' },
    concurrency: { type: 'string', default: '8' }, 'inventory-only': { type: 'boolean', default: false },
    'checkpoint': { type: 'string' }, all: { type: 'boolean', default: false },
  } });
  const concurrency = Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('--concurrency must be an integer from 1 to 32');
  const path = resolve(values.out ?? STATIC_READINGS_PATH);
  const checkpointPath = values.checkpoint ? resolve(values.checkpoint) : `${path}.checkpoint`;
  const journalPath = `${checkpointPath}.journal`;
  const logPath = values.log ? resolve(values.log) : undefined;
  assertStaticCapturePathsDistinct({ output: path, outputStage: `${path}.next`, checkpoint: checkpointPath,
    checkpointStage: `${checkpointPath}.next`, journal: journalPath,
    ...(logPath ? { log: logPath, logWal: `${logPath}-wal`, logShm: `${logPath}-shm` } : {}),
    ...(values.inputs ? { inputs: resolve(values.inputs) } : {}) });
  const inputs = collectStaticInputs();
  const decisionSourceHash = staticDecisionSourceHash();
  const snapshot = sha256(JSON.stringify(inputs.map(input => staticInputKey(input))));
  const counts = Object.fromEntries(['internal-identifier', 'deferred-work'].map(kind => [kind, inputs.filter(input => input.kind === kind).length]));
  console.log(`[static-source] ${inputs.length} complete inputs: ${JSON.stringify(counts)}`);
  if (values.inputs) {
    mkdirSync(dirname(resolve(values.inputs)), { recursive: true });
    writeFileSync(resolve(values.inputs), `${JSON.stringify({ readingPlanVersion: STATIC_SOURCE_READING_PLAN_VERSION, decisionSourceHash, snapshot, inputs }, null, 2)}\n`);
  }
  if (values['inventory-only']) return;
  if (!values.log) throw new Error('--log is required to retain genuine provider evidence');
  mkdirSync(dirname(resolve(values.log)), { recursive: true });
  const previous = loadStaticSourceJournal(journalPath, await loadStaticSourceCheckpoint(checkpointPath) ?? loadStaticSourceReadings(path));
  const captureSources = { ...previous?.captureSources, [decisionSourceHash]: staticDecisionSourceManifest() };
  const captureBatterySources = { ...previous?.captureBatterySources,
    [decisionSourceHash]: readFileSync(resolve(import.meta.dir, 'batteries/static-source.ts'), 'utf8') };
  // Changed input keys remain historical captures, never evidence for a current
  // input. Replaced captures under the same key retain their lineage below.
  const readings: Record<string, unknown> = { ...previous?.readings };
  const current: StaticSourceReadings = { format: 1, readingPlanVersion: STATIC_SOURCE_READING_PLAN_VERSION, decisionSourceHash, readings, captureSources, captureBatterySources };
  const pending = inputs.filter(input => {
    const key = staticInputKey(input);
    const revalidated = values.all ? null : revalidateStaticInput(input, previous);
    if (revalidated !== null) {
      readings[key] = revalidated;
      return !staticInputCaptureComplete(input, current);
    }
    return true;
  });
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(checkpointPath), { recursive: true });
  using journal = openStaticSourceJournal(journalPath);
  journal.append({ ...current, readings: {} });
  using log = new SqliteDecisionLog(resolve(values.log));
  const port = withDecisionLog(createSystemOnePort(judgmentConfigFromEnv(process.env)), log);
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Source preparation cancelled'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let next = 0;
  let completed = inputs.length - pending.length;
  const persist = (): void => saveStaticSourceReadings(current, checkpointPath);
  const onReceipt = (input: StaticSourceInput, receipt: StaticSourceReceipt): void => {
    const key = staticInputKey(input);
    const prior = readings[key];
    const priorId = typeof prior === 'object' && prior !== null && 'presence' in prior
      && typeof prior.presence === 'object' && prior.presence !== null && 'id' in prior.presence ? prior.presence.id : undefined;
    const priorSelectionId = typeof prior === 'object' && prior !== null && 'selection' in prior
      && typeof prior.selection === 'object' && prior.selection !== null && 'id' in prior.selection ? prior.selection.id : undefined;
    const lineage = typeof prior === 'object' && prior !== null && 'previousCaptures' in prior && Array.isArray(prior.previousCaptures)
      ? prior.previousCaptures : undefined;
    const retainedLineage = receipt.previousCaptures ?? lineage;
    const value = prior !== undefined && priorId !== receipt.presence.id ? { ...receipt, previousCaptures: [prior] }
      : retainedLineage ? { ...receipt, previousCaptures: retainedLineage } : receipt;
    if (JSON.stringify(value) === JSON.stringify(prior)) return;
    readings[key] = value;
    const capturedInput = priorId !== receipt.presence.id || (receipt.selection && priorSelectionId !== receipt.selection.id) ? input : undefined;
    journal.append({ format: 1, readingPlanVersion: STATIC_SOURCE_READING_PLAN_VERSION, decisionSourceHash, readings: { [key]: value } }, capturedInput);
  };
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      abort.signal.throwIfAborted();
      const input = pending[next++]!;
      await readStaticInput(port, log, input, abort.signal, {
        previous: values.all ? { ...current, readings: {} } : current,
        ...(previous && !values.all ? { original: previous } : {}),
        decisionSourceHash,
        onReceipt,
      });
      completed++;
      if (completed % 25 === 0) {
        persist(); console.log(`[static-source] ${completed}/${inputs.length} current observations`);
      }
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, worker);
  try {
    await Promise.all(workers);
    persist();
    const after = collectStaticInputs();
    if (staticDecisionSourceHash() !== decisionSourceHash || sha256(JSON.stringify(after.map(input => staticInputKey(input)))) !== snapshot) {
      throw new Error(`Source changed during preparation; reusable genuine observations retained in ${checkpointPath}, canonical artifact was not published`);
    }
    const result: StaticSourceReadings = projectCurrentStaticSourceReadings(inputs, current);
    saveStaticSourceReadings(result, path);
    const held = inputs.filter(input => staticInputStanding(input, result).kind === 'held');
    const violations = inputs.filter(input => staticInputStanding(input, result).kind === 'violation');
    console.log(`[static-source] ${pending.length} read, ${inputs.length - pending.length} reused, ${held.length} inconclusive advisories, ${violations.length} violating inputs`);
    if (violations.length) process.exitCode = 1;
  } catch (error) {
    abort.abort(error);
    await Promise.allSettled(workers);
    persist(); throw error;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

if (import.meta.main) await main();
