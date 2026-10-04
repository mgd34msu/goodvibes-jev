/**
 * A contract runner under test: the real AgentManager, AgentMessageBus,
 * RuntimeEventBus, orchestration engine and contract store, over a temporary
 * git repository, with a scripted fake executor in place of the model loop, a
 * fake planner runner, a fake route selector and the fake judgment port.
 *
 * The fake executor does what the sub-agent loop does for a contract-bound
 * agent: it reports each turn to the runner's `onTurnEnd`, and where the loop
 * would complete it awaits the runner's `holdCompletion`, taking another turn
 * on `continue`. What each agent does is scripted per unit.
 *
 * The unit judge is scripted through the agent's output: an output carrying
 * `[unmet]` reads every criterion as failing, `[p=0.1,0.9]` gives each
 * criterion's probability that it fails, anything else reads met.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withDecisionLog, type DecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { ContractEvent } from '../../sdk/src/events/contract.js';
import { AgentMessageBus } from '../../sdk/src/platform/agents/message-bus.js';
import type { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import type { DecompositionRunner } from '../../sdk/src/platform/core/plan-decomposition.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { emitAgentCompleted, emitAgentFailed, emitAgentRunning } from '../../sdk/src/platform/runtime/emitters/agents.js';
import { emitCommunicationConsumed } from '../../sdk/src/platform/runtime/emitters/communication.js';
import { RuntimeEventBus } from '../../sdk/src/platform/runtime/events/index.js';
import { AgentManager, type AgentRecord } from '../../sdk/src/platform/tools/agent/manager.js';
import {
  ContractStore,
  createContractRunner,
  type ContractHoldOutcome,
  type ContractRouteSelector,
  type ContractRunner,
  type ContractRunnerDeps,
  type ContractSteps,
  type ExecutionPlans,
  type WorkPlanService,
  type ContractTurnRecord,
  type UnitRoute,
} from '../../sdk/src/platform/contract/index.js';
import { planningPort, plannerOutput, type AnswerContext, type DraftPlan } from './plan-support.js';

export const ASK = 'Add a CSV parser module and wire it into the convert command.';

/** Two units: u1 implements the parser in g1; u2 integrates it in g2. */
export function twoUnitPlan(): DraftPlan {
  return {
    goal: 'A convert command backed by a CSV parser',
    criteria: [
      { id: 'c1', text: 'A CSV parser module exists', quote: 'Add a CSV parser module' },
      { id: 'c2', text: 'The convert command uses the parser', quote: 'wire it into the convert command' },
    ],
    groups: [
      {
        id: 'g1', title: 'Parser', goal: 'The parser', kind: 'work', dependsOn: [], criteria: [],
        units: [{
          id: 'u1', title: 'CSV parser', goal: 'Parse CSV', role: 'implement', brief: 'Write src/csv.ts.',
          dependsOn: [], files: ['src/csv.ts'], attempts: undefined,
          criteria: [{ id: 'u1.c1', text: 'src/csv.ts parses CSV', serves: ['c1'] }],
        }],
      },
      {
        id: 'g2', title: 'Integration', goal: 'Wire the parser in', kind: 'integration', dependsOn: ['g1'], criteria: [],
        units: [{
          id: 'u2', title: 'Wire convert', goal: 'Use the parser in convert', role: 'integration', brief: 'Edit src/convert.ts.',
          dependsOn: [], files: ['src/convert.ts'], attempts: undefined,
          criteria: [{ id: 'u2.c1', text: 'convert calls the parser', serves: ['c2'] }],
        }],
      },
    ],
  };
}

/** One unit, u1, with two criteria. */
export function oneUnitPlan(criteria = 2): DraftPlan {
  return {
    goal: 'A CSV parser',
    criteria: [{ id: 'c1', text: 'A CSV parser module exists', quote: 'Add a CSV parser module' }],
    groups: [{
      id: 'g1', title: 'Parser', goal: 'The parser', kind: 'work', dependsOn: [], criteria: [],
      units: [{
        id: 'u1', title: 'CSV parser', goal: 'Parse CSV', role: 'implement', brief: 'Write src/csv.ts.',
        dependsOn: [], files: ['src/csv.ts'], attempts: undefined,
        criteria: Array.from({ length: criteria }, (_, index) => ({ id: `u1.c${index + 1}`, text: `parser property ${index + 1}`, serves: ['c1'] })),
      }],
    }],
  };
}

// ── The judgment port ─────────────────────────────────────────────────────────

const UNMET = 0.9;
const MET = 0.03;

/** Each criterion's probability of failing, read from the output under check. */
function criterionAnswer(output: string, index: number): number {
  const scripted = /\[p=([0-9.,]+)\]/.exec(output);
  if (scripted !== null) return Number(scripted[1]!.split(',')[index] ?? MET);
  return output.includes('[unmet]') ? UNMET : MET;
}

/** The planning port, with the unit judge and the failure reading scripted as above. */
export function runnerPort(override: (context: AnswerContext) => unknown = () => undefined) {
  return planningPort((context) => {
    const scripted = override(context);
    if (scripted !== undefined) return scripted;
    const output = typeof context.state['output'] === 'string' ? context.state['output'] : '';
    const criterion = /^criterion_(\d+)$/.exec(context.name);
    if (criterion !== null) return noulAnswer(criterionAnswer(output, Number(criterion[1])));
    if (context.name === 'goal') return noulAnswer(output.includes('[unmet]') ? UNMET : MET);
    if (context.name === 'severity') return choiceAnswer(context.question, 'major', 0.9);
    // The failure reading (errors package): scripted by the error text.
    const message = JSON.stringify(context.state);
    // The recording boundary validates the complete battery. These two choice
    // questions must not fall through to the planning port's default noul.
    if (context.name === 'category') return choiceAnswer(context.question, message.includes('ECONNRESET') ? 'network' : 'unknown', 0.97);
    if (context.name === 'connection_failure') return choiceAnswer(context.question, 'none', 0.97);
    if (context.name === 'transient_network' || context.name === 'before_response') return noulAnswer(message.includes('ECONNRESET') ? 0.97 : MET);
    return undefined;
  });
}

// ── The temporary repository ──────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

export function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'contract-runner-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

// ── The fake executor ─────────────────────────────────────────────────────────

/** What one scripted step of an agent's run can do. */
export interface AgentStep {
  /** Files to write in the agent's working tree before the turn is reported. */
  readonly files?: Readonly<Record<string, string>>;
  /** The assistant text of the turn (and the output if it is the last). */
  readonly text: string;
  /** Report this as a tool turn (write) to the runner; the final turn is not. */
  readonly tool?: boolean;
  /** Stop here: 'hang' never finishes, 'budget' fails on the turn budget, 'transport' fails with the message. */
  readonly stop?: { readonly kind: 'hang' } | { readonly kind: 'budget' } | { readonly kind: 'error'; readonly message: string };
  /** Awaited after the turn is reported, before the next step. */
  readonly after?: () => Promise<void>;
}

/** The script for one agent run: its steps, taken in order; after a hold's continue, the next step runs. */
export type AgentScript = (record: AgentRecord, run: number) => readonly AgentStep[];

export interface Harness {
  readonly root: string;
  readonly runner: ContractRunner;
  readonly manager: AgentManager;
  readonly messageBus: AgentMessageBus;
  readonly bus: RuntimeEventBus;
  readonly store: ContractStore;
  readonly events: ContractEvent[];
  readonly holds: { readonly agentId: string; readonly outcome: ContractHoldOutcome }[];
  /** Agent ids per unit, in spawn order. */
  agentsOf(unitId: string): string[];
  dispose(): void;
}

export interface HarnessOptions {
  readonly executeAgent?: (record: AgentRecord, context: { readonly root: string; readonly runner: ContractRunner; readonly manager: AgentManager; readonly bus: RuntimeEventBus; readonly messageBus: AgentMessageBus }) => Promise<void>;
  readonly createEngine?: ContractRunnerDeps['createEngine'];
  readonly plan?: DraftPlan;
  readonly contract?: Record<string, unknown>;
  readonly scripts: Readonly<Record<string, AgentScript>>;
  readonly steps?: Partial<ContractSteps>;
  readonly port?: (context: AnswerContext) => unknown;
  /** A planner runner; defaults to one that answers with `plan`. */
  readonly planner?: DecompositionRunner;
  /** The route selector; defaults to one fixed route. */
  readonly routeSelector?: ContractRouteSelector;
  readonly workPlanService?: WorkPlanService;
  readonly planManager?: ExecutionPlans;
  /**
   * An existing repository to run in (a second runner resuming what the first
   * left on disk, as after a restart); the harness then leaves it on dispose.
   */
  readonly root?: string;
  /** Records every reading, so a test can check that the contract tree names them. */
  readonly decisionLog?: DecisionLog;
}

const ROUTE: UnitRoute = { model: 'provider-a:model-a', provider: 'provider-a', reason: 'test tier' };

function configManager(contract: Record<string, unknown>): Pick<ConfigManager, 'get' | 'getCategory'> {
  const values: Record<string, unknown> = { isolation: 'shared', gates: [], transportRetryDelayMs: 0, ...contract };
  // The real reader is typed per key; a test reader over plain values cannot be, hence the widening.
  return {
    get: (key: string): unknown => (key.startsWith('contract.') ? values[key.slice('contract.'.length)] : undefined),
    getCategory: (name: string): unknown => (name === 'contract' ? values : undefined),
  } as unknown as Pick<ConfigManager, 'get' | 'getCategory'>;
}

export function makeHarness(options: HarnessOptions): Harness {
  const root = options.root ?? makeRepo();
  const bus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const events: ContractEvent[] = [];
  const holds: { agentId: string; outcome: ContractHoldOutcome }[] = [];
  const runs = new Map<string, number>();
  const config = configManager(options.contract ?? {});
  const ctx = { sessionId: 'test', traceId: 'test', source: 'test' };
  let runner: ContractRunner;

  async function execute(record: AgentRecord): Promise<void> {
    const unitId = record.contractUnitId;
    const script = unitId === undefined ? undefined : options.scripts[unitId];
    if (script === undefined) throw new Error(`no script for agent ${record.id} (${unitId ?? 'no unit'})`);
    // A real agent's first act is a model call; nothing happens inside spawn itself.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const count = (runs.get(record.id) ?? 0) + 1;
    runs.set(record.id, count);
    record.status = 'running';
    record.usage = { inputTokens: 100 * count, outputTokens: 10 * count, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: count, turnCount: count };
    record.toolCallCount += 2;
    emitAgentRunning(bus, ctx, { agentId: record.id, contractId: record.contractId, contractRole: 'unit', contractUnitId: unitId });
    const cwd = record.workingDirectory ?? root;
    const steps = script(record, count);
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      for (const [path, text] of Object.entries(step.files ?? {})) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), text);
      }
      if (step.stop?.kind === 'hang') {
        // Silent until cancelled, like the real cooperative executor. Tests of
        // uncooperative cleanup supply their own explicit settlement barrier.
        const signal = manager.getCancellationSignal(record.id)!;
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return;
      }
      if (step.stop !== undefined) {
        record.status = 'failed';
        record.fullOutput = step.text;
        if (step.stop.kind === 'budget') record.failureReason = 'max_turns';
        record.error = step.stop.kind === 'error' ? step.stop.message : 'turn budget exhausted';
        record.completedAt = Date.now();
        emitAgentFailed(bus, ctx, { agentId: record.id, error: record.error, durationMs: 1 });
        return;
      }
      if (step.tool === true) {
        const paths = Object.keys(step.files ?? {});
        const turn: ContractTurnRecord = {
          turn: index + 1,
          toolCalls: [{ name: 'write', arguments: { files: paths.map((path) => ({ path })) } }],
          results: paths.map((path) => ({ callId: `write-${path}`, success: true, output: 'written' })),
          assistantText: step.text,
        };
        runner.hooks().onTurnEnd(record, turn);
        await step.after?.();
        continue;
      }
      record.fullOutput = step.text;
      const outcome = await runner.hooks().holdCompletion(record);
      holds.push({ agentId: record.id, outcome });
      if (outcome.kind === 'continue') {
        emitCommunicationConsumed(bus, ctx, { messageId: outcome.nudgeId, agentId: record.id, turn: index + 2 });
        continue;
      }
      break;
    }
    if (record.status !== 'running') return;
    record.status = 'completed';
    record.completedAt = Date.now();
    emitAgentCompleted(bus, ctx, { agentId: record.id, durationMs: 1, output: record.fullOutput ?? '' });
  }

  const manager: AgentManager = new AgentManager({
    configManager: { get: () => null } as unknown as Pick<ConfigManager, 'get'>,
    messageBus,
    archetypeLoader: { loadArchetype: () => null },
    executor: { runAgent: (record): Promise<void> => options.executeAgent ? options.executeAgent(record, { root, runner, manager, bus, messageBus }) : execute(record) },
  });
  manager.setRuntimeBus(bus);
  const store = new ContractStore({ projectRoot: root, debounceMs: 5, sweepIntervalMs: 0 });
  const plan = options.plan ?? twoUnitPlan();
  const planner: DecompositionRunner = options.planner ?? {
    run: async () => ({ status: 'completed', output: plannerOutput(plan), elapsedMs: 1, agentId: 'planner-1' }),
  };
  runner = createContractRunner({
    agentManager: manager,
    messageBus,
    runtimeBus: bus,
    configManager: config,
    projectRoot: root,
    routeSelector: options.routeSelector ?? (async () => ROUTE),
    decompositionRunner: planner,
    createEngine: options.createEngine ?? ((input) => createOrchestrationEngine({
      agentManager: manager,
      configManager: config,
      runtimeBus: bus,
      projectRoot: input.projectRoot,
      stateRoot: input.stateRoot,
      stateNamespace: input.stateNamespace,
      contractUnitSettlement: input.contractUnitSettlement,
      fleetCapacity: input.fleetCapacity,
      judgeAttempts: input.judgeAttempts,
      runWorktreeSetup: () => undefined,
    })),
    fleetCapacity: () => ({ active: 0, maxSize: 64, capKey: 'fleet.maxSize' }),
    priceUsage: (_model, usage) => (usage.inputTokens + usage.outputTokens) / 1_000_000,
    priceProvenance: () => ({ source: 'catalog', asOf: '2026-09-01' }),
    store,
    ...(options.steps === undefined ? {} : { steps: options.steps }),
    ...(options.workPlanService === undefined ? {} : { workPlanService: options.workPlanService }),
    ...(options.planManager === undefined ? {} : { planManager: options.planManager }),
    repositoryMap: async () => 'README.md',
  });
  runner.on((event) => events.push(event));
  const fake = runnerPort(options.port);
  const previous = installJudgmentPort(options.decisionLog === undefined ? fake.port : withDecisionLog(fake.port, options.decisionLog));

  return {
    root,
    runner,
    manager,
    messageBus,
    bus,
    store,
    events,
    holds,
    agentsOf: (unitId) => manager.list().filter((record) => record.contractUnitId === unitId).sort((a, b) => a.startedAt - b.startedAt).map((record) => record.id),
    dispose: () => {
      runner.dispose();
      installJudgmentPort(previous);
      if (options.root === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Starts a contract on the harness's repository. */
export function startContract(harness: Harness, overrides: Partial<Parameters<ContractRunner['start']>[0]> = {}) {
  return harness.runner.start({ ask: ASK, sessionId: 'session-1', origin: 'cli', projectRoot: harness.root, ...overrides });
}

/** Waits until `predicate` holds, polling; throws with `what` after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The events of one type. */
export function eventsOf<T extends ContractEvent['type']>(harness: Harness, type: T): Extract<ContractEvent, { type: T }>[] {
  return harness.events.filter((event): event is Extract<ContractEvent, { type: T }> => event.type === type);
}
