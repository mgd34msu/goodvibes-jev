/**
 * Runs every registered decision's fixtures live and reports accuracy,
 * band outcomes and confidence against accuracy. Exits non-zero when a
 * decision falls below its accuracy floor.
 *
 *   bun run calibrate [--registry <module>]... [--only a,b] [--log <sqlite>] [--out <json>]
 *   bun run calibrate sweep <report.json> [decision] [--thresholds 0.6,0.7,0.8]
 *
 * A registry module exports `registry` (a BatteryRegistry). Without
 * --registry the judgment package's reference registry is used. Readings go
 * to the decision log at --log; the report goes to --out. `sweep` re-bands a
 * saved report at other thresholds without calling the model.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BatteryRegistry,
  calibrate,
  createSystemOnePort,
  DEFAULT_SWEEP,
  formatReport,
  formatSweep,
  judgmentConfigFromEnv,
  SqliteDecisionLog,
  sweep,
  withDecisionLog,
  type CalibrationReport,
} from '../src/index.ts';

const stateDir = join(process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'goodvibes-jev', 'judgment');
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    registry: { type: 'string', multiple: true },
    only: { type: 'string' },
    log: { type: 'string' },
    out: { type: 'string' },
    thresholds: { type: 'string' },
  },
});

if (positionals[0] === 'sweep') {
  const reportPath = positionals[1];
  if (reportPath === undefined) throw new Error('usage: calibrate sweep <report.json> [decision] [--thresholds 0.6,0.7]');
  const report = (await Bun.file(reportPath).json()) as CalibrationReport;
  const thresholds = values.thresholds === undefined ? DEFAULT_SWEEP : values.thresholds.split(',').map(Number);
  const name = positionals[2];
  for (const decision of report.decisions.filter((d) => name === undefined || d.name === name)) {
    console.log(formatSweep(decision.name, sweep(decision.checks, thresholds)));
  }
  process.exit(0);
}

const modules = values.registry ?? [resolve(import.meta.dir, 'reference-registry.ts')];
const registries: BatteryRegistry[] = [];
for (const specifier of modules) {
  const loaded = (await import(resolve(specifier))) as { registry?: unknown };
  if (!(loaded.registry instanceof BatteryRegistry)) throw new Error(`${specifier} does not export a BatteryRegistry named "registry"`);
  registries.push(loaded.registry);
}
const registry = BatteryRegistry.merge(...registries);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = values.log ?? join(stateDir, 'calibration.sqlite');
const outPath = values.out ?? join(stateDir, 'reports', `calibration-${stamp}.json`);
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(dirname(outPath), { recursive: true });

const config = judgmentConfigFromEnv(process.env);
using log = new SqliteDecisionLog(logPath);
const port = withDecisionLog(createSystemOnePort(config), log);
const report = await calibrate(port, registry.list(), {
  endpoint: { kind: config.endpoint.kind, baseURL: config.endpoint.baseURL },
  log,
  ...(values.only === undefined ? {} : { only: values.only.split(',') }),
});
await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(formatReport(report));
console.log(`\nreport: ${outPath}\ndecision log: ${logPath}`);
process.exit(report.passed ? 0 : 1);
