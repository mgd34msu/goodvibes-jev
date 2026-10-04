/** Owned persisted fixtures prove source admission, cancellation and recovery through the real owner. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../sdk/src/platform/workspace/registration/store.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { createNativeConversationIntakeHost } from '../sdk/src/platform/workflow/work-ledger/native-intake.js';
import type { NativeRequirementProposer } from '../sdk/src/platform/workflow/work-ledger/native-intake-proposer.js';
import type { NativeConversationIntakeResult } from '../sdk/src/platform/workflow/work-ledger/native-intake-wire.js';
import type { NativeConversationStorage } from '../sdk/src/platform/workflow/work-ledger/native-intake-types.js';
import { makeRepo } from './contract/runner-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function fixture(options: { route?: 'contract' | 'converse' | 'answer'; final?: string; proposer?: NativeRequirementProposer; decorate?: (port: JudgmentPort) => JudgmentPort;
  decorateStorage?: (storage: NativeConversationStorage) => NativeConversationStorage } = {}) {
  const root = makeRepo(); mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json')); const token = tokens.mint({ name: 'Synthetic owned intake device' });
  const catalog = new GatewayMethodCatalog();
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: catalog,
    controlPlaneGateway: { touchWebSocketClient() {} } } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(token.token)!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'workspaces.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') });
  await scopes.add(root);
  const store = new KnowledgeStore({ dbPath: join(root, '.goodvibes', 'knowledge.sqlite') });
  const storage = await store.openNativeConversationStorage('project');
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const fake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, options.route ?? 'contract', 0.99);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.99);
    if (name.startsWith('part_')) return noulAnswer(0.01);
    if (name === 'refuse') return noulAnswer(0.99);
    return choiceAnswer(question, options.final ?? 'act', 0.99);
  });
  const recorded = withDecisionLog(fake.port, log); const port = options.decorate?.(recorded) ?? recorded;
  let proposals = 0;
  const proposer: NativeRequirementProposer = options.proposer ?? { async propose(input) { proposals++; return { sourceRevision: input.sourceRevision,
    spans: [{ partId: 'input', start: 0, end: input.text.length }] }; } };
  const deps = { projectId: 'project', projectRoot: root, sessionId: 'native-work:project', storage: options.decorateStorage?.(storage) ?? storage, scopes, port, decisionLog: log, proposer };
  const host = createNativeConversationIntakeHost(deps);
  const principalId = authority.current()!.principalId;
  cleanups.push(async () => { await host.close(); await store.close(); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });
  const original = { requestId: 'request-1', inputId: 'input-1', text: '  Add JSON export.\r\nKeep CSV unchanged. 🌻  ', unsupportedSources: [] };
  async function capture() { return host.capture(original, authority); }
  const target = (value: Exclude<NativeConversationIntakeResult, { kind: 'not-found' }>) => ({ inputId: value.sourceRef.inputId, sourceRevision: value.sourceRef.sourceRevision });
  return { root, token, tokens, helper, authority, scopes, store, storage, log, fake, deps, host, principalId, original, capture, target, proposals: () => proposals };
}

test('capture is byte-preserving, model-free and atomic admission creates exactly one work and claim', async () => {
  const f = await fixture(); const captured = await f.capture(); expect(captured.kind).toBe('captured');
  expect(f.fake.requests).toHaveLength(0); expect(f.proposals()).toBe(0);
  expect(f.storage.current({ principalId: f.principalId, inputId: f.original.inputId })?.text).toBe(f.original.text);
  const admitted = await f.host.admit(f.target(captured), f.authority);
  expect(admitted.kind).toBe('work'); if (admitted.kind !== 'work') throw new Error('Expected source-bearing work');
  expect(admitted.receipt.goal).toBe(f.original.text); expect(admitted.receipt.criteria).toEqual([f.original.text]);
  expect(admitted.receipt.source.version).toBe(2); expect(admitted.receipt.source.spans).toEqual([{ partId: 'input', start: 0, end: f.original.text.length }]);
  expect(admitted.receipt.ledgerRevision).toBe(1); expect(admitted.receipt.expectedRevision).toEqual({ work: 1, criteria: 1, attempt: 1 });
  for (const id of admitted.receipt.source.judgmentDecisionIds) expect(f.log.get(id)?.status).toBe('answered');
  const count = f.fake.requests.length;
  expect(await f.host.admit(f.target(captured), f.authority)).toEqual(admitted);
  expect(await f.host.resume(f.target(captured), f.authority)).toEqual(admitted);
  expect(await f.capture()).toEqual(admitted); expect(await f.host.cancel(f.target(captured), f.authority)).toEqual(admitted);
  expect(f.fake.requests).toHaveLength(count); expect(f.proposals()).toBe(1);
  const ledger = await (await f.store.openWorkLedgerStorage('project')).read();
  expect(ledger).toMatchObject({ revision: 1, works: [{ goal: f.original.text }], attempts: [{ state: 'active' }], history: [{ type: 'submit_native' }] });
});

test('fresh intentional identical input gets new authority identity; retries never invent one', async () => {
  const f = await fixture(); const first = await f.capture(); const result = await f.host.admit(f.target(first), f.authority);
  const second = await f.host.capture({ ...f.original, inputId: 'input-2', requestId: 'request-2' }, f.authority);
  expect(second.sourceRef.sourceId).not.toBe(first.sourceRef.sourceId);
  const next = await f.host.admit(f.target(second), f.authority);
  if (next.kind !== 'work' || result.kind !== 'work') throw new Error('Expected two deliberate requests');
  expect(next.receipt.workId).not.toBe(result.receipt.workId); expect(next.receipt.ledgerRevision).toBe(2);
  await expect(f.host.capture({ ...f.original, text: f.original.text + 'Changed' }, f.authority)).rejects.toMatchObject({ code: 'request-conflict' });
  await expect(f.host.admit({ ...f.target(first), sourceRevision: 'old' }, f.authority)).rejects.toMatchObject({ code: 'stale' });
});

test.each(['converse', 'answer'] as const)('settled %s still needs a recorded act, creates no work and never invokes proposer', async route => {
  const f = await fixture({ route }); const captured = await f.capture(); const result = await f.host.admit(f.target(captured), f.authority);
  expect(result).toMatchObject({ kind: 'turn', route, text: f.original.text }); expect(f.proposals()).toBe(0);
  expect(f.fake.requests).toHaveLength(2); expect(await (await f.store.openWorkLedgerStorage('project')).read()).toMatchObject({ revision: 0 });
});

test('unsupported original source selects registered source resolution and never falls back or fabricates roots', async () => {
  const f = await fixture({ route: 'converse', final: 'revise_0' });
  const captured = await f.host.capture({ ...f.original, unsupportedSources: [{ kind: 'image', label: 'Original referenced screenshot' }] }, f.authority);
  const result = await f.host.admit(f.target(captured), f.authority);
  expect(result).toMatchObject({ kind: 'blocked', reason: 'unsupported-source', recovery: 'required' });
  expect(f.proposals()).toBe(0); expect(f.fake.requests.every(request => JSON.stringify(request.state).includes('Original referenced screenshot'))).toBe(true);
  const reads = f.fake.requests.length;
  expect(await f.host.resume(f.target(captured), f.authority)).toEqual(result); expect(f.fake.requests).toHaveLength(reads);
  expect(await (await f.store.openWorkLedgerStorage('project')).read()).toMatchObject({ revision: 0 });
});

test('semantic refusal cannot be rerolled by repeated resume of unchanged source', async () => {
  const f = await fixture({ final: 'reject' }); const captured = await f.capture(); const result = await f.host.admit(f.target(captured), f.authority);
  expect(result).toMatchObject({ kind: 'refused', reason: 'semantic' }); const reads = f.fake.requests.length;
  expect(await f.host.resume(f.target(captured), f.authority)).toEqual(result); expect(f.fake.requests).toHaveLength(reads);
  expect(await f.host.cancel(f.target(captured), f.authority)).toMatchObject({ kind: 'cancelled' });
});

test.each(['before', 'after'] as const)('recorded refusal survives %s capture publication acknowledgement and cannot be rerolled', async phase => {
  let fail = true;
  const options = { final: 'reject', decorateStorage(storage: NativeConversationStorage): NativeConversationStorage {
    return { ...storage, async transaction(key, decide) {
      let terminal = false;
      const result = await storage.transaction(key, current => {
        const mutation = decide(current); terminal = mutation.next?.state === 'refused';
        if (terminal && fail && phase === 'before') { fail = false; throw new Error('Owned pre-publication source failure'); }
        return mutation;
      });
      if (terminal && fail && phase === 'after') { fail = false; throw new Error('Owned lost capture acknowledgement'); }
      return result;
    } };
  } };
  const f = await fixture(options); const captured = await f.capture(); const target = f.target(captured);
  await expect(f.host.admit(target, f.authority)).rejects.toThrow();
  const retained = f.storage.current({ principalId: f.principalId, inputId: target.inputId })!;
  expect(retained.state).toBe(phase === 'before' ? 'processing' : 'refused');
  if (phase === 'before') expect(retained.stage).toBe('deciding');
  const reads = f.fake.requests.length; await f.host.close(); options.final = 'act';
  const replacement = createNativeConversationIntakeHost(f.deps);
  try {
    expect(await replacement.resume(target, f.authority)).toMatchObject({ kind: 'refused', reason: 'semantic' });
    expect(f.fake.requests).toHaveLength(reads); expect(f.proposals()).toBe(1);
    expect(await (await f.store.openWorkLedgerStorage('project')).read()).toMatchObject({ revision: 0 });
  } finally { await replacement.close(); }
});

test('identical-span repair has a distinct final attempt and restores its later refusal after capture failure', async () => {
  let disposition = 0, fail = true;
  const f = await fixture({ get final() { return ++disposition === 1 ? 'revise_1' : 'reject'; },
    decorateStorage(storage) { return { ...storage, transaction(key, decide) {
      return storage.transaction(key, current => { const mutation = decide(current);
        if (mutation.next?.state === 'refused' && fail) { fail = false; throw new Error('Owned final capture failure'); }
        return mutation;
      });
    } }; } });
  const captured = await f.capture(); const target = f.target(captured);
  await expect(f.host.admit(target, f.authority)).rejects.toThrow('Owned final capture');
  const retained = f.storage.current({ principalId: f.principalId, inputId: target.inputId })!;
  expect(retained.proposalsSpent).toBe(2); expect(retained.decisions).toHaveLength(1);
  expect(retained.decisions[0]?.decision.outcome).toBe('revise'); const reads = f.fake.requests.length;
  await f.host.close(); const replacement = createNativeConversationIntakeHost(f.deps);
  try {
    expect(await replacement.resume(target, f.authority)).toMatchObject({ kind: 'refused' });
    expect(f.fake.requests).toHaveLength(reads); expect(f.proposals()).toBe(2);
  } finally { await replacement.close(); }
});

test('an answered final reading with incomplete decision notes refuses re-evaluation after restart', async () => {
  const f = await fixture({ decorate(port) { return { ...port, recorder: { ...port.recorder!, recordReadings(id, readings) {
    if (readings !== null && typeof readings === 'object' && !Array.isArray(readings) && Object.hasOwn(readings, 'autonomousDecision')) throw new Error('Owned interrupted final decision notes');
    port.recorder!.recordReadings(id, readings);
  } } }; } });
  const captured = await f.capture(); const target = f.target(captured);
  await expect(f.host.admit(target, f.authority)).rejects.toThrow('Owned interrupted final');
  const reads = f.fake.requests.length; await f.host.close();
  const replacement = createNativeConversationIntakeHost(f.deps);
  try {
    await expect(replacement.resume(target, f.authority)).rejects.toMatchObject({ code: 'recovery-required' });
    expect(f.fake.requests).toHaveLength(reads);
    expect(await replacement.cancel(target, f.authority)).toMatchObject({ kind: 'cancelled' });
  } finally { await replacement.close(); }
});

test('cancellation persists before abort and joins the actual proposer cleanup', async () => {
  const entered = deferred(), cleanup = deferred(), aborted = deferred();
  const f = await fixture({ proposer: { async propose(input) {
    entered.resolve(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
    await cleanup.promise; input.signal.throwIfAborted(); return {};
  } } });
  const capture = await f.capture(); const target = f.target(capture);
  const start = f.host.admit(target, f.authority); void start.catch(() => {}); await entered.promise;
  let ended = false; const cancel = f.host.cancel(target, f.authority).finally(() => { ended = true; });
  await aborted.promise; expect(f.storage.current({ principalId: f.principalId, inputId: target.inputId })?.state).toBe('cancelled'); expect(ended).toBe(false);
  cleanup.resolve(); expect(await cancel).toMatchObject({ kind: 'cancelled' }); await expect(start).rejects.toThrow();
  expect(await f.host.resume(target, f.authority)).toMatchObject({ kind: 'cancelled' });
  expect(await (await f.store.openWorkLedgerStorage('project')).read()).toMatchObject({ revision: 0 });
});

test('replacement owner cancellation fences an abort-ignoring late proposal before any claim', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ proposer: { async propose(input) { entered.resolve(); await release.promise; return { sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.text.length }] }; } } });
  const captured = await f.capture(); const target = f.target(captured); const old = f.host.admit(target, f.authority); void old.catch(() => {}); await entered.promise;
  const replacement = createNativeConversationIntakeHost(f.deps);
  try {
    expect(await replacement.get({ inputId: target.inputId }, f.authority)).toMatchObject({ kind: 'processing', recovery: 'required' });
    expect(await replacement.admit(target, f.authority)).toMatchObject({ kind: 'processing', recovery: 'required' });
    expect(await replacement.cancel(target, f.authority)).toMatchObject({ kind: 'cancelled' });
    release.resolve(); await expect(old).rejects.toThrow();
    expect(await (await f.store.openWorkLedgerStorage('project')).read()).toMatchObject({ revision: 0 });
  } finally { release.resolve(); await replacement.close(); }
});

test('revocation while proposal is pending prevents publication and refuses protected lookup', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ proposer: { async propose(input) { entered.resolve(); await release.promise; return { sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.text.length }] }; } } });
  const captured = await f.capture(); const start = f.host.admit(f.target(captured), f.authority); void start.catch(() => {}); await entered.promise;
  f.tokens.revoke(f.token.id); release.resolve(); await expect(start).rejects.toThrow();
  await expect(f.host.get({ inputId: f.original.inputId }, f.authority)).rejects.toThrow();
  expect(await (await f.store.openWorkLedgerStorage('project')).read()).toMatchObject({ revision: 0 });
});

test('transport cancellation requires explicit resume and preserves logical input across owner replacement', async () => {
  const entered = deferred(); let calls = 0;
  const f = await fixture({ proposer: { async propose(input) {
    if (++calls === 1) { entered.resolve(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true })); input.signal.throwIfAborted(); }
    return { sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.text.length }] };
  } } });
  const captured = await f.capture(); const target = f.target(captured); const controller = new AbortController();
  const interrupted = f.host.admit(target, f.authority, { signal: controller.signal }); void interrupted.catch(() => {}); await entered.promise; controller.abort();
  await expect(interrupted).rejects.toThrow(); await f.host.close();
  const replacement = createNativeConversationIntakeHost(f.deps);
  try {
    const count = f.fake.requests.length;
    expect(await replacement.admit(target, f.authority)).toMatchObject({ kind: 'processing', recovery: 'required' }); expect(f.fake.requests).toHaveLength(count);
    const resumed = await replacement.resume(target, f.authority); expect(resumed.kind).toBe('work');
    expect(calls).toBe(2); expect(await replacement.get({ inputId: target.inputId }, f.authority)).toEqual(resumed);
  } finally { await replacement.close(); }
});

test('fresh paired principal cannot inspect or cancel another principal source', async () => {
  const f = await fixture(); const captured = await f.capture(); const other = f.tokens.mint({ name: 'Other synthetic owner' });
  const authority = f.helper.createNativeExecutionAuthority(other.token)!;
  expect(await f.host.get({ inputId: f.original.inputId }, authority)).toEqual({ kind: 'not-found' });
  await expect(f.host.cancel(f.target(captured), authority)).rejects.toMatchObject({ code: 'not-found' });
  expect(await f.host.get({ inputId: f.original.inputId }, f.authority)).toEqual(captured);
});

test('unrelated ledger revision cannot duplicate admission; simultaneous identical delivery joins one proposer', async () => {
  const entered = deferred(), release = deferred(); let count = 0;
  const f = await fixture({ proposer: { async propose(input) { count++; entered.resolve(); await release.promise;
    return { sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.text.length }] }; } } });
  const captured = await f.capture(); const target = f.target(captured);
  const a = f.host.admit(target, f.authority); await entered.promise; const b = f.host.admit(target, f.authority); release.resolve();
  expect(await a).toEqual(await b); expect(count).toBe(1);
  expect(await (await f.store.openWorkLedgerStorage('project')).read()).toMatchObject({ revision: 1 });
});

test('scope remove and re-add fences captured history without minting replacement authority', async () => {
  const f = await fixture(); const captured = await f.capture(); await f.scopes.remove(f.root); await f.scopes.add(f.root);
  await expect(f.host.admit(f.target(captured), f.authority)).rejects.toMatchObject({ code: 'stale' });
  expect(f.fake.requests).toHaveLength(0); expect(f.proposals()).toBe(0);
});
