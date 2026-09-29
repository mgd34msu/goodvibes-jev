/**
 * The judgment port every composition root installs: built from the judgment
 * settings over judgmentConfigFromEnv, recording every call in the state
 * root's decision log. The daemon test boots the real composition against a
 * fake System One endpoint on loopback (the transport is real HTTP; only the
 * answers are canned) and reads a failure through the installed port.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetFailureReadings, installJudgmentPort, judgmentPort, JudgmentPortMissingError, readFailure } from '@goodvibes-jev/engine/errors';
import { PINNED_MODEL, readingsOf, SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { bootDaemon, type BootedDaemon } from '../sdk/src/platform/daemon/boot.ts';
import { createDisposalScope } from '../sdk/src/platform/runtime/disposal.ts';
import { composeJudgment, judgmentConfigFromSettings, type JudgmentSettingsSource } from '../sdk/src/platform/runtime/judgment-services.ts';
import { decisionLogPath } from '../sdk/src/platform/state/decision-log.ts';

const KEY = 'test-judgment-key';

interface SystemOneCall {
  readonly authorization: string | null;
  readonly body: { readonly model: string; readonly questions: Readonly<Record<string, { readonly type: string; readonly criteria?: unknown }>> };
}

/** A System One endpoint answering every failure question as a spent-account error (no connection failure). */
function startFakeSystemOne(): { url: string; calls: SystemOneCall[]; stop(): void } {
  const calls: SystemOneCall[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/systemone') return new Response('not found', { status: 404 });
      const body = (await request.json()) as SystemOneCall['body'];
      calls.push({ authorization: request.headers.get('authorization'), body });
      const answers = Object.fromEntries(Object.entries(body.questions).map(([name, question]) => {
        if (question.type === 'choice') {
          const options = Object.keys(question.criteria as Record<string, string>);
          const chosen = name === 'connection_failure' ? 'none' : 'billing';
          const probabilities = Object.fromEntries(options.map((option) => [option, option === chosen ? 0.95 : 0.05 / (options.length - 1)]));
          return [name, { type: 'choice', choice: chosen, confidence: 0.95, probabilities }];
        }
        return [name, { type: 'noul', noul: name === 'billing' || name === 'provider_unusable' ? 0.96 : 0.03 }];
      }));
      return Response.json({ model: body.model, answers, usage: { input_tokens: 40, output_tokens: 7 } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const SPENT = { message: 'Your credit balance is too low to access the API. Please go to Plans & Billing to purchase credits.', status: 400 };

let savedKey: string | undefined;
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  savedKey = process.env['TYPESAFE_API_KEY'];
  previousPort = installJudgmentPort(undefined);
  forgetFailureReadings();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY'];
  else process.env['TYPESAFE_API_KEY'] = savedKey;
  installJudgmentPort(previousPort);
  forgetFailureReadings();
});

describe('the daemon composition installs the judgment port', () => {
  let home: string;
  let work: string;
  let fake: ReturnType<typeof startFakeSystemOne>;
  let daemon: BootedDaemon | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'judgment-home-'));
    work = mkdtempSync(join(tmpdir(), 'judgment-work-'));
    fake = startFakeSystemOne();
  });
  afterAll(async () => {
    await daemon?.stop();
    fake.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('reads a failure through the booted daemon and records it in the state decision log', async () => {
    process.env['TYPESAFE_API_KEY'] = KEY;
    const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes', ownsDaemonTier: true });
    configManager.set('judgment.endpoint', fake.url);
    daemon = await bootDaemon({ homeDirectory: home, workingDir: work, daemonHomeDir: join(home, 'daemon'), configManager, port: 0, host: '127.0.0.1', token: 'judgment-boot-token' });

    const failure = await readFailure(SPENT, 'test.judgment-composition');
    expect(failure.category).toBe('billing');
    expect(failure.billing).toBe(true);
    expect(failure.transientNetwork).toBe(false);

    // The booted daemon asks its own readings too (credential keys, watched
    // config files); the failure reading is the one request carrying its
    // questions. Every request goes out with the key and the pinned model.
    const failureCalls = fake.calls.filter((call) => 'billing' in call.body.questions);
    expect(failureCalls).toHaveLength(1);
    for (const call of fake.calls) {
      expect(call.authorization).toBe(`Bearer ${KEY}`);
      expect(call.body.model).toBe(PINNED_MODEL);
    }

    const path = decisionLogPath(join(work, '.goodvibes', 'goodvibes'));
    expect(existsSync(path)).toBe(true);
    using log = new SqliteDecisionLog(path);
    const [entry] = log.query({ site: 'test.judgment-composition' });
    expect(entry?.status).toBe('answered');
    expect(entry?.context.battery).toBe('engine.failure-reading');
    expect(readingsOf(entry!)).toMatchObject({ billing: { verdict: 'yes', outcome: 'act' } });

    await daemon.stop();
    daemon = undefined;
    expect(() => judgmentPort('after stop')).toThrow(JudgmentPortMissingError);
  });
});

describe('the settings the port is built from', () => {
  const source = (settings: Record<string, unknown>, env: Record<string, string | undefined>, stored: string | null = null): JudgmentSettingsSource => ({
    config: { get: (key) => settings[key] ?? { 'judgment.keySource': 'env', 'judgment.endpoint': '', 'judgment.model': '', 'judgment.timeoutMs': 10_000 }[key] },
    secrets: { get: async () => stored },
    env,
  });

  test('empty settings defer to the TypeSafe environment variables, then the hosted endpoint and pinned model', async () => {
    const hosted = await judgmentConfigFromSettings(source({}, { TYPESAFE_API_KEY: KEY }));
    expect(hosted.endpoint).toEqual({ kind: 'hosted', baseURL: 'https://api.typesafe.ai', apiKey: KEY });
    expect(hosted.model).toBe(PINNED_MODEL);
    const fromEnv = await judgmentConfigFromSettings(source({}, { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'http://127.0.0.1:9000', TYPESAFE_DEFAULT_MODEL: 'jev-env' }));
    expect(fromEnv.endpoint.kind).toBe('local');
    expect(fromEnv.model).toBe('jev-env');
  });

  test('engine settings win over the environment', async () => {
    const config = await judgmentConfigFromSettings(source(
      { 'judgment.endpoint': 'https://judgment.example.test', 'judgment.model': 'jev-pinned-here', 'judgment.timeoutMs': 4000 },
      { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'http://127.0.0.1:9000', TYPESAFE_DEFAULT_MODEL: 'jev-env' },
    ));
    expect(config.endpoint.baseURL).toBe('https://judgment.example.test');
    expect(config.model).toBe('jev-pinned-here');
    expect(config.timeoutMs).toBe(4000);
  });

  test('keySource secret reads the key from the secret store, not the environment', async () => {
    const config = await judgmentConfigFromSettings(source({ 'judgment.keySource': 'secret' }, { TYPESAFE_API_KEY: 'env-key' }, 'stored-key'));
    expect(config.endpoint.apiKey).toBe('stored-key');
    await expect(judgmentConfigFromSettings(source({ 'judgment.keySource': 'secret' }, { TYPESAFE_API_KEY: 'env-key' }))).rejects.toThrow('secret store holds no TYPESAFE_API_KEY');
  });

  test('a missing key fails the judgment and the decision log records the failure', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'judgment-state-'));
    const scope = createDisposalScope('test');
    try {
      const { decisionLog } = composeJudgment({ ...source({}, {}), stateRoot, disposal: scope.registry });
      await expect(readFailure(SPENT, 'test.no-key')).rejects.toThrow('TYPESAFE_API_KEY is not set');
      const [entry] = decisionLog.query({ site: 'test.no-key' });
      expect(entry?.status).toBe('failed');
    } finally {
      scope.dispose();
      rmSync(stateRoot, { recursive: true, force: true });
    }
    expect(() => judgmentPort('after dispose')).toThrow(JudgmentPortMissingError);
  });

  test('disposing a composition puts back the port it replaced', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'judgment-state-'));
    const outer = { model: 'outer', ask: async () => { throw new Error('unused'); } };
    installJudgmentPort(outer);
    const scope = createDisposalScope('test');
    try {
      const { port } = composeJudgment({ ...source({}, {}), stateRoot, disposal: scope.registry });
      expect(judgmentPort('installed')).toBe(port);
      scope.dispose();
      expect(judgmentPort('restored')).toBe(outer);
    } finally {
      scope.dispose();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
