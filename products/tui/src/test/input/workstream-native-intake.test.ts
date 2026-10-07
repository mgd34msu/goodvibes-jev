import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorkstreamRuntimeCommands } from '../../input/commands/workstream-runtime.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';
import { handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';
import { nativeConversationIntakeFixture } from '../helpers/native-conversation-intake.ts';
import type { NativeConversationIntakeState } from '../../runtime/native-conversation-intake.ts';

const enter = { type: 'key' as const, name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false };
const original = '  Repair  the\r\n界 e\u0301 😀\t  ';
function fixture() {
  const native = nativeConversationIntakeFixture();
  const registry = new CommandRegistry(); registerWorkstreamRuntimeCommands(registry);
  const output: string[] = []; const dispatched: NativeConversationIntakeState[] = []; let renders = 0;
  const context = { nativeConversationIntake: native.controls,
    dispatchNativeIntakeTurn: async (state: NativeConversationIntakeState) => { dispatched.push(state); },
    print: (line: string) => output.push(line), renderRequest: () => { renders++; },
    session: { contractOperator: { start: () => { throw new Error('Legacy start is forbidden'); } } },
  } as unknown as CommandContext;
  context.executeCommand = (name, args) => registry.execute(name, args, context);
  const submit = (raw: string, fallback = false) => {
    const state = { prompt: raw, cursorPos: raw.length, inputScrollTop: 0, commandMode: !fallback,
      indicatorFocused: false, commandRegistry: registry, commandContext: context, modalStack: ['command'],
      autocomplete: null, conversationManager: null, requestRender: () => { renders++; },
    };
    if (fallback) handlePromptKeyToken(state as unknown as KeyRouteState, enter);
    else handleCommandModeToken(state as unknown as CommandModeRouteState, enter);
  };
  return { ...native, registry, context, output, dispatched, submit, renders: () => renders };
}
async function settled(f: ReturnType<typeof fixture>) {
  for (let count = 0; count < 100 && !f.renders(); count++) await Bun.sleep(1);
  expect(f.renders()).toBeGreaterThan(0);
}
for (const fallback of [false, true]) {
  test(`terminal ${fallback ? 'fallback' : 'command mode'} preserves exact request into native admission`, async () => {
    const f = fixture(); f.submit(` \t/workstream\tstart ${original}`, fallback); await settled(f);
    expect(f.captures).toHaveLength(1); expect(f.captures[0]?.text).toBe(original);
    expect(f.dispatched).toHaveLength(1); expect(f.dispatched[0]?.result).toMatchObject({ kind: 'turn', text: original });
    expect(f.calls).toContain('claim'); expect(f.calls).toContain('bind');
  });
  test(`terminal ${fallback} sends work through native execution, never ordinary/legacy dispatch`, async () => {
    const f = fixture(); f.setOutcome('work'); f.submit(`/workstream start ${original}`, fallback); await settled(f);
    expect(f.dispatched).toEqual([]); expect(f.calls).toContain('execution-intent'); expect(f.calls).toContain('execution-start');
    expect(f.captures[0]?.text).toBe(original);
  });
  test(`terminal ${fallback} reports unsupported folded paste and source references without expansion`, async () => {
    const f = fixture(); f.setOutcome('blocked'); const raw = 'Use !@a.ts @folder [TEXT: p1, 9 lines] [IMAGE: img1, clip, 2KB]';
    f.submit(`/workstream start ${raw}`, fallback); await settled(f);
    expect(f.captures[0]?.text).toBe(raw); expect(f.captures[0]?.unsupportedSources.map(ref => ref.kind)).toEqual(['context', 'image', 'file', 'context']);
    expect(f.dispatched).toEqual([]); expect(f.calls).not.toContain('execution-start');
  });
}
test('generic, forged, copied and nested command contexts cannot mint native owner input', async () => {
  const f = fixture(); const args = ['start', 'fake'];
  for (const invokedByModel of [undefined, false, true]) {
    await f.registry.execute('workstream', args, { ...f.context, invokedByModel });
    await f.registry.get('workstream')!.handler(args, { ...f.context, invokedByModel, rawInput: '/workstream start fake' } as CommandContext);
  }
  await f.registry.executeFromOwner('workstream', args, { ...f.context, invokedByModel: true }, '/workstream start fake');
  await f.registry.executeFromOwner('workstream', args, f.context); // tokenization is not source
  let retained: CommandContext | undefined;
  f.registry.register({ name: 'relay', description: 'test relay', async handler(_args, context) {
    retained = context;
    await f.registry.execute('workstream', args, context);
    await f.registry.get('workstream')!.handler(args, { ...context });
    await f.registry.get('workstream')!.handler(args, context);
    await f.registry.executeFromOwner('workstream', args, context, '/workstream start fake');
    await f.registry.executeFromOwner('workstream', args, { ...context }, '/workstream start fake');
  } });
  await f.registry.executeFromOwner('relay', [], f.context, '/workstream start fake');
  await f.registry.execute('relay', [], f.context);
  await f.registry.get('workstream')!.handler(args, retained!);
  expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
});
test('missing native dispatch fails before capture; empty request never starts', async () => {
  const f = fixture(); delete f.context.dispatchNativeIntakeTurn;
  f.submit('/workstream start request'); await settled(f);
  expect(f.captures).toEqual([]); expect(f.output.join('\n')).toContain('unavailable');
  const g = fixture(); g.submit('/workstream start'); await settled(g);
  expect(g.captures).toEqual([]); expect(g.output.join('\n')).toContain('Usage:');
});
async function flush() { for (let count = 0; count < 80; count++) await Promise.resolve(); }
test('pending terminal resubmission does not allocate or capture a second source', async () => {
  const f = fixture(); const admit = f.client.admit; let release!: () => void;
  f.client.admit = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return admit(...args); };
  f.submit(`/workstream start ${original}`); await flush();
  expect(f.captures).toHaveLength(1);
  f.submit('/workstream start different source', true); await flush();
  expect(f.ids()).toBe(2); expect(f.captures).toHaveLength(1); expect(f.output.join('\n')).toContain('already pending');
  release(); await flush(); expect(f.dispatched).toHaveLength(1); expect(f.captures[0]?.text).toBe(original);
});
test('cancel during admission discards the late terminal result without ordinary dispatch', async () => {
  const f = fixture(); const admit = f.client.admit; let release!: () => void;
  f.client.admit = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return admit(...args); };
  f.submit(`/workstream start ${original}`); await flush();
  expect((await f.controls.cancel())?.result?.kind).toBe('cancelled');
  release(); await flush();
  expect(f.dispatched).toEqual([]); expect(f.calls).not.toContain('claim'); expect(f.ids()).toBe(2);
});
test('host replacement during terminal admission cannot dispatch its late result', async () => {
  const f = fixture(); const admit = f.client.admit; let release!: () => void;
  f.client.admit = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return admit(...args); };
  f.submit(`/workstream start ${original}`, true); await flush();
  f.replaceHost(); release(); await flush();
  expect(f.dispatched).toEqual([]); expect(f.calls).not.toContain('claim');
});
test('uncertain journal publication recovers the exact terminal source without a second write or identity', async () => {
  const f = fixture(); const save = f.journal.save; let saves = 0;
  f.journal.save = async (...args) => { saves++; await save(...args); throw new Error('published-indeterminate'); };
  f.submit(`/workstream start ${original}`); await settled(f);
  expect(f.captures).toEqual([]); expect(f.dispatched).toEqual([]);
  f.submit('/workstream start replacement', true); await flush();
  expect(saves).toBe(1); expect(f.ids()).toBe(2);
  const recovered = await f.controls.retry();
  expect(recovered?.turnReady).toBe(true); expect(saves).toBe(1); expect(f.ids()).toBe(2); expect(f.captures[0]?.text).toBe(original);
  expect((await f.create().status())?.turnReady).toBeUndefined();
});
test('uncertain capture resumes only the original source; another principal cannot recover it', async () => {
  const f = fixture(); const capture = f.client.capture;
  f.client.capture = async (...args) => { await capture(...args); throw new Error('lost response'); };
  f.submit(`/workstream start ${original}`, true); await settled(f);
  f.submit('/workstream start replacement'); await flush();
  expect(f.ids()).toBe(2); expect(f.captures).toHaveLength(1); expect(f.dispatched).toEqual([]);
  expect((await f.controls.resume())?.result).toMatchObject({ kind: 'turn', text: original });
  f.replacePrincipal(); expect((await f.controls.retry())?.status).toBe('unavailable');
  expect(f.captures).toHaveLength(1);
});
test('missing host, journal, or verified principal never falls back to legacy start', async () => {
  const unavailable = fixture(); delete unavailable.context.nativeConversationIntake;
  unavailable.submit('/workstream start request'); await settled(unavailable); expect(unavailable.captures).toEqual([]);
  const journal = fixture(); journal.journal.read = async () => { throw new Error('unavailable'); };
  journal.submit('/workstream start request', true); await settled(journal); expect(journal.captures).toEqual([]);
  const principal = fixture(); principal.context.nativeConversationIntake = new (await import('../../runtime/native-conversation-intake.ts')).NativeConversationIntakeControls(() => ({ available: false, identity: 'missing', reason: 'No paired host is selected.' }));
  principal.submit('/workstream start request'); await settled(principal); expect(principal.captures).toEqual([]);
  for (const f of [unavailable, journal, principal]) expect(f.dispatched).toEqual([]);
});
test('CRLF command separator is one syntax delimiter; intentionally repeated input gets distinct IDs', async () => {
  const f = fixture(); f.submit(`/workstream start\r\n${original}`); await settled(f);
  f.submit(`/workstream start\r\n${original}`, true); await flush();
  expect(f.captures.map(capture => capture.text)).toEqual([original, original]);
  expect(new Set(f.captures.map(capture => capture.inputId)).size).toBe(2); expect(f.dispatched).toHaveLength(2);
});
