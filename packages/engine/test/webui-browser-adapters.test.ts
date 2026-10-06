import { describe, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, type Answerer } from '@goodvibes-jev/judgment/testing';
import { BrowserJudgmentError, type AuthenticatedPrincipal, type BrowserJudgmentInputMap, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { BrowserJudgmentReferences, BrowserJudgmentRegistry, BrowserJudgmentService } from '../sdk/src/platform/judgment-browser/index.ts';
import { createWebuiCommandRankAdapter, webuiDaemonRefusalAdapter, webuiStatusToneAdapter, type WebuiPaletteSources } from '../sdk/src/platform/judgment-browser/batteries/webui-adapters.ts';
import { withWebuiAnswerBoundary } from '../sdk/src/platform/judgment-browser/batteries/webui-answers.ts';
import { WEBUI_BUILTIN_COMMANDS, WEBUI_COMMAND_CATALOG_VERSION } from '../sdk/src/platform/judgment-browser/batteries/webui-command-catalog.ts';
import { readStructuredDaemonRefusal } from '../sdk/src/platform/judgment-browser/batteries/webui-readers.ts';
import { readWebuiStatusCatalog } from '../sdk/src/platform/judgment-browser/batteries/webui-status-catalog.ts';
import type { ResolvedCommandRank } from '../sdk/src/platform/judgment-browser/batteries/webui-types.ts';

const ERRORS = 'webui.errors.daemon-refusal';
const STATUS = 'webui.status.badge-tone';
const PALETTE = 'webui.palette.command-rank';
const owner: AuthenticatedPrincipal = { principalId: 'fixture-owner', principalKind: 'user', admin: false, scopes: ['write:judgment', 'read:sessions'] };
const body = <K extends keyof BrowserJudgmentInputMap>(battery: K, input: BrowserJudgmentInputMap[K]): BrowserJudgmentRequest<K> => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery, batteryVersion: 1, input }) as BrowserJudgmentRequest<K>;
const source = (message = 'This daemon does not host a live runtime for the existing session.', status = 404) => ({ methodId: 'sessions.contextUsage.get', status, message });
const sourceBinding = 'fixture-palette-query-and-candidate-source';

function harness(options: { answer?: Answerer; sources?: WebuiPaletteSources; authorize?: () => boolean; beforeAnswer?: (request: JudgmentRequest<Questions>) => Promise<void> } = {}) {
  const fake = fakePort(options.answer ?? ((name) => noulAnswer(name === 'session_not_local' ? 0.99 : 0.01)));
  const log = new SqliteDecisionLog(':memory:');
  const references = new BrowserJudgmentReferences();
  const registry = new BrowserJudgmentRegistry();
  registry.register(webuiDaemonRefusalAdapter);
  registry.register(webuiStatusToneAdapter);
  if (options.sources) registry.register(createWebuiCommandRankAdapter(options.sources));
  let current = owner;
  let active = 0;
  let peak = 0;
  const inner: JudgmentPort = { model: fake.port.model, async ask(request) {
    active++; peak = Math.max(peak, active);
    try { await options.beforeAnswer?.(request as JudgmentRequest<Questions>); return await fake.port.ask(request); }
    finally { active--; }
  } };
  const port = withDecisionLog(withWebuiAnswerBoundary(inner), log);
  const service = new BrowserJudgmentService({ registry, references,
    currentRoute: () => ({ revision: 'fixture-route', kind: 'local', port, assertCurrent() {} }),
    authorize: options.authorize ?? (() => true),
  });
  return { ...fake, port, log, references, service, peak: () => peak,
    principal: (value: AuthenticatedPrincipal) => { current = value; },
    issue: (battery: keyof BrowserJudgmentInputMap, snapshot: unknown, extra: { mayRead?: (principal: AuthenticatedPrincipal) => boolean; assertCurrent?: () => void } = {}) => references.issue({
      principalId: owner.principalId, battery, revision: 'fixture-source-v1', expiresAt: Date.now() + 60_000, snapshot,
      mayRead: extra.mayRead ?? ((principal) => principal.principalId === owner.principalId), assertCurrent: extra.assertCurrent ?? (() => {}),
    }),
    execute: (request: BrowserJudgmentRequest, signal = new AbortController().signal) => service.execute(request, owner, signal, () => current),
    async close() { await service.close(); log[Symbol.dispose](); },
  };
}

/** Trusted source fixture only. Production session/access authority is supplied by daemon composition. */
function paletteSources(state: ResolvedCommandRank, assertCurrent: () => void = () => {}): WebuiPaletteSources {
  return { async resolve(_input, context) {
    const samePrincipal = () => {
      const principal = context.currentPrincipal();
      if (principal.principalId !== context.principal.principalId
        || (principal.admin !== true && !principal.scopes.includes('read:sessions'))) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD');
      assertCurrent();
    };
    samePrincipal();
    return { state, sourceBinding, assertCurrent: samePrincipal };
  } };
}
const rankState = (count = 3): ResolvedCommandRank => ({ query: 'start over', registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
  candidates: Array.from({ length: count }, (_, index) => ({ title: index === 0 ? 'New Chat' : `Unrelated ${index}`, group: 'chat' })) });
const rankBody = (count = 3) => body(PALETTE, { query: { kind: 'inline', text: 'start over' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
  candidates: Array.from({ length: count }, (_, index) => ({ kind: 'chat' as const, sessionId: `private-session-${index}` })) });

describe('actual WebUI descriptors through the published service', () => {
  test('known refusal codes resolve structurally and cannot create endpoint readings', async () => {
    const f = harness();
    try {
      const known = { ...source(), code: 'SESSION_NOT_FOUND' };
      expect(readStructuredDaemonRefusal(known)).toEqual({ status: 'ready', basis: 'structured', value: { session_not_found: true, session_closed: false, session_active: false, session_not_local: false, method_unknown: false } });
      const ref = f.issue(ERRORS, known);
      await expect(f.execute(body(ERRORS, { errorRef: ref }))).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('unknown error refs produce genuine five-item readings and decision evidence', async () => {
    const f = harness();
    try {
      const ref = f.issue(ERRORS, source());
      const result = await f.execute(body(ERRORS, { errorRef: ref })) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'settled', outcome: 'act', value: { session_not_local: true, session_not_found: false }, readings: { session_not_local: { probability: 0.99, verdict: 'yes', outcome: 'act' } } });
      expect(f.requests).toHaveLength(1); expect(f.log.query()).toHaveLength(1);
      expect(result.evidence).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(source().message);
    } finally { await f.close(); }
  });

  test('non-404 omits method_unknown reading while returning its structural false value', async () => {
    const f = harness({ answer: () => noulAnswer(0.01) });
    try {
      const ref = f.issue(ERRORS, source('Gateway storage unavailable.', 500));
      const result = await f.execute(body(ERRORS, { errorRef: ref })) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'settled', value: { method_unknown: false }, structuralBasis: { method_unknown: 'http-status-not-404' } });
      expect(result.readings).not.toHaveProperty('method_unknown');
      expect(Object.keys(f.requests[0]!.questions)).toHaveLength(4);
    } finally { await f.close(); }
  });

  test('an unknown refusal without an actual HTTP status is held before the port or log', async () => {
    const f = harness();
    try {
      const ref = f.issue(ERRORS, { methodId: 'sessions.get', message: 'An unresolved refusal with no wire status.' });
      await expect(f.execute(body(ERRORS, { errorRef: ref }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('a conflicting all-act compound escalates without altering individual readings or returning a value', async () => {
    const f = harness({ answer: (name) => noulAnswer(name === 'session_closed' || name === 'session_active' ? 0.99 : 0.01) });
    try {
      const ref = f.issue(ERRORS, source('Mixed current-state evidence.'));
      const result = await f.execute(body(ERRORS, { errorRef: ref })) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'held', outcome: 'escalate', readings: { session_closed: { outcome: 'act' }, session_active: { outcome: 'act' } } });
      expect(result).not.toHaveProperty('value');
      expect(result).not.toHaveProperty('compoundOutcome');
    } finally { await f.close(); }
  });

  test('confirm and escalate survive the service projection with no guessed value', async () => {
    for (const [p, outcome] of [[0.8, 'confirm'], [0.5, 'escalate']] as const) {
      const f = harness({ answer: (name) => noulAnswer(name === 'session_closed' ? p : 0.01) });
      try {
        const result = await f.execute(body(ERRORS, { errorRef: f.issue(ERRORS, source()) })) as Record<string, unknown>;
        expect(result).toMatchObject({ status: 'held', outcome, readings: { session_closed: { probability: p, outcome } } });
        expect(result).not.toHaveProperty('value');
      } finally { await f.close(); }
    }
  });

  test('current status catalogs use exhaustive structural mappings and never call a provider', async () => {
    expect(readWebuiStatusCatalog('session.closed', 'badge')).toEqual({ vocabulary: 'badge', tone: 'neutral' });
    expect(readWebuiStatusCatalog('knowledge-job.running', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'info' });
    expect(readWebuiStatusCatalog('knowledge-job.completed', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'ok' });
    expect(readWebuiStatusCatalog('knowledge-job.future-status', 'badge')).toBeUndefined();
    const f = harness();
    try {
      await expect(f.execute(body(STATUS, { vocabulary: 'badge', source: { kind: 'catalog', labelId: 'session.closed' } }))).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('unresolved status references preserve independent confidence and selected probability', async () => {
    const f = harness({ answer: () => ({ type: 'choice', choice: 'ok', confidence: 0.61, probabilities: { ok: 0.42, warning: 0.28, bad: 0.2, neutral: 0.1 } }) });
    try {
      const ref = f.issue(STATUS, { kind: 'text', vocabulary: 'badge', status: 'Operational with a minor advisory.', domain: 'session' });
      const result = await f.execute(body(STATUS, { vocabulary: 'badge', source: { kind: 'daemon', statusRef: ref } }));
      expect(result).toMatchObject({ status: 'settled', value: { vocabulary: 'badge', tone: 'ok' }, readings: { badge: { confidence: 0.61, probabilities: { ok: 0.42 }, outcome: 'act' } } });
      expect(f.requests).toHaveLength(1); expect(f.log.query()).toHaveLength(1);
      expect(Object.keys(f.requests[0]!.questions)).toEqual(['badge']);
    } finally { await f.close(); }
  });

  test('library-dot asks its separate fixed choice and preserves unsettled evidence without a tone', async () => {
    const f = harness({ answer: (_name, question) => choiceAnswer(question, 'info', 0.57) });
    try {
      const ref = f.issue(STATUS, { kind: 'text', vocabulary: 'library-dot', status: 'Work remains in progress.', domain: 'knowledge-job' });
      const result = await f.execute(body(STATUS, { vocabulary: 'library-dot', source: { kind: 'daemon', statusRef: ref } }));
      expect(result).toMatchObject({ status: 'held', outcome: 'confirm', readings: { library_dot: { choice: 'info', confidence: 0.57, outcome: 'confirm' } } });
      expect(result).not.toHaveProperty('value');
      expect(f.requests).toHaveLength(1); expect(Object.keys(f.requests[0]!.questions)).toEqual(['library_dot']);
      expect(f.log.query()).toHaveLength(1);
    } finally { await f.close(); }
  });

  test('no free-form status issuer or cross-vocabulary ref is assumed', async () => {
    const f = harness({ answer: (_name, question) => choiceAnswer(question, 'ok') });
    try {
      await expect(f.execute(body(STATUS, { vocabulary: 'badge', source: { kind: 'daemon', statusRef: 'not-issued' } }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      const ref = f.issue(STATUS, { kind: 'text', vocabulary: 'library-dot', status: 'indexing', domain: 'knowledge-job' });
      await expect(f.execute(body(STATUS, { vocabulary: 'badge', source: { kind: 'daemon', statusRef: ref } }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      expect(f.requests).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('palette reads every opaque index, preserves actual probabilities and keeps private identities out of the log', async () => {
    const f = harness({ sources: paletteSources(rankState()), answer: (_name, _question, state) => noulAnswer((state as { candidate: { title: string } }).candidate.title === 'New Chat' ? 0.93 : 0.03) });
    try {
      const result = await f.execute(rankBody()) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'settled', value: { accepted: [{ candidateIndex: 0, probability: 0.93 }], rejected: [1, 2] }, readings: { candidate_0: { verdict: 'yes', outcome: 'act' }, candidate_1: { verdict: 'no', outcome: 'act' } } });
      expect(f.requests).toHaveLength(3); expect(Object.keys(result.readings as object)).toEqual(['candidate_0', 'candidate_1', 'candidate_2']);
      const recorded = JSON.stringify(f.log.query());
      for (const text of ['private-session-', 'New Chat', 'start over', sourceBinding]) expect(recorded).not.toContain(text);
    } finally { await f.close(); }
  });

  test('palette preserves source lifetime cancellation across its resolver wrapper and drains fan-out', async () => {
    const lifetime = new AbortController(); const sources = paletteSources(rankState(8));
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let active = 0;
    const f = harness({ sources: { async resolve(input, context) {
      return { ...await sources.resolve(input, context), signal: lifetime.signal };
    } }, beforeAnswer: ({ signal }) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      if (++active === 4) entered();
    }) });
    try {
      const pending = f.execute(rankBody(8)).catch((error: unknown) => error);
      await started; lifetime.abort();
      expect(await pending).toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      await f.service.close();
      expect(active).toBe(4); expect(f.requests).toHaveLength(0);
      // Retiring the source also retires retention authority. Drained calls
      // cannot acquire a source-bearing failure hash after that boundary.
      expect(f.log.query()).toEqual([]);
    } finally { await f.close(); }
  });

  test('all 64 candidates are read with at most four active provider calls', async () => {
    const f = harness({ sources: paletteSources(rankState(64)), answer: () => noulAnswer(0.01), beforeAnswer: () => new Promise((resolve) => setTimeout(resolve, 1)) });
    try {
      const result = await f.execute(rankBody(64));
      expect(result).toMatchObject({ status: 'settled', value: { accepted: [], rejected: Array.from({ length: 64 }, (_, i) => i) } });
      expect(f.requests).toHaveLength(64); expect(f.peak()).toBe(4);
    } finally { await f.close(); }
  });

  test('the complete 27 builtins and eight chats use request indices with genuine sorted scores', async () => {
    const candidates = [...WEBUI_BUILTIN_COMMANDS.map(({ title, group, keywords }) => ({ title, group, keywords })), ...rankState(8).candidates];
    const request = body(PALETTE, { query: { kind: 'inline', text: 'start over' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
      candidates: [...WEBUI_BUILTIN_COMMANDS.map(({ id }) => ({ kind: 'builtin' as const, commandId: id })), ...rankBody(8).input.candidates] });
    const f = harness({ sources: paletteSources({ ...rankState(), candidates }), answer: (_name, _question, state) => {
      const title = (state as { candidate: { title: string } }).candidate.title;
      return noulAnswer(title === 'New Chat' ? 0.93 : title === 'Go to Chat' ? 0.8 : 0.03);
    } });
    try {
      const result = await f.execute(request) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'settled', value: { accepted: [
        { candidateIndex: 7, probability: 0.93 }, { candidateIndex: 27, probability: 0.93 }, { candidateIndex: 0, probability: 0.8 },
      ] } });
      expect(Object.keys(result.readings as object)).toHaveLength(35);
      expect(f.requests).toHaveLength(35); expect(f.peak()).toBeLessThanOrEqual(4);
      const recorded = JSON.stringify(f.log.query());
      for (const text of ['private-session-', 'chat.new', 'New Chat', 'start over', sourceBinding]) expect(recorded).not.toContain(text);
    } finally { await f.close(); }
  });

  test('one unsettled candidate holds the entire ranking with original confirm or escalate outcomes', async () => {
    for (const [probability, outcome] of [[0.57, 'confirm'], [0.5, 'escalate']] as const) {
      const f = harness({ sources: paletteSources(rankState()), answer: (_name, _question, state) => noulAnswer((state as { candidate: { title: string } }).candidate.title === 'New Chat' ? probability : 0.99) });
      try {
        const result = await f.execute(rankBody());
        expect(result).toMatchObject({ status: 'held', outcome, readings: { candidate_0: { probability, outcome }, candidate_1: { outcome: 'act' } } });
        expect(result).not.toHaveProperty('value'); expect(f.requests).toHaveLength(3);
      } finally { await f.close(); }
    }
  });
});

describe('adapter source ownership and full-input admission', () => {
  test('source refs require the right principal, purpose and current literal read grant', async () => {
    const f = harness();
    try {
      const ref = f.issue(ERRORS, source(), { mayRead: () => false });
      await expect(f.execute(body(ERRORS, { errorRef: ref }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      const wrongPurpose = f.issue(STATUS, source());
      await expect(f.execute(body(ERRORS, { errorRef: wrongPurpose }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      const nonBoolean = f.issue(ERRORS, source(), { mayRead: (async () => true) as unknown as () => boolean });
      await expect(f.execute(body(ERRORS, { errorRef: nonBoolean }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      f.principal({ ...owner, principalId: 'different' });
      await expect(f.execute(body(ERRORS, { errorRef: f.issue(ERRORS, source()) }))).rejects.toMatchObject({ code: 'JUDGMENT_AUTH_REQUIRED' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('source access alone does not grant route/retention permission, even with a thenable true grant', async () => {
    for (const authorize of [() => false, (async () => true) as unknown as () => boolean]) {
      const f = harness({ authorize });
      try {
        await expect(f.execute(body(ERRORS, { errorRef: f.issue(ERRORS, source()) }))).rejects.toMatchObject({ code: 'JUDGMENT_PERMISSION_HELD' });
        expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
      } finally { await f.close(); }
    }
  });

  test('full resolved palette is inspected before candidate bounds or first port/log use', async () => {
    const state = { ...rankState(65), candidates: [...rankState(64).candidates, { title: 'password=synthetic-secret' }] };
    const f = harness({ sources: paletteSources(state) });
    try {
      await expect(f.execute(rankBody(3))).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('palette source cannot substitute inline query, count or registry revision', async () => {
    for (const state of [{ ...rankState(), query: 'different private query' }, { ...rankState(), registryVersion: 'stale' }, rankState(2)]) {
      const f = harness({ sources: paletteSources(state) });
      try {
        await expect(f.execute(rankBody())).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
        expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
      } finally { await f.close(); }
    }
  });

  test('source revision and principal are rechecked after asynchronous provider work', async () => {
    for (const change of ['source', 'principal'] as const) {
      let valid = true;
      let release!: () => void;
      let enter!: () => void;
      const started = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const f = harness({ beforeAnswer: async () => { enter(); await gate; } });
      try {
        const ref = f.issue(ERRORS, source(), { assertCurrent: () => { if (!valid) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); } });
        const pending = f.execute(body(ERRORS, { errorRef: ref }));
        await started;
        if (change === 'source') valid = false; else f.principal({ ...owner, scopes: [] });
        release();
        await expect(pending).rejects.toMatchObject({ code: change === 'source' ? 'JUDGMENT_REFERENCE_HELD' : 'JUDGMENT_AUTH_REQUIRED' });
      } finally { release?.(); await f.close(); }
    }
  });

  test('palette cancellation stops new calls and discards all late candidate results', async () => {
    let entered = 0;
    let enter!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = harness({ sources: paletteSources(rankState(12)), beforeAnswer: async () => { if (++entered === 4) enter(); await gate; } });
    const abort = new AbortController();
    try {
      const pending = f.execute(rankBody(12), abort.signal);
      await started; abort.abort(); release();
      await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_ABORTED' });
      expect(entered).toBe(4);
    } finally { release?.(); await f.close(); }
  });

  test('palette source rechecks current read:sessions after asynchronous scoring', async () => {
    let entered = 0;
    let enter!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = harness({ sources: paletteSources(rankState()), beforeAnswer: async () => { if (++entered === 3) enter(); await gate; } });
    try {
      const pending = f.execute(rankBody());
      await started;
      f.principal({ ...owner, scopes: ['write:judgment'] });
      release();
      await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    } finally { release?.(); await f.close(); }
  });

  test('public command catalog includes the complete 27 builtin registrations and no callbacks', () => {
    expect(WEBUI_BUILTIN_COMMANDS).toHaveLength(27);
    expect(new Set(WEBUI_BUILTIN_COMMANDS.map((command) => command.id)).size).toBe(27);
    expect(WEBUI_BUILTIN_COMMANDS.find((command) => command.id === 'chat.new')).toMatchObject({ title: 'New Chat', group: 'chat', keywords: ['new', 'create', 'session'] });
    expect(WEBUI_BUILTIN_COMMANDS.every((command) => Object.keys(command).sort().join() === 'group,id,keywords,title')).toBe(true);
  });
});
