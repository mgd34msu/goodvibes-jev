import { afterEach, describe, expect, test } from 'bun:test';
import type { Orchestrator } from '@goodvibes-jev/engine/sdk/platform/core';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { ToolRegistry, ContextAccountingHolder, createContextAccountingTool } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ConversationManager } from '../../core/conversation.ts';
import { hydrateConversationUsage, isConversationUsageAvailable, isConversationContextAvailable } from '../../core/conversation-usage.ts';
import { createBootstrapShell } from '../../runtime/bootstrap-shell.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { RuntimeEventBus, ForensicsRegistry, createTaskManager } from '@/runtime/index.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { resumeSessionCore } from '../../core/session-resume-core.ts';
import { createContextAccountingSource } from '../../runtime/context-accounting-source.ts';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { handleSessionPickerToken } from '../../input/handler-modal-routes.ts';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/sdk/platform/rewind';
import { saveWorkTreeFolds } from '../../core/work-tree-fold-store.ts';
import { SessionSpineClient, TUI_SPINE_PARTICIPANT } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import { UsageModal } from '../../input/usage-modal.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';
import { withPublicErrorText } from '../helpers/user-error-reading.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const services = getTestRuntimeServices();
  cleanups.push(async () => { await services.close(); resetTestRuntimeServices(); });
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  const conversation = new ConversationManager(() => 160);
  const orchestrator = {
    usage: { input: 9000, output: 8000, cacheRead: 7000, cacheWrite: 6000 },
    lastInputTokens: 22000,
    setSystemMessageRouter: () => {},
    getTurnInjections: () => [],
  };
  const runtime = { sessionId: 'previous-session', model: 'mock-model', provider: 'mock' };
  const sessionChanges: string[] = [];
  const pointers: string[] = [];
  const sessionSpine = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT });
  cleanups.push(() => sessionSpine.dispose());
  const shell = createBootstrapShell({
    configManager: services.configManager, runtimeBus, runtimeStore, services, conversation,
    runtime: runtime as never, orchestrator: orchestrator as unknown as Orchestrator,
    requestRender: () => {}, permissionPromptRef: { requestPermission: async () => ({ approved: false }) },
    onSessionIdChanged: (id) => { sessionChanges.push(id); }, writeLastSessionPointer: (id) => { pointers.push(id); },
    getControlPlaneRecentEvents: () => [], toolRegistry: new ToolRegistry(),
    forensicsRegistry: new ForensicsRegistry(), policyRuntimeState: services.policyRuntimeState,
    uiServices: createUiRuntimeServices(services),
    taskManager: createTaskManager(runtimeStore, runtimeBus, runtime.sessionId, services.featureFlags),
    sessionSpine,
  });
  cleanups.push(() => { shell.gitStatusProvider.stopPolling(); shell.closeNativeWorkSubmission?.(); shell.views.dispose(); });
  const holder = new ContextAccountingHolder();
  const accounting = createContextAccountingSource({ orchestrator, providerRegistry: services.providerRegistry, sessionLineageTracker: { getCompactionCount: () => 0 }, sessionId: runtime.sessionId });
  holder.setSource(accounting.source);
  cleanups.push(accounting.dispose);
  const save = (id: string, messages: object[]) => services.sessionManager.save(id, messages, { title: id, model: 'mock-model', provider: 'mock', timestamp: Date.now() });
  const resume = async (id: string) => {
    await resumeSessionCore(id, { sessionManager: services.sessionManager, conversation, runtime, surface: services.surface, hydrateSessionUsage: shell.commandContext.session.hydrateSessionUsage });
  };
  const footer = () => buildShellFooter({
    width: 180, promptText: '', promptLineCount: 1, usage: { available: isConversationUsageAvailable(orchestrator.usage), up: orchestrator.usage.input, down: orchestrator.usage.output },
    showExitNotice: false, lastCopyTime: 0, model: 'mock-model', contextWindow: 100_000,
    lastInputTokens: orchestrator.lastInputTokens, contextUsageAvailable: isConversationContextAvailable(orchestrator),
    runningAgentCount: 0, runningProcessCount: 0, indicatorFocused: false,
  }).lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
  return { services, shell, conversation, orchestrator, runtime, sessionChanges, pointers, sessionSpine, save, resume, footer, accountingTool: createContextAccountingTool(holder) };
}

const validHistory = [
  { role: 'assistant', content: 'complete turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 } },
  { role: 'assistant', content: 'follow-up', followUp: true, usage: { inputTokens: 2, outputTokens: 3 } },
];

describe('real bootstrap usage restoration', () => {
  test('malformed persisted usage resumes as unavailable, remains unknown after a live increment, and recovers on a valid restore and clear', async () => {
    const f = fixture();
    f.save('invalid-usage', [{ role: 'assistant', content: 'transcript survives', usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 'PRIVATE-BILLING-VALUE' } }]);
    await f.resume('invalid-usage');
    expect(f.conversation.getMessageSnapshot()[0]?.content).toBe('transcript survives');
    expect(isConversationUsageAvailable(f.orchestrator.usage)).toBe(false);
    expect(f.orchestrator.lastInputTokens).toBe(0);
    expect(f.footer()).toContain('usage unavailable');
    expect(f.footer()).toContain('context unavailable');
    expect(f.footer()).not.toMatch(/9000|22000|PRIVATE-BILLING-VALUE|NaN/);
    const usageParts: JsonValue[] = [
      { kind: 'text', text: 'Session usage unavailable: ' },
      { kind: 'span', reference: 'span-1', syntax: 'assignment-value', field: 'unavailable' },
      { kind: 'text', text: ' usage is ' },
      { kind: 'span', reference: 'span-2', syntax: 'assignment-value', field: 'usage' },
      { kind: 'text', text: '' },
    ];
    const unknown = await withPublicErrorText(['Session usage unavailable: saved token usage is invalid.'], () => f.accountingTool.execute({}, {} as never), {
      ordinaryFields: ['unavailable', 'usage'],
      credentialProjections: ['span-1', 'span-2'].map(target => ({ phase: 'source', target, parts: usageParts })),
      residualProjections: [{ parts: [
        { kind: 'text', text: 'Session usage unavailable: ' },
        { kind: 'withheld', reference: 'span-1' },
        { kind: 'text', text: ' usage is ' },
        { kind: 'withheld', reference: 'span-2' },
        { kind: 'text', text: '' },
      ] }],
    });
    expect(unknown.success).toBe(false);
    expect('error' in unknown ? unknown.error : '').toContain('usage unavailable');
    expect(JSON.stringify(unknown)).not.toContain('PRIVATE-BILLING-VALUE');
    const modal = new UsageModal({ tracker: f.shell.views.usage, compact: () => {}, pollMs: 0 });
    cleanups.push(() => modal.onClose());
    const text = layerTextBlock(modal.render(120, 40));
    expect(text).toContain('Usage and cost unavailable');
    expect(text).not.toContain('$0.00');
    expect(f.shell.views.usage.overBudget()).toBe(false);
    expect(f.shell.views.usage.sessionCost().priced).toBe(false);
    modal.tab = 'turns';
    expect(layerTextBlock(modal.render(120, 40))).toContain('Turn usage unavailable');
    modal.tab = 'agents';
    expect(layerTextBlock(modal.render(120, 40))).toContain('plan total unavailable');
    f.orchestrator.usage.input += 300;
    f.orchestrator.lastInputTokens = 300;
    expect(isConversationUsageAvailable(f.orchestrator.usage)).toBe(false);
    expect(f.footer()).toContain('usage unavailable');
    expect(f.footer()).not.toContain('context unavailable');

    f.save('valid-usage', validHistory);
    await f.resume('valid-usage');
    expect(isConversationUsageAvailable(f.orchestrator.usage)).toBe(true);
    expect(f.orchestrator.usage).toEqual({ input: 102, output: 23, cacheRead: 30, cacheWrite: 40 });
    expect(f.orchestrator.lastInputTokens).toBe(170);
    expect(f.footer()).not.toContain('unavailable');
    expect((await f.accountingTool.execute({}, {} as never)).success).toBe(true);

    await f.resume('invalid-usage');
    await f.shell.commandRegistry.execute('clear', [], f.shell.commandContext);
    expect(f.conversation.getMessageSnapshot()).toHaveLength(0);
    expect(isConversationUsageAvailable(f.orchestrator.usage)).toBe(true);
    expect(f.orchestrator.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(f.orchestrator.lastInputTokens).toBe(0);
  });

  test('all malformed persisted usage shapes stay unavailable without losing the transcript', async () => {
    const f = fixture();
    const values: unknown[] = [null, [], 'PRIVATE-USAGE', {}, { inputTokens: '9', outputTokens: 2 },
      { inputTokens: -1, outputTokens: 2 }, { inputTokens: 1.5, outputTokens: 2 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 2 },
      { inputTokens: 9, outputTokens: 2, cacheReadTokens: null },
      { inputTokens: 9, outputTokens: 2, cacheWriteTokens: 'PRIVATE-CACHE' }];
    for (const [index, usage] of values.entries()) {
      const id = `malformed-${index}`;
      f.save(id, [{ role: 'assistant', content: 'kept', usage }]);
      await f.resume(id);
      expect(f.conversation.getMessageSnapshot()[0]?.content).toBe('kept');
      expect(f.footer()).toContain('usage unavailable');
      expect(f.footer()).not.toMatch(/PRIVATE|NaN/);
    }
  });

  test('the picker Enter route resumes the native session and uses the same bound restore adapter', async () => {
    const f = fixture();
    const target = 'picker-invalid';
    f.services.sessionManager.save(target, [{ role: 'assistant', content: 'kept', usage: null }], {
      title: 'Saved picker', titleSource: 'user', model: 'mock-model', provider: 'mock', timestamp: Date.now(),
    });
    recordTurnAnchor(target, { turnId: 'saved-turn', label: 'saved anchor', messageCount: 1, at: Date.now() });
    persistTurnAnchors(target, f.services.surface);
    clearTurnAnchors(target);
    cleanups.push(() => clearTurnAnchors(target));
    saveWorkTreeFolds(f.services.surface.sessionsDir, target, [['turn_1', true]]);
    f.conversation.fromJSON({ messages: [{ role: 'user', content: 'old active transcript' }] });
    let cancelledRecovery = 0;
    f.shell.commandContext.cancelPendingRecovery = () => { cancelledRecovery++; return true; };
    const picker = new SessionPickerModal(f.services.sessionManager);
    picker.open();
    picker.setQuery(target);
    const enter = { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false } satisfies import('@goodvibes-jev/engine/sdk/platform/core').InputToken;
    expect(handleSessionPickerToken({
      sessionPickerModal: picker, commandContext: f.shell.commandContext,
      requestRender: () => {}, handleEscape: () => picker.close(),
    }, enter)).toBe(true);
    const pending = picker.pendingResume;
    expect(pending).not.toBeNull();
    await pending;
    expect(picker.active).toBe(false);
    expect(f.runtime.sessionId).toBe(target);
    expect(f.sessionChanges).toEqual([target]);
    expect(f.pointers).toEqual([target]);
    expect(f.sessionSpine.keepaliveSessionId).toBe(target);
    expect(f.sessionSpine.pendingOps).toBe(1);
    expect(cancelledRecovery).toBe(1);
    expect(f.conversation.title).toBe('Saved picker');
    expect(f.conversation.getTitleSource()).toBe('user');
    expect(f.conversation.getMessageSnapshot().map((message) => message.content)).toEqual(['kept']);
    expect(getTurnAnchors(target).map((anchor) => anchor.turnId)).toEqual(['saved-turn']);
    expect(f.conversation.workTree.foldState()).toEqual([['turn_1', true]]);
    expect(f.runtime.model).toBe('mock:mock-model');
    expect(f.runtime.provider).toBe('mock');
    expect(f.footer()).toContain('usage unavailable');
  });

  test('aggregate overflow is unavailable rather than a partial sum', async () => {
    const f = fixture();
    f.save('overflow', [
      { role: 'assistant', content: 'one', usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } },
      { role: 'assistant', content: 'two', usage: { inputTokens: 1, outputTokens: 0 } },
    ]);
    await f.resume('overflow');
    expect(f.conversation.getMessageSnapshot()).toHaveLength(2);
    expect(f.footer()).toContain('usage unavailable');
    f.save('empty', []);
    await f.resume('empty');
    expect(isConversationUsageAvailable(f.orchestrator.usage)).toBe(true);
    expect(f.orchestrator.usage.input).toBe(0);
  });

  test('unrelated snapshot failures propagate without rewriting counters', () => {
    const orchestrator = { usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 }, lastInputTokens: 12 };
    const error = new TypeError('snapshot failed');
    expect(() => hydrateConversationUsage({ getMessageSnapshot: () => { throw error; } }, orchestrator)).toThrow(error);
    expect(orchestrator.usage.input).toBe(12);
    expect(isConversationUsageAvailable(orchestrator.usage)).toBe(true);
  });
});
