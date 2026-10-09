import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createSystemOnePort, PINNED_MODEL, type JudgmentConfig, type JudgmentPort, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { CreateAutomationJobInput } from '@goodvibes-jev/engine/sdk/platform/automation';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerScheduleRuntimeCommands } from '../../input/commands/schedule-runtime.ts';
import { ScheduleReadingLifetime } from '../../input/commands/schedule-reading-lifetime.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';
import { KillRing } from '../../input/kill-ring.ts';
import { handlePromptKeyToken } from '../../input/handler-feed-routes.ts';
import { createCancelGeneration } from '../../core/turn-cancellation.ts';

const previous = installJudgmentPort(undefined);
afterEach(() => { installJudgmentPort(previous); });
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((r, fail) => { resolve = r; reject = fail; }); return { resolve, reject, promise }; }
function choices(parts: Record<string, string>) {
  return fakePort((name, question) => choiceAnswer(question, parts[name] ?? (name === 'complete' ? 'yes' : 'unknown'), 0.99));
}
const interval = { shape: 'interval', quantity: 'literal_1', unit: 'minute' };
function context(start: () => Promise<void> = async () => {}) {
  let session = 's1'; let active = true;
  const printed: string[] = []; const jobs: CreateAutomationJobInput[] = [];
  const lifetime = new ScheduleReadingLifetime(() => session, () => active);
  const manager = { start, createJob: async (input: CreateAutomationJobInput) => {
    jobs.push(structuredClone(input)); return { id: 'job-1', name: input.name, schedule: input.schedule };
  } };
  const ctx = { ops: { automationManager: manager }, scheduleReading: lifetime, print: (text: string) => printed.push(text) } as unknown as CommandContext;
  const registry = new CommandRegistry(); registerScheduleRuntimeCommands(registry);
  return { registry, ctx, lifetime, jobs, printed, setSession: (id: string) => { session = id; }, close: () => { active = false; lifetime.dispose(); } };
}
const args = (phrase = 'every 30 minutes') => ['add', 'when', phrase, 'check builds'];
async function enteredRead(f: ReturnType<typeof context>, port: JudgmentPort) {
  const entered = deferred(); const release = deferred();
  installJudgmentPort({ ...port, async ask(request) { entered.resolve(); await release.promise; return port.ask(request); } });
  const pending = f.registry.execute('schedule', args(), f.ctx);
  await entered.promise;
  return { pending, release };
}
function transport(fetch: NonNullable<JudgmentConfig['fetch']>) {
  return createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: PINNED_MODEL, timeoutMs: 1000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch });
}
function wireAnswer(questions: Questions, parts = interval) {
  const values: Record<string, string> = parts;
  return Response.json({ model: PINNED_MODEL, answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, choiceAnswer(q, values[name] ?? (name === 'complete' ? 'yes' : 'unknown'), 0.99)])), usage: { input_tokens: 1, output_tokens: 1 } });
}

describe('registered /schedule when owns Jev reading before createJob', () => {
  test('persists exactly the concrete interpretation that it echoes', async () => {
    const f = context(); const jev = choices({ shape: 'daily', hour: '9', minute: '0' }); installJudgmentPort(jev.port);
    await f.registry.execute('schedule', [...args('at nine every morning'), '--tz', 'Asia/Tokyo'], f.ctx);
    expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0]!.schedule).toEqual({ kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo' });
    expect(f.printed.join('\n')).toContain('0 9 * * * [Asia/Tokyo]');
    expect(jev.requests[0]!.state).toMatchObject({ source: { phrase: 'at nine every morning', timezone: 'Asia/Tokyo' } });
  });
  test('unknown reading creates zero jobs and has no human question', async () => {
    const f = context(); installJudgmentPort(choices({ shape: 'unknown', complete: 'unknown' }).port);
    await f.registry.execute('schedule', args('sometime later'), f.ctx);
    expect(f.jobs).toEqual([]); expect(f.printed.join('\n')).toContain('No automation job was created');
    expect(f.printed.join('\n')).not.toMatch(/confirm|approve|\?/i);
  });
  test('no installed reader creates zero jobs; a later invocation recovers', async () => {
    const f = context(); installJudgmentPort(undefined);
    await f.registry.execute('schedule', args(), f.ctx); expect(f.jobs).toEqual([]);
    installJudgmentPort(choices(interval).port);
    await f.registry.execute('schedule', args(), f.ctx); expect(f.jobs).toHaveLength(1);
  });
  test('duplicate pending invocation creates one job and one reading', async () => {
    const f = context(); const jev = choices(interval); const pending = await enteredRead(f, jev.port);
    await f.registry.execute('sched', args(), f.ctx); expect(f.jobs).toEqual([]);
    pending.release.resolve(); await pending.pending;
    expect(f.jobs).toHaveLength(1); expect(jev.requests).toHaveLength(1);
  });
  test.each(['cancel', 'session', 'shutdown', 'superseded'] as const)('%s after the read started creates zero old jobs', async cause => {
    const f = context(); const jev = choices(interval); const pending = await enteredRead(f, jev.port);
    if (cause === 'cancel') {
      let aborts = 0; let recoveries = 0;
      const cancel = f.lifetime.withCancellation(createCancelGeneration({ isThinking: false, abort: () => aborts++ } as never, { stop: () => false }, () => { recoveries++; return false; }));
      expect(cancel()).toBe(true); expect(aborts).toBe(0); expect(recoveries).toBe(1);
    } else if (cause === 'session') { f.lifetime.cancel(); f.setSession('s2'); }
    else if (cause === 'shutdown') f.close();
    else { const next = f.lifetime.begin('different submission'); expect(next).toBeDefined(); next!.finish(); }
    pending.release.resolve(); await pending.pending; expect(f.jobs).toEqual([]);
  });
  test('cancellation during manager startup creates zero jobs and does not start a reading', async () => {
    const startup = deferred(); const f = context(() => startup.promise); const jev = choices(interval); installJudgmentPort(jev.port);
    const pending = f.registry.execute('schedule', args(), f.ctx); f.lifetime.cancel(); startup.resolve(); await pending;
    expect(jev.requests).toEqual([]); expect(f.jobs).toEqual([]);
  });
  test('typed cron/every/at paths preserve grammar and never ask Jev', async () => {
    const f = context(); const jev = choices(interval); installJudgmentPort(jev.port);
    await f.registry.execute('schedule', ['add', 'cron', '*/30 * * * *', 'check'], f.ctx);
    await f.registry.execute('schedule', ['add', 'every', '15m', 'check'], f.ctx);
    await f.registry.execute('schedule', ['add', 'at', '2030-01-01T00:00:00Z', 'check'], f.ctx);
    expect(f.jobs.map(j => j.schedule)).toEqual([{ kind: 'cron', expression: '*/30 * * * *' }, { kind: 'every', intervalMs: 900000 }, { kind: 'at', at: Date.parse('2030-01-01T00:00:00Z') }]);
    expect(jev.requests).toEqual([]);
    await f.registry.execute('schedule', ['add', 'every', '0m', 'check'], f.ctx); expect(f.jobs).toHaveLength(3);
  });
  test('source args/clock stay captured while startup is pending', async () => {
    const startup = deferred(); const f = context(() => startup.promise); const jev = choices(interval); installJudgmentPort(jev.port);
    const input = args(); const before = Date.now(); const pending = f.registry.execute('schedule', input, f.ctx); input[2] = 'different'; startup.resolve(); await pending;
    const source = (jev.requests[0]!.state as { source: { phrase: string; now: number } }).source;
    expect(source.phrase).toBe('every 30 minutes'); expect(source.now).toBeGreaterThanOrEqual(before); expect(source.now).toBeLessThanOrEqual(Date.now());
  });
  test('shared transport retries 503 then creates exactly one job from the recovered reading', async () => {
    const f = context(); let calls = 0;
    installJudgmentPort(transport(async (_url, init) => {
      if (++calls < 3) return Response.json({}, { status: 503 });
      return wireAnswer((JSON.parse(String(init?.body)) as { questions: Questions }).questions);
    }));
    await f.registry.execute('schedule', args(), f.ctx);
    expect(calls).toBe(3); expect(f.jobs).toHaveLength(1); expect(f.printed.join('\n')).toContain('Waiting for Jev');
  });
  test('real shared retry is immediately cancelled before creation, even when fetch ignores its signal', async () => {
    const f = context(); const entered = deferred(); const held = deferred<Response>();
    installJudgmentPort(transport(async () => { entered.resolve(); return held.promise; }));
    const pending = f.registry.execute('schedule', args(), f.ctx); await entered.promise;
    f.lifetime.withCancellation(() => false)();
    await pending; expect(f.jobs).toEqual([]);
    held.resolve(Response.json({}, { status: 503 }));
  });
  test('actual terminal command-mode dispatch retains the complete quoted schedule phrase', async () => {
    const f = context(); const jev = choices(interval); installJudgmentPort(jev.port);
    const done = deferred();
    const state = { commandMode: true, prompt: '/schedule add when "every  30 minutes" "check builds"', cursorPos: 0, autocomplete: null, modalStack: [], commandRegistry: f.registry,
      commandContext: f.ctx, conversationManager: null, requestRender: () => done.resolve(), handleEscape() {}, projectRoot: '.', pasteRegistry: new Map(), imageRegistry: new Map(), nextPasteId: 0, nextImageId: 0,
      saveUndoState() {}, ensureInputCursorVisible() {} } as CommandModeRouteState;
    handleCommandModeToken(state, { type: 'key', logicalName: 'enter' } as never); await done.promise;
    expect(f.jobs).toHaveLength(1); expect(f.jobs[0]!.prompt).toBe('check builds');
    expect(jev.requests[0]!.state).toMatchObject({ source: { phrase: 'every  30 minutes' } });
  });
});

async function dispatchTerminal(f: ReturnType<typeof context>, command: string, fallback: boolean): Promise<void> {
  let task: Promise<void> | undefined;
  const registered = f.registry.get('schedule')!;
  const original = registered.handler;
  registered.handler = (args, ctx) => { task = Promise.resolve(original(args, ctx)); return task; };
  f.ctx.executeCommand = (name, args) => f.registry.execute(name, args, f.ctx);
  if (!fallback) {
    handleCommandModeToken({ commandMode: true, prompt: command, cursorPos: command.length, autocomplete: null, modalStack: [], commandRegistry: f.registry,
      commandContext: f.ctx, conversationManager: { dismissSplash() {}, log: (text: string) => f.printed.push(text) } as never, requestRender() {}, handleEscape() {}, projectRoot: '.', pasteRegistry: new Map(), imageRegistry: new Map(), nextPasteId: 0, nextImageId: 0,
      saveUndoState() {}, ensureInputCursorVisible() {} }, { type: 'key', logicalName: 'enter' } as never);
  } else {
    handlePromptKeyToken({ prompt: command, cursorPos: command.length, commandMode: false, inputScrollTop: 0, contentWidth: 80, maxInputRows: 10, inputHistory: null,
      indicatorFocused: false, conversationManager: { dismissSplash() {}, log: (text: string) => f.printed.push(text) } as never, commandContext: f.ctx, commandRegistry: f.registry, autocomplete: null, requestRender() {},
      blockActionsMenu: { open() {} }, getBlockAnchorLine: () => 0, openAgentsView() {}, modalOpened() {}, saveUndoState() {}, breakUndoCoalesce() {}, ensureInputCursorVisible() {},
      getWrappedPromptInfo: () => ({ wrappedLines: [command], segments: [], cursorWrappedLine: 0, cursorCol: 0, visibleLines: [command], visibleCursorLine: 0, visibleCursorCol: 0 }),
      moveCursorVertical: () => false, handlePathCompletion: () => false, handleBlockToggle() {}, findMarkerAtPos: () => null, cleanupMarkerRegistry() {}, expandPrompt: text => text,
      scroll() {}, exitApp() {}, killRing: new KillRing(),
    }, { type: 'key', logicalName: 'enter' } as never);
  }
  await task;
}
for (const fallback of [false, true]) {
  describe(`actual terminal ${fallback ? 'fallback' : 'command-mode'} schedule grammar`, () => {
    test('quoted phrase and escaped quotes reach the same engine reader intact', async () => {
      const f = context(); const jev = choices(interval); installJudgmentPort(jev.port);
      await dispatchTerminal(f, '/sched add when "every  30 minutes (the \\"short\\" interval)" "check \\"failed\\" builds"', fallback);
      expect(f.jobs).toHaveLength(1);
      expect(f.jobs[0]!.prompt).toBe('check "failed" builds');
      expect(jev.requests[0]!.state).toMatchObject({ source: { phrase: 'every  30 minutes (the "short" interval)' } });
    });
    test.each(['/schedule add when "daily" "unterminated prompt', "/schedule add when 'daily' 'unterminated prompt", '/schedule add when daily prompt\\'])('malformed quoting creates zero jobs: %s', async command => {
      const f = context(); const jev = choices(interval); installJudgmentPort(jev.port);
      await dispatchTerminal(f, command, fallback);
      expect(f.jobs).toEqual([]); expect(jev.requests).toEqual([]); expect(f.printed).toContain('Invalid schedule command quoting.');
    });
    test.each([
      ['/schedule add cron "*/30 * * * *" "check builds"', { kind: 'cron', expression: '*/30 * * * *' } as const],
      ['/schedule add every 15m "check builds"', { kind: 'every', intervalMs: 900000 } as const],
      ['/schedule add at 2030-01-01T00:00:00Z "check builds"', { kind: 'at', at: Date.parse('2030-01-01T00:00:00Z') } as const],
    ])('typed command %s stays independent of Jev', async (command, expected) => {
      const f = context(); const jev = choices(interval); installJudgmentPort(jev.port);
      await dispatchTerminal(f, command, fallback);
      expect(f.jobs).toHaveLength(1); expect(f.jobs[0]!.schedule).toEqual(expected); expect(f.jobs[0]!.prompt).toBe('check builds'); expect(jev.requests).toEqual([]);
    });
  });
}

for (const fallback of [false, true]) {
  describe(`terminal ${fallback ? 'fallback' : 'command-mode'} empty/source-error fencing`, () => {
    test.each(['""', "''"])('empty quoted phrase %s cannot promote the prompt into schedule meaning', async empty => {
      const f = context(); const jev = choices(interval); installJudgmentPort(jev.port);
      await dispatchTerminal(f, `/schedule add when ${empty} "every 30 minutes" "check builds"`, fallback);
      expect(f.jobs).toEqual([]); expect(jev.requests).toEqual([]);
    });
    test.each(['cancel', 'session', 'closed', 'live'] as const)('%s startup failure stays on its owning command', async cause => {
      const startup = deferred(); const f = context(() => startup.promise);
      const outcome = dispatchTerminal(f, '/schedule add when "every 30 minutes" "check builds"', fallback).catch(() => {});
      if (cause === 'cancel') f.lifetime.withCancellation(() => false)();
      else if (cause === 'session') f.setSession('new-session');
      else if (cause === 'closed') f.close();
      startup.reject(new Error('late manager failure'));
      await outcome;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(f.jobs).toEqual([]);
      if (cause === 'live') expect(f.printed.join(' ')).toContain('late manager failure');
      else expect(f.printed).toEqual([]);
    });
  });
}

for (const fallback of [false, true]) {
  test(`malformed replacement in terminal ${fallback ? 'fallback' : 'command-mode'} revokes the older read`, async () => {
    const f = context(); const jev = choices(interval); const old = await enteredRead(f, jev.port);
    await dispatchTerminal(f, '/schedule add when "unterminated replacement', fallback);
    old.release.resolve(); await old.pending;
    expect(f.jobs).toEqual([]);
    expect(f.printed).toContain('Invalid schedule command quoting.');
    expect(f.printed.join(' ')).not.toContain('Automation job created');
  });
}
