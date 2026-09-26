/**
 * Live proof of the judgment foundation. Every reference decision (one per
 * pattern and compound) runs its fixtures against the configured System One
 * endpoint, then the two compositions that are not decisions of their own
 * (fan-out and the verify-then-escalate cascade) run on real examples. Every
 * call lands in a decision log. Exits non-zero on any decision below its
 * floor, any wrong composition result, or any call the log lacks.
 *
 *   bun run proof
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  calibrate,
  createSystemOnePort,
  fanOut,
  formatReport,
  judgmentConfigFromEnv,
  SqliteDecisionLog,
  verifyThenEscalate,
  withDecisionLog,
} from '../src/index.ts';
import { judge, registry, ticketTriage, ticketUrgency } from './reference-registry.ts';

const config = judgmentConfigFromEnv(process.env);
const logPath = join(tmpdir(), `judgment-proof-${Date.now()}.sqlite`);
using log = new SqliteDecisionLog(logPath);
const port = withDecisionLog(createSystemOnePort(config), log);

const report = await calibrate(port, registry.list(), { endpoint: { kind: config.endpoint.kind, baseURL: config.endpoint.baseURL } });
console.log(formatReport(report));
let failed = report.passed ? 0 : 1;

const fanned = await fanOut(port, 'Nobody on our team can log in since this morning. Every attempt returns a 500 error. We need this fixed now.', {
  urgency: ticketUrgency,
  triage: ticketTriage,
});
const r = fanned.readings;
const fanOk =
  r.urgency.urgent.verdict === 'yes' && r.triage.category.choice === 'bug_report' && r.triage.severity.level === 2 && r.triage.refund.verdict === 'no';
console.log(`\n${fanOk ? 'PASS' : 'FAIL'}  fan-out  ${JSON.stringify(r)}`);
if (!fanOk) failed++;

const page = 'NYU Events Calendar. Search Events. About the Events Calendar. Report issue or provide feedback. Campus Map. Contact Us.';
const cascade = await verifyThenEscalate(
  port,
  judge,
  [
    { name: 'small', produce: async () => ({ registration_open_date: '', description: 'Registration opens for the fall semester' }) },
    { name: 'strong', produce: async () => ({ registration_open_date: '', description: '' }) },
  ],
  {
    goal: 'Extract the fall registration open date and a description of it, leaving fields blank when the page does not state them.',
    criteria: ['Every non-empty field is stated in `evidence.page`.', 'A field is left empty only when `evidence.page` does not state it.'],
    evidence: () => ({ page }),
  },
);
const cascadeOk = cascade.accepted && cascade.tier === 'strong';
console.log(`${cascadeOk ? 'PASS' : 'FAIL'}  cascade  ${JSON.stringify(cascade.attempts.map((a) => ({ tier: a.tier, verdict: a.judgment.verdict })))}`);
if (!cascadeOk) failed++;

const entries = log.query({ limit: 100_000 });
const unlogged = entries.filter((entry) => entry.readings === undefined && entry.error === undefined);
console.log(`\ndecision log: ${entries.length} entries at ${logPath}; ${unlogged.length} without readings`);
if (unlogged.length > 0) failed++;
process.exit(failed === 0 ? 0 : 1);
