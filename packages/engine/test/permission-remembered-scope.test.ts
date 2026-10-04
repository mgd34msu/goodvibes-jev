/**
 * Remembered authority keeps its chosen scope and follows live revocation.
 * Current callback behavior is exercised with synthetic decisions and Jev
 * readings; this is regression coverage, not a human-wait product contract.
 * No command is executed: the real registry/admission path ends at a counter.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import type { PermissionRequestHandler } from '../sdk/src/platform/permissions/prompt.ts';
import { buildDurableRuleForDecision } from '../sdk/src/platform/permissions/approval-rules.ts';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { registerPermissionRulesGatewayMethods } from '../sdk/src/platform/control-plane/routes/permission-rules.ts';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { EXEC_TOOL_SCHEMA } from '../sdk/src/platform/tools/exec/schema.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { evaluatePrefixRule } from '../sdk/src/platform/runtime/permissions/rules/prefix.ts';
import { LayeredPolicyEvaluator } from '../sdk/src/platform/runtime/permissions/evaluator.ts';
import type { PrefixRule } from '../sdk/src/platform/runtime/permissions/types.ts';

useGateReadings([['git wipe-fixture', { catastrophic: true }]]);

const execArgs = (...commands: string[]): Record<string, unknown> => ({
  commands: commands.map((cmd) => ({ cmd })),
});
const commit = execArgs('git commit -m one');
const push = execArgs('git push');

function manager(handler: PermissionRequestHandler, store: UserPermissionRuleStore | null): PermissionManager {
  return new PermissionManager(handler, {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/synthetic/remembered-scope',
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as PermissionConfigReader, new PolicyRuntimeState(), null, null, store);
}

/** These callback-era fixtures exercise the retained API; autonomous negatives live in autonomous-tool-admission.test.ts. */
function legacyPermissionConsumer(manager: PermissionManager): PermissionManager {
  return { check: manager.check.bind(manager), checkDetailed: manager.checkDetailed.bind(manager) } as PermissionManager;
}

async function revoke(store: UserPermissionRuleStore): Promise<void> {
  const catalog = new GatewayMethodCatalog();
  registerPermissionRulesGatewayMethods(catalog, { userRuleStore: store });
  const invocation = { context: { admin: true } } as const;
  const listed = await catalog.invoke('permissions.rules.list', { ...invocation, body: {} }) as { rules: { id: string }[] };
  expect(listed.rules).toHaveLength(1);
  expect(await catalog.invoke('permissions.rules.delete', {
    ...invocation, body: { ruleId: listed.rules[0]!.id },
  })).toEqual({ deleted: true });
  expect(store.rules()).toHaveLength(0);
}

describe('remembered exec scope', () => {
  test('an exact grant covers the same command but not another command in the class or a mixed batch', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: true, rememberTier: 'exact' }
      : { approved: false, reason: 'outside the exact grant' }, store);

    expect(await permissions.checkDetailed('exec', commit)).toMatchObject({ approved: true, persisted: true });
    expect((await permissions.checkDetailed('exec', commit)).approved).toBe(true);
    expect(asks).toBe(1);
    expect(await permissions.checkDetailed('exec', push)).toMatchObject({
      approved: false, sourceLayer: 'user_prompt', reasonCode: 'user_denied', userReason: 'outside the exact grant',
    });
    expect((await permissions.checkDetailed('exec', execArgs('git commit -m one', 'git push'))).approved).toBe(false);
    expect(asks).toBe(3);
  });

  test('a loaded exact rule is never widened by matching it in the current manager', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    const rule = buildDurableRuleForDecision({ toolName: 'exec', args: commit, tier: 'exact', effect: 'allow' })!;
    await store.add({ rule, createdAt: 1, tier: 'exact', tool: 'exec' });
    let asks = 0;
    const permissions = manager(async () => { asks++; return { approved: false }; }, store);
    expect(await permissions.checkDetailed('exec', commit)).toMatchObject({ approved: true, sourceLayer: 'user_rule' });
    expect((await permissions.checkDetailed('exec', push)).approved).toBe(false);
    expect(asks).toBe(1);
  });

  test('an exact denial does not become a command-class denial', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: false, rememberTier: 'exact' }
      : { approved: true }, store);
    expect((await permissions.checkDetailed('exec', commit)).approved).toBe(false);
    expect((await permissions.checkDetailed('exec', commit)).approved).toBe(false);
    expect((await permissions.checkDetailed('exec', push)).approved).toBe(true);
    expect(asks).toBe(2);
  });

  test.each(['exact', 'command-class'] as const)('deleting the %s grant takes effect in both the granting and matching managers', async (tier) => {
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const granting = manager(async () => ++asks === 1
      ? { approved: true, rememberTier: tier }
      : { approved: false }, store);
    const matching = manager(async () => { asks++; return { approved: false }; }, store);
    expect((await granting.checkDetailed('exec', commit)).approved).toBe(true);
    expect((await matching.checkDetailed('exec', commit)).approved).toBe(true);
    expect(asks).toBe(1);
    await revoke(store);
    for (const permissions of [granting, matching]) {
      expect(await permissions.checkDetailed('exec', commit)).toMatchObject({
        approved: false, sourceLayer: 'user_prompt', reasonCode: 'user_denied',
      });
    }
    expect(asks).toBe(3);
  });

  test('deleting an exact denial also removes it from the current manager', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: false, rememberTier: 'exact' }
      : { approved: true }, store);
    expect((await permissions.checkDetailed('exec', commit)).approved).toBe(false);
    expect((await permissions.checkDetailed('exec', commit)).approved).toBe(false);
    expect(asks).toBe(1);
    await revoke(store);
    expect(await permissions.checkDetailed('exec', commit)).toMatchObject({ approved: true, sourceLayer: 'user_prompt' });
    expect(asks).toBe(2);
  });

  test('a durable tier without a store never becomes a broader session grant', async () => {
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: true, rememberTier: 'exact' }
      : { approved: false }, null);
    expect(await permissions.checkDetailed('exec', commit)).toMatchObject({ approved: true, persisted: false });
    expect((await permissions.checkDetailed('exec', push)).approved).toBe(false);
    expect(asks).toBe(2);
  });

  test('an inapplicable durable tier is not reported or remembered as a session decision', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: true, rememberTier: 'path' }
      : { approved: false }, store);
    expect(await permissions.checkDetailed('exec', commit)).toMatchObject({ approved: true, persisted: false });
    expect(store.rules()).toHaveLength(0);
    expect((await permissions.checkDetailed('exec', push)).approved).toBe(false);
    expect(asks).toBe(2);
  });

  test('an explicit session decision retains its session command-class scope', async () => {
    let asks = 0;
    const permissions = manager(async () => { asks++; return { approved: true, remember: true }; }, null);
    expect((await permissions.checkDetailed('exec', commit)).approved).toBe(true);
    expect(await permissions.checkDetailed('exec', push)).toMatchObject({
      approved: true, sourceLayer: 'session_override', reasonCode: 'session_cached_allow',
    });
    expect(asks).toBe(1);
  });
});

test('legacy callback admission and registry never reach the intercepted executor outside an exact grant or after revocation', async () => {
  const store = new UserPermissionRuleStore(':memory:');
  let asks = 0;
  const permissions = manager(async () => ++asks === 1
    ? { approved: true, rememberTier: 'exact' }
    : { approved: false }, store);
  const admitted: Record<string, unknown>[] = [];
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: 'exec', description: 'Synthetic exec admission probe', parameters: EXEC_TOOL_SCHEMA },
    execute: async (args) => { admitted.push(args); return { success: true, output: 'intercepted' }; },
  });
  const deps: ToolExecutionDeps = {
    toolRegistry: registry, permissionManager: legacyPermissionConsumer(permissions), hookDispatcher: null, runtimeBus: null,
    sessionId: 'synthetic-scope',
    emitterContext: () => ({ sessionId: 'synthetic-scope', traceId: 'synthetic-trace', source: 'orchestrator' }),
  };
  const run = async (id: string, args: Record<string, unknown>) => (await executeToolCalls(deps, 'synthetic-turn', [
    { id, name: 'exec', arguments: args },
  ]))[0]!;
  expect((await run('grant', commit)).success).toBe(true);
  expect((await run('same', commit)).success).toBe(true);
  expect(await run('different', push)).toMatchObject({ success: false, denial: { reason: 'user_denied' } });
  await revoke(store);
  expect(await run('revoked', commit)).toMatchObject({ success: false, denial: { reason: 'user_denied' } });
  expect(admitted).toEqual([commit, commit]);
  expect(asks).toBe(3);
});

test('the gate boundary still runs before any remembered authorization', async () => {
  const store = new UserPermissionRuleStore(':memory:');
  let asks = 0;
  const permissions = manager(async () => { asks++; return { approved: true, rememberTier: 'command-class' }; }, store);
  expect((await permissions.checkDetailed('exec', commit)).approved).toBe(true);
  expect(await permissions.checkDetailed('exec', execArgs('git wipe-fixture'))).toMatchObject({
    approved: false, sourceLayer: 'boundary', reasonCode: 'boundary_catastrophic',
  });
  expect(asks).toBe(1);
});

describe('literal exact command authority', () => {
  const original = 'git add src/README.md';
  const mismatches = [
    ['command case', 'GIT add src/README.md'],
    ['target case', 'git add src/readme.md'],
    ['leading whitespace', ' git add src/README.md'],
    ['trailing newline', 'git add src/README.md\n'],
  ] as const;

  test.each(mismatches)('%s mismatch cannot reach the legacy callback registry executor through an exact grant', async (_label, changed) => {
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: true, rememberTier: 'exact' }
      : { approved: false }, store);
    const admitted: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'exec', description: 'Synthetic literal-scope probe', parameters: EXEC_TOOL_SCHEMA },
      execute: async (args) => { admitted.push(args); return { success: true, output: 'intercepted' }; },
    });
    const deps: ToolExecutionDeps = {
      toolRegistry: registry, permissionManager: legacyPermissionConsumer(permissions), hookDispatcher: null, runtimeBus: null,
      sessionId: 'synthetic-literal',
      emitterContext: () => ({ sessionId: 'synthetic-literal', traceId: 'synthetic-trace', source: 'orchestrator' }),
    };
    const run = async (id: string, command: string) => (await executeToolCalls(deps, 'synthetic-turn', [
      { id, name: 'exec', arguments: execArgs(command) },
    ]))[0]!;
    expect((await run('grant', original)).success).toBe(true);
    expect((await run('identical', original)).success).toBe(true);
    const mismatch = await run('changed', changed);
    expect(admitted).toEqual([execArgs(original), execArgs(original)]);
    expect(mismatch).toMatchObject({ success: false, denial: { reason: 'user_denied' } });
    expect(asks).toBe(2);
    await revoke(store);
    expect((await run('revoked', original)).success).toBe(false);
    expect(admitted).toHaveLength(2);
  });

  test('building an exact rule preserves whitespace and denies only that literal string', async () => {
    const command = ' git add src/README.md\n';
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: false, rememberTier: 'exact' }
      : { approved: true }, store);
    expect((await permissions.checkDetailed('exec', execArgs(command))).approved).toBe(false);
    expect(store.rules()[0]).toMatchObject({ exactCommands: [command] });
    expect((await permissions.checkDetailed('exec', execArgs(command))).approved).toBe(false);
    expect((await permissions.checkDetailed('exec', execArgs(command.trim()))).approved).toBe(true);
    expect((await permissions.checkDetailed('exec', execArgs(' git add src/readme.md\n'))).approved).toBe(true);
    expect(asks).toBe(3);
  });

  test.each(['allow', 'deny'] as const)('the shared matcher and layered evaluator keep %s exact rules literal', (effect) => {
    const rule = buildDurableRuleForDecision({ toolName: 'exec', args: execArgs(original), tier: 'exact', effect })!;
    if (rule.type !== 'prefix') throw new Error('expected an exact prefix rule');
    const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [rule], defaultEffect: 'deny' });
    expect(evaluatePrefixRule(rule, 'exec', execArgs(original)).matched).toBe(true);
    expect(evaluator.evaluate('exec', execArgs(original), 'write').sourceLayer).toBe('policy');
    for (const [, changed] of mismatches) {
      expect(evaluatePrefixRule(rule, 'exec', execArgs(changed)).matched).toBe(false);
      expect(evaluator.evaluate('exec', execArgs(changed), 'write').sourceLayer).not.toBe('policy');
    }
  });

  test('an exact broker sweep leaves command-case and target-case neighbors unresolved', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const commands = [original, 'GIT add src/README.md', 'git add src/readme.md'];
    const pending = await Promise.all(commands.map((command, index) => broker.raiseApproval({
      request: {
        callId: `synthetic-exact-sweep-${index}`, tool: 'exec', args: execArgs(command), category: 'execute',
        analysis: { classification: 'generic', riskLevel: 'medium', summary: 'Synthetic exact scope', reasons: [] },
      },
    })));
    try {
      await broker.resolveApproval(pending[0]!.approval.id, { approved: true, rememberTier: 'exact', actor: 'synthetic' });
      expect((await pending[0]!.decision).approved).toBe(true);
      for (const other of pending.slice(1)) {
        expect(broker.getApproval(other.approval.id)!.status).toBe('pending');
      }
    } finally {
      for (const other of pending) {
        if (broker.getApproval(other.approval.id)!.status === 'pending') await broker.cancelApproval(other.approval.id, 'synthetic-cleanup');
        await other.decision;
      }
    }
  });

  test('an explicit command-class grant keeps its broad case and whitespace behavior', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    let asks = 0;
    const permissions = manager(async () => ++asks === 1
      ? { approved: true, rememberTier: 'command-class' }
      : { approved: false }, store);
    expect((await permissions.checkDetailed('exec', execArgs(original))).approved).toBe(true);
    for (const command of ['git', ' GIT ', ' GIT ADD src/readme.md ', 'git push']) {
      expect((await permissions.checkDetailed('exec', execArgs(command))).approved).toBe(true);
    }
    expect(asks).toBe(1);
    expect((await permissions.checkDetailed('exec', execArgs('gitfoo push'))).approved).toBe(false);
    expect(asks).toBe(2);
  });

  test.each([undefined, 'literal', 'unknown', null, true, { mode: 'command-class' }])('absent or invalid exact match metadata stays literal: %j', (option) => {
    const rule = {
      type: 'prefix', id: 'synthetic-exact', origin: 'user', effect: 'allow', toolPattern: 'exec',
      exactCommands: ['git'], ...(option === undefined ? {} : { exactCommandMatch: option }),
    } as unknown as PrefixRule;
    expect(evaluatePrefixRule(rule, 'exec', execArgs('git')).matched).toBe(true);
    expect(evaluatePrefixRule(rule, 'exec', execArgs('GIT')).matched).toBe(false);
    expect(evaluatePrefixRule(rule, 'exec', execArgs(' git ')).matched).toBe(false);
  });

  test('even the explicit class option cannot normalize an exact payload with arguments', () => {
    const rule: PrefixRule = {
      type: 'prefix', id: 'synthetic-class', origin: 'user', effect: 'allow', toolPattern: 'exec',
      exactCommands: [original], exactCommandMatch: 'command-class',
    };
    expect(evaluatePrefixRule(rule, 'exec', execArgs(original)).matched).toBe(true);
    for (const [, changed] of mismatches) expect(evaluatePrefixRule(rule, 'exec', execArgs(changed)).matched).toBe(false);
  });

  test.each(['new', 'legacy'] as const)('%s class rules preserve explicit breadth after serialization and reopening', async (format) => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-literal-class-'));
    try {
      const path = join(dir, 'rules.json');
      const store = new UserPermissionRuleStore(path);
      const built = buildDurableRuleForDecision({ toolName: 'exec', args: execArgs(original), tier: 'command-class', effect: 'allow' })!;
      if (built.type !== 'prefix') throw new Error('expected a prefix rule');
      const { exactCommandMatch: _option, ...legacy } = built;
      await store.add({ rule: format === 'legacy' ? legacy : built, createdAt: 1, tier: 'command-class', tool: 'exec' });
      const disk = JSON.parse(readFileSync(path, 'utf8')) as { rules: { rule: PrefixRule }[] };
      expect(disk.rules[0]!.rule.exactCommandMatch).toBe(format === 'new' ? 'command-class' : undefined);
      const reopened = new UserPermissionRuleStore(path);
      await reopened.init();
      let asks = 0;
      const permissions = manager(async () => { asks++; return { approved: false }; }, reopened);
      for (const command of ['git', ' GIT ', 'GIT ADD src/readme.md', 'git push']) {
        expect(await permissions.checkDetailed('exec', execArgs(command))).toMatchObject({ approved: true, sourceLayer: 'user_rule' });
      }
      expect(asks).toBe(0);
      expect((await permissions.checkDetailed('exec', execArgs('gitfoo push'))).approved).toBe(false);
      await revoke(reopened);
      expect((await permissions.checkDetailed('exec', execArgs(' GIT '))).approved).toBe(false);
      expect(asks).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('literal exact commands preserve their bytes after serialization and reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-literal-exact-'));
    try {
      const path = join(dir, 'rules.json');
      const command = ' git add src/README.md\n';
      const store = new UserPermissionRuleStore(path);
      const rule = buildDurableRuleForDecision({ toolName: 'exec', args: execArgs(command), tier: 'exact', effect: 'allow' })!;
      await store.add({ rule, createdAt: 1, tier: 'exact', tool: 'exec' });
      const reopened = new UserPermissionRuleStore(path);
      await reopened.init();
      expect(reopened.rules()[0]).toMatchObject({ exactCommands: [command] });
      let asks = 0;
      const permissions = manager(async () => { asks++; return { approved: false }; }, reopened);
      expect((await permissions.checkDetailed('exec', execArgs(command))).approved).toBe(true);
      for (const changed of [command.trim(), command.toLowerCase(), command.toUpperCase()]) {
        expect((await permissions.checkDetailed('exec', execArgs(changed))).approved).toBe(false);
      }
      expect(asks).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('legacy adaptation requires explicit class provenance and the original class-rule shape', async () => {
    const cases = [
      { tier: 'exact', exactCommands: ['git'], commandPrefixes: ['git '] },
      { tier: undefined, exactCommands: ['git'], commandPrefixes: ['git '] },
      { tier: 'command-class', exactCommands: ['git'], commandPrefixes: undefined },
      { tier: 'command-class', exactCommands: ['git add src/README.md'], commandPrefixes: ['git add src/README.md '] },
      { tier: 'command-class', exactCommands: ['git'], commandPrefixes: ['git '], exactCommandMatch: 'unknown' },
    ];
    for (const input of cases) {
      const { tier, ...constraints } = input;
      const store = new UserPermissionRuleStore(':memory:');
      await store.add({
        rule: { type: 'prefix', id: 'legacy-invalid', origin: 'user', effect: 'allow', toolPattern: 'exec', ...constraints },
        createdAt: 1, tier, tool: 'exec',
      } as unknown as Parameters<UserPermissionRuleStore['add']>[0]);
      const rule = store.rules()[0]!;
      if (rule.type !== 'prefix') throw new Error('expected a prefix rule');
      expect(rule.exactCommandMatch).not.toBe('command-class');
      expect(evaluatePrefixRule(rule, 'exec', execArgs(' GIT ')).matched).toBe(false);
    }
  });

  test.each([
    ['duplicate classes with an unrelated prefix', ['git', 'git'], ['git ', 'npm ']],
    ['duplicate classes and prefixes', ['git', 'git'], ['git ', 'git ']],
    ['unique classes with duplicate prefixes', ['git', 'npm'], ['git ', 'git ']],
    ['unique noncorresponding prefixes', ['git', 'npm'], ['git ', 'bun ']],
  ] as const)('reopened legacy %s do not gain normalized bare-command authority', async (_label, classes, prefixes) => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-legacy-duplicate-'));
    try {
      const path = join(dir, 'rules.json');
      const store = new UserPermissionRuleStore(path);
      await store.add({
        rule: {
          type: 'prefix', id: 'malformed-legacy-class', origin: 'user', effect: 'allow', toolPattern: 'exec',
          exactCommands: [...classes], commandPrefixes: [...prefixes],
        },
        createdAt: 1, tier: 'command-class', tool: 'exec',
      });
      const reopened = new UserPermissionRuleStore(path);
      await reopened.init();
      const rule = reopened.rules()[0]!;
      if (rule.type !== 'prefix') throw new Error('expected a prefix rule');
      expect(rule.exactCommandMatch).toBeUndefined();
      expect(evaluatePrefixRule(rule, 'exec', execArgs('git')).matched).toBe(true);
      expect(evaluatePrefixRule(rule, 'exec', execArgs(' GIT ')).matched).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
