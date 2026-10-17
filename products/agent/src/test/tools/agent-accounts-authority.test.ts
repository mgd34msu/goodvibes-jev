import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { AgentAccountRegistry } from '@goodvibes-jev/engine/sdk/platform/google';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createAgentAccountsTool, registerAgentAccountsTool, type AgentAccountsToolOptions } from '../../tools/agent-accounts-tool.ts';
import { containsSecretLikeText } from '../../agent/memory-safety.ts';
import { getSessionExpectationBook, resetSessionExpectationBookForTests } from '../../agent/signup/session-expectations.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { createAgentAccountsInputProjector } from '../../tools/agent-accounts-admission.ts';

const VALID = { action: 'record', serviceDomain: 'example.com', serviceUrl: 'https://example.com/signup',
  aliasAddress: 'agent+example@owner.test', purpose: 'reading account docs', credentialSecretKey: 'GOODVIBES_ACCOUNT_EXAMPLE_COM' };
let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
let readings = 0, duringReading: ((name: string) => void) | undefined;
const roots: string[] = [];
beforeEach(() => {
  resetSessionExpectationBookForTests(); resetSessionUntrustedContentLedgerForTests(); readings = 0; duringReading = undefined;
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => {
    readings++; duringReading?.(name);
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' ? 'read' : 'generic', 0.999);
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected question ${name}`);
  });
  prior = installJudgmentPort(withDecisionLog(fake.port, log));
});
afterEach(() => {
  installJudgmentPort(prior); log[Symbol.dispose](); resetSessionExpectationBookForTests(); resetSessionUntrustedContentLedgerForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scene(knownSecretKeys?: () => Promise<readonly string[]>, nested = false) {
  const root = makeProjectTempDir('account-authority'); roots.push(root);
  const path = join(root, ...(nested ? ['new', 'directory'] : []), 'accounts.json');
  let beforeSafety: (() => void) | undefined;
  const store = new AgentAccountRegistry({ storePath: path, containsSecretLikeText(text) { beforeSafety?.(); return containsSecretLikeText(text); } });
  const options: AgentAccountsToolOptions = { registry: store, shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), baseAddress: () => 'owner@example.com', ...(knownSecretKeys ? { knownSecretKeys } : {}) };
  const tool = createAgentAccountsTool(options), fixture = recordedEffectFixture(tool, 'prompt', {}, root);
  fixture.registry.unregister('accounts'); registerAgentAccountsTool(fixture.registry, options);
  return { root, path, store, options, tool, fixture, beforeSafety(callback: () => void) { beforeSafety = callback; } };
}
function actions() { return [{ action: 'alias', serviceDomain: 'github.com' }, VALID, { action: 'forget', id: 'example-com' }, { action: 'sweep' }]; }

test('raw forged flags cannot open an expectation or mutate the account file', async () => {
  const current = scene();
  for (const args of actions()) expect(await current.tool.execute({ ...args, confirm: true, explicitUserRequest: 'Caller assertion' })).toMatchObject({ success: false });
  expect(existsSync(current.path)).toBe(false); expect(getSessionExpectationBook().list()).toHaveLength(0); expect(readings).toBe(0);
});

test('real recorded admission performs alias, record, forget and sweep without confirmation flags', async () => {
  const current = scene();
  expect(await current.fixture.run({ action: 'alias', serviceDomain: 'github.com' })).toMatchObject({ success: true });
  expect(getSessionExpectationBook().list()).toHaveLength(1);
  expect(await current.fixture.run(VALID)).toMatchObject({ success: true }); expect(current.store.list()).toHaveLength(1);
  expect(await current.fixture.run({ action: 'forget', id: 'example-com' })).toMatchObject({ success: true }); expect(current.store.list()).toHaveLength(0);
  expect(await current.fixture.run({ action: 'sweep' })).toMatchObject({ success: true }); expect(readings).toBe(0);
});

test('owned writes create missing parents without invalidating their own source fence', async () => {
  const current = scene(undefined, true);
  expect(await current.fixture.run(VALID)).toMatchObject({ success: true });
  expect(current.store.list()).toHaveLength(1);
});

test('synthetic read admission cannot bypass read-only and custom write-deny floors', async () => {
  for (const mode of ['plan', 'custom'] as const) {
    const current = scene();
    const fixture = recordedEffectFixture(current.tool, mode, mode === 'custom' ? { write: 'deny' } : {}, current.root);
    fixture.registry.unregister('accounts'); registerAgentAccountsTool(fixture.registry, current.options);
    for (const args of actions()) expect(await fixture.run(args)).toMatchObject({ success: false });
    expect(existsSync(current.path)).toBe(false); expect(getSessionExpectationBook().list()).toHaveLength(0);
  }
});

test.each(['cancel', 'revoke', 'replace-file', 'file-aba', 'parent-aba', 'new-owner'] as const)('sweep holds %s after the awaited key-store read', async change => {
  const abort = new AbortController();
  let mutate: () => void = () => {};
  const current = scene(async () => { await Promise.resolve(); mutate(); return []; });
  current.store.record(VALID);
  const original = readFileSync(current.path, 'utf8');
  mutate = () => {
    if (change === 'cancel') abort.abort();
    if (change === 'revoke') current.fixture.setMode('plan');
    if (change === 'replace-file') { renameSync(current.path, `${current.path}.old`); writeFileSync(current.path, original); }
    if (change === 'file-aba') { renameSync(current.path, `${current.path}.old`); renameSync(`${current.path}.old`, current.path); }
    if (change === 'parent-aba') { renameSync(current.root, `${current.root}.old`); renameSync(`${current.root}.old`, current.root); }
    if (change === 'new-owner') Object.defineProperty(current.options, 'registry', { value: new AgentAccountRegistry({ storePath: current.path, containsSecretLikeText }) });
  };
  const result = await current.fixture.run({ action: 'sweep' }, abort.signal);
  expect(result).toMatchObject({ success: false }); expect(readFileSync(current.path, 'utf8')).toBe(original);
});

test('replacement and restoration of a parent symlink is held before persistence', async () => {
  let mutate: () => void = () => {};
  const current = scene(async () => { mutate(); return []; });
  const target = join(current.root, 'target'), alias = join(current.root, 'alias'); mkdirSync(target); symlinkSync(target, alias);
  const store = new AgentAccountRegistry({ storePath: join(alias, 'accounts.json'), containsSecretLikeText }); store.record(VALID);
  const options = { registry: store, ...(current.options.knownSecretKeys ? { knownSecretKeys: current.options.knownSecretKeys } : {}) };
  const tool = createAgentAccountsTool(options), fixture = recordedEffectFixture(tool, 'prompt', {}, current.root);
  fixture.registry.unregister('accounts'); registerAgentAccountsTool(fixture.registry, options);
  mutate = () => { unlinkSync(alias); symlinkSync(target, alias); };
  expect(await fixture.run({ action: 'sweep' })).toMatchObject({ success: false }); expect(store.list()).toHaveLength(1);
});

test.each(['cancel', 'revoke', 'file-aba'] as const)('final backing registry guard catches %s inside the safety predicate', async change => {
  const current = scene(), abort = new AbortController();
  current.store.record(VALID); const original = readFileSync(current.path, 'utf8'); let armed = true;
  current.beforeSafety(() => {
    if (!armed) return; armed = false;
    if (change === 'cancel') abort.abort();
    if (change === 'revoke') current.fixture.setMode('plan');
    if (change === 'file-aba') { renameSync(current.path, `${current.path}.old`); renameSync(`${current.path}.old`, current.path); }
  });
  expect(await current.fixture.run({ action: 'forget', id: 'example-com' }, abort.signal)).toMatchObject({ success: false });
  expect(readFileSync(current.path, 'utf8')).toBe(original);
});

test('complete original and repaired inputs are screened before semantic repair', async () => {
  const current = scene();
  const hidden = Object.defineProperty({ action: 'record' }, 'secret', { value: 'password=private-value' });
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'action', { enumerable: true, get() { getterCalls++; return 'alias'; } });
  for (const args of [{ action: 'wrong', spare: { text: 'password=private-value' } }, hidden, accessor, new Proxy({ action: 'sweep' }, {})]) {
    await expect(current.fixture.registry.prepareCall('private-original', 'accounts', args)).rejects.toThrow();
  }
  expect(await current.tool.execute(accessor)).toMatchObject({ success: false });
  expect(getterCalls).toBe(0); expect(readings).toBe(0); expect(existsSync(current.path)).toBe(false);
});

test('record retains the complete taint source through its awaited semantic reading', async () => {
  const current = scene();
  getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'prior.example', at: new Date().toISOString(), content: 'A different subject that does not supply this account purpose.' });
  let armed = true;
  duringReading = name => { if (name !== 'derives' || !armed) return; armed = false;
    getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'new.example', at: new Date().toISOString(), content: 'reading account docs' });
  };
  expect(await current.fixture.run(VALID)).toMatchObject({ success: false });
  expect(armed).toBe(false); expect(existsSync(current.path)).toBe(false);
});

test('a mutable key-store result remains fixed through the final permission callback', async () => {
  const keys = ['GOODVIBES_ACCOUNT_EXAMPLE_COM']; let arm: () => void = () => {};
  const current = scene(async () => { arm(); return keys; });
  current.store.record(VALID); const original = readFileSync(current.path, 'utf8');
  // Arm after capture, so the first source check sees the actual original keys.
  let reads = 0;
  arm = () => current.fixture.beforeAuthorityRead(() => { if (++reads === 2) keys.splice(0); });
  expect(await current.fixture.run({ action: 'sweep' })).toMatchObject({ success: false });
  expect(readFileSync(current.path, 'utf8')).toBe(original);
});

test('registered list refuses a changed file from inside the backing safety predicate', async () => {
  const current = scene(); current.store.record(VALID); let armed = true;
  current.beforeSafety(() => { if (!armed) return; armed = false; renameSync(current.path, `${current.path}.old`); renameSync(`${current.path}.old`, current.path); });
  expect(await current.fixture.run({ action: 'list' })).toMatchObject({ success: false });
});

test('the runtime workspace remains bound when the account store is outside that workspace', async () => {
  const current = scene(); const workspace = join(current.root, 'work'); mkdirSync(workspace);
  const options = { registry: current.store, shellPaths: createShellPathService({ workingDirectory: workspace, homeDirectory: current.root }),
    knownSecretKeys: async () => { renameSync(workspace, `${workspace}.old`); renameSync(`${workspace}.old`, workspace); return []; } };
  current.store.record(VALID); const original = readFileSync(current.path, 'utf8');
  const tool = createAgentAccountsTool(options), fixture = recordedEffectFixture(tool, 'prompt', {}, workspace);
  fixture.registry.unregister('accounts'); registerAgentAccountsTool(fixture.registry, options);
  expect(await fixture.run({ action: 'sweep' })).toMatchObject({ success: false });
  expect(readFileSync(current.path, 'utf8')).toBe(original);
});

test('repaired input is screened and a standalone projection context cannot mint effect authority', async () => {
  const current = scene();
  const projection = await createAgentAccountsInputProjector(current.options).project({ callId: 'standalone', name: 'accounts', args: VALID, assertCurrent() {} });
  if (projection.status !== 'projected') throw new Error('Unexpected held ordinary fixture');
  try {
    expect(() => projection.assertRepairedArgs?.({ ...VALID, spare: 'password=private-value' })).toThrow();
    expect(await current.tool.execute(VALID, { inputProjectionContext: projection.executionContext })).toMatchObject({ success: false });
    expect(existsSync(current.path)).toBe(false); expect(readings).toBe(0);
  } finally { await projection.release?.(); }
});

test.each(['cancel', 'revoke'] as const)('the final rename is held for late %s and cleans its private temporary file', async change => {
  const current = scene(), abort = new AbortController(); current.store.record(VALID);
  const original = readFileSync(current.path, 'utf8'); let observedTemporary = false;
  current.beforeSafety(() => current.fixture.beforeAuthorityRead(() => {
    if (!readdirSync(current.root).some(name => name.endsWith('.tmp'))) return;
    observedTemporary = true;
    if (change === 'cancel') abort.abort(); else current.fixture.setMode('plan');
  }));
  expect(await current.fixture.run({ action: 'forget', id: 'example-com' }, abort.signal)).toMatchObject({ success: false });
  expect(observedTemporary).toBe(true); expect(readFileSync(current.path, 'utf8')).toBe(original);
  expect(readdirSync(current.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('a replaced expectation mutation method is refused without invoking it', async () => {
  const current = scene(), book = getSessionExpectationBook(); let invoked = 0, armed = true;
  current.fixture.beforeAuthorityRead(() => { if (!armed) return; armed = false;
    book.sweepExpired = () => { invoked++; return []; };
  });
  await expect(current.fixture.run({ action: 'alias', serviceDomain: 'github.com' })).rejects.toThrow();
  expect(armed).toBe(false); expect(invoked).toBe(0); expect(book.list()).toHaveLength(0);
});
