import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { captureJevDecisionContext, JEV_DECISION_BINDING_KEYS } from '@goodvibes-jev/judgment/decisions';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { captureAutonomousCatalogContext, inspectDecisionProtocolReferences } from '../sdk/src/platform/gate/autonomous-decision.ts';
import { autonomousSourceEvidence, captureAutonomousChoices, captureAutonomousSource, captureAutonomousSourceFrame } from '../sdk/src/platform/permissions/autonomous.ts';
import { createPermissionConfigReader, PermissionManager } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { assertCurrentToolEffect, ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { NATIVE_CONVERSATION_CONTINUATION_MAX_MESSAGES } from '../sdk/src/platform/workflow/work-ledger/native-continuation-context.ts';
import type { NativeSelectedDiffContext } from '../sdk/src/platform/workflow/work-ledger/native-diff-context.ts';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';

const NAME = 'component_capture_effect';
const GOAL = 'Perform the exact component capture operation';
const diff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n';
const protocolIdentity = '4111111111111111' + 'a'.repeat(48);
const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let transmissions = 0;

beforeEach(() => {
  forgetGateReadings(); transmissions = 0;
  log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort([[NAME, READ_ONLY]]);
  const act = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const port: JudgmentPort = { model: gate.port.model, ask(request) {
    transmissions++;
    return ('disposition' in request.questions ? act.port : gate.port).ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => {
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function selectedDiff(): NativeSelectedDiffContext {
  return { kind: 'session', revision: protocolIdentity, fileIndex: 2, hunkIndex: 3, unifiedDiff: diff,
    provenance: { kind: 'session', sessionId: 'component-session', baselineCheckpointId: 'before', latestCheckpointId: 'after' } };
}
function source() {
  return { goal: GOAL, criteria: ['Retain the exact first criterion', 'Retain the exact second criterion'],
    conversationContext: [{ role: 'user' as const, content: 'Original quoted discussion.' }], selectedDiffContext: selectedDiff() };
}

test('one complete capture retains full source identity and the exact semantic projection', () => {
  const original = source();
  const frame = captureAutonomousSourceFrame(original);
  expect(frame.source).toEqual(original);
  expect(frame.evidence).toEqual({ goal: GOAL, criteria: original.criteria, conversationContext: original.conversationContext,
    selectedDiffContext: { kind: 'session', unifiedDiff: diff } });
  expect(frame.source).toEqual(captureAutonomousSource(original));
  expect(frame.evidence).toEqual(autonomousSourceEvidence(original));
  expect(JSON.stringify(frame.source)).toBe(JSON.stringify(original));
  expect(Object.isFrozen(frame)).toBe(true);
  expect(Object.isFrozen(frame.source.selectedDiffContext?.provenance)).toBe(true);
  expect(Object.isFrozen(frame.evidence.criteria)).toBe(true);
  expect(Object.getPrototypeOf(frame.source)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(frame.evidence)).toBe(Object.prototype);
  original.criteria.reverse(); original.conversationContext[0]!.content = 'Changed later discussion.';
  if (original.selectedDiffContext.kind === 'session') original.selectedDiffContext.provenance.latestCheckpointId = 'later';
  expect(frame.source.criteria).toEqual(['Retain the exact first criterion', 'Retain the exact second criterion']);
  expect(frame.evidence.conversationContext?.[0]?.content).toBe('Original quoted discussion.');
  const fresh = captureAutonomousSourceFrame(original);
  expect(fresh.source).toEqual(original);
  expect(fresh.source).not.toEqual(frame.source);
  expect(fresh.evidence.conversationContext?.[0]?.content).toBe('Changed later discussion.');
});

test('paired source capture removes the second complete descriptor traversal without retaining a later observation', () => {
  const original = source();
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptors');
  if (!descriptor) throw new Error('Native descriptor inspection is unavailable');
  const inspect = Object.getOwnPropertyDescriptors;
  let maps = 0;
  Object.defineProperty(Object, 'getOwnPropertyDescriptors', { ...descriptor, value(value: object) {
    const result = inspect(value);
    if (result.goal?.value === GOAL && result.criteria) maps++;
    return result;
  } });
  let paired = 0, separate = 0;
  try {
    captureAutonomousSourceFrame(original); paired = maps; maps = 0;
    autonomousSourceEvidence(captureAutonomousSource(original)); separate = maps;
  } finally { Object.defineProperty(Object, 'getOwnPropertyDescriptors', descriptor); }
  expect(paired).toBeGreaterThan(0); expect(separate).toBeGreaterThan(paired);
  original.goal = 'The original host changed its goal';
  expect(captureAutonomousSourceFrame(original).source.goal).toBe(original.goal);
});

test.each(['goal', 'criteria', 'conversation', 'diff', 'provenance'] as const)('both standalone helpers and paired capture screen complete %s content', part => {
  const original = source();
  if (part === 'goal') original.goal = 'password=synthetic-original-private';
  else if (part === 'criteria') original.criteria.push('Use card 4111111111111111');
  else if (part === 'conversation') original.conversationContext[0]!.content = 'password=synthetic-private-discussion';
  else if (part === 'diff') original.selectedDiffContext = { ...selectedDiff(), unifiedDiff: diff.replace('+new', '+password=synthetic-private-diff') };
  else if (original.selectedDiffContext.kind === 'session') original.selectedDiffContext.provenance.latestCheckpointId = 'password=synthetic-private-provenance';
  expect(() => captureAutonomousSourceFrame(original)).toThrow();
  expect(() => captureAutonomousSource(original)).toThrow();
  expect(() => autonomousSourceEvidence(original)).toThrow();
  expect(transmissions).toBe(0);
});

test('complete source validation refuses hidden accessors and nested proxies without invoking them', () => {
  let accessed = 0;
  const accessor = source();
  Object.defineProperty(accessor.criteria, 'hidden', { get() { accessed++; return 'ordinary'; } });
  const proxied = source();
  proxied.conversationContext = new Proxy(proxied.conversationContext, { ownKeys() { accessed++; return []; } });
  expect(() => captureAutonomousSourceFrame(accessor)).toThrow();
  expect(() => captureAutonomousSourceFrame(proxied)).toThrow();
  expect(accessed).toBe(0);
  const oversized = source();
  oversized.conversationContext = Array.from({ length: NATIVE_CONVERSATION_CONTINUATION_MAX_MESSAGES + 1 }, () => ({ role: 'user' as const, content: 'Ordinary discussion.' }));
  expect(() => captureAutonomousSourceFrame(oversized)).toThrow();
});

test('catalog factory preserves the original canonical context and fresh detached references', () => {
  const continuations = [{ id: 'registered-alternative', revision: protocolIdentity, kind: 'revise-action' as const }];
  const conditions = [{ id: 'registered-condition', revision: 'condition-current' }];
  const expected = captureJevDecisionContext({ decisionId: 'catalog',
    binding: Object.fromEntries(JEV_DECISION_BINDING_KEYS.map(key => [key, 'catalog'])), judgmentDecisionIds: [], evidence: [], continuations, resumeConditions: conditions });
  inspectDecisionProtocolReferences(expected);
  const captured = captureAutonomousCatalogContext(continuations, conditions);
  expect(captured).toEqual(expected);
  expect(JSON.stringify(captured)).toBe(JSON.stringify(expected));
  continuations[0]!.revision = 'alternative-next'; conditions[0]!.revision = 'condition-next';
  expect(captured.continuations[0]?.revision).toBe(protocolIdentity);
  expect(captureAutonomousCatalogContext(continuations, conditions).continuations[0]?.revision).toBe('alternative-next');
  expect(captureAutonomousCatalogContext([], [])).not.toBe(captureAutonomousCatalogContext([], []));
});

test.each(['continuation', 'condition', 'arguments', 'name'] as const)('an unselected catalog %s remains fully screened', part => {
  const alternatives = [
    { ref: { id: 'first-alternative', revision: 'first-current', kind: 'revise-action' as const }, toolName: NAME, args: { operation: 'first' } },
    { ref: { id: 'unselected-alternative', revision: 'second-current', kind: 'revise-action' as const }, toolName: NAME, args: { operation: 'second' } },
  ];
  const conditions = [{ id: 'condition', revision: 'current' }];
  if (part === 'continuation') alternatives[1]!.ref.revision = 'password=synthetic-private-ref';
  else if (part === 'condition') conditions[0]!.id = '4111111111111111';
  else if (part === 'arguments') Object.defineProperty(alternatives[1]!.args, 'password', { enumerable: true, value: 'synthetic-private-argument' });
  else alternatives[1]!.toolName = 'password=synthetic-private-tool';
  expect(() => captureAutonomousChoices({ revisions: alternatives, resumeConditions: conditions })).toThrow();
  expect(transmissions).toBe(0);
});

test('generic protocol inspection still screens every non-catalog field', () => {
  const context = captureAutonomousCatalogContext([], []);
  for (const changed of [
    { ...context, decisionId: 'password=synthetic-private-decision' },
    { ...context, binding: { ...context.binding, scopeId: '4111111111111111' } },
    { ...context, judgmentDecisionIds: ['password=synthetic-private-support'] },
    { ...context, evidence: [{ id: 'ordinary', revision: 'password=synthetic-private-evidence' }] },
  ]) expect(() => inspectDecisionProtocolReferences(changed)).toThrow();
});

test('catalog capture retains canonical duplicate and array bounds and refuses executable borrowed choices', () => {
  const ref = { id: 'registered-alternative', revision: 'current', kind: 'revise-action' as const };
  expect(() => captureAutonomousCatalogContext([ref, ref], [])).toThrow();
  expect(() => captureAutonomousCatalogContext(Array.from({ length: 257 }, (_, index) => ({ ...ref, id: `alternative-${index}` })), [])).toThrow();
  let accessed = 0;
  const accessor = { revisions: [{ ref, toolName: NAME, args: { operation: 'ordinary' } }] };
  Object.defineProperty(accessor.revisions[0]!.args, 'hidden', { get() { accessed++; return 'ordinary'; } });
  const proxied = { resumeConditions: [new Proxy({ id: 'condition', revision: 'current' }, { ownKeys() { accessed++; return []; } })] };
  expect(() => captureAutonomousChoices(accessor)).toThrow();
  expect(() => captureAutonomousChoices(proxied)).toThrow();
  expect(accessed).toBe(0); expect(transmissions).toBe(0);
});

function nativeFixture(events: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'authority-components-')); roots.push(root);
  const config = new ConfigManager({ configDir: root }); config.flushConfigFileChanges();
  const original = source();
  const revisions = [{ ref: { id: 'unselected-alternative', revision: 'alternative-current', kind: 'revise-action' as const }, toolName: NAME, args: { operation: 'alternative' } }];
  const conditions = [{ id: 'condition', revision: 'condition-current' }];
  const reader = createPermissionConfigReader(config);
  const snapshot = reader.getAutonomousSnapshot;
  if (!snapshot) throw new Error('Native permission owner is unavailable');
  let onSnapshot: (() => void) | undefined;
  reader.getAutonomousSnapshot = () => { events.push('config'); const current = snapshot(); onSnapshot?.(); return current; };
  const sourceOf = () => { events.push('source'); return original; };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState(), null, null, null, {
    autonomousChoices: () => { events.push('choices'); return { revisions, resumeConditions: conditions }; },
    surfaceOf: () => { events.push('surface'); return undefined; },
  });
  const registry = new ToolRegistry(manager);
  let effects = 0;
  registry.register({ definition: { name: NAME, description: 'Perform one synthetic native-authority effect.', parameters: {
    type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'], additionalProperties: false,
  } }, async execute(args, options) {
    expect(assertCurrentToolEffect(args, options)).toBe(true); effects++;
    return { success: true, output: 'Synthetic effect completed' };
  } });
  return { config, original, revisions, conditions, sourceOf, manager, registry,
    onSnapshot(callback: () => void) { onSnapshot = callback; }, get effects() { return effects; } };
}

test('each real native preparation observation samples host callbacks in the original order', () => {
  const events: string[] = [];
  const f = nativeFixture(events);
  const preparation = f.manager.autonomousPreparation('component-preparation', f.sourceOf);
  expect(events).toEqual(['choices', 'surface', 'source', 'config']);
  events.length = 0;
  preparation.assertCurrent();
  expect(events).toEqual(['choices', 'surface', 'source', 'config']);
  f.original.criteria.reverse(); events.length = 0;
  expect(() => preparation.assertCurrent()).toThrow();
  expect(events).toEqual(['choices', 'surface', 'source', 'config']);
  expect(transmissions).toBe(0);
});

test.each(['source', 'unselected'] as const)('the final native snapshot callback cannot hide %s retirement', change => {
  const f = nativeFixture();
  const controller = new AbortController();
  const preparation = f.manager.autonomousPreparation('component-reentrant-preparation', f.sourceOf, controller.signal);
  f.onSnapshot(() => {
    if (change === 'source') f.original.conversationContext[0]!.content = 'A new callback-owned transcript';
    else f.revisions[0]!.args.operation = 'changed-by-final-owner';
  });
  expect(() => preparation.assertCurrent()).toThrow();
  expect(transmissions).toBe(0); expect(f.effects).toBe(0);
});

test.each(['source', 'config'] as const)('preparation refuses cancellation inside its %s observation before wire or recording', async point => {
  const f = nativeFixture();
  const controller = new AbortController();
  let armed = false;
  const preparation = f.manager.autonomousPreparation('component-callback-preparation', () => {
    const current = f.sourceOf();
    if (armed && point === 'source') controller.abort();
    return current;
  }, controller.signal);
  armed = true;
  if (point === 'config') f.onSnapshot(() => controller.abort());
  expect(() => preparation.assertCurrent()).toThrow();
  await expect(Promise.resolve().then(() => preparation.port.ask({ state: 'Owned synthetic preparation input',
    questions: { disposition: { type: 'choice', criteria: { act: 'Perform the exact synthetic operation', reject: 'Refuse the synthetic operation' } } },
  }))).rejects.toThrow();
  expect(transmissions).toBe(0); expect(log.query()).toHaveLength(0); expect(f.effects).toBe(0);
});

test('the final native snapshot callback cancellation retires admitted execution before its effect', async () => {
  const f = nativeFixture();
  const controller = new AbortController();
  const call = await f.registry.prepareCall('component-callback-call', NAME, { operation: 'execute' }, { signal: controller.signal });
  const admission = await f.manager.admitAutonomous('component-callback-source', NAME, call.args, {
    sourceOf: f.sourceOf, signal: controller.signal, schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call },
  });
  const originalTransmissions = transmissions;
  f.onSnapshot(() => controller.abort());
  await expect(f.registry.executePrepared(call, admission)).rejects.toThrow();
  expect(f.effects).toBe(0); expect(transmissions).toBe(originalTransmissions);
});

test.each(['none', 'source', 'conversation', 'diff-provenance', 'unselected', 'condition', 'accessor', 'config-aba', 'cancel'] as const)(
  'real native admission preserves effect/currentness behavior for %s', async change => {
    const f = nativeFixture();
    const controller = new AbortController();
    const call = await f.registry.prepareCall('component-call', NAME, { operation: 'execute' }, { signal: controller.signal });
    const admission = await f.manager.admitAutonomous('component-source', NAME, call.args, {
      sourceOf: f.sourceOf, signal: controller.signal, schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call },
    });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    const originalTransmissions = transmissions;
    let accessed = 0;
    if (change === 'source') f.original.criteria.reverse();
    else if (change === 'conversation') f.original.conversationContext[0]!.content = 'Changed current transcript';
    else if (change === 'diff-provenance' && f.original.selectedDiffContext.kind === 'session') f.original.selectedDiffContext.provenance.latestCheckpointId = 'changed-checkpoint';
    else if (change === 'unselected') f.revisions[0]!.args.operation = 'changed-unselected-action';
    else if (change === 'condition') f.conditions[0]!.revision = 'condition-next';
    else if (change === 'accessor') Object.defineProperty(f.revisions[0]!.args, 'hidden', { get() { accessed++; return 'ordinary'; } });
    else if (change === 'config-aba') { const original = f.config.get('permissions.mode'); f.config.set('permissions.mode', 'allow-all'); f.config.set('permissions.mode', original); }
    else if (change === 'cancel') controller.abort();
    if (change === 'none') {
      expect(await f.registry.executePrepared(call, admission)).toMatchObject({ success: true });
      expect(f.effects).toBe(1);
    } else {
      await expect(f.registry.executePrepared(call, admission)).rejects.toThrow();
      expect(f.effects).toBe(0);
    }
    expect(transmissions).toBe(originalTransmissions); expect(accessed).toBe(0);
  },
);


test.each(['source', 'unselected'] as const)('native preparation initially refuses private %s before any reading', part => {
  const f = nativeFixture();
  if (part === 'source') f.original.goal = 'password=synthetic-initial-source';
  else f.revisions[0]!.args.operation = 'password=synthetic-initial-alternative';
  expect(() => f.manager.autonomousPreparation('initial-private-component', f.sourceOf)).toThrow();
  expect(transmissions).toBe(0); expect(log.query()).toHaveLength(0); expect(f.effects).toBe(0);
});

test.each(['source', 'unselected', 'condition', 'provenance'] as const)(
  'preparation compares the original baseline after a private %s change and restoration', part => {
    const f = nativeFixture();
    const preparation = f.manager.autonomousPreparation('current-private-component', f.sourceOf);
    const originalGoal = f.original.goal;
    const originalOperation = f.revisions[0]!.args.operation;
    const originalCondition = f.conditions[0]!.revision;
    const originalDiff = f.original.selectedDiffContext;
    if (part === 'source') f.original.goal = 'password=synthetic-changed-source';
    else if (part === 'unselected') f.revisions[0]!.args.operation = 'password=synthetic-changed-alternative';
    else if (part === 'condition') f.conditions[0]!.revision = 'password=synthetic-changed-condition';
    else if (originalDiff.kind === 'session') f.original.selectedDiffContext = {
      ...originalDiff, provenance: { ...originalDiff.provenance, latestCheckpointId: 'password=synthetic-changed-provenance' },
    };
    expect(() => preparation.assertCurrent()).toThrow('Autonomous preparation authority changed');
    f.original.goal = originalGoal;
    f.revisions[0]!.args.operation = originalOperation;
    f.conditions[0]!.revision = originalCondition;
    f.original.selectedDiffContext = originalDiff;
    // The existing native policy permits exact restoration; a failed comparison
    // never makes the changed data a new baseline or a new reading.
    preparation.assertCurrent();
    expect(transmissions).toBe(0); expect(log.query()).toHaveLength(0); expect(f.effects).toBe(0);
  },
);

test.each(['accessor', 'proxy', 'oversized'] as const)('preparation currentness retains complete %s rejection before callbacks or wire', part => {
  const f = nativeFixture();
  const preparation = f.manager.autonomousPreparation('unsupported-current-component', f.sourceOf);
  let accessed = 0;
  if (part === 'accessor') Object.defineProperty(f.revisions[0]!.args, 'hidden', { get() { accessed++; return 'ordinary'; } });
  else if (part === 'proxy') f.original.criteria = new Proxy(f.original.criteria, { ownKeys() { accessed++; return []; } });
  else f.original.criteria.push('x'.repeat(1_000_001));
  expect(() => preparation.assertCurrent()).toThrow();
  expect(accessed).toBe(0); expect(transmissions).toBe(0); expect(log.query()).toHaveLength(0); expect(f.effects).toBe(0);
});

test.each(['unselected', 'condition'] as const)('authentic execution refuses a late private %s without a new reading', async part => {
  const f = nativeFixture();
  const call = await f.registry.prepareCall('private-component-call', NAME, { operation: 'execute' });
  const admission = await f.manager.admitAutonomous('private-component-source', NAME, call.args, {
    sourceOf: f.sourceOf, schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call },
  });
  expect(admission.result.autonomousDecision?.outcome).toBe('act');
  const originalTransmissions = transmissions;
  if (part === 'unselected') f.revisions[0]!.args.operation = 'password=synthetic-late-alternative';
  else f.conditions[0]!.revision = 'password=synthetic-late-condition';
  await expect(f.registry.executePrepared(call, admission)).rejects.toThrow();
  expect(f.effects).toBe(0); expect(transmissions).toBe(originalTransmissions);
});
