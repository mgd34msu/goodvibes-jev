/** Actual contract -> AgentManager -> default orchestrator -> captured repair -> ToolLLM. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { judgmentInputBoundary } from '../../sdk/src/platform/gate/boundary.js';
import { assertContractInputAuthority, getContractInputAuthority, revokeContractInputAuthority } from '../../sdk/src/platform/contract/input-authority.js';
import { createContractRunner } from '../../sdk/src/platform/contract/runner.js';
import { ContractStore } from '../../sdk/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import type { ChatRequest, LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import type { ToolCall, ToolResult } from '../../sdk/src/platform/types/tools.js';
import type { ReadOutput } from '../../sdk/src/platform/tools/read/index.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

const supported = (await probeCapturedExecAvailability()).available;
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !supported)
  throw new Error('required actual captured auto-heal execution backend is unavailable');

const original = 'export const parse = () => "ORIGINAL_HEAL_INPUT";\n';
const broken = 'export function parse() { return "BROKEN_HEAL_INPUT";\n';
const repaired = 'export function parse() { return "BROKEN_HEAL_INPUT"; }\n';
const editRepaired = original.replace('ORIGINAL_HEAL_INPUT', 'REPAIRED_EDIT_VALIDATION');
type Mode = 'write' | 'edit';
type Outcome = 'accept' | 'reject' | 'unparsable' | 'deny-before' | 'deny-pending' | 'revoke-pending' | 'cancel-pending' | 'resume';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function observed<T>(promise: Promise<T>, milliseconds: number) {
  return Promise.race([
    promise.then((value) => ({ state: 'settled' as const, value })),
    Bun.sleep(milliseconds).then(() => ({ state: 'pending' as const })),
  ]);
}

interface WrittenFile {
  backup_path?: string;
  bytes_written: number;
  auto_heal?: { attempted: boolean; healed: boolean; method?: string };
}

async function fixture(mode: Mode, outcome: Outcome) {
  const root = makeRepo();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/csv.ts'), original);
  writeFileSync(join(root, 'owner.txt'), 'OWNER_COMMITTED\n');
  writeFileSync(join(root, 'private.txt'), 'DENIED_ORIGINAL_HEAL_SECRET\n');
  if (mode === 'edit') {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'bun build-fixture.ts' } }));
    writeFileSync(join(root, 'build-fixture.ts'), [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `if (existsSync(${JSON.stringify(join(root, 'owner.txt'))})) throw Error("owner escaped into repair validator");`,
      'if (existsSync(".git") || existsSync(".goodvibes") || existsSync("private.txt")) throw Error("unadmitted validator input");',
      'if (process.env.HOME !== "/home/captured") throw Error("validator is not contained");',
      'const source = readFileSync("src/csv.ts", "utf8");',
      'if (!source.includes("REPAIRED_EDIT_VALIDATION")) throw Error("REPAIR_REQUIRED_FOR_EDIT: " + source);',
      'writeFileSync("validated-repair.txt", source);',
    ].join('\n'));
  }
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'actual captured auto-heal fixture');
  writeFileSync(join(root, 'owner.txt'), 'OWNER_STAGED\n'); git(root, 'add', 'owner.txt');
  writeFileSync(join(root, 'owner.txt'), 'OWNER_UNSTAGED\n');
  writeFileSync(join(root, 'owner-untracked.txt'), 'OWNER_UNTRACKED\n');
  const ownerIndex = readFileSync(join(root, '.git/index'));
  const ownerHead = git(root, 'rev-parse', 'HEAD');
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.engine', 'policy-engine'); config.set('permissions.mode', 'prompt');
  config.set('behavior.autoApprove', false); config.set('contract.isolation', 'worktree');
  config.set('tools.autoHeal', true); config.set('tools.llmEnabled', true);
  config.set('tools.llmProvider', 'captured-heal-fixture'); config.set('tools.llmModel', 'fixture');
  const bus = new RuntimeEventBus();
  const runtime = createClientRuntimeServices({
    surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
    runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
    providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
  });
  await resumeContracts(runtime.contractRunner, root);
  const acceptance: { name: string; state: Record<string, unknown> }[] = [];
  const previous = installJudgmentPort(runnerPort((context) => {
    if (context.name === 'family') return choiceAnswer(context.question, 'file-mutation', 0.99);
    // A denied mutation can legitimately reach the runner's stall battery.
    // Return that question's complete choice distribution, never a noul stub.
    if (context.name === 'route' && context.question.type === 'choice'
      && Object.keys(context.question.criteria).sort().join(',') === 'fresh,owner,split')
      return choiceAnswer(context.question, 'owner', 0.99);
    if (context.name === 'fixes_errors' || context.name === 'only_the_fix') {
      acceptance.push({ name: context.name, state: context.state });
      return noulAnswer(outcome === 'reject' && context.name === 'only_the_fix' ? 0.03 : 0.97);
    }
    return undefined;
  }).port);
  async function denyOriginal(path: string, id: string): Promise<void> {
    await runtime.userPermissionRuleStore.add({ rule: {
      id, type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, path)],
    }, createdAt: Date.now(), tier: 'path', tool: 'read' });
  }
  await denyOriginal('private.txt', 'deny-original-heal-private');
  const repairEntered = deferred<void>();
  const releaseRepair = deferred<void>();
  const repairReturned = deferred<void>();
  const resumePaused = deferred<void>();
  let resumed = false;
  const pending = outcome.endsWith('-pending');
  const results = new Map<string, ToolResult>();
  const requests: string[] = [];
  const repairRequests: ChatRequest[] = [];
  let memberCalls = 0;
  let plannerCalls = 0;
  let memberRoot = '';
  let memberContent: string | undefined;
  let backups: string[] = [];
  let checkedBeforeDelivery = false;
  // Bounded, value-free observations of the actual original-owner read filter.
  // Preserve the real permission answer; never log paths, source bytes or tokens.
  const readChecks: { candidate: 'owner-source' | 'member-source' | 'other'; decision: 'allow' | 'restricted'; boundary: string; memberCalls: number }[] = [];
  const originalReadAccess = runtime.permissionManager.readAccess;
  runtime.permissionManager.readAccess = async (path) => {
    const decision = await originalReadAccess.call(runtime.permissionManager, path);
    if (readChecks.length < 128) {
      const boundary = judgmentInputBoundary('read', { path }, root);
      readChecks.push({
        candidate: path === join(root, 'src/csv.ts') ? 'owner-source'
          : path.endsWith('/src/csv.ts') && path.includes('/.worktrees/') ? 'member-source' : 'other',
        decision, boundary: boundary.passed ? 'pass' : boundary.checks[0]?.detail ?? 'refused', memberCalls,
      });
    }
    return decision;
  };
  const firstToolResult = deferred<void>();
  const assertOwnerState = (): void => {
    expect(readFileSync(join(root, 'owner.txt'), 'utf8')).toBe('OWNER_UNSTAGED\n');
    expect(readFileSync(join(root, 'owner-untracked.txt'), 'utf8')).toBe('OWNER_UNTRACKED\n');
    expect(readFileSync(join(root, '.git/index'))).toEqual(ownerIndex);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(ownerHead);
    expect(existsSync(join(root, '.goodvibes', '.backups'))).toBe(false);
  };
  const assertOwnerUnchanged = (): void => {
    assertOwnerState();
    expect(readFileSync(join(root, 'src/csv.ts'), 'utf8')).toBe(original);
    expect(existsSync(join(root, 'validated-repair.txt'))).toBe(false);
  };
  const call: ToolCall = mode === 'write' ? {
    id: 'captured-heal', name: 'write', arguments: {
      files: [
        { path: 'src/csv.ts', content: broken, mode: 'backup' },
        ...(outcome === 'accept' ? [{ path: 'src/csv.ts', content: broken, mode: 'backup' }] : []),
      ], transaction: { mode: 'atomic' }, verbosity: 'standard',
    },
  } : {
    id: 'captured-heal', name: 'edit', arguments: {
      edits: [{ path: 'src/csv.ts', find: 'ORIGINAL_HEAL_INPUT', replace: 'BROKEN_EDIT_VALIDATION' }],
      validate: { after: ['build'] }, transaction: { mode: 'atomic' }, output: { format: 'with_diff' },
    },
  };
  const provider: LLMProvider = {
    name: 'captured-heal-fixture', models: ['fixture'], isConfigured: () => true,
    async chat(request) {
      if (request.systemPrompt?.startsWith('You are a code repair tool.')) {
        repairRequests.push(request); repairEntered.resolve();
        assertOwnerUnchanged();
        if (pending) await releaseRepair.promise; // Deliberately ignores cancellation.
        repairReturned.resolve();
        return {
          content: outcome === 'unparsable' ? 'export function parse( {' : mode === 'edit' ? editRepaired : repaired,
          toolCalls: [], usage: { inputTokens: 2, outputTokens: 3 }, stopReason: 'completed',
        };
      }
      requests.push(JSON.stringify(request));
      if (!request.tools?.some((tool) => tool.name === 'write')) {
        plannerCalls++;
        return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      }
      memberCalls++;
      memberRoot = runtime.agentManager.list().find((record) => record.contractRole === 'unit')!.workingDirectory!;
      expect(memberRoot).not.toBe(root); assertOwnerUnchanged();
      if (outcome === 'resume' && !resumed && memberCalls === 2) {
        resumePaused.resolve();
        return new Promise<never>((_, reject) => {
          if (!request.signal) return reject(new Error('resume fixture member has no owned cancellation signal'));
          const abort = () => reject(new DOMException('fixture interrupted for restart', 'AbortError'));
          if (request.signal.aborted) abort();
          else request.signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (memberCalls === 1 && outcome === 'deny-before') await denyOriginal('src/csv.ts', 'deny-original-heal-source');
      const step: ToolCall | undefined = memberCalls === 1 ? call
        : outcome === 'accept' && memberCalls === 2 ? {
            id: 'read-repaired-file', name: 'read', arguments: {
              files: [{ path: 'src/csv.ts', force: true }],
              output: { format: 'standard', include_line_numbers: false },
            },
          } : undefined;
      return {
        content: step ? '' : 'Created src/csv.ts. The parser works.',
        toolCalls: step ? [step] : [], usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: step ? 'tool_call' : 'completed',
      };
    },
  };
  runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{
    id: 'fixture', provider: provider.name, registryKey: 'captured-heal-fixture:fixture', displayName: 'Fixture', description: 'In-process captured repair fixture',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard',
  }], replace: true });
  await runtime.providerRegistry.ready();
  let store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
  const buildRunner = () => createContractRunner({
    agentManager: runtime.agentManager, messageBus: runtime.agentMessageBus, runtimeBus: bus,
    configManager: { get: config.get.bind(config), getCategory: ((name: string) => name === 'contract'
      ? { ...config.getCategory('contract'), gates: [] }
      : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory },
    projectRoot: root, routeSelector: async () => ({ model: 'captured-heal-fixture:fixture', provider: 'captured-heal-fixture', reason: 'actual captured repair fixture' }),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
    createEngine: (input) => createOrchestrationEngine({
      agentManager: runtime.agentManager, configManager: config, runtimeBus: bus,
      projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: outcome === 'revoke-pending' ? 'ctr-797d133b' : input.stateNamespace,
      initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
      contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
      runWorktreeSetup: () => undefined,
    }),
    fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
    priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-08' }), store,
    readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
  });
  let runner = buildRunner();
  function bindRunner(): void {
    runtime.agentManager.setContractRunner(runner);
    runtime.agentOrchestrator.setDependencies({
      ...runtime, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow,
      contractRunner: runner, contractHooks: {
        onTurnEnd(record, turn) {
          for (const result of turn.results) {
            results.set(result.callId, result);
            if (result.callId === call.id) {
              firstToolResult.resolve();
              const source = join(record.workingDirectory!, 'src/csv.ts');
              memberContent = existsSync(source) ? readFileSync(source, 'utf8') : undefined;
              if (mode === 'write' && result.success) {
                const files = (JSON.parse(result.output!) as { files: WrittenFile[] }).files;
                backups = files.flatMap((file) => file.backup_path ? [readFileSync(file.backup_path, 'utf8')] : []);
              }
            }
          }
          runner.hooks().onTurnEnd(record, turn);
        },
        async holdCompletion(record) {
          if (record.contractRole === 'unit') { assertOwnerUnchanged(); checkedBeforeDelivery = true; }
          return runner.hooks().holdCompletion(record);
        },
      },
    });
  }
  bindRunner();
  let id: string | undefined;
  return {
    root, runtime, get runner() { return runner; }, results, requests, repairRequests, acceptance, repairEntered, releaseRepair, repairReturned, resumePaused,
    assertOwnerState, assertOwnerUnchanged, denyOriginal,
    awaitRepair: () => Promise.race([
      repairEntered.promise.then(() => 'entered' as const),
      firstToolResult.promise.then(() => 'ended-before-repair' as const),
    ]),
    member: () => runtime.agentManager.list().find((record) => record.contractRole === 'unit')!,
    state: () => ({ memberCalls, plannerCalls, memberRoot, memberContent, backups, checkedBeforeDelivery, repairRequestCount: repairRequests.length, readChecks }),
    start() {
      id = runner.start({ ask: 'Add a CSV parser module', sessionId: 'actual-captured-heal-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' }).contract.id;
      return id;
    },
    async resume() {
      runner.dispose(); await runner.join(id!); store.dispose();
      resumed = true; memberCalls = 0;
      store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
      runner = buildRunner(); bindRunner(); await runner.resumeAll();
    },
    async settle() {
      try {
        await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'actual captured auto-heal settlement', 60_000);
      } catch (error) {
        throw new Error(JSON.stringify({ error: String(error), contract: runner.get(id!), memberCalls, plannerCalls,
          repairs: repairRequests.length, results: [...results], agents: runtime.agentManager.list().map((record) => ({
            role: record.contractRole, status: record.status, error: record.error, progress: record.progress,
          })) }));
      }
      await runner.join(id!);
      return runner.get(id!)!;
    },
    async dispose() {
      releaseRepair.resolve();
      if (id) { runner.cancel(id, 'fixture cleanup'); await runner.join(id); }
      runner.dispose(); store.dispose(); runtime.dispose(); runtime.permissionManager.readAccess = originalReadAccess; installJudgmentPort(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const mode of ['write', 'edit'] as const) {
  test.skipIf(mode === 'edit' && !supported)(`actual captured ${mode} repairs through ToolLLM and reads accepted member bytes before delivery`, async () => {
    const f = await fixture(mode, 'accept');
    try {
      f.start(); const contract = await f.settle(); const result = f.results.get('captured-heal');
      expect(result?.success, JSON.stringify({ result, contract: contract.error })).toBe(true);
      expect(contract.status, contract.error).toBe('passed'); expect(contract.commit?.status).toBe('applied');
      expect(contract.commit?.hash).toBeUndefined(); expect(contract.commit?.note).toContain('uncommitted');
      expect(f.state().plannerCalls).toBe(1); expect(f.state().memberCalls).toBe(3);
      const repairCount = mode === 'write' ? 2 : 1;
      expect(f.state().checkedBeforeDelivery).toBe(true); expect(f.repairRequests).toHaveLength(repairCount);
      expect(f.repairRequests.every((request) => request.signal !== undefined)).toBe(true);
      expect(f.acceptance.map((entry) => entry.name).sort()).toEqual(
        Array.from({ length: repairCount }, () => ['fixes_errors', 'only_the_fix']).flat().sort(),
      );
      expect(JSON.stringify(f.repairRequests)).not.toContain('DENIED_ORIGINAL_HEAL_SECRET');
      expect(f.requests.join('\n')).not.toContain('DENIED_ORIGINAL_HEAL_SECRET');
      const expected = mode === 'write' ? repaired : editRepaired;
      const readResult = f.results.get('read-repaired-file');
      expect(readResult?.success, JSON.stringify(readResult)).toBe(true);
      const readOutput = JSON.parse(readResult!.output!) as ReadOutput;
      expect(readOutput.success).toBe(true);
      expect(readOutput.summary).toMatchObject({ files_read: 1, files_binary: 0, files_errored: 0 });
      expect(readOutput.files).toHaveLength(1);
      expect(readOutput.files?.[0]).toMatchObject({
        path: 'src/csv.ts', resolvedPath: join(f.state().memberRoot, 'src/csv.ts'),
        content: expected, byteSize: Buffer.byteLength(expected), cache: { status: 'miss' },
      });
      const memberRequests = f.requests.map((request) => JSON.parse(request) as ChatRequest)
        .filter((request) => request.tools?.some((tool) => tool.name === 'write'));
      expect(memberRequests).toHaveLength(3);
      const repairDelivered = memberRequests[1]?.messages.find((message) => message.role === 'tool' && message.callId === 'captured-heal');
      const readDelivered = memberRequests[2]?.messages.find((message) => message.role === 'tool' && message.callId === 'read-repaired-file');
      expect(repairDelivered?.content).toBe(result!.output);
      expect(readDelivered?.content).toBe(readResult!.output);
      expect(readResult!.output).not.toContain('DENIED_ORIGINAL_HEAL_SECRET');
      expect(f.state().memberContent).toBe(expected); expect(readFileSync(join(f.root, 'src/csv.ts'), 'utf8')).toBe(expected);
      if (mode === 'write') {
        const files = (JSON.parse(result!.output!) as { files: WrittenFile[] }).files;
        expect(files).toHaveLength(2);
        for (const file of files) {
          expect(file.auto_heal).toEqual({ attempted: true, healed: true, method: 'llm' });
          expect(file.bytes_written).toBe(Buffer.byteLength(repaired));
        }
        expect(f.state().backups).toEqual([original, repaired]);
      } else {
        expect(JSON.stringify(f.repairRequests[0]?.messages)).toContain('REPAIR_REQUIRED_FOR_EDIT');
        expect(JSON.stringify(f.repairRequests[0]?.messages)).toContain('BROKEN_EDIT_VALIDATION');
        expect(readFileSync(join(f.root, 'validated-repair.txt'), 'utf8')).toBe(editRepaired);
      }
      f.assertOwnerState();
    } finally { await f.dispose(); }
  }, 90_000);
}

for (const outcome of ['reject', 'unparsable'] as const) {
  test(`actual captured write ${outcome} repair preserves initial written bytes and backup`, async () => {
    const f = await fixture('write', outcome);
    try {
      f.start(); await f.settle(); const result = f.results.get('captured-heal');
      expect(result?.success, JSON.stringify(result)).toBe(true);
      const file = (JSON.parse(result!.output!) as { files: WrittenFile[] }).files[0]!;
      expect(file.auto_heal).toEqual({ attempted: true, healed: false });
      expect(file.bytes_written).toBe(Buffer.byteLength(broken));
      expect(f.repairRequests).toHaveLength(1); expect(f.state().memberContent).toBe(broken);
      expect(f.state().backups).toEqual([original]);
      expect(readFileSync(join(f.root, 'src/csv.ts'), 'utf8')).toBe(broken);
      expect(f.acceptance).toHaveLength(outcome === 'unparsable' ? 0 : 2);
      f.assertOwnerState();
    } finally { await f.dispose(); }
  }, 90_000);
}

test('actual captured repair respects a stored original-owner source denial before ToolLLM admission', async () => {
  const f = await fixture('write', 'deny-before');
  try {
    f.start(); const contract = await f.settle();
    expect(contract.status).toBe('awaiting-owner');
    expect(contract.error ?? '').not.toContain('probability distribution');
    expect(f.repairRequests).toHaveLength(0); expect(f.acceptance).toHaveLength(0);
    // A path denied before its first read need not block subsequent safe model
    // turns. It must block this mutation and every repair admission.
    expect(f.state().memberCalls).toBeGreaterThanOrEqual(1);
    const result = f.results.get('captured-heal');
    expect(result?.success).toBe(false); expect(result?.output).toBeUndefined(); expect(result?.error).toContain('Output withheld');
    expect(f.state().memberContent).toBe(original); f.assertOwnerUnchanged();
  } finally { await f.dispose(); }
}, 90_000);

for (const outcome of ['deny-pending', 'revoke-pending', 'cancel-pending'] as const) {
  test(`actual captured repair ${outcome} withholds a late signal-ignoring model response`, async () => {
    const f = await fixture('write', outcome);
    try {
      const id = f.start();
      const entry = await observed(f.awaitRepair(), 60_000);
      expect(entry.state === 'settled' ? entry.value : entry.state,
        JSON.stringify({ state: f.state(), contract: f.runner.get(id)?.error, results: [...f.results] })).toBe('entered');
      const member = f.member(); const source = join(member.workingDirectory!, 'src/csv.ts');
      expect(readFileSync(source, 'utf8')).toBe(broken); f.assertOwnerUnchanged();
      const execution = f.runtime.agentManager.join(member.id);
      expect((await observed(execution, 25)).state).toBe('pending');
      if (outcome === 'deny-pending') await f.denyOriginal('src/csv.ts', 'deny-original-heal-late');
      else if (outcome === 'revoke-pending') {
        const authority = getContractInputAuthority(member);
        expect(authority).toBeDefined(); revokeContractInputAuthority(authority!);
      } else {
        f.runner.cancel(id, 'cancel pending captured auto-heal');
        expect((await observed(execution, 2_000)).state).toBe('settled');
        expect(f.repairRequests[0]?.signal?.aborted).toBe(true);
      }
      f.releaseRepair.resolve();
      expect((await observed(f.repairReturned.promise, 2_000)).state).toBe('settled');
      const contract = await f.settle();
      expect(contract.status).not.toBe('passed'); expect(f.acceptance).toHaveLength(0);
      expect(f.state().memberCalls).toBe(1); expect(f.repairRequests).toHaveLength(1);
      const snapshot = f.runtime.agentManager.getConversationSnapshot(member.id);
      const toolResult = snapshot.find((message) => message.role === 'tool' && message.callId === 'captured-heal');
      expect(toolResult).toBeDefined();
      expect(JSON.stringify(toolResult)).not.toContain('bytes_written');
      expect(JSON.stringify(toolResult)).not.toContain('auto_heal');
      if (existsSync(source)) expect(readFileSync(source, 'utf8')).toBe(broken);
      expect(f.requests).toHaveLength(2); f.assertOwnerUnchanged();
      // A completed ToolLLM response cannot resume judgment or publication after settlement.
      await Bun.sleep(25); expect(f.acceptance).toHaveLength(0);
      if (existsSync(source)) expect(readFileSync(source, 'utf8')).toBe(broken);
    } finally { await f.dispose(); }
  }, 90_000);
}

test('actual captured repair resumes with a fresh authority/backend for the same member root', async () => {
  const f = await fixture('write', 'resume');
  try {
    const id = f.start();
    expect((await observed(f.resumePaused.promise, 60_000)).state,
      JSON.stringify({ state: f.state(), results: [...f.results], contract: f.runner.get(id)?.error })).toBe('settled');
    const oldMember = f.member(); const oldAuthority = getContractInputAuthority(oldMember)!;
    expect(oldAuthority).toBeDefined(); expect(f.repairRequests).toHaveLength(1);
    expect(readFileSync(join(oldMember.workingDirectory!, 'src/csv.ts'), 'utf8')).toBe(repaired);
    f.assertOwnerUnchanged();
    await f.resume(); await expect(assertContractInputAuthority(oldAuthority)).rejects.toThrow();
    const contract = await f.settle();
    const rebound = f.runtime.agentManager.list().find((record) => record.contractRole === 'unit' && record.id !== oldMember.id);
    expect(rebound).toBeDefined(); expect(rebound?.workingDirectory).toBe(oldMember.workingDirectory);
    expect(getContractInputAuthority(rebound!)).toBeDefined(); expect(getContractInputAuthority(rebound!)).not.toBe(oldAuthority);
    expect(contract.status, JSON.stringify({ error: contract.error, results: [...f.results] })).toBe('passed');
    expect(contract.commit?.status).toBe('applied'); expect(f.repairRequests).toHaveLength(2);
    expect(f.results.get('captured-heal')?.success).toBe(true);
    expect(readFileSync(join(f.root, 'src/csv.ts'), 'utf8')).toBe(repaired);
    expect(f.acceptance).toHaveLength(4); f.assertOwnerState();
  } finally { await f.dispose(); }
}, 120_000);
