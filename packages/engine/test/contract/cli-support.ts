/**
 * Fakes for the contract CLI tests: a runner over real contract trees whose
 * behaviour each test scripts, the process io, and the opened runner the bin
 * would hand the CLI.
 */
import type { ContractEvent } from '../../sdk/src/events/contract.js';
import type {
  ContractCliDeps,
  ContractCliIo,
  ContractCliRunner,
  ContractSessionDriver,
  OpenedContractRunner,
} from '../../sdk/src/platform/contract/cli.js';
import type { OwnerReplyOutcome } from '../../sdk/src/platform/contract/escalation.js';
import type { ResumeReport } from '../../sdk/src/platform/contract/resume.js';
import type { StartedContract } from '../../sdk/src/platform/contract/runner.js';
import type { Contract, ContractView, Escalation, StartContractInput, UnitCheck } from '../../sdk/src/platform/contract/types.js';
import type { AgentRecord } from '../../sdk/src/platform/tools/agent/index.js';
import { makeContract } from './fixtures.js';

export const PROJECT = '/work/project';
export const CLI_SESSION = 'cli-test-session';

function ownerRecord(contract: Contract): AgentRecord {
  return {
    id: contract.ownerAgentId,
    task: contract.ask,
    template: 'contract-owner',
    tools: [],
    status: 'running',
    startedAt: contract.createdAt,
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'contract',
    communicationLane: 'parent-only',
    contractId: contract.id,
    contractRole: 'owner',
  };
}

export function unitCheck(id: string): UnitCheck {
  return {
    id,
    at: 2_000,
    trigger: 'completion',
    goal: { probabilityUnmet: 0.1, verdict: 'met', outcome: 'act' },
    quality: {},
    result: 'nudge',
    decisionIds: [],
    evidenceDigest: 'digest',
  };
}

/** A runner holding real contract trees; `onStart` scripts what a started contract does next. */
export class FakeRunner implements ContractCliRunner {
  readonly contracts = new Map<string, Contract>();
  readonly started: StartContractInput[] = [];
  readonly cancels: [string, string][] = [];
  readonly replies: [string, string, string][] = [];
  onStart: (contract: Contract) => void = () => {};
  onReply: (contract: Contract, escalationId: string, text: string) => OwnerReplyOutcome = (contract, escalationId) => {
    this.resolveEscalation(contract, escalationId);
    return { escalationId, reading: 'approve', outcome: 'act', action: 'approved' };
  };
  private readonly listeners = new Set<(event: ContractEvent) => void>();

  hold(contract: Contract): Contract {
    this.contracts.set(contract.id, contract);
    return contract;
  }

  emit(event: ContractEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  move(contract: Contract, to: Contract['status']): void {
    const from = contract.status;
    contract.status = to;
    this.emit({ type: 'CONTRACT_STATUS_CHANGED', contractId: contract.id, from, to });
  }

  pass(contract: Contract, answer = 'The parser is written and tested.'): void {
    for (const unit of contract.units) unit.status = 'passed';
    contract.answer = answer;
    contract.statusLine = `Contract ${contract.id} passed; 1/1 criteria met`;
    this.move(contract, 'passed');
    this.emit({ type: 'CONTRACT_PASSED', contractId: contract.id, criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
  }

  fail(contract: Contract, reason = 'the planner could not plan'): void {
    contract.error = reason;
    contract.statusLine = `Contract ${contract.id} failed: ${reason}`;
    this.move(contract, 'failed');
    this.emit({ type: 'CONTRACT_FAILED', contractId: contract.id, reason, failureKind: 'planning', membersSettled: true });
  }

  escalate(contract: Contract, question = 'The parser keeps failing criterion u1.c1. What should change?'): Escalation {
    const escalation: Escalation = {
      id: `${contract.id}.e${contract.escalations.length + 1}`,
      at: 3_000 + contract.escalations.length,
      scope: 'unit',
      targetId: 'u1',
      reason: 'stalled',
      question,
      unmetCriterionIds: ['u1.c1'],
    };
    contract.escalations.push(escalation);
    if (contract.status !== 'awaiting-owner') this.move(contract, 'awaiting-owner');
    this.emit({
      type: 'CONTRACT_ESCALATED',
      contractId: contract.id,
      escalationId: escalation.id,
      scope: escalation.scope,
      targetId: escalation.targetId,
      reason: escalation.reason,
      question: escalation.question,
      unmetCriterionIds: escalation.unmetCriterionIds,
    });
    return escalation;
  }

  resolveEscalation(contract: Contract, escalationId: string): void {
    const escalation = contract.escalations.find((candidate) => candidate.id === escalationId);
    if (escalation !== undefined) escalation.resolvedAt = 4_000;
  }

  start(input: StartContractInput): StartedContract {
    this.started.push(input);
    const contract = this.hold(makeContract({ ask: input.ask, sessionId: input.sessionId, origin: input.origin, projectRoot: input.projectRoot, status: 'queued' }));
    this.emit({ type: 'CONTRACT_CREATED', contractId: contract.id, sessionId: contract.sessionId, origin: contract.origin, ask: contract.ask, ownerAgentId: contract.ownerAgentId });
    queueMicrotask(() => this.onStart(contract));
    return { contract: structuredClone(contract), owner: ownerRecord(contract) };
  }

  get(contractId: string): ContractView | null {
    const contract = this.contracts.get(contractId);
    return contract === undefined ? null : structuredClone(contract);
  }

  list(filter: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined } = {}): ContractView[] {
    return [...this.contracts.values()]
      .filter((contract) => filter.sessionId === undefined || contract.sessionId === filter.sessionId)
      .filter((contract) => filter.includeTerminal === true || !['passed', 'failed', 'cancelled'].includes(contract.status))
      .map((contract) => structuredClone(contract));
  }

  cancel(contractId: string, reason: string): boolean {
    this.cancels.push([contractId, reason]);
    const contract = this.contracts.get(contractId);
    if (contract === undefined || ['passed', 'failed', 'cancelled'].includes(contract.status)) return false;
    contract.error = reason;
    contract.statusLine = `Contract ${contract.id} cancelled; 0 files already modified on disk`;
    this.move(contract, 'cancelled');
    this.emit({ type: 'CONTRACT_CANCELLED', contractId, reason, filesModified: 0 });
    return true;
  }

  async reply(contractId: string, escalationId: string, text: string): Promise<OwnerReplyOutcome> {
    this.replies.push([contractId, escalationId, text]);
    const contract = this.contracts.get(contractId);
    if (contract === undefined) throw new Error(`contract ${contractId} is not running`);
    return this.onReply(contract, escalationId, text);
  }

  on(listener: (event: ContractEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The process io: captured lines, scripted input lines, and an interrupt the test fires. */
export class FakeIo implements ContractCliIo {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  readonly prompts: string[] = [];
  readonly interruptHandlers = new Set<() => void>();
  constructor(readonly isTTY: boolean, private readonly input: string[] = []) {}
  out = (line: string): void => { this.stdout.push(line); };
  err = (line: string): void => { this.stderr.push(line); };
  async readLine(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.input.shift() ?? null;
  }
  onInterrupt(handler: () => void): () => void {
    this.interruptHandlers.add(handler);
    return () => { this.interruptHandlers.delete(handler); };
  }
  interrupt(): void {
    for (const handler of [...this.interruptHandlers]) handler();
  }
}

/** A session driver whose turns the test scripts. */
export class FakeSessions implements ContractSessionDriver {
  readonly submitted: [string, string][] = [];
  cancelled = 0;
  private running = new Set<string>();
  onTurn: (sessionId: string, text: string) => void | Promise<void> = () => {};
  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }
  async submit(sessionId: string, text: string): Promise<void> {
    this.submitted.push([sessionId, text]);
    this.running.add(sessionId);
    try {
      await this.onTurn(sessionId, text);
    } finally {
      this.running.delete(sessionId);
    }
  }
  cancelAll(): void {
    this.cancelled += 1;
  }
}

export interface CliHarness {
  readonly runner: FakeRunner;
  readonly sessions: FakeSessions;
  readonly deps: ContractCliDeps;
  readonly opened: { count: number; disposed: number; resumedCalls: number };
  /** Contracts `readContracts` returns. */
  readonly onDisk: Contract[];
}

export function cliHarness(options: { readonly report?: ResumeReport | null; readonly openError?: Error } = {}): CliHarness {
  const runner = new FakeRunner();
  const sessions = new FakeSessions();
  const onDisk: Contract[] = [];
  const opened = { count: 0, disposed: 0, resumedCalls: 0 };
  const report = options.report === undefined ? { resumed: [], queued: [], reaped: [], skipped: [] } : options.report;
  const deps: ContractCliDeps = {
    cwd: PROJECT,
    readContracts: () => onDisk.map((contract) => structuredClone(contract)),
    openRunner: async (): Promise<OpenedContractRunner> => {
      if (options.openError !== undefined) throw options.openError;
      opened.count += 1;
      return {
        runner,
        resumed: () => {
          opened.resumedCalls += 1;
          return Promise.resolve(report);
        },
        sessions,
        dispose: async () => { opened.disposed += 1; },
      };
    },
    newSessionId: () => CLI_SESSION,
  };
  return { runner, sessions, deps, opened, onDisk };
}

/** Waits until `predicate` holds, a macrotask at a time. */
export async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}
