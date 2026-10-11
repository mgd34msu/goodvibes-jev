import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createJudgmentSourceLifetime } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
/** Real agent command action -> setup runner -> browser flow, all I/O synthetic. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, judgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { runGoogleSetup } from '../../input/commands/google-connection-actions.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { GOOGLE_SECRET_KEYS, type GoogleBrowserPort, type GoogleProgressPort } from '@goodvibes-jev/engine/sdk/platform/google';

let previous: ReturnType<typeof installJudgmentPort>;
const disposals: (() => void)[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); installJudgmentPort(previous); });
const progress: GoogleProgressPort = { stepStarted() {}, stepFinished() {}, humanActionNeeded() {}, note() {} };
function fixture() {
  const writes: string[] = [], clicks: string[] = [], typed: string[] = [];
  const runtime = { sessionId: 'request-session' };
  const root = makeProjectTempDir('google-semantic-command');
  mkdirSync(join(root, 'project'), { recursive: true });
  const config = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json') });
  const secrets = new SecretsManager({ projectRoot: join(root, 'project'), globalHome: join(root, 'home'), daemonHome: join(root, 'daemon'), surfaceRoot: 'synthetic-google', configManager: config });
  disposals.push(config.onDidChangeIncarnation(() => { writes.push('config'); }));
  disposals.push(secrets.onDidInvalidateCredentials(() => { writes.push('secret'); }));
  const lifetime = createJudgmentSourceLifetime({ config, secrets, env: {} });
  disposals.push(lifetime.dispose); bindJudgmentPortAuthority(judgmentPort('test.google'), lifetime.capture);
  const context = {
    workspace: { shellPaths: { homeDirectory: root } }, session: { runtime },
    platform: { configManager: config, secretsManager: secrets },
  } as unknown as CommandContext;
  let url = '', created = false;
  let onResult: (() => void) | undefined;
  const browser: GoogleBrowserPort = {
    navigate: async target => { url = target; return { url, title: 'Synthetic Google' }; }, currentUrl: async () => url,
    snapshot: async () => [
      { ref: 'unrelated', role: 'button', name: 'Create project', tag: 'button' },
      { ref: 'name', role: 'textbox', name: 'App password name', tag: 'input' },
      { ref: 'create', role: 'button', name: 'Créer', tag: 'button' },
    ],
    readText: async () => { if (created) { onResult?.(); return 'abcd efgh ijkl mnop'; } return '2-Step Verification is on'; },
    type: async ref => { typed.push(ref); }, click: async ref => { clicks.push(ref); created = true; },
  };
  return { context, runtime, writes, clicks, typed, secrets, config, root, browser, resultHook: (fn: () => void) => { onResult = fn; } };
}
function readings() {
  return fakePort((name, question, state) => {
    if (name === 'signIn') return noulAnswer(0.01);
    const input = state as unknown as { context: { purpose: string }; candidates: { id: string; content: { name: string } }[] };
    const label = input.context.purpose === 'Name the new Google app password' ? 'App password name' : 'Créer';
    const index = input.candidates.findIndex(e => e.content.name === label);
    return name === 'pick' ? choiceAnswer(question, index < 0 ? 'none' : `control_${index}`, 0.99)
      : noulAnswer(name === `fits_${index}` ? 0.99 : 0.01);
  });
}
test('the real command composition selects localized create instead of the first overlapping control and stores only through the secret port', async () => {
  installJudgmentPort(readings().port); const rig = fixture();
  rig.config.setDynamic('email.username', 'synthetic@example.test');
  const report = await runGoogleSetup('app-password', rig.context, progress, undefined, { browser: async () => rig.browser });
  expect(report.steps.find(step => step.id === 'app-password')?.outcome).toBe('done');
  expect(report.steps.find(step => step.id === 'gmail-config')?.outcome).toBe('done');
  expect(rig.config.get('email.enabled')).toBe(true);
  expect(rig.clicks).toEqual(['create']); expect(rig.typed).toEqual(['name']);
  expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.appPassword)).toBe('abcdefghijklmnop');
  expect(JSON.stringify(report)).not.toContain('abcdefghijklmnop');
});
for (const mode of ['session', 'port', 'cancel'] as const) test(`the actual command rejects ${mode} retirement after creation but before credential storage`, async () => {
  installJudgmentPort(readings().port); const rig = fixture(), abort = new AbortController();
  rig.resultHook(() => {
    if (mode === 'session') rig.runtime.sessionId = 'replacement-session';
    if (mode === 'port') installJudgmentPort(readings().port);
    if (mode === 'cancel') abort.abort();
  });
  const report = await runGoogleSetup('app-password', rig.context, progress, undefined, { browser: async () => rig.browser, signal: abort.signal });
  expect(report.steps.find(step => step.id === 'app-password')?.outcome).toBe('failed');
  expect(rig.writes).toEqual([]); expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.appPassword)).toBeNull();
});
test('held sign-in reading is cancelled in the actual command with no late click or write', async () => {
  const base = readings().port; let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  installJudgmentPort({ model: base.model, ask: async request => { began(); await gate; return base.ask(request); } });
  const rig = fixture(), abort = new AbortController();
  const pending = runGoogleSetup('app-password', rig.context, progress, undefined, { browser: async () => rig.browser, signal: abort.signal });
  await started; abort.abort(); release(); const report = await pending; await Promise.resolve();
  expect(report.steps.find(step => step.id === 'google-signed-in')?.outcome).toBe('failed');
  expect(rig.writes).toEqual([]); expect(rig.clicks).toEqual([]); expect(rig.typed).toEqual([]);
});

for (const mode of ['cancel', 'config', 'credential', 'installation'] as const) test(`a real lock-delayed ${mode} change blocks the consumed setup credential write`, async () => {
  installJudgmentPort(readings().port); const rig = fixture(), abort = new AbortController();
  await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, 'synthetic-seed');
  const path = (await rig.secrets.listDetailed()).find(row => row.key === GOOGLE_SECRET_KEYS.oauthClientSecret)!.path!;
  const release = await acquireCrossProcessLock(`${path}.mutation.lock`, { strictOwnership: true });
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const unsubscribe = rig.secrets.onDidInvalidateCredentials(() => { if (rig.secrets.getCredentialMutationState().pending) reached(); });
  const pending = runGoogleSetup('app-password', rig.context, progress, undefined, { browser: async () => rig.browser, signal: abort.signal });
  let competing: Promise<void> | undefined;
  try {
    await started;
    if (mode === 'cancel') abort.abort();
    if (mode === 'config') rig.config.setDynamic('judgment.timeoutMs', 9999);
    if (mode === 'credential') competing = rig.secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, 'synthetic-new');
    if (mode === 'installation') installJudgmentPort(readings().port);
  } finally { unsubscribe(); release(); }
  const report = await pending; await competing;
  expect(report.steps.find(step => step.id === 'app-password')?.outcome).toBe('failed');
  expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.appPassword)).toBeNull();
  if (mode === 'credential') expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret)).toBe('synthetic-new');
  expect(rig.secrets.getCredentialMutationState().pending).toBe(false);
});

test('a committed credential followed by owner retirement is truthfully reported and never rolled back', async () => {
  installJudgmentPort(readings().port); const rig = fixture(); let intended = false;
  const unsubscribe = rig.secrets.onDidInvalidateCredentials(() => {
    if (rig.secrets.getCredentialMutationState().pending) intended = true;
    else if (intended) installJudgmentPort(readings().port);
  });
  const report = await runGoogleSetup('app-password', rig.context, progress, undefined, { browser: async () => rig.browser });
  unsubscribe();
  const step = report.steps.find(step => step.id === 'app-password');
  expect(step?.outcome).toBe('failed');
  expect(JSON.stringify(step)).toContain('committed');
  expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.appPassword)).toBe('abcdefghijklmnop');
  expect(report.steps.find(step => step.id === 'gmail-config')?.outcome).not.toBe('done');
});
