import { describe, expect, test } from 'bun:test';
import { wireSessionAmbience, type SessionAmbienceDeps } from '../../runtime/session-ambience-wiring.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { resumeSessionCore } from '../../core/session-resume-core.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { rmSync } from 'node:fs';

function fixture(raw: object = { session: { autoTitle: true } }) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const turns = { on(type: string, handler: (event: unknown) => void) {
    const handlers = listeners.get(type) ?? new Set(); handlers.add(handler); listeners.set(type, handlers);
    return () => { handlers.delete(handler); };
  } };
  const conversation = new ConversationManager(() => 80); conversation.addUserMessage('refactor auth');
  let sessionId = 'session-a'; let active = true; let calls = 0; let renders = 0;
  let release!: (value: string) => void;
  const messages: string[] = [];
  const deps = {
    configManager: { getRaw: () => raw, get: () => false },
    events: { turns }, conversation,
    toolLLM: { chat: () => { calls++; return new Promise<string>(resolve => { release = resolve; }); } },
    voiceService: {}, orchestrator: {}, providerRegistry: {}, workingDir: '.',
    notify: (message: string) => { messages.push(message); }, render: () => { renders++; },
    getSessionId: () => sessionId, isActive: () => active,
  } as unknown as SessionAmbienceDeps;
  const ambience = wireSessionAmbience(deps);
  return {
    conversation, messages, get calls() { return calls; }, get renders() { return renders; },
    complete() { for (const handler of listeners.get('TURN_COMPLETED') ?? []) handler({ type: 'TURN_COMPLETED' }); },
    release(value = 'Generated Auth Title') { release(value); },
    switchSession() { sessionId = 'session-b'; }, restoreTerminal() { active = false; },
    dispose() { for (const unsubscribe of ambience.unsubs) unsubscribe(); },
  };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('real ambience caller owns title delivery', () => {
  test('default settings spend nothing', async () => {
    const f = fixture({}); try { f.complete(); await settle(); expect(f.calls).toBe(0); } finally { f.dispose(); }
  });
  test('one attempt and one real notice/repaint despite repeated completion', async () => {
    const f = fixture(); try {
      f.complete(); f.complete(); expect(f.calls).toBe(1); f.release(); await settle(); f.complete();
      expect(f.calls).toBe(1); expect(f.conversation.title).toBe('Generated Auth Title');
      expect(f.messages).toEqual(['[Session] Auto-titled: "Generated Auth Title"']); expect(f.renders).toBe(1);
    } finally { f.dispose(); }
  });
  test('a consumed attempt never clones the conversation again on later turns', async () => {
    const f = fixture(); let snapshots = 0;
    const readSnapshot = f.conversation.getMessageSnapshot.bind(f.conversation);
    f.conversation.getMessageSnapshot = () => { snapshots++; return readSnapshot(); };
    try {
      f.complete(); f.complete(); expect(snapshots).toBe(1);
      f.release(); await settle(); f.complete(); f.complete(); await settle();
      expect(snapshots).toBe(1); expect(f.calls).toBe(1);
    } finally { f.dispose(); }
  });
  test('a user title chosen during generation wins', async () => {
    const f = fixture(); try {
      f.complete(); f.conversation.title = 'My Title'; f.release(); await settle();
      expect(f.conversation.title).toBe('My Title'); expect(f.messages).toEqual([]); expect(f.renders).toBe(0);
    } finally { f.dispose(); }
  });
  for (const boundary of ['session switch', 'reset same ID', 'restore same ID', 'dispose', 'terminal restore'] as const) {
    test(`a held result cannot apply or repaint after ${boundary}, nor retry`, async () => {
      const f = fixture(); try {
        f.complete(); expect(f.calls).toBe(1);
        if (boundary === 'session switch') f.switchSession();
        if (boundary === 'reset same ID') f.conversation.resetAll();
        if (boundary === 'restore same ID') f.conversation.fromJSON({ messages: [{ role: 'user', content: 'replacement history' }] });
        if (boundary === 'dispose') f.dispose();
        if (boundary === 'terminal restore') f.restoreTerminal();
        const titleBefore = f.conversation.title;
        f.release(); await settle(); f.complete(); await settle();
        expect(f.conversation.title).toBe(titleBefore); expect(f.messages).toEqual([]); expect(f.renders).toBe(0); expect(f.calls).toBe(1);
      } finally { f.dispose(); }
    });
  }
  test('genuine same-ID resume replaces history before a held result settles', async () => {
    const f = fixture(); const dir = makeProjectTempDir('session-title-resume');
    const surface = makeTestSurface(dir); const manager = new SessionManager(dir, { surface });
    const runtime = { sessionId: 'session-a', model: 'model', provider: 'provider' };
    try {
      manager.save('session-a', [{ role: 'user', content: 'saved conversation' }], {
        title: 'Saved System Title', titleSource: 'system', model: 'model', provider: 'provider', timestamp: Date.now(),
      });
      f.complete();
      await resumeSessionCore('session-a', { conversation: f.conversation, runtime, sessionManager: manager, surface });
      expect(runtime.sessionId).toBe('session-a');
      f.release(); await settle(); f.complete(); await settle();
      expect(f.conversation.title).toBe('Saved System Title'); expect(f.messages).toEqual([]);
      expect(f.renders).toBe(0); expect(f.calls).toBe(1);
    } finally { f.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('turns before live opt-in do not consume the attempt or enable spending', async () => {
    const settings = { session: { autoTitle: false } }; const f = fixture(settings);
    try {
      f.complete(); await settle(); expect(f.calls).toBe(0);
      settings.session.autoTitle = true; f.complete(); expect(f.calls).toBe(1);
      f.release(); await settle(); expect(f.messages).toHaveLength(1);
    } finally { f.dispose(); }
  });
  test('disabling prevents a new attempt but preserves an already started same-lifetime result', async () => {
    const settings = { session: { autoTitle: true } }; const f = fixture(settings);
    try {
      settings.session.autoTitle = false; f.complete(); await settle(); expect(f.calls).toBe(0);
      settings.session.autoTitle = true; f.complete(); expect(f.calls).toBe(1);
      settings.session.autoTitle = false; f.complete(); expect(f.calls).toBe(1);
      f.release(); await settle();
      expect(f.conversation.title).toBe('Generated Auth Title'); expect(f.messages).toHaveLength(1);
      f.complete(); await settle(); expect(f.calls).toBe(1);
    } finally { f.dispose(); }
  });
  test('empty input leaves the one attempt for the first later user message', async () => {
    const f = fixture(); try {
      f.conversation.resetAll(); f.complete(); await settle(); expect(f.calls).toBe(0);
      f.conversation.addUserMessage('later request'); f.complete(); expect(f.calls).toBe(1);
      f.release(); await settle(); expect(f.messages).toHaveLength(1);
    } finally { f.dispose(); }
  });
  test('ordinary conversation append preserves the pending title lifetime', async () => {
    const f = fixture(); try {
      f.complete(); f.conversation.addAssistantMessage('done'); f.release(); await settle();
      expect(f.conversation.title).toBe('Generated Auth Title'); expect(f.messages).toHaveLength(1);
    } finally { f.dispose(); }
  });
});
