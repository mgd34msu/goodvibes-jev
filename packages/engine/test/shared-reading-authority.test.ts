import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindJudgmentPortAuthority, captureJudgmentPort, installJudgmentPort, readFailure } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { SecretsManager } from '../sdk/src/platform/config/secrets.ts';
import { ModelFamilyReadings } from '../sdk/src/platform/providers/model-family.ts';
import { createJudgmentSourceLifetime } from '../sdk/src/platform/runtime/judgment-source-lifetime.ts';
import { createAsyncDisposalScope } from '../sdk/src/platform/runtime/disposal.ts';
import { composeJudgment } from '../sdk/src/platform/runtime/judgment-services.ts';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.ts';

const model = (id = 'cached') => ({ registryKey: `synthetic:${id}`, id, displayName: id, provider: 'synthetic' });
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred() { return Promise.withResolvers<void>(); }
async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Owned reader did not stop')), 500);
  })]); } finally { clearTimeout(timer); }
}
let previous: ReturnType<typeof installJudgmentPort>;
const cleanup: Array<() => void> = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); installJudgmentPort(previous); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shared-reading-owner-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: join(root, 'project'), surfaceRoot: 'synthetic' });
  config.set('judgment.endpoint', 'https://synthetic.example.test');
  config.set('storage.secretPolicy', 'plaintext_allowed');
  const secrets = new SecretsManager({ projectRoot: join(root, 'project'), globalHome: join(root, 'home'), surfaceRoot: 'synthetic', configManager: config });
  const lifetime = createJudgmentSourceLifetime({ config, secrets, env: {} });
  const log = new SqliteDecisionLog(':memory:'); cleanup.push(() => log[Symbol.dispose]()); cleanup.push(lifetime.dispose);
  const entered = deferred(); const release = deferred();
  let held = false; let family = 'Llama'; let category = 'billing';
  const fake = fakePort((name, question) => {
    if (name === 'family') return choiceAnswer(question, family, 0.99);
    if (name === 'category') return choiceAnswer(question, category, 0.99);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.99);
    return noulAnswer(0.01);
  });
  let started = 0;
  const inner: JudgmentPort = { ...fake.port, async ask(request) {
    started++;
    if (held) { entered.resolve(); await release.promise; }
    return fake.port.ask(request);
  } };
  const port = withDecisionLog(inner, log);
  bindJudgmentPortAuthority(port, lifetime.capture); installJudgmentPort(port);
  return { root, config, secrets, log, port, entered, release, lifetime,
    hold() { held = true; }, resume() { held = false; release.resolve(); },
    changeAnswer() { family = 'Claude'; category = 'network'; }, started: () => started };
}

const changes: readonly { name: string; mutate: (config: ConfigManager) => void }[] = [
  { name: 'endpoint ABA', mutate: config => { config.set('judgment.endpoint', 'https://other.example.test'); config.set('judgment.endpoint', 'https://synthetic.example.test'); } },
  { name: 'model ABA', mutate: config => { config.set('judgment.model', 'synthetic-model'); config.set('judgment.model', ''); } },
  { name: 'key source ABA', mutate: config => { config.set('judgment.keySource', 'secret'); config.set('judgment.keySource', 'env'); } },
  { name: 'timeout ABA', mutate: config => { config.set('judgment.timeoutMs', 11000); config.set('judgment.timeoutMs', 10000); } },
  { name: 'no-op setting', mutate: config => { config.set('judgment.endpoint', 'https://synthetic.example.test'); } },
  { name: 'failed mutation', mutate: config => { expect(() => config.set('judgment.timeoutMs', 0)).toThrow(); } },
  { name: 'global save', mutate: config => { config.save(); } },
  { name: 'project save', mutate: config => { config.saveProject(); } },
];

describe('same-port source incarnation', () => {
  for (const change of changes) test(`${change.name} retires cache, pending requests and decision retention`, async () => {
    const f = fixture(); const readings = new ModelFamilyReadings();
    await readings.read([model()]); expect(readings.known(model())).toBe('Llama');
    const oldIdentity = captureJudgmentPort('fixture').identity;
    f.hold(); const pending = readings.read([model('pending')]).then(() => null, error => error);
    await f.entered.promise;
    try {
      change.mutate(f.config);
      expect(await promptly(pending)).toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
      expect(readings.known(model())).toBeUndefined();
      expect(captureJudgmentPort('fixture').identity).not.toBe(oldIdentity);
      expect(f.log.query()).toHaveLength(1);
      f.changeAnswer(); f.resume(); await turn();
      expect(f.log.query()).toHaveLength(1);
      await readings.read([model()]); expect(readings.known(model())).toBe('Claude');
      expect(f.log.query()).toHaveLength(2);
      expect(f.started()).toBe(3);
    } finally { f.resume(); await pending; await turn(); }
  });

  test('a pending credential replacement and alias ABA retire the same stable port', async () => {
    const f = fixture(); const plain = { scope: 'user', medium: 'plaintext' } as const;
    await f.secrets.set('TYPESAFE_API_KEY', 'goodvibes://secrets/goodvibes/SYNTHETIC_LEAF', plain);
    await f.secrets.set('SYNTHETIC_LEAF', 'synthetic-one', plain);
    const readings = new ModelFamilyReadings(); await readings.read([model()]);
    const path = (await f.secrets.listDetailed()).find(row => row.key === 'SYNTHETIC_LEAF')!.path!;
    const unlock = await acquireCrossProcessLock(`${path}.mutation.lock`, { strictOwnership: true });
    f.hold(); const pending = readings.read([model('pending')]).then(() => null, error => error); await f.entered.promise;
    const write = f.secrets.set('SYNTHETIC_LEAF', 'synthetic-two', plain);
    try {
      expect(f.secrets.getCredentialMutationState().pending).toBe(true);
      expect(await promptly(pending)).toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
      expect(() => captureJudgmentPort('fixture')).toThrow('no longer current');
      expect(readings.known(model())).toBeUndefined();
    } finally { unlock(); await write; f.resume(); await pending; await turn(); }
    await f.secrets.set('SYNTHETIC_LEAF', 'synthetic-one', plain);
    f.changeAnswer(); await readings.read([model()]); expect(readings.known(model())).toBe('Claude');
    const recorded = JSON.stringify(f.log.query());
    for (const marker of ['SYNTHETIC_LEAF', 'TYPESAFE_API_KEY', 'synthetic-one', 'synthetic-two']) expect(recorded).not.toContain(marker);
    expect(Object.keys(captureJudgmentPort('fixture').identity)).toEqual([]);
  });

  test('shared failure memo cannot cross config ABA, port replacement or removal', async () => {
    const f = fixture(); const evidence = { message: 'Synthetic account condition' };
    expect((await readFailure(evidence, 'fixture')).category).toBe('billing');
    f.changeAnswer(); changes[0]!.mutate(f.config);
    expect((await readFailure(evidence, 'fixture')).category).toBe('network');
    const first = f.port; installJudgmentPort(undefined);
    await expect(readFailure(evidence, 'fixture')).rejects.toMatchObject({ name: 'JudgmentPortMissingError' });
    installJudgmentPort(first);
    await readFailure(evidence, 'fixture'); expect(f.started()).toBe(3);
  });

  test('revocation inside a record prevents later battery attachments and cache publication', async () => {
    const f = fixture(); const readings = new ModelFamilyReadings();
    const original = f.log.record.bind(f.log);
    const record = spyOn(f.log, 'record').mockImplementation(entry => {
      const id = original(entry); changes[0]!.mutate(f.config); return id;
    });
    try {
      await expect(readings.read([model()])).rejects.toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
      expect(readings.known(model())).toBeUndefined();
      expect(f.log.query()).toMatchObject([{ status: 'answered', notes: [] }]);
    } finally { record.mockRestore(); }
  });
});

describe('installation and consumer lifetimes', () => {
  test.each(['resolve', 'reject'] as const)('replacement drains a non-aborting reader with late %s, and stops queued siblings', async settlement => {
    const f = fixture(); const readings = new ModelFamilyReadings(); f.hold();
    const pending = readings.read(Array.from({ length: 12 }, (_, i) => model(String(i)))).then(() => null, error => error);
    await f.entered.promise;
    const replacement = fakePort((_name, question) => choiceAnswer(question, 'Claude', 0.99));
    installJudgmentPort(replacement.port);
    try {
      expect(await promptly(pending)).toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
      expect(f.started()).toBe(8);
      await readings.read([model()]); expect(readings.known(model())).toBe('Claude');
      if (settlement === 'reject') f.release.reject(new Error('synthetic-private-late-error')); else f.resume();
      await turn(); expect(f.log.query()).toHaveLength(0); expect(f.started()).toBe(8);
    } finally { f.resume(); await pending; await turn(); }
  });

  test('one consumer cancellation leaves another shared family consumer alive', async () => {
    const f = fixture(); const readings = new ModelFamilyReadings(); f.hold();
    const first = readings.read([model()]); const second = readings.read([model()]);
    const abort = new AbortController(); const scoped = captureJudgmentPort('fixture', { signal: abort.signal });
    abort.abort(new Error('synthetic-private-abort'));
    expect(() => scoped.assertCurrent()).toThrow('no longer current');
    f.resume(); expect(await first).toBe(true); expect(await second).toBe(true); expect(f.started()).toBe(1);
    expect(readings.known(model())).toBe('Llama');
  });

  test('same-port owner rebinding retires pending reads and cache even with the same frame identity', async () => {
    const f = fixture(); const readings = new ModelFamilyReadings();
    await readings.read([model()]);
    const old = captureJudgmentPort('fixture');
    f.hold(); const pending = readings.read([model('pending')]).then(() => null, error => error);
    await f.entered.promise;
    const rebound = () => f.lifetime.capture();
    bindJudgmentPortAuthority(f.port, rebound);
    try {
      expect(await promptly(pending)).toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
      expect(() => old.assertCurrent()).toThrow('no longer current');
      expect(readings.known(model())).toBeUndefined();
      const current = captureJudgmentPort('fixture');
      expect(current.identity).not.toBe(old.identity);
      bindJudgmentPortAuthority(f.port, rebound);
      expect(() => current.assertCurrent()).not.toThrow();
      f.changeAnswer(); f.resume(); await turn();
      expect(f.log.query()).toHaveLength(1);
      await readings.read([model()]); expect(readings.known(model())).toBe('Claude');
    } finally { f.resume(); await pending; await turn(); }
  });

  test('retiring an older composition does not transiently revoke the current installation', async () => {
    const f = fixture(); const a = createAsyncDisposalScope('a'); const b = createAsyncDisposalScope('b');
    const input = { config: f.config, secrets: f.secrets, env: {} };
    composeJudgment({ ...input, stateRoot: join(f.root, 'a'), disposal: a.registry });
    composeJudgment({ ...input, stateRoot: join(f.root, 'b'), disposal: b.registry });
    const current = captureJudgmentPort('fixture');
    try { await a.close(); expect(() => current.assertCurrent()).not.toThrow(); }
    finally { await b.close(); await a.close(); }
  });
});
