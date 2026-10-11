import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { proveVoiceRoundTrip, type ProofEngineRunner } from '../sdk/src/platform/voice/provisioning/round-trip-proof.js';
import { createVoiceSetupService } from '../sdk/src/platform/runtime/voice-setup.js';
import { createVoiceInstallHandler } from '../sdk/src/platform/control-plane/routes/voice-setup.js';
import { readVoiceDiagnostics } from '../sdk/src/platform/voice/diagnostics.js';

const engine = { ttsEngine: 'piper', ttsBinary: '/managed/piper', ttsModelPath: '/managed/voice.onnx',
  sttEngine: 'whisper-cpp', sttBinary: '/managed/whisper', sttModelPath: '/managed/model.bin' };
let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
function reading(probability: number) {
  const fixture = fakePort(() => noulAnswer(probability));
  previous = installJudgmentPort(fixture.port); installed = true;
  return fixture;
}
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function runner(transcript: string, paths: string[] = []): ProofEngineRunner {
  return async input => {
    if (input.binary === engine.ttsBinary) {
      const path = String(input.args[input.args.indexOf('--output_file') + 1]);
      paths.push(path); writeFileSync(path, 'RIFFfixture'); return { stdout: '' };
    }
    return { stdout: transcript };
  };
}

describe('complete-transcript semantic proof, never overlap authority', () => {
  for (const transcript of [
    'dog lazy the over jumps fox brown quick the',
    'the quick brown fox does not jump over the lazy dog',
    'the quick brown fox jumps over the lazy dog is a phrase I cannot hear',
    '[BLANK_AUDIO]', 'none',
  ]) test(`settled no stays unproven: ${transcript}`, async () => {
    reading(0.01);
    const proof = await proveVoiceRoundTrip({ ...engine, runner: runner(transcript) });
    expect(proof.proved).toBe(false); expect(proof.comparison).toBe('no');
    expect(proof.transcript).toBe(transcript);
  });
  test('number spelling and punctuation can prove despite low word overlap', async () => {
    reading(0.99);
    const proof = await proveVoiceRoundTrip({ ...engine, phrase: '1 2 3', runner: runner('One, two, three!') });
    expect(proof.wordOverlap).toBe(0); expect(proof.proved).toBe(true);
  });
  test('empty transcript cannot prove even with an affirmative fixture', async () => {
    reading(0.99);
    const proof = await proveVoiceRoundTrip({ ...engine, runner: runner('  ') });
    expect(proof.proved).toBe(false); expect(proof.comparison).toBe('no');
  });
  test('uncertainty is honest about comparison rather than broken engines', async () => {
    reading(0.5);
    const proof = await proveVoiceRoundTrip({ ...engine, runner: runner('the quick brown fox jumps over the lazy dog') });
    expect(proof.comparison).toBe('uncertain'); expect(proof.proved).toBe(false);
    expect(proof.summary).toContain('comparison was uncertain'); expect(proof.error).toBeUndefined();
  });
  test('missing judgment is unproven and still preserves transcript and cleanup', async () => {
    previous = installJudgmentPort(undefined); installed = true;
    const paths: string[] = [];
    const proof = await proveVoiceRoundTrip({ ...engine, runner: runner('the quick brown fox jumps over the lazy dog', paths) });
    expect(proof.comparison).toBe('unavailable'); expect(proof.proved).toBe(false);
    expect(proof.transcript).toBe('the quick brown fox jumps over the lazy dog');
    expect(existsSync(dirname(paths[0]!))).toBe(false);
  });
  test('malformed model answer cannot prove', async () => {
    const fixture = fakePort(() => ({ kind: 'noul', noul: Number.NaN }) as never);
    previous = installJudgmentPort(fixture.port); installed = true;
    const proof = await proveVoiceRoundTrip({ ...engine, runner: runner('the quick brown fox jumps over the lazy dog') });
    expect(proof.proved).toBe(false); expect(proof.comparison).toBe('unavailable');
  });
  test('cancellation during synthesis prevents transcription and removes temporary files', async () => {
    reading(0.99); const controller = new AbortController(); const paths: string[] = []; let calls = 0;
    await expect(proveVoiceRoundTrip({ ...engine, signal: controller.signal, runner: async input => {
      calls++; await runner('', paths)(input); controller.abort(); return { stdout: '' };
    } })).rejects.toThrow();
    expect(calls).toBe(1); expect(existsSync(dirname(paths[0]!))).toBe(false);
  });
  test('deadline releases a noncooperating subprocess seam and cleans scratch', async () => {
    reading(0.99); let scratch = '';
    await expect(proveVoiceRoundTrip({ ...engine, timeoutMs: 10, runner: input => {
      scratch = dirname(String(input.args[input.args.indexOf('--output_file') + 1]));
      return new Promise(() => {});
    } })).rejects.toThrow();
    expect(existsSync(scratch)).toBe(false);
  });
  test('replacement of installed judgment during synthesis cannot authorize a stale result', async () => {
    reading(0.99); let calls = 0;
    await expect(proveVoiceRoundTrip({ ...engine, runner: async input => {
      calls++; const result = await runner('')(input);
      installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); return result;
    } })).rejects.toThrow(); expect(calls).toBe(1);
  });
  test('zero audio remains a synthesis failure and caller-owned scratch survives', async () => {
    reading(0.99); const scratchDir = mkdtempSync(join(tmpdir(), 'voice-owned-'));
    try {
      const proof = await proveVoiceRoundTrip({ ...engine, scratchDir, runner: async () => {
        writeFileSync(join(scratchDir, 'proof.wav'), ''); return { stdout: '' };
      } });
      expect(proof.stage).toBe('synthesize'); expect(proof.proved).toBe(false); expect(existsSync(scratchDir)).toBe(true);
    } finally { rmSync(scratchDir, { recursive: true, force: true }); }
  });
});

function setup(root: string, transcript: string, mutate?: () => void) {
  const config: Record<string, string> = {};
  const service = createVoiceSetupService({
    managedVoiceRoot: root, getConfig: key => config[key] ?? '', setConfig: (key, value) => { config[key] = value; },
    resetLocalEngineFailureState: () => {}, admitExpensiveWork: () => ({ allowed: true }),
    provision: async () => ({ platform: 'linux-x64', components: [],
      tts: { engine: 'piper', state: 'provisioned', binaryPath: engine.ttsBinary, modelPath: engine.ttsModelPath },
      stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: engine.sttBinary, modelPath: engine.sttModelPath } }),
    prove: options => proveVoiceRoundTrip({ ...options, runner: async input => {
      const answer = await runner(transcript)(input); mutate?.(); return answer;
    } }),
  });
  return { service, config };
}

describe('real setup service and gateway preserve semantic proof and ownership', () => {
  for (const probability of [0.99, 0.01, 0.5]) test(`receipt and diagnostic preserve settled result ${probability}`, async () => {
    reading(probability); const root = mkdtempSync(join(tmpdir(), 'voice-service-'));
    try {
      const { service } = setup(root, 'the quick brown fox jumps over the lazy dog');
      const result = await createVoiceInstallHandler(service)({ context: {} }) as Awaited<ReturnType<typeof service.install>>;
      expect(result.provisioned).toBe(probability === 0.99);
      expect(result.proof?.proved).toBe(probability === 0.99);
      expect(result.tts.state).toBe('provisioned'); expect(result.stt.state).toBe('provisioned');
      expect(readVoiceDiagnostics(root).at(-1)?.ok).toBe(probability === 0.99);
      expect(service.status().installInProgress).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('voice config changes during a real engine seam prevent diagnostic publication', async () => {
    reading(0.99); const root = mkdtempSync(join(tmpdir(), 'voice-config-'));
    try {
      const { service, config } = setup(root, 'the quick brown fox jumps over the lazy dog', () => {
        config['voice.local.sttBinary'] = '/replacement/whisper';
      });
      await expect(service.install()).rejects.toThrow('configuration changed');
      expect(readVoiceDiagnostics(root)).toHaveLength(0);
      expect(service.status().installInProgress).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('gateway cancellation is retained into subprocesses and publishes no diagnostic', async () => {
    reading(0.99); const root = mkdtempSync(join(tmpdir(), 'voice-cancel-')); const controller = new AbortController();
    try {
      const { service } = setup(root, '', () => controller.abort());
      await expect(Promise.resolve(createVoiceInstallHandler(service)({ signal: controller.signal, context: {} }))).rejects.toThrow();
      // The owning work consumes cancellation before its finally releases progress.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(readVoiceDiagnostics(root)).toHaveLength(0);
      expect(service.status().installInProgress).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('gateway authorization revocation cannot publish a successful proof', async () => {
    reading(0.99); const root = mkdtempSync(join(tmpdir(), 'voice-revoke-')); let authorized = true;
    try {
      const { service } = setup(root, '', () => { authorized = false; });
      await expect(Promise.resolve(createVoiceInstallHandler(service)({ context: {}, isAuthorized: () => authorized }))).rejects.toThrow();
      expect(readVoiceDiagnostics(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// Admission is tested with full source tails, never abbreviated display text.
test('private phrase is refused before model lookup and private transcript before a reading', async () => {
  const fixture = fakePort(() => noulAnswer(0.99)); let modelReads = 0;
  Object.defineProperty(fixture.port, 'model', { get() { modelReads++; return 'jev-1.13.0'; } });
  previous = installJudgmentPort(fixture.port); installed = true;
  const phrase = `ordinary words ${'x '.repeat(80_000)} Authorization: Bearer private-proof-token`;
  const proof = await proveVoiceRoundTrip({ ...engine, phrase, runner: runner('ordinary words') });
  expect(proof.comparison).toBe('unavailable'); expect(modelReads).toBe(0); expect(fixture.requests).toHaveLength(0);
  const transcriptProof = await proveVoiceRoundTrip({ ...engine, runner: runner(phrase) });
  expect(transcriptProof.comparison).toBe('unavailable'); expect(fixture.requests).toHaveLength(0);
});

test('late yes from a noncooperating model after cancellation is never retained', async () => {
  const controller = new AbortController(); const fixture = fakePort(() => noulAnswer(0.99));
  const ask = fixture.port.ask.bind(fixture.port); let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  fixture.port.ask = async request => { reached(); await gate; return ask(request); };
  previous = installJudgmentPort(fixture.port); installed = true;
  const paths: string[] = [];
  const pending = proveVoiceRoundTrip({ ...engine, signal: controller.signal,
    runner: runner('the quick brown fox jumps over the lazy dog', paths) });
  await entered; controller.abort();
  await expect(pending).rejects.toThrow(); release();
  expect(existsSync(dirname(paths[0]!))).toBe(false);
});

test('unavailable semantic comparison propagates without changing installed engine states', async () => {
  previous = installJudgmentPort(undefined); installed = true;
  const root = mkdtempSync(join(tmpdir(), 'voice-unavailable-'));
  try {
    const { service } = setup(root, 'the quick brown fox jumps over the lazy dog');
    const receipt = await service.install();
    expect(receipt.provisioned).toBe(false); expect(receipt.proof?.comparison).toBe('unavailable');
    expect(receipt.tts.state).toBe('provisioned'); expect(receipt.stt.state).toBe('provisioned');
    expect(readVoiceDiagnostics(root).at(-1)?.detail).toContain('comparison was unavailable');
    expect(readVoiceDiagnostics(root).at(-1)?.error).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TTS-only installation retains its existing success contract and explicitly has no round-trip proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-tts-only-'));
  try {
    const config: Record<string, string> = {};
    let proofs = 0;
    const service = createVoiceSetupService({
      managedVoiceRoot: root, getConfig: key => config[key] ?? '', setConfig: (key, value) => { config[key] = value; },
      resetLocalEngineFailureState: () => {}, admitExpensiveWork: () => ({ allowed: true }),
      provision: async () => ({ platform: 'linux-x64', components: [],
        tts: { engine: 'piper', state: 'provisioned', binaryPath: engine.ttsBinary, modelPath: engine.ttsModelPath },
        stt: { engine: 'whisper-cpp', state: 'unsupported-platform', reason: 'No pinned STT bundle for this fixture' } }),
      prove: async () => { proofs++; throw new Error('No STT engine should be invoked'); },
    });
    const receipt = await createVoiceInstallHandler(service)({ context: {} }) as Awaited<ReturnType<typeof service.install>>;
    expect(receipt.provisioned).toBe(true); expect(receipt.proof).toBeUndefined(); expect(proofs).toBe(0);
    expect(receipt.notes.join(' ')).toContain('no round trip could be proven');
    expect(receipt.stt.state).toBe('unsupported-platform'); expect(readVoiceDiagnostics(root)).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an original source generation retired by a config ABA cannot publish', async () => {
  const fixture = reading(0.99); let generation = 1;
  bindJudgmentPortAuthority(fixture.port, () => {
    const original = generation;
    return { identity: Object.freeze({}), assertCurrent: () => {
      if (generation !== original) throw new Error('Retired source generation');
    } };
  });
  const root = mkdtempSync(join(tmpdir(), 'voice-aba-'));
  try {
    const { service, config } = setup(root, 'the quick brown fox jumps over the lazy dog', () => {
      const old = config['voice.local.ttsBinary'];
      config['voice.local.ttsBinary'] = '/temporary/other-provider'; generation++;
      config['voice.local.ttsBinary'] = old!; generation++;
    });
    await expect(service.install()).rejects.toThrow();
    expect(readVoiceDiagnostics(root)).toHaveLength(0); expect(fixture.requests).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a joining caller cancellation cannot cancel or replace the original single-flight owner', async () => {
  reading(0.99); const root = mkdtempSync(join(tmpdir(), 'voice-join-'));
  const config: Record<string, string> = {}; let release!: () => void; let entered!: () => void; let provisions = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begun = new Promise<void>(resolve => { entered = resolve; });
  try {
    const service = createVoiceSetupService({
      managedVoiceRoot: root, getConfig: key => config[key] ?? '', setConfig: (key, value) => { config[key] = value; },
      resetLocalEngineFailureState: () => {}, admitExpensiveWork: () => ({ allowed: true }),
      provision: async () => { provisions++; entered(); await gate; return { platform: 'linux-x64', components: [],
        tts: { engine: 'piper', state: 'provisioned', binaryPath: engine.ttsBinary, modelPath: engine.ttsModelPath },
        stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: engine.sttBinary, modelPath: engine.sttModelPath } }; },
      prove: options => proveVoiceRoundTrip({ ...options, runner: runner('the quick brown fox jumps over the lazy dog') }),
    });
    const original = service.install(); await begun;
    const controller = new AbortController(); const joining = service.install({ signal: controller.signal });
    controller.abort(); await expect(joining).rejects.toThrow();
    expect(service.status().installInProgress).toBeDefined(); expect(provisions).toBe(1);
    release(); expect((await original).proof?.proved).toBe(true);
    expect(service.status().installInProgress).toBeUndefined(); expect(readVoiceDiagnostics(root)).toHaveLength(1);
  } finally { release?.(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('real subprocess cancellation waits for SIGKILL and close before scratch cleanup', async () => {
  reading(0.99); const root = mkdtempSync(join(tmpdir(), 'voice-child-')); const marker = join(root, 'started.json');
  const binary = join(root, 'fixture-engine'); const controller = new AbortController();
  writeFileSync(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.on('SIGTERM', () => {});\nconst wav = process.argv[process.argv.indexOf('--output_file') + 1];\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, wav}));\nsetInterval(() => {}, 100);\n`, { mode: 0o755 });
  let pid: number | undefined;
  let pending: ReturnType<typeof proveVoiceRoundTrip> | undefined;
  try {
    pending = proveVoiceRoundTrip({ ...engine, ttsBinary: binary, signal: controller.signal });
    // Drain rejection immediately without waiting before the caller aborts.
    void pending.catch(() => {});
    const until = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    expect(existsSync(marker)).toBe(true);
    const started = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; wav: string }; pid = started.pid;
    controller.abort(); await expect(pending).rejects.toThrow();
    expect(() => process.kill(started.pid, 0)).toThrow();
    expect(existsSync(dirname(started.wav))).toBe(false);
  } finally {
    controller.abort();
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already closed, as asserted above. */ } }
    await pending?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
