#!/usr/bin/env bun
/**
 * Calibrate every engine and foundation registry through the genuine configured
 * System One port. Only each battery's built-in fixture inputs are submitted.
 *
 * bun packages/engine/scripts/project-calibration.ts --out /tmp/calibration.json --log /tmp/calibration.sqlite
 * Add --inventory-only to enumerate without contacting the service, --only a,b
 * for a repair run, or --provisional while the integrated source is changing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BatteryRegistry, calibrate, createSystemOnePort, formatReport, judgmentConfigFromEnv, readingsOf,
  SqliteDecisionLog, withDecisionLog,
  type CalibrationReport, type DecisionReport, type NamedDecision,
} from '@goodvibes-jev/judgment';
import { ENGINE_ROOT, loadEngineRegistries } from './judgment-registries.ts';

const REPO_ROOT = resolve(ENGINE_ROOT, '../..');
const THIS_SCRIPT = relative(REPO_ROOT, import.meta.path);

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.toString();
}

async function sourceSnapshot() {
  const files = [...new Set([
    ...git('ls-files', '--cached', '--others', '--exclude-standard', '-z', 'packages/engine', 'packages/judgment', 'products',
      'package.json', 'bun.lock', 'tsconfig.base.json').split('\0').filter(Boolean),
    THIS_SCRIPT,
  ])].sort();
  const hashes: { path: string; sha256: string | null }[] = [];
  for (const path of files) {
    const file = Bun.file(resolve(REPO_ROOT, path));
    hashes.push({ path, sha256: await file.exists() ? createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex') : null });
  }
  return {
    sha: git('rev-parse', 'HEAD').trim(),
    trackedChanges: git('status', '--porcelain=v1', '--untracked-files=no').trim(),
    digest: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
    files: hashes,
  };
}

export async function loadProjectCalibration() {
  const engine = await loadEngineRegistries();
  const referencePath = 'packages/judgment/scripts/reference-registry.ts';
  const reference: unknown = await import(resolve(REPO_ROOT, referencePath));
  if (typeof reference !== 'object' || reference === null || !('registry' in reference)
    || !(reference.registry instanceof BatteryRegistry)) throw new Error(`${referencePath} does not export a BatteryRegistry`);
  const byName = new Map<string, { decision: NamedDecision; registries: string[] }>();
  const registries = [
    ...engine.byFile.map(({ file, decisions }) => ({ file: `packages/engine/${file}`, decisions })),
    { file: referencePath, decisions: reference.registry.list() },
  ];
  const conflicts = new Set(engine.conflicts);
  for (const { file, decisions } of registries) for (const decision of decisions) {
    const known = byName.get(decision.name);
    if (known === undefined) byName.set(decision.name, { decision, registries: [file] });
    else {
      if (known.decision !== decision) conflicts.add(decision.name);
      known.registries.push(file);
    }
  }
  if (conflicts.size > 0) throw new Error(`Conflicting registered batteries: ${[...conflicts].sort().join(', ')}`);
  const entries = [...byName.values()].sort((a, b) => a.decision.name.localeCompare(b.decision.name));
  return {
    decisions: entries.map(({ decision }) => decision),
    inventory: entries.map(({ decision, registries: sources }) => ({
      name: decision.name, version: decision.version, description: decision.description,
      declaredModel: decision.model ?? null, accuracyFloor: decision.accuracyFloor,
      fixtureCount: decision.fixtureCount, registries: sources,
    })),
    registries: registries.map(({ file, decisions }) => ({ file, batteries: decisions.map((decision) => decision.name) })),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    out: { type: 'string' }, log: { type: 'string' }, only: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'inventory-only': { type: 'boolean', default: false },
    provisional: { type: 'boolean', default: false },
    'source-sha': { type: 'string' },
  } });
  if (values.out === undefined) throw new Error('--out is required');
  const outPath = resolve(values.out);
  const concurrency = Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  const source = await sourceSnapshot();
  if (values['source-sha'] !== undefined && values['source-sha'] !== source.sha) throw new Error('HEAD does not match --source-sha');
  const project = await loadProjectCalibration();
  const names = values.only?.split(',');
  if (names !== undefined) for (const name of names) {
    if (!project.decisions.some((decision) => decision.name === name)) throw new Error(`Unknown battery: ${name}`);
  }
  const decisions = project.decisions.filter((decision) => names === undefined || names.includes(decision.name));
  const inventory = {
    source, provisional: values.provisional, registries: project.registries, batteries: project.inventory,
    totalRegistries: project.registries.length, totalBatteries: project.decisions.length,
    totalFixtures: project.decisions.reduce((sum, decision) => sum + decision.fixtureCount, 0),
    selectedBatteries: decisions.map((decision) => decision.name),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  console.log(`[project-calibration] ${inventory.totalBatteries} unique batteries, ${inventory.totalFixtures} declared fixtures, ${inventory.totalRegistries} registries`);
  if (values['inventory-only']) {
    await Bun.write(outPath, `${JSON.stringify({ ...inventory, mode: 'inventory', executed: false }, null, 2)}\n`);
    return;
  }
  if (values.log === undefined) throw new Error('--log is required for genuine calibration');
  const logPath = resolve(values.log);
  mkdirSync(dirname(logPath), { recursive: true });
  const config = judgmentConfigFromEnv(process.env);
  const endpoint = { kind: config.endpoint.kind, baseURL: config.endpoint.baseURL };
  using log = new SqliteDecisionLog(logPath);
  const previousIds = new Set(log.query({ limit: 1_000_000 }).map((entry) => entry.id));
  const port = withDecisionLog(createSystemOnePort(config), log);
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Calibration cancelled by operator'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const reports: DecisionReport[] = [];
  const queue = [...decisions];
  let pendingWrite = Promise.resolve();
  const startedAt = new Date().toISOString();
  const currentReport = (): CalibrationReport => ({
    at: startedAt, endpoint, decisions: [...reports].sort((a, b) => a.name.localeCompare(b.name)),
    passed: reports.length === decisions.length && reports.every((report) => report.passed),
  });
  const persist = async (complete: boolean) => {
    const entries = log.query({ limit: 1_000_000 }).filter((entry) => !previousIds.has(entry.id));
    const after = complete ? await sourceSnapshot() : undefined;
    const sourceStable = after === undefined ? null : source.digest === after.digest && source.sha === after.sha;
    const coverage = decisions.flatMap((declared) => {
      const report = reports.find((candidate) => candidate.name === declared.name);
      if (report === undefined) return [];
      const checkedFixtures = new Set(report.checks.map((check) => check.fixture)).size;
      // Fidelity's literal quote check deliberately needs no model or log entry.
      // Preserve these checks separately from genuine provider answers.
      const deterministicFixtures = [...new Set(report.checks.filter((check) =>
        check.aspect === 'fidelity' && check.expected === 'fabricated' && check.got === 'fabricated'
        && check.signal === 1 && check.outcome === 'act',
      ).map((check) => check.fixture))];
      return { name: report.name, declaredFixtures: declared.fixtureCount, checkedFixtures,
        truthRecorded: report.truthRecorded ?? 0, deterministicFixtures,
        complete: checkedFixtures === declared.fixtureCount
          && (report.truthRecorded ?? 0) + deterministicFixtures.length === declared.fixtureCount };
    });
    const answered = entries.filter((entry) => entry.status === 'answered');
    const logEvidence = {
      path: logPath, entries: entries.length, answered: answered.length, failed: entries.length - answered.length,
      answeredWithoutReadings: answered.filter((entry) => readingsOf(entry) === undefined).length,
      observedModels: [...new Set(answered.map((entry) => entry.model))].sort(),
      calls: entries.map((entry) => ({ id: entry.id, at: entry.at, context: entry.context,
        status: entry.status, requestedModel: entry.requestedModel, observedModel: entry.status === 'answered' ? entry.model : null,
        requestId: entry.requestId, lineage: entry.lineage, stateHash: entry.stateHash })),
    };
    const report = currentReport();
    const passed = complete && sourceStable === true && report.passed
      && coverage.every((battery) => battery.complete) && logEvidence.failed === 0 && logEvidence.answeredWithoutReadings === 0;
    const serialized = `${JSON.stringify({ ...inventory, mode: 'genuine-calibration', startedAt,
      complete, completedAt: complete ? new Date().toISOString() : null, sourceStable,
      sourceAfter: after, requestedDefaultModel: config.model,
      protocol: { method: 'POST', path: '/v1/systemone' },
      notRunBatteries: decisions.filter((decision) => !reports.some((report) => report.name === decision.name)).map((decision) => decision.name),
      coverage, report, logEvidence, passed,
    }, null, 2)}\n`;
    pendingWrite = pendingWrite.then(async () => {
      await Bun.write(`${outPath}.next`, serialized);
      renameSync(`${outPath}.next`, outPath);
    });
    await pendingWrite;
    return passed;
  };
  await persist(false);
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, decisions.length) }, async () => {
      while (queue.length > 0 && !abort.signal.aborted) {
        const decision = queue.shift();
        if (decision === undefined) break;
        const result = await calibrate(port, [decision], { endpoint, log, signal: abort.signal });
        reports.push(...result.decisions);
        for (const report of result.decisions) console.log(`[project-calibration] ${report.passed ? 'PASS' : 'FAIL'} ${report.name}@${report.version} ${report.accuracy.toFixed(3)}/${report.accuracyFloor} ${report.checks.length} checks${report.error === undefined ? '' : ` ${report.error}`}`);
        await persist(false);
      }
    }));
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  const passed = await persist(true);
  console.log(formatReport(currentReport()));
  console.log(`[project-calibration] ${passed ? 'PASS' : 'FAIL'}; report: ${outPath}; decision log: ${logPath}`);
  process.exitCode = passed ? 0 : 1;
}

if (import.meta.main) await main();
