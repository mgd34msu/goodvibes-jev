import { afterEach, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { readPlanningGoal } from '@goodvibes-jev/engine/sdk/platform/agents';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';
import { ScheduleReadingLifetime } from '../../input/commands/schedule-reading-lifetime.ts';
import { nativeConversationIntakeFixture } from '../helpers/native-conversation-intake.ts';
import { recordedPlanningGoalPort } from '../helpers/planning-goal-reading.ts';
import { createReadingDrain } from '../helpers/owned-reading-deferred.ts';

const previous = installJudgmentPort(undefined), drain = createReadingDrain();
afterEach(async () => { try { await drain.drain(); } finally { installJudgmentPort(previous); } });
const original = '  Cancel the legacy billing flow\r\nand replace it with invoices.  ';
function fixture() {
  const native = nativeConversationIntakeFixture(), registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
  const output: string[] = [], dispatched: unknown[] = [], runtime = { sessionId: 'planning-session' };
  const lifetime = new ScheduleReadingLifetime(() => runtime.sessionId, () => true);
  const ctx = { session: { runtime }, provider: {}, platform: {},
    workspace: { projectPlanningService: new Proxy({}, { get() { throw new Error('Historical planning is not native intake.'); } }) },
    nativeConversationIntake: native.controls, planningReading: lifetime,
    dispatchNativeIntakeTurn: async (state: unknown) => { dispatched.push(state); },
    print: (line: string) => output.push(line), renderRequest() {},
  } as unknown as CommandContext;
  drain.stopWith(() => { lifetime.dispose(); native.controls.close(); });
  let executedContext = ctx;
  const command = registry.get('project-plan');
  if (!command) throw new Error('Planning command must be registered.');
  const handler = command.handler;
  command.handler = (args, owner) => { executedContext = owner; return handler(args, owner); };
  const submit = (text = original) => registry.executeFromOwner('project-plan', [text], ctx, `/project-plan ${text}`);
  return { ...native, registry, ctx, lifetime, runtime, output, dispatched, submit, currentContext: () => executedContext };
}

for (const text of [original, 'Documentation']) test(`recorded goal sends exact owner input to native intake: ${text === original ? 'complete text' : 'short goal'}`, async () => {
  const f = fixture(), port = recordedPlanningGoalPort(new Map([[text, .99]])); installJudgmentPort(port.port);
  await f.submit(text);
  expect(port.requests).toHaveLength(1); expect(port.requests[0]?.state).toMatchObject({ text, unsupportedSources: [] });
  expect(f.captures.map(input => input.text)).toEqual([text]); expect(f.calls).toContain('claim'); expect(f.calls).toContain('bind');
  expect(f.dispatched).toHaveLength(1);
});
for (const text of ['pause', 'stop', 'cancel', 'stop now please']) test(`recorded no holds command text before native intake: ${text}`, async () => {
  const f = fixture(), port = recordedPlanningGoalPort(new Map([[text, .01]])); installJudgmentPort(port.port);
  await f.submit(text);
  expect(port.requests).toHaveLength(1); expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
  expect(f.output.join('\n')).toContain('does not state a planning goal');
});
for (const probability of [.65, .5]) test(`unsettled goal ${probability} is held without human fallback`, async () => {
  const f = fixture(), port = recordedPlanningGoalPort(new Map([[original, probability]])); installJudgmentPort(port.port);
  await f.submit(); expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
  expect(f.output.join('\n')).toContain('unsettled'); expect(f.output.join('\n')).not.toContain('approve');
});

for (const action of ['escape', 'session-away-back', 'shutdown', 'port', 'native-account', 'native-config', 'intake-method', 'dispatch-method', 'arguments'] as const) {
  test(`${action} retires a late goal response before the original native intake`, async () => {
    const f = fixture(), base = recordedPlanningGoalPort(new Map([[original, .99]])), held = drain.hold(base.port);
    let account = 'original', configuration = 0;
    bindJudgmentPortAuthority(held.port, () => ({ identity: {}, assertCurrent() { if (account !== 'original' || configuration !== 0) throw new Error('Native reading owner retired.'); } }));
    installJudgmentPort(held.port);
    const args = [original], pending = drain.own(f.registry.executeFromOwner('project-plan', args, f.ctx, `/project-plan ${original}`));
    await held.started;
    if (action === 'escape') f.lifetime.withCancellation(() => false)();
    if (action === 'session-away-back') { f.lifetime.cancel(); f.runtime.sessionId = 'other'; f.runtime.sessionId = 'planning-session'; }
    if (action === 'shutdown') f.lifetime.dispose();
    if (action === 'port') installJudgmentPort(base.port);
    if (action === 'native-account') account = 'retired';
    if (action === 'native-config') configuration++;
    if (action === 'intake-method') f.controls.submit = async () => { throw new Error('Replacement intake must never run.'); };
    if (action === 'dispatch-method') f.currentContext().dispatchNativeIntakeTurn = async () => { throw new Error('Replacement dispatch must never run.'); };
    if (action === 'arguments') args[0] = 'Replacement goal';
    held.release(); await pending;
    expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
  });
}

test('a current second submission retires only the earlier pending goal reading', async () => {
  const f = fixture(), base = recordedPlanningGoalPort(new Map([[original, .99], ['Add invoices', .99]]));
  const held = drain.hold(base.port); installJudgmentPort(held.port);
  const pending = drain.own(f.submit()); await held.started;
  installJudgmentPort(base.port); await f.submit('Add invoices');
  held.release(); await pending;
  expect(f.captures.map(input => input.text)).toEqual(['Add invoices']); expect(f.dispatched).toHaveLength(1);
});

test('goal choice is not owner provenance for a generic or model-invoked command', async () => {
  const f = fixture(), port = recordedPlanningGoalPort(new Map([[original, .99]])); installJudgmentPort(port.port);
  await f.registry.execute('project-plan', [original], f.ctx);
  await f.registry.executeFromOwner('project-plan', [original], { ...f.ctx, invokedByModel: true }, `/project-plan ${original}`);
  expect(port.requests).toEqual([]); expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
});

for (const text of ['Change Authorization: Bearer synthetic-private-value', '{"clientSecret":"synthetic-private-value"}', '{"cardMaterial":{"pan":"4111111111111111"}}']) {
  test('complete source privacy material never reaches a goal reader or native intake', async () => {
    const f = fixture(), port = recordedPlanningGoalPort(new Map([[text, .99]])); installJudgmentPort(port.port);
    await f.submit(text); expect(port.requests).toEqual([]); expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
    expect(f.output.join('\n')).not.toContain('synthetic-private-value'); expect(f.output.join('\n')).not.toContain('4111111111111111');
  });
}

test('the complete original goal object, including ignored credential fields, is refused', async () => {
  const port = recordedPlanningGoalPort(new Map([[original, .99]])); installJudgmentPort(port.port);
  const source = { text: original, ignored: { clientSecret: 'synthetic-private-value' } };
  await expect(readPlanningGoal(source)).rejects.toThrow();
  expect(port.requests).toEqual([]);
});

test('source slot replacement during a goal reading cannot become a settled observation', async () => {
  const source = { text: original }, base = recordedPlanningGoalPort(new Map([[original, .99]]));
  const held = drain.hold(base.port); installJudgmentPort(held.port);
  const pending = drain.own(readPlanningGoal(source)); await held.started;
  source.text = 'Replacement goal'; held.release(); await expect(pending).rejects.toThrow();
});

test('the complete raw result is admitted before native intake, including hidden accessors', async () => {
  const f = fixture(), port = recordedPlanningGoalPort(new Map([[original, .99]])); let touched = 0;
  installJudgmentPort({ model: port.port.model, async ask(request) {
    const result = await port.port.ask(request);
    Object.defineProperty(result, 'ignored', { get() { touched++; return 'private'; } });
    return result;
  } });
  await f.submit(); expect(touched).toBe(0); expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
});

test('missing judgment port holds a goal without restoring retired historical seeding', async () => {
  const f = fixture(); installJudgmentPort(undefined); await f.submit();
  expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
  expect(f.output.join('\n')).toContain('unavailable');
});

test('a non-synchronous source guard cannot start a planning request', async () => {
  const port = recordedPlanningGoalPort(new Map([[original, .99]])); installJudgmentPort(port.port);
  await expect(readPlanningGoal({ text: original }, { assertCurrent: () => Promise.resolve() })).rejects.toThrow();
  expect(port.requests).toEqual([]);
});
