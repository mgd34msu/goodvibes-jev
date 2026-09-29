/**
 * Live proof of the contract runner (docs/design/contract-runner.md, R.13).
 *
 * It makes a temporary git repository holding a small TypeScript project with
 * a `test` gate, and runs two real contracts through the goodvibes-contract
 * command line, with live Jev and real model providers:
 *
 * 1. A multi-unit ask (a parser module, a formatter module, each with tests,
 *    then a command line that wires them together, documented in the README),
 *    run by `runContractCli` in this process over the command line's own host
 *    (bin/contract-cli-host.ts), so the owner agent record the runner keeps
 *    can be read before the process lets it go.
 * 2. A session-mode ask (the person forbids delegating), run by the real
 *    `goodvibes-contract` bin as a child process, so the command line's session
 *    path runs end to end: the CLI hosts the session and submits its turns.
 *
 * Then it asserts, from the contract store on disk and the decision log:
 * criteria traced to the ask; a unit nudged at completion and read all met by
 * a later check; the group and deliverable checks passed; the deliverable
 * committed on the base branch with the gate passing there; every reading in
 * the contract tree logged, and every contract reading in the log traced from
 * the tree; the answer on the owner record and the status line on the operator
 * audience only. It fails loudly when no nudge happened: the ask carries
 * criteria a first attempt commonly misses (a README section, twelve test
 * cases per module, an exit code shown by running the command), and nothing
 * here makes a nudge happen.
 *
 * It prints a transcript of every unit, every reading, every nudge and every
 * re-check, from the contract tree.
 *
 * The proof speaks as the owner in one case only: when the plan checks could
 * not settle a plan (a confirm-level reading means "proceed once the owner
 * confirms"), it approves the plan, at the in-process run's terminal or, for
 * the bin, with `goodvibes-contract reply` followed by `resume`. Any other
 * question goes unanswered, which fails the proof.
 *
 * Configuration of the throwaway project, stated because it shapes the run:
 * - the only gate is `test` (`bun test`);
 * - `permissions.mode` is `allow-all`: nobody is at a terminal to approve the
 *   units' writes and commands, and the project is a temporary directory;
 * - `provider.model` is the session model (CONTRACT_PROOF_SESSION_MODEL,
 *   default gemini:gemini-3.5-flash): a session-mode contract is worked by the
 *   session's own turns on the configured model;
 * - the model providers are those whose keys are named in
 *   CONTRACT_PROOF_PROVIDER_KEYS (comma-separated environment variable names;
 *   default GEMINI_API_KEY). The proof runs itself again as a
 *   child process without the other provider keys and under an empty
 *   temporary home directory, so no stored secret or subscription adds a
 *   provider; the route planner picks among those providers' models.
 *
 *   TYPESAFE_API_KEY=... bun run --cwd packages/engine contract-proof
 *
 * A full run takes tens of minutes (every unit is real model work, checked
 * live). Exit 0 when every assertion holds, 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeForMatch, SqliteDecisionLog, type DecisionEntry } from '@goodvibes-jev/judgment';
import { openContractRunner, readContracts, type HostedContractRunner } from '../sdk/src/bin/contract-cli-host.ts';
import { openEscalation } from '../sdk/src/platform/contract/intake-route.ts';
import { runContractCli, type ContractCliIo } from '../sdk/src/platform/contract/cli.ts';
import type { ContractUnitView, ContractView, CriterionView, UnitCheck } from '../sdk/src/platform/contract/types.ts';
import { decisionLogPath } from '../sdk/src/platform/state/decision-log.ts';

const BIN = resolve(dirname(new URL(import.meta.url).pathname), '..', 'sdk', 'src', 'bin', 'goodvibes-contract.ts');
/** The longest either contract may run before the proof gives up on it. */
const RUN_DEADLINE_MS = 90 * 60_000;

const MAIN_ASK = [
  'Add src/parse.ts exporting parseDuration(text), which turns strings such as 1h30m, 45s or 2h into a number of seconds and throws a RangeError whose message names the input for malformed text,',
  "and src/format.ts exporting formatDuration(seconds), which renders 5405 as '1h 30m 5s', leaves out zero parts and gives '0s' for zero.",
  'Give each module its own test file under test/ with at least 12 test cases.',
  'Then wire both into src/cli.ts so that `bun src/cli.ts normalize <text>` prints formatDuration(parseDuration(text)), and for malformed input prints the error message to stderr and exits with code 2.',
  'Every exported function needs a JSDoc comment with an @example line, and README.md needs a Usage section showing the normalize command with one example.',
].join(' ');

/** The session's conversation model: session mode has no sub-agent to route, so the session runs on the configured model. */
const SESSION_MODEL = process.env['CONTRACT_PROOF_SESSION_MODEL'] ?? 'gemini:gemini-3.5-flash';

const SESSION_ASK = [
  'Do this yourself in this session, without delegating to sub-agents or any other agent:',
  "add src/version.ts exporting a function versionLabel() that returns 'durations 0.1.0', built from VERSION in src/index.ts, and a test for it in test/version.test.ts.",
].join(' ');

// ── Output ────────────────────────────────────────────────────────────────────

const failures: string[] = [];

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function heading(title: string): void {
  say();
  say(`== ${title} ${'='.repeat(Math.max(0, 74 - title.length))}`);
}

function check(label: string, ok: boolean, detail = ''): void {
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail.length > 0 ? `: ${detail}` : ''}`);
  if (!ok) failures.push(`${label}${detail.length > 0 ? `: ${detail}` : ''}`);
}

function indent(text: string, prefix = '      '): string {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

// ── The environment ───────────────────────────────────────────────────────────

if ((process.env['TYPESAFE_API_KEY'] ?? '').trim().length === 0) {
  say('contract-proof: TYPESAFE_API_KEY is not set; the proof reads live Jev and cannot run without it.');
  process.exit(1);
}
const providerKeys = (process.env['CONTRACT_PROOF_PROVIDER_KEYS'] ?? 'GEMINI_API_KEY').split(',').map((name) => name.trim()).filter(Boolean);
const presentKeys = providerKeys.filter((name) => (process.env[name] ?? '').trim().length > 0);
if (presentKeys.length === 0) {
  say(`contract-proof: none of the provider keys ${providerKeys.join(', ')} is set.`);
  process.exit(1);
}

/**
 * Stored secrets and subscriptions under the home directory configure
 * providers too, and the home directory is read once when a process starts,
 * so the proof runs itself again as a child process whose environment keeps
 * only the named provider keys and whose home is a new empty directory.
 */
const CHILD_MARK = 'CONTRACT_PROOF_CLEAN_ENVIRONMENT';
if (process.env[CHILD_MARK] !== '1') {
  const home = mkdtempSync(join(tmpdir(), 'contract-proof-home-'));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.endsWith('_API_KEY') && name !== 'TYPESAFE_API_KEY' && !providerKeys.includes(name)) continue;
    env[name] = value;
  }
  env['HOME'] = home;
  env[CHILD_MARK] = '1';
  const child = Bun.spawn(['bun', new URL(import.meta.url).pathname], { env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  const forward = (): void => { child.kill('SIGINT'); };
  process.on('SIGINT', forward);
  const code = await child.exited;
  process.off('SIGINT', forward);
  rmSync(home, { recursive: true, force: true });
  process.exit(code);
}

// ── The project ───────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'contract-proof-'));
  write(root, 'package.json', `${JSON.stringify({ name: 'durations', private: true, type: 'module', scripts: { test: 'bun test' } }, null, 2)}\n`);
  write(root, 'src/index.ts', "export const VERSION = '0.1.0';\n");
  write(root, 'test/index.test.ts', "import { expect, test } from 'bun:test';\nimport { VERSION } from '../src/index.ts';\n\ntest('version', () => {\n  expect(VERSION).toBe('0.1.0');\n});\n");
  write(root, 'README.md', '# durations\n\nParses and formats durations.\n');
  write(root, '.gitignore', 'node_modules/\n.goodvibes/\n');
  write(root, '.goodvibes/goodvibes/settings.json', `${JSON.stringify({
    contract: { gates: [{ name: 'test', command: 'bun test', enabled: true }] },
    permissions: { mode: 'allow-all' },
    // The conversation model a session-mode contract's session runs on (units are routed by the route planner).
    provider: { model: SESSION_MODEL },
  }, null, 2)}\n`);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Contract Proof');
  git(root, 'config', 'user.email', 'contract-proof@example.invalid');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'A durations project with a test gate');
  return root;
}

// ── Running the command line ──────────────────────────────────────────────────

interface OwnerSnapshot {
  readonly status: string;
  readonly fullOutput: string | undefined;
  readonly progress: string | undefined;
  readonly progressAudience: string | undefined;
}

interface MainRun {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly owners: ReadonlyMap<string, OwnerSnapshot>;
  /** Every question the proof answered as the owner, and its answer. */
  readonly ownerAnswers: readonly { readonly reason: string; readonly answer: string | null }[];
}

/**
 * What the proof says as the owner. It confirms a plan the plan checks could
 * not settle (a confirm-level reading means "proceed once the owner
 * confirms"); every other question is left unanswered, which ends the run
 * waiting on the owner and fails the proof, so no unit or deliverable is ever
 * passed by the proof's word.
 */
const OWNER_PLAN_APPROVAL = 'Yes, I approve the plan as it stands.';

/** Runs `goodvibes-contract run <ask>` in this process over the CLI's own host, keeping each contract's owner record as the runner left it. */
async function runInProcess(root: string, ask: string): Promise<MainRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const owners = new Map<string, OwnerSnapshot>();
  const ownerAnswers: { reason: string; answer: string | null }[] = [];
  let live: HostedContractRunner | undefined;
  const interruptHandlers = new Set<() => void>();
  const onSigint = (): void => { for (const handler of interruptHandlers) handler(); };
  process.on('SIGINT', onSigint);
  const io: ContractCliIo = {
    out: (line) => { stdout.push(line); say(`  [cli stdout] ${line}`); },
    err: (line) => { stderr.push(line); say(`  [cli] ${line}`); },
    // A terminal the proof answers at: plan confirmations only (OWNER_PLAN_APPROVAL).
    isTTY: true,
    readLine: async (prompt) => {
      if (!prompt.startsWith('Reply')) {
        say(`  [owner] ${prompt.trim()} (refused: the proof allows nothing it is asked)`);
        return null;
      }
      const waiting = live === undefined ? null : openEscalation(live.runner.list());
      const reason = waiting?.escalation.reason ?? '(none)';
      const answer = reason === 'plan-unresolved' ? OWNER_PLAN_APPROVAL : null;
      ownerAnswers.push({ reason, answer });
      say(`  [owner] asked (${reason}); ${answer === null ? 'no answer: the proof answers only plan confirmations' : `answers: ${answer}`}`);
      return answer;
    },
    onInterrupt: (handler) => {
      interruptHandlers.add(handler);
      return () => { interruptHandlers.delete(handler); };
    },
  };
  const deadline = setTimeout(onSigint, RUN_DEADLINE_MS);
  try {
    const code = await runContractCli(['run', ask, '--cwd', root], io, {
      cwd: root,
      readContracts,
      openRunner: async (projectRoot) => {
        const opened = await openContractRunner(projectRoot, io);
        live = opened;
        return {
          ...opened,
          dispose: async () => {
            for (const contract of opened.runner.list({ includeTerminal: true })) {
              const record = opened.services.agentManager.getStatus(contract.ownerAgentId);
              if (record !== null) {
                owners.set(contract.id, { status: record.status, fullOutput: record.fullOutput, progress: record.progress, progressAudience: record.progressAudience });
              }
            }
            await opened.dispose();
          },
        };
      },
    });
    return { code, stdout, stderr, owners, ownerAnswers };
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', onSigint);
  }
}

/** Runs the real bin as a child process; every stderr line is shown as it comes. */
async function runBin(root: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', BIN, ...args, '--cwd', root], { cwd: root, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const deadline = setTimeout(() => child.kill('SIGINT'), RUN_DEADLINE_MS);
  let stderr = '';
  const decoder = new TextDecoder();
  const readErr = (async () => {
    let pending = '';
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      stderr += text;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) say(`  [bin] ${line}`);
    }
    if (pending.length > 0) say(`  [bin] ${pending}`);
  })();
  const stdout = await new Response(child.stdout).text();
  await readErr;
  const code = await child.exited;
  clearTimeout(deadline);
  return { code, stdout, stderr };
}

// ── Reading the tree ──────────────────────────────────────────────────────────

const judged = (criteria: readonly CriterionView[]): CriterionView[] => criteria.filter((criterion) => criterion.disposition === 'judged');

function planUnits(contract: ContractView): ContractUnitView[] {
  const fixGroups = new Set(contract.groups.filter((group) => group.kind === 'fix').map((group) => group.id));
  return contract.units.filter((unit) => !fixGroups.has(unit.groupId));
}

function readingAt(criterion: CriterionView, checkId: string): string {
  const reading = criterion.readings.find((candidate) => candidate.checkId === checkId);
  if (reading === undefined) return `[${criterion.id}] not read`;
  const severity = reading.severity === undefined ? '' : `, ${reading.severity}`;
  return `[${criterion.id}] ${reading.verdict} (p unmet ${reading.probabilityUnmet.toFixed(2)}, ${reading.outcome}${severity})`;
}

function describeCheck(check: DeepCheck, criteria: readonly CriterionView[], label: string): string[] {
  const gates = (check.gates ?? []).map((gate) => `${gate.gate} ${gate.skipped === true ? 'skipped' : gate.passed ? 'passed' : 'FAILED'}`);
  const quality = Object.entries(check.quality).map(([item, reading]) => `${item} ${reading?.verdict}/${reading?.outcome}`);
  return [
    `    ${label} ${check.id} (trigger ${check.trigger}) -> ${check.result}${check.problems !== undefined && check.problems.length > 0 ? ` [${check.problems.join(', ')}]` : ''}`,
    ...judged(criteria).map((criterion) => `      ${readingAt(criterion, check.id)}`),
    `      goal: ${check.goal.verdict} (p unmet ${check.goal.probabilityUnmet.toFixed(2)}, ${check.goal.outcome})`,
    ...(quality.length > 0 ? [`      quality: ${quality.join('; ')}`] : []),
    ...(gates.length > 0 ? [`      gates: ${gates.join('; ')}`] : []),
    ...(check.claims === undefined ? [] : [`      claims: ${check.claims.kind} (${check.claims.summary})`]),
    `      decision log: ${check.decisionIds.join(', ') || '(none)'}`,
  ];
}

type DeepCheck = ContractView['checks'][number];

function printTranscript(contract: ContractView): void {
  say(`Contract ${contract.id}: ${contract.status}${contract.sessionMode === true ? ' (session mode)' : ''}, isolation ${contract.isolation}`);
  say(`Ask: ${contract.ask}`);
  say(`Goal: ${contract.goal}`);
  say('Contract criteria (each with the words of the ask it traces to):');
  for (const criterion of contract.criteria) {
    say(`  [${criterion.id}] ${criterion.text} (${criterion.disposition}, ${criterion.status})`);
    if (criterion.quote !== undefined) say(`      quote: "${criterion.quote}"`);
  }
  for (const decision of contract.decisions.filter((entry) => entry.action === 'spawned' || entry.action.startsWith('plan'))) {
    say(`  decision ${decision.action} ${decision.targetId}: ${decision.reason}`);
  }
  for (const group of contract.groups) {
    say();
    say(`Group ${group.id} "${group.title}" (${group.kind}, ${group.status})`);
    for (const criterion of group.criteria) say(`  [${criterion.id}] ${criterion.text} (serves ${criterion.serves.join(', ')})`);
    for (const unit of contract.units.filter((candidate) => candidate.groupId === group.id)) {
      say(`  Unit ${unit.id} "${unit.title}" (${unit.role}, ${unit.status}), route ${unit.route?.model ?? '(none)'}`);
      for (const criterion of unit.criteria) say(`    [${criterion.id}] ${criterion.text} (serves ${criterion.serves.join(', ')})`);
      let nudged = false;
      for (const unitCheck of unit.checks) {
        for (const line of describeCheck(unitCheck, unit.criteria, nudged && unitCheck.trigger !== 'turn-end' ? 're-check' : 'check')) say(line);
        for (const nudge of unit.nudges.filter((candidate) => candidate.checkId === unitCheck.id)) {
          nudged = true;
          say(`    nudge ${nudge.id} (${nudge.kinds.join(', ')}; delivered by ${nudge.delivery} to ${nudge.agentId}${nudge.consumedAt === undefined ? '; not consumed' : '; consumed'}):`);
          say(indent(nudge.text, '      | '));
        }
      }
    }
    for (const groupCheck of group.checks) for (const line of describeCheck(groupCheck, group.criteria, 'group check')) say(line);
  }
  say();
  say('Deliverable:');
  for (const deliverable of contract.checks) for (const line of describeCheck(deliverable, contract.criteria, 'deliverable check')) say(line);
  for (const escalation of contract.escalations) {
    say(`  escalation ${escalation.id} (${escalation.reason}):`);
    say(indent(escalation.question, '      | '));
  }
  say(`Commit: ${contract.commit === undefined ? '(none)' : `${contract.commit.status} ${contract.commit.hash ?? ''} ${contract.commit.note}`}`);
  say(`Status line: ${contract.statusLine ?? '(none)'}`);
  say('Answer:');
  say(indent(contract.answer ?? '(none)'));
  say(`Jev calls: ${contract.judgmentUsage.calls}`);
}

/** Every decision-log id the contract tree names. */
function decisionIdsOf(contract: ContractView): { readonly ids: Set<string>; readonly readingsWithoutId: string[] } {
  const ids = new Set<string>();
  const readingsWithoutId: string[] = [];
  const add = (list: readonly string[] | undefined): void => { for (const id of list ?? []) ids.add(id); };
  const addCriteria = (criteria: readonly CriterionView[]): void => {
    for (const criterion of criteria) {
      for (const reading of criterion.readings) {
        // A reading an owner's reply settled carries the reply's decision.
        if (reading.decisionId === undefined) readingsWithoutId.push(`${criterion.id} at ${reading.checkId}`);
        else ids.add(reading.decisionId);
        if (reading.severityDecisionId !== undefined) ids.add(reading.severityDecisionId);
      }
    }
  };
  add(contract.shape?.decisionIds);
  addCriteria(contract.criteria);
  for (const deliverable of contract.checks) add(deliverable.decisionIds);
  for (const decision of contract.decisions) add(decision.decisionIds);
  for (const escalation of contract.escalations) if (escalation.reply?.decisionId !== undefined) ids.add(escalation.reply.decisionId);
  for (const group of contract.groups) {
    addCriteria(group.criteria);
    for (const groupCheck of group.checks) add(groupCheck.decisionIds);
  }
  for (const unit of contract.units.flatMap((candidate) => [candidate, ...(candidate.attemptUnits ?? [])])) {
    addCriteria(unit.criteria);
    for (const unitCheck of unit.checks) add(unitCheck.decisionIds);
    if (unit.attemptSelection?.decisionId !== undefined) ids.add(unit.attemptSelection.decisionId);
  }
  return { ids, readingsWithoutId };
}

function openLog(root: string): SqliteDecisionLog {
  return new SqliteDecisionLog(decisionLogPath(join(root, '.goodvibes', 'goodvibes')));
}

/** The readings every judged check and every logged contract call are held to. */
function assertReadingsLogged(contract: ContractView, log: SqliteDecisionLog, label: string, project: readonly ContractView[]): void {
  const { ids, readingsWithoutId } = decisionIdsOf(contract);
  // A contract resumed by a later process reads during that process's window too, so tracing looks across every contract in the project.
  const traced = new Set(project.flatMap((other) => [...decisionIdsOf(other).ids]));
  check(`${label}: every criterion reading names its decision`, readingsWithoutId.length === 0, readingsWithoutId.join('; '));
  const missing = [...ids].filter((id) => log.get(id) === undefined);
  check(`${label}: every reading in the contract tree has a decision-log entry`, ids.size > 0 && missing.length === 0, `${ids.size} decision ids in the tree${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`);
  const failed = [...ids].map((id) => log.get(id)).filter((entry): entry is DecisionEntry => entry !== undefined && entry.status !== 'answered');
  check(`${label}: every logged reading was answered`, failed.length === 0, failed.map((entry) => `${entry.id} ${entry.context.site ?? ''}`).join('; '));
  const since = new Date(contract.createdAt).toISOString();
  const until = new Date((contract.completedAt ?? Date.now()) + 1).toISOString();
  const contractCalls = log.query({ since, until, limit: 100_000 }).filter((entry) => (entry.context.site ?? '').startsWith('contract.'));
  const untraced = contractCalls.filter((entry) => !traced.has(entry.id));
  check(
    `${label}: every contract reading in the decision log is traced from the tree`,
    untraced.length === 0,
    `${contractCalls.length} contract readings logged${untraced.length > 0 ? `; untraced: ${untraced.map((entry) => `${entry.id} (${entry.context.site})`).join(', ')}` : ''}`,
  );
  const bySite = new Map<string, number>();
  for (const entry of contractCalls) bySite.set(entry.context.site ?? '(no site)', (bySite.get(entry.context.site ?? '(no site)') ?? 0) + 1);
  say(`      readings by site: ${[...bySite].map(([site, count]) => `${site} ${count}`).join(', ')}`);
}

// ── The proof ─────────────────────────────────────────────────────────────────

const root = makeProject();
heading('Setup');
say(`Project: ${root}`);
say(`Model providers: ${presentKeys.map((name) => name.replace(/_API_KEY$/, '').toLowerCase()).join(', ')} (keys ${presentKeys.join(', ')})`);
say(`Base commit: ${git(root, 'rev-parse', 'HEAD').out}`);

heading('Run 1: a multi-unit contract through goodvibes-contract run');
say(`Ask: ${MAIN_ASK}`);
const main = await runInProcess(root, MAIN_ASK);
say(`goodvibes-contract run exited ${main.code}`);
const mainContract = readContracts(root).find((contract) => contract.ask === MAIN_ASK);

heading('Transcript of run 1');
if (mainContract === undefined) {
  check('run 1 left a contract in the store', false);
} else {
  printTranscript(mainContract);
}

heading('Assertions on run 1');
check('run 1: goodvibes-contract run exited 0', main.code === 0, `exit ${main.code}`);
check('run 1: the owner was asked only to confirm plans', main.ownerAnswers.every((entry) => entry.answer !== null),
  main.ownerAnswers.map((entry) => entry.reason).join(', ') || 'no question asked');
if (mainContract !== undefined) {
  const contract = mainContract;
  check('run 1: the contract passed', contract.status === 'passed', contract.status + (contract.error === undefined ? '' : `: ${contract.error}`));

  // The plan: at least two implementation units and an integration unit, every criterion traced.
  const units = planUnits(contract);
  const implement = units.filter((unit) => unit.role === 'implement');
  const integration = units.filter((unit) => unit.role === 'integration');
  check('plan: at least three units, two or more implementation units and an integration unit', units.length >= 3 && implement.length >= 2 && integration.length >= 1,
    `${units.length} units: ${units.map((unit) => `${unit.id} ${unit.role}`).join(', ')}`);
  const ask = normalizeForMatch(contract.ask);
  const untraced = contract.criteria.filter((criterion) => criterion.origin === 'stated' && (criterion.quote === undefined || !ask.includes(normalizeForMatch(criterion.quote))));
  check('plan: every stated contract criterion quotes the ask', contract.criteria.length > 0 && untraced.length === 0, untraced.map((criterion) => criterion.id).join(', '));
  const accepted = contract.decisions.find((decision) => decision.action === 'plan-accepted');
  const log = openLog(root);
  const traceReadings = (accepted?.decisionIds ?? []).map((id) => log.get(id)).filter((entry) => entry?.context.site === 'contract.criterion-trace');
  const stated = contract.criteria.filter((criterion) => criterion.origin === 'stated');
  check('plan: the accepted plan records a criterion-trace reading for every stated criterion', accepted !== undefined && traceReadings.length >= stated.length,
    `${traceReadings.length} trace readings for ${stated.length} stated criteria`);
  const unserving = contract.units.flatMap((unit) => unit.criteria).filter((criterion) => criterion.serves.length === 0);
  check('plan: every unit criterion serves a contract criterion', unserving.length === 0, unserving.map((criterion) => criterion.id).join(', '));

  // The nudge loop: a completion check that nudged, then a later check of the same unit reading every criterion met.
  const nudgedAtCompletion = contract.units.flatMap((unit) => unit.nudges
    .filter((nudge) => unit.checks.find((unitCheck) => unitCheck.id === nudge.checkId)?.trigger === 'completion')
    .map((nudge) => ({ unit, nudge })));
  check('nudge: at least one unit was nudged at completion', nudgedAtCompletion.length > 0,
    nudgedAtCompletion.length === 0
      ? 'no unit was nudged at completion; the loop was not exercised, so the proof does not pass'
      : nudgedAtCompletion.map(({ unit, nudge }) => `${unit.id} ${nudge.id} (${nudge.kinds.join(', ')})`).join('; '));
  const recovered = nudgedAtCompletion.filter(({ unit, nudge }) => {
    const nudgedAt = unit.checks.findIndex((unitCheck) => unitCheck.id === nudge.checkId);
    return unit.checks.slice(nudgedAt + 1).some((later: UnitCheck) => later.result === 'pass' && judged(unit.criteria).every((criterion) => criterion.readings.find((reading) => reading.checkId === later.id)?.verdict === 'met'));
  });
  check('nudge: a later check of a nudged unit read every criterion met', recovered.length > 0, recovered.map(({ unit }) => unit.id).join(', '));
  const unconsumed = nudgedAtCompletion.filter(({ nudge }) => nudge.consumedAt === undefined);
  check('nudge: every completion nudge was taken by its agent', unconsumed.length === 0, unconsumed.map(({ nudge }) => nudge.id).join(', '));

  // Groups and the deliverable.
  const planGroups = contract.groups.filter((group) => group.kind !== 'fix');
  const groupsNotPassed = planGroups.filter((group) => group.status !== 'passed' || (judged(group.criteria).length > 0 && group.checks.at(-1)?.result !== 'pass'));
  check('groups: every group passed its group check', planGroups.length > 0 && groupsNotPassed.length === 0,
    planGroups.map((group) => `${group.id} ${group.status}, last check ${group.checks.at(-1)?.result ?? '(none: no group criteria)'}`).join('; '));
  const deliverable = contract.checks.at(-1);
  check('deliverable: the deliverable check passed', deliverable?.result === 'pass', deliverable === undefined ? 'no deliverable check' : `${deliverable.id} ${deliverable.result}`);
  const deliverableGate = deliverable?.gates?.find((gate) => gate.gate === 'test');
  check('deliverable: the test gate ran and passed at the deliverable check', deliverableGate?.passed === true && deliverableGate.skipped !== true);

  // The commit, on the base branch, with the gate passing there.
  const head = git(root, 'rev-parse', 'main').out;
  check('commit: the deliverable was committed on the base branch', contract.commit?.status === 'committed' && contract.commit.hash !== undefined && head === contract.commit.hash,
    `${contract.commit?.status ?? 'no commit'} ${contract.commit?.hash ?? ''}; main is ${head}`);
  const gate = spawnSync('bun', ['test'], { cwd: root, encoding: 'utf-8' });
  check('commit: the test gate passes on the base branch', gate.status === 0, `bun test exited ${gate.status}; ${(gate.stderr ?? '').trim().split('\n').at(-1) ?? ''}`);
  const committedFiles = git(root, 'show', '--name-only', '--format=', `${contract.commit?.hash ?? 'HEAD'}^1..${contract.commit?.hash ?? 'HEAD'}`).out.split('\n').filter(Boolean);
  say(`      files the contract committed: ${committedFiles.join(', ')}`);

  // The decision log.
  assertReadingsLogged(contract, log, 'decision log', readContracts(root));

  // The answer to the owner, the status line to the operator only.
  const owner = main.owners.get(contract.id);
  check('answer: the owner record completed and carries the answer', owner?.status === 'completed' && owner.fullOutput === contract.answer && (contract.answer ?? '').length > 0,
    owner === undefined ? 'no owner record' : `owner ${owner.status}`);
  check('answer: the status line is on the owner record for the operator audience only', owner?.progress === contract.statusLine && owner?.progressAudience === 'operator',
    `audience ${owner?.progressAudience ?? '(none)'}`);
  check('answer: the answer does not carry the status line', !(owner?.fullOutput ?? '').includes(`Contract ${contract.id}`));
  check('answer: the command line printed the answer on stdout and the status line on stderr only',
    main.stdout.join('\n').includes((contract.answer ?? '').trim()) && main.stderr.includes(contract.statusLine ?? '') && !main.stdout.some((line) => line.includes(contract.statusLine ?? '\u0000')));
  log[Symbol.dispose]();

  // The bin reads the stored tree from another process.
  const status = await runBin(root, ['status', contract.id, '--json']);
  let fromBin: ContractView | null = null;
  try {
    fromBin = JSON.parse(status.stdout) as ContractView;
  } catch {
    fromBin = null;
  }
  check('bin: goodvibes-contract status <id> --json reads the passed contract from the store', status.code === 0 && fromBin?.id === contract.id && fromBin.status === 'passed', `exit ${status.code}`);
}

heading('Run 2: a session-mode contract through the goodvibes-contract bin');
say(`Ask: ${SESSION_ASK}`);
let session = await runBin(root, ['run', SESSION_ASK]);
say(`goodvibes-contract run exited ${session.code}`);
if (session.stdout.trim().length > 0) say(indent(session.stdout.trim(), '  [bin stdout] '));
const sessionOwnerReplies: string[] = [];
// Without a terminal the CLI leaves a question waiting (exit 2); the owner answers
// with `reply` and the work goes on with `resume`, plan confirmations only.
for (let round = 0; round < 3 && session.code === 2; round += 1) {
  const waiting = openEscalation(readContracts(root).filter((contract) => contract.ask === SESSION_ASK));
  if (waiting === null || waiting.escalation.reason !== 'plan-unresolved') break;
  say(`  [owner] goodvibes-contract reply ${waiting.contract.id} "${OWNER_PLAN_APPROVAL}"`);
  const reply = await runBin(root, ['reply', waiting.contract.id, OWNER_PLAN_APPROVAL]);
  say(`  [owner] reply exited ${reply.code}: ${reply.stdout.trim()}`);
  sessionOwnerReplies.push(waiting.escalation.reason);
  say('  [owner] goodvibes-contract resume');
  session = await runBin(root, ['resume']);
  say(`goodvibes-contract resume exited ${session.code}`);
  if (session.stdout.trim().length > 0) say(indent(session.stdout.trim(), '  [bin stdout] '));
}
const sessionContract = readContracts(root).find((contract) => contract.ask === SESSION_ASK);

heading('Transcript of run 2');
if (sessionContract === undefined) check('run 2 left a contract in the store', false);
else printTranscript(sessionContract);

heading('Assertions on run 2');
check('run 2: goodvibes-contract run (and any resume after an owner reply) exited 0', session.code === 0, `exit ${session.code}; owner replies: ${sessionOwnerReplies.join(', ') || 'none'}`);
if (sessionContract !== undefined) {
  const contract = sessionContract;
  check('run 2: the contract passed in session mode', contract.status === 'passed' && contract.sessionMode === true, `${contract.status}, session mode ${String(contract.sessionMode)}`);
  const unit = contract.units[0];
  check('run 2: one unit, worked by the session\'s own turns', contract.units.length === 1 && unit !== undefined && !contract.decisions.some((decision) => decision.action === 'spawned' && decision.targetId === unit.id),
    `${contract.units.length} unit(s)`);
  check('run 2: the unit passed a completion check', unit?.checks.some((unitCheck) => unitCheck.result === 'pass') === true);
  check('run 2: the work was committed', contract.commit?.status === 'committed', contract.commit?.note ?? 'no commit');
  const gate = spawnSync('bun', ['test'], { cwd: root, encoding: 'utf-8' });
  check('run 2: the test gate passes after the session contract', gate.status === 0, `bun test exited ${gate.status}`);
  const log = openLog(root);
  assertReadingsLogged(contract, log, 'run 2 decision log', readContracts(root));
  log[Symbol.dispose]();
}

heading('Result');
if (failures.length === 0) {
  say('Every assertion held.');
  rmSync(root, { recursive: true, force: true });
} else {
  say(`${failures.length} assertion(s) failed; the project is kept at ${root}:`);
  for (const failure of failures) say(`  - ${failure}`);
}
process.exit(failures.length === 0 ? 0 : 1);
