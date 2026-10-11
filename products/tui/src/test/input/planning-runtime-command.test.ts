import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  KnowledgeStore,
  ProjectPlanningService,
  type ProjectPlanningState,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { KillRing } from '../../input/kill-ring.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';
import { handlePromptTextToken, handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';

function makeState(input: Partial<ProjectPlanningState> = {}): ProjectPlanningState {
  const now = Date.now();
  return {
    id: input.id ?? 'current',
    projectId: input.projectId ?? 'proj',
    knowledgeSpaceId: input.knowledgeSpaceId ?? 'project:proj',
    goal: input.goal ?? '',
    scope: input.scope,
    knownContext: input.knownContext ?? [],
    openQuestions: input.openQuestions ?? [],
    answeredQuestions: input.answeredQuestions ?? [],
    decisions: input.decisions ?? [],
    assumptions: input.assumptions ?? [],
    constraints: input.constraints ?? [],
    risks: input.risks ?? [],
    tasks: input.tasks ?? [],
    dependencies: input.dependencies ?? [],
    verificationGates: input.verificationGates ?? [],
    agentAssignments: input.agentAssignments ?? [],
    readiness: input.readiness ?? 'not-ready',
    executionApproved: input.executionApproved ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    metadata: input.metadata ?? {},
  };
}

function makeService(initial: ProjectPlanningState | null = null): {
  readonly service: ProjectPlanningService;
  readonly state: () => ProjectPlanningState | null;
} {
  let state = initial;
  const service = {
    async status() {
      return {
        ok: true,
        projectId: 'proj',
        knowledgeSpaceId: 'project:proj',
        passiveOnly: true,
        counts: { states: state ? 1 : 0, decisions: 0, languageArtifacts: 0 },
        capabilities: ['project-scoped-storage'],
      };
    },
    async getState() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state,
        ...(state ? { revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } } : {}) };
    },
    async upsertState(): Promise<never> {
      throw new Error('Commands must not round-trip numeric public planning state');
    },
    async applyStateAction(input: { action: { kind: string } }) {
      if (input.action.kind !== 'dismiss' || !state) throw new Error('Unexpected fixture action');
      state = { ...state, metadata: { ...state.metadata, active: false,
        dismissedAt: new Date(Date.now()).toISOString(), dismissedFrom: 'plan-command' } };
      return { ok: true, applied: true, state };
    },
    async evaluate(): Promise<never> {
      throw new Error('Commands must not request a fresh historical evaluation');
    },
  };
  return {
    service: service as unknown as ProjectPlanningService,
    state: () => state,
  };
}

function makeContext(
  service: ProjectPlanningService,
  out: string[],
  opened: string[],
  planManagerOverride: Record<string, unknown> = {},
): CommandContext {
  return {
    print: (message: string) => out.push(message),
    // Native entry and the explicit historical view have separate modal routes.
    openModal: (name: string) => { opened.push(name); },
    session: {
      runtime: {
        model: 'gpt-test',
        provider: 'test',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'session',
      },
      conversationManager: {},
      sessionLineageTracker: {
        setOriginalTask: () => {},
      },
    },
    workspace: {
      projectPlanningService: service,
      projectPlanningProjectId: 'proj',
    },
    ops: {
      planManager: {
        getActive: () => null,
        getSummary: () => '',
        list: () => [],
        toMarkdown: () => '',
        dismiss: () => ({ outcome: 'no-active-plan' }),
        ...planManagerOverride,
      },
    },
    provider: {},
    platform: {},
    extensions: {},
    renderRequest: () => {},
    exit: () => {},
  } as unknown as CommandContext;
}

// Regression: after coordinator removal, text containing 'plan' must reach orchestrator.handleUserInput.
// This test drives plan-keyword text through the real input routing layer (handlePromptTextToken +
// handlePromptKeyToken) and asserts that submitInput on CommandContext is called with the original text.
describe('submitInput plan-keyword regression (coordinator removed)', () => {
  test('text containing "plan" flows through real input routing and reaches submitInput unchanged', () => {
    const submitCalls: string[] = [];

    const commandContext = {
      submitInput: (text: string) => { submitCalls.push(text); },
    } as unknown as CommandContext;

    // Build initial prompt state (empty, not in command mode)
    const textState = {
      prompt: '',
      cursorPos: 0,
      commandMode: false,
      killRing: new KillRing(),
      nextPasteId: 1,
      nextImageId: 1,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      inputHistory: null,
      commandRegistry: new CommandRegistry(),
      commandContext,
      autocomplete: null,
      filePicker: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      saveUndoStateForText: () => {},
      ensureInputCursorVisible: () => {},
      registerPaste: (content: string) => content,
      requestRender: () => {},
    };

    // Simulate user typing 'plan me a new feature' through the text route
    const afterText = handlePromptTextToken(textState, { type: 'text', value: 'plan me a new feature' });

    // Build key route state using the updated prompt from text routing
    const keyState = {
      prompt: afterText.prompt,
      cursorPos: afterText.cursorPos,
      killRing: new KillRing(),
      inputScrollTop: 0,
      commandMode: afterText.commandMode,
      contentWidth: 80,
      maxInputRows: 10,
      inputHistory: null,
      indicatorFocused: false,
      conversationManager: null,
      commandContext,
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      getBlockAnchorLine: () => 0,
      openAgentsView: () => {},
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      saveUndoStateForText: () => {},
      breakUndoCoalesce: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => ({
        wrappedLines: [afterText.prompt],
        segments: [],
        cursorWrappedLine: 0,
        cursorCol: afterText.cursorPos,
        visibleLines: [afterText.prompt],
        visibleCursorLine: 0,
        visibleCursorCol: afterText.cursorPos,
      }),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (text: string) => text,
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
    };

    // Simulate pressing Enter, drives through real key routing which calls submitInput
    handlePromptKeyToken(keyState, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });

    // Plan-keyword text must reach submitInput unchanged, not swallowed, not intercepted
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toBe('plan me a new feature');
  });
});

describe('/project-plan project planning runtime command', () => {
  test('generic goal dispatch cannot seed historical state or fabricate owner input', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['replace', 'the', 'planning', 'modal'], makeContext(fake.service, out, opened));

    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Original owner input is required');
    expect(fake.state()).toBeNull();
  });

  // `dismiss` and `answer` are REAL subcommands now, they must NOT be
  // refused as pseudo-verbs, and they must never seed a goal named after themselves.
  test('/project-plan dismiss with no active plan and no interview state → honest no-op, never seeded', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, opened));

    expect(fake.state()).toBeNull(); // never seeded, the goal is not overwritten with "dismiss"
    expect(out.join('\n')).toContain('No active plan or planning state to dismiss.');
    expect(out.join('\n')).not.toContain('Unknown /project-plan subcommand');
  });

  test('/project-plan dismiss explicitly deactivates a historical planning record', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const fake = makeService(makeState({ goal: 'Ship it', metadata: { active: true, owner: 'tui' } }));

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, []));

    expect(fake.state()?.metadata?.['active']).toBe(false);
    expect(fake.state()?.metadata?.['dismissedFrom']).toBe('plan-command');
    expect(out.join('\n')).toContain('Historical project planning record marked inactive.');
  });

  test('/project-plan dismiss refuses a mid-execution plan and points at /workstream cancel', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const fake = makeService(makeState({ goal: 'Running', metadata: { active: true } }));
    const planManager = { dismiss: () => ({ outcome: 'requires-cancel', blockedBy: { title: 'Running plan' } }) };

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, [], planManager));

    expect(out.join('\n')).toContain('mid-execution');
    expect(out.join('\n')).toContain('/workstream cancel');
    // Saved historical state is left untouched when execution is mid-flight.
    expect(fake.state()?.metadata?.['active']).toBe(true);
  });

  test('/project-plan answer <index> <text> records a real answer and clears its open-question gap', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const answerCalls: unknown[] = [];
    const fake = makeService(makeState({ goal: 'Answer path', openQuestions: [{ id: 'q1', prompt: 'What scope?', status: 'open' }] }));
    // Record the explicit current-mode action received by the public service seam.
    const service = {
      ...(fake.service as unknown as Record<string, unknown>),
      applyStateAction: async (input: { action: { questionIndex?: number; questionId?: string; answer: string } }) => {
        answerCalls.push(input);
        return {
          ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', applied: true,
          question: { id: 'q1', prompt: 'What scope?', status: 'answered', answer: input.action.answer },
          openQuestions: [], state: fake.state(),
          get evaluation() { throw new Error('Fresh readiness and next-question hints must not be read'); },
        };
      },
    } as unknown as ProjectPlanningService;

    await registry.execute('project-plan', ['answer', '1', 'focused', 'first', 'pass'], makeContext(service, out, opened));

    expect(answerCalls).toEqual([{ projectId: 'proj', expected: { kind: 'current' }, action: { kind: 'answer', questionIndex: 0, answer: 'focused first pass' } }]);
    expect(out.join('\n')).toContain('Recorded historical answer to: What scope?');
    expect(opened).toContain('planning-modal');
    expect(out.join(' ')).toContain('The planning interview is retired; no native work authorized.');
    expect(out.join(' ')).not.toContain('Next question:');
    expect(out.join(' ')).not.toContain('Readiness:');
  });

  test('/project-plan answer with a bad question ref reports honestly (no seed)', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const fake = makeService(makeState({ goal: 'Answer path', openQuestions: [{ id: 'q1', prompt: 'What scope?', status: 'open' }] }));
    const service = {
      ...(fake.service as unknown as Record<string, unknown>),
      applyStateAction: async () => ({
        ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', applied: false,
        reason: 'question-not-found',
        openQuestions: [{ id: 'q1', prompt: 'What scope?', status: 'open' }],
        state: fake.state(),
      }),
    } as unknown as ProjectPlanningService;

    await registry.execute('project-plan', ['answer', 'nope', 'my', 'answer'], makeContext(service, out, []));
    expect(out.join('\n')).toContain('No open question matched "nope"');
    expect(out.join('\n')).toContain('1. What scope? (q1)');
  });

  test('remaining pseudo-subcommand verbs (pause/stop/cancel) are still refused as lone tokens', async () => {
    for (const verb of ['pause', 'stop', 'cancel']) {
      const registry = new CommandRegistry();
      registerPlanningRuntimeCommands(registry);
      const out: string[] = [];
      const fake = makeService();
      await registry.execute('project-plan', [verb], makeContext(fake.service, out, []));
      expect(fake.state()).toBeNull();
      expect(out.join('\n')).toContain(`Unknown /project-plan subcommand "${verb}"`);
    }
  });

  test('a multi-word goal never falls back to historical seeding without owner provenance', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['cancel', 'the', 'legacy', 'billing', 'flow'], makeContext(fake.service, out, opened));

    expect(fake.state()).toBeNull();
    expect(out.join('\n')).toContain('Original owner input is required');
    expect(opened).toEqual([]);
  });
});

for (const name of ['project-plan', 'planning']) {
  for (const args of [[], ['panel'], ['history']]) {
    test(`${name} ${args.join(' ')} separates native recovery from historical inspection without legacy writes`, async () => {
      const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
      const out: string[] = []; const opened: string[] = [];
      const service = new Proxy({}, { get() { throw new Error('Opening a view must not evaluate or mutate historical planning'); } }) as ProjectPlanningService;
      await registry.execute(name, args, makeContext(service, out, opened));
      expect(opened).toEqual([args[0] === 'history' ? 'planning-modal' : 'native-work-ledger-modal']);
      expect(out.join(' ')).toContain(args[0] === 'history' ? 'historical' : 'native work');
    });
  }
}

for (const name of ['project-plan', 'planning']) {
  test(`${name} approve records explicit historical metadata without reading evaluation hints`, async () => {
    const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
    const out: string[] = []; const opened: string[] = []; const calls: unknown[] = [];
    const service = {
      applyStateAction: async (input: unknown) => {
        calls.push(input);
        return { applied: true, state: makeState({ executionApproved: true }),
          get evaluation() { throw new Error('Fresh evaluation hints must not be read'); } };
      },
      evaluate: () => { throw new Error('The interview is retired'); },
      upsertState: () => { throw new Error('No unguarded historical write'); },
    } as unknown as ProjectPlanningService;
    const ctx = makeContext(service, out, opened);
    ctx.dispatchNativeIntakeTurn = async () => { throw new Error('Historical approval cannot dispatch native work'); };
    await registry.execute(name, ['approve'], ctx);
    expect(calls).toEqual([{ projectId: 'proj', expected: { kind: 'current' }, action: { kind: 'approve' } }]);
    expect(opened).toEqual(['planning-modal']);
    expect(out.join(' ')).toContain('Historical planning approval recorded; no native work authorized.');
    expect(out.join(' ')).not.toContain('Readiness:');
    expect(out.join(' ')).not.toContain('Next question:');
  });

  for (const action of ['approve', 'answer']) {
    test(`${name} ${action} rejects malformed revision bindings without legacy fallback`, async () => {
      const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
      for (const selection of [[], ['current'], ['current', 'source'], ['current', 'source', 'bad']]) {
        const out: string[] = []; const opened: string[] = [];
        const service = new Proxy({}, { get() { throw new Error('Malformed selections must not access the historical service'); } }) as ProjectPlanningService;
        const args = [action, '--selected-revision', ...selection];
        const ctx = makeContext(service, out, opened);
        ctx.dispatchNativeIntakeTurn = async () => { throw new Error('No native fallback'); };
        await registry.execute(name, args, ctx);
        expect(out.join(' ')).toContain('Invalid planning selection.');
        expect(opened).toEqual([]);
      }
    });

    test(`${name} ${action} with no saved state does not start an interview or native work`, async () => {
      const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
      const out: string[] = []; const opened: string[] = [];
      const service = {
        applyStateAction: async () => ({ applied: false, reason: 'no-state', state: null }),
        evaluate: () => { throw new Error('No fresh interview'); },
        upsertState: () => { throw new Error('No historical state seeding'); },
      } as unknown as ProjectPlanningService;
      const ctx = makeContext(service, out, opened);
      ctx.dispatchNativeIntakeTurn = async () => { throw new Error('No native fallback'); };
      await registry.execute(name, action === 'answer' ? [action, '1', 'Answer'] : [action], ctx);
      expect(out.join(' ')).toContain('No');
      expect(out.join(' ')).toContain('planning state exists');
      expect(opened).toEqual([]);
    });
  }
}


async function withActualDismissalService(run: (fixture: {
  readonly service: ProjectPlanningService; readonly store: KnowledgeStore; readonly path: string;
  readonly requests: () => number; readonly openStore: () => KnowledgeStore;
}) => Promise<void>, collisionClock = false): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tui-owned-dismissal-'));
  const path = join(root, 'knowledge.sqlite');
  const clock = collisionClock ? spyOn(Date, 'now').mockReturnValue(1700000000004) : undefined;
  const fake = fakePort(() => noulAnswer(0.99)); const previous = installJudgmentPort(fake.port);
  const stores: KnowledgeStore[] = [];
  const openStore = () => { const store = new KnowledgeStore({ dbPath: path }); stores.push(store); return store; };
  try {
    const store = openStore(); const service = new ProjectPlanningService(store);
    await service.upsertState({ projectId: 'proj', state: {
      goal: 'Preserve retry history', scope: 'Retry helper only', executionApproved: true,
      tasks: [{ id: 'retry', title: 'Keep retry records', verification: ['Run retry tests'] }],
      metadata: { active: true, owner: 'tui' },
    } });
    await run({ service, store, path, requests: () => fake.requests.length, openStore });
  } finally {
    try { for (const store of stores) await store.close(); }
    finally { installJudgmentPort(previous); clock?.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }
}

for (const clockMode of ['runtime', 'collision'] as const) test(`actual /project-plan dismiss owns canonical stored state with the ${clockMode} clock`, async () => {
  await withActualDismissalService(async f => {
    const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    f.service.upsertState = async () => { throw new Error('Dismissal must not submit a numeric public view'); };
    await registry.execute('project-plan', ['dismiss'], makeContext(f.service, out, []));
    const reopened = new ProjectPlanningService(f.openStore());
    const state = await reopened.getState({ projectId: 'proj' });
    expect(state.state?.metadata).toMatchObject({ active: false, owner: 'tui', dismissedFrom: 'plan-command' });
    const dismissedAt = state.state?.metadata?.dismissedAt;
    expect(typeof dismissedAt).toBe('string');
    expect(new Date(dismissedAt as string).toISOString()).toBe(dismissedAt);
    if (clockMode === 'collision') {
      expect(dismissedAt).toBe(new Date(1700000000004).toISOString());
      expect(state.state?.createdAt).toBe(1700000000004);
    } else expect(typeof state.state?.createdAt).toBe('number');
    expect(state.state?.goal).toBe('Preserve retry history');
    expect(out.join('\n')).toContain('Historical project planning record marked inactive.');
    const before = readFileSync(f.path), requests = f.requests();
    const forged = { projectId: 'proj', expected: { kind: 'current' as const },
      action: { kind: 'dismiss' as const, dismissedAt: 4111111111111111 } };
    await expect(reopened.applyStateAction(forged)).rejects.toMatchObject({ problem: 'card-material' });
    expect(readFileSync(f.path)).toEqual(before); expect(f.requests()).toBe(requests);
  }, clockMode === 'collision');
});

for (const mode of ['missing', 'stale'] as const) {
  test(`actual /project-plan dismiss refuses a ${mode} selected revision without changing history`, async () => {
    await withActualDismissalService(async f => {
      const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
      const out: string[] = []; const getState = f.service.getState.bind(f.service);
      let expectedBytes: Buffer | undefined; let requests = 0;
      f.service.getState = async input => {
        const selected = await getState(input);
        if (mode === 'stale') {
          await new ProjectPlanningService(f.openStore()).upsertState({ projectId: 'proj', state: {
            goal: 'A newer historical record', scope: 'Retry helper only', executionApproved: false,
            tasks: [{ id: 'newer', title: 'Keep newer work', verification: ['Run retry tests'] }],
            metadata: { active: true, owner: 'other-owner' },
          } });
        }
        expectedBytes = readFileSync(f.path); requests = f.requests();
        return mode === 'missing' ? { ...selected, revision: undefined } : selected;
      };
      f.service.upsertState = async () => { throw new Error('Dismissal must not submit a numeric public view'); };
      await registry.execute('project-plan', ['dismiss'], makeContext(f.service, out, []));
      expect(readFileSync(f.path)).toEqual(expectedBytes); expect(f.requests()).toBe(requests);
      const after = await new ProjectPlanningService(f.openStore()).getState({ projectId: 'proj' });
      expect(after.state?.metadata?.active).toBe(true);
      expect(after.state?.metadata?.dismissedAt).toBeUndefined();
      expect(out.join('\n')).toContain('Historical project planning record was not changed');
      expect(out.join('\n')).not.toContain('record marked inactive');
    });
  });
}
