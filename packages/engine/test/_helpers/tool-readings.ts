/**
 * A fake judgment port for the tools batteries
 * (packages/engine/sdk/src/platform/tools/batteries), so tests of the exec,
 * analyze, agent and auto-repair paths never call the live Jev API.
 *
 * Each table entry pairs text that appears in a reading's state (its JSON)
 * with what Jev is expected to read about it; the first matching entry
 * answers. With no matching entry: no variable is a credential, no command
 * will prompt, no line is awaiting input, a command failure is lasting, a
 * child failure is `error`, a diff neither breaks callers nor changes
 * behavior, no spare argument fills a missing parameter, no frontend
 * candidate is an issue, and a project is a Node project on npm with no test
 * runner. Readings are
 * strong, so every band acts on them. Questions of other batteries (the
 * gate's, which the exec tool also asks) go to the gate helper's port with
 * `gateTable`.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { JudgmentPort, Question, Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetGateReadings, gateReadingsPort, type GateReadingTable } from './gate-readings.ts';
import { forgetCredentialEnvReadings } from '../../sdk/src/platform/tools/exec/credential-env.ts';
import { forgetServerOnlyReadings } from '../../sdk/src/platform/tools/inspect/frontend-readings.ts';
import type { ExecFailureCategory } from '../../sdk/src/platform/tools/batteries/exec-retry.ts';
import type { ChildFailureReading } from '../../sdk/src/platform/tools/batteries/child-failure-reason.ts';

export interface ToolReading {
  readonly credential?: boolean;
  readonly willPrompt?: boolean;
  readonly awaitingInput?: boolean;
  readonly failure?: ExecFailureCategory;
  readonly childFailure?: ChildFailureReading;
  readonly breaksCallers?: boolean | 'uncertain';
  readonly changesBehavior?: boolean | 'uncertain';
  /** For a param-fill selection: the spare argument that fills the missing parameter. */
  readonly fill?: string;
  readonly realSecret?: boolean | 'uncertain';
  readonly risky?: boolean | 'uncertain';
  readonly severity?: 'high' | 'medium' | 'low';
  /** engine.tools.frontend-finding: the answer to whichever question the analyzer asks. */
  readonly finding?: boolean | 'uncertain';
  readonly projectType?: 'nodejs' | 'rust' | 'python' | 'go' | 'make';
  readonly packageManager?: 'npm' | 'bun' | 'yarn' | 'pnpm';
  readonly testFramework?: string;
}

/** One recorded request: the state read and the questions asked. */
export interface ToolReadingRequest {
  readonly state: unknown;
  readonly questions?: Readonly<Record<string, unknown>>;
}

export type ToolReadingTable = ReadonlyArray<readonly [text: string, reading: ToolReading]>;

const YES = 0.97;
const NO = 0.03;
/** A strong yes, a strong no, or a reading in the middle that no band acts on. */
const noul = (value: boolean | 'uncertain' | undefined) => noulAnswer(value === 'uncertain' ? 0.5 : value === true ? YES : NO);

/** The candidate id a param-fill fit question asks about, from its instructions. */
function fitCandidate(question: Question): string | undefined {
  const instructions = JSON.stringify(question);
  return /\(id \\"([^\\]+)\\"\)/.exec(instructions)?.[1];
}

/** The question names the tools batteries ask. */
const FINDING_QUESTIONS = new Set(['a11y_violation', 'omits_dependency', 'overflow_problem', 'fixed_size_problem', 'server_only']);
const TOOL_QUESTIONS = new Set(['credential', 'will_prompt', 'awaiting_input', 'category', 'reason', 'breaks_callers', 'changes_behavior', 'pick', 'real_secret', 'risky', 'severity', 'project_type', 'package_manager', 'test_framework', ...FINDING_QUESTIONS]);
const isToolQuestion = (name: string): boolean => TOOL_QUESTIONS.has(name) || name.startsWith('fits_');

/**
 * A port answering the tools batteries from `table` and every other question
 * through the gate helper's port with `gateTable`, recording every request.
 */
export function toolReadingsPort(table: ToolReadingTable = [], gateTable: GateReadingTable = []) {
  const tools = toolAnswers(table);
  const gate = gateReadingsPort(gateTable);
  const requests: Array<{ readonly state: unknown; readonly questions: Questions }> = [];
  const port: JudgmentPort = {
    model: tools.port.model,
    async ask(request) {
      requests.push(request as { state: unknown; questions: Questions });
      const entries = Object.entries(request.questions as Questions);
      const own = Object.fromEntries(entries.filter(([name]) => isToolQuestion(name)));
      const other = Object.fromEntries(entries.filter(([name]) => !isToolQuestion(name)));
      const answered = Object.keys(own).length > 0 ? await tools.port.ask({ ...request, questions: own }) : undefined;
      const forwarded = Object.keys(other).length > 0 ? await gate.port.ask({ ...request, questions: other }) : undefined;
      const base = (answered ?? forwarded)!;
      return { ...base, answers: { ...(forwarded?.answers ?? {}), ...(answered?.answers ?? {}) } as never };
    },
  };
  return { port, requests };
}

function toolAnswers(table: ToolReadingTable) {
  return fakePort((name: string, question: Question, state: unknown) => {
    const text = JSON.stringify(state);
    const reading = table.find(([match]) => text.includes(match))?.[1] ?? {};
    switch (name) {
      case 'credential': return noul(reading.credential);
      case 'will_prompt': return noul(reading.willPrompt);
      case 'awaiting_input': return noul(reading.awaitingInput);
      case 'category': return choiceAnswer(question, reading.failure ?? 'lasting', 0.95);
      case 'reason': return choiceAnswer(question, reading.childFailure ?? 'error', 0.95);
      case 'breaks_callers': return noul(reading.breaksCallers);
      case 'changes_behavior': return noul(reading.changesBehavior);
      case 'pick': return choiceAnswer(question, reading.fill ?? 'none', 0.95);
      case 'real_secret': return noul(reading.realSecret);
      case 'risky': return noul(reading.risky);
      case 'severity': return choiceAnswer(question, reading.severity ?? 'low', 0.95);
      case 'project_type': return choiceAnswer(question, reading.projectType ?? 'nodejs', 0.95);
      case 'package_manager': return choiceAnswer(question, reading.packageManager ?? 'npm', 0.95);
      case 'test_framework': return choiceAnswer(question, reading.testFramework ?? 'none', 0.95);
      default:
        if (FINDING_QUESTIONS.has(name)) return noul(reading.finding);
        if (name.startsWith('fits_')) return noul(reading.fill !== undefined && fitCandidate(question) === reading.fill);
        throw new Error(`tool-readings: no answer for question ${name}`);
    }
  });
}

/**
 * Installs a {@link toolReadingsPort} around every test in the calling file
 * (or describe block) and restores the previous port afterwards. The returned
 * object's `requests` is the current test's request log.
 */
export function useToolReadings(table: ToolReadingTable = [], gateTable: GateReadingTable = []): { readonly requests: ReadonlyArray<ToolReadingRequest> } {
  const log: { requests: ReadonlyArray<ToolReadingRequest> } = { requests: [] };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    forgetCredentialEnvReadings();
    forgetServerOnlyReadings();
    forgetGateReadings();
    const { port, requests } = toolReadingsPort(table, gateTable);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
    forgetCredentialEnvReadings();
    forgetServerOnlyReadings();
    forgetGateReadings();
  });
  return log;
}
