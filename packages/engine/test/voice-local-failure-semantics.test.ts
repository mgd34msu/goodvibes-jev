import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { VoiceProviderRegistry } from '../sdk/src/platform/voice/provider-registry.js';
import { ensureBuiltinVoiceProviders } from '../sdk/src/platform/voice/builtin-providers.js';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { createLocalVoiceProvider, type LocalEngineRunner } from '../sdk/src/platform/voice/providers/local.js';
import { localEngineFailureReading, type LocalEngineFailureKind } from '../sdk/src/platform/voice/providers/local-failure-reading.js';
import { registry } from '../sdk/src/platform/runtime/judgment-registry.js';
import type { VoiceProvider } from '../sdk/src/platform/voice/types.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function reading(kind: LocalEngineFailureKind, confidence = 0.99) {
  const fixture = fakePort((_name, question) => choiceAnswer(question, kind, confidence));
  installJudgmentPort(fixture.port);
  return fixture;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function delayedReading(kind: LocalEngineFailureKind) {
  const fixture = fakePort((_name, question) => choiceAnswer(question, kind, 0.99));
  const entered = deferred<void>(), gate = deferred<void>();
  const ask = fixture.port.ask.bind(fixture.port);
  fixture.port.ask = async request => { entered.resolve(); await gate.promise; return ask(request); };
  installJudgmentPort(fixture.port);
  return { ...fixture, entered: entered.promise, release: () => gate.resolve() };
}
function fixture(runner: LocalEngineRunner) {
  const config: Record<string, string> = {
    'voice.local.ttsEngine': 'piper', 'voice.local.ttsBinary': '/fixture/piper', 'voice.local.ttsModelPath': '/fixture/voice.onnx',
    'voice.local.sttEngine': 'whisper-cpp', 'voice.local.sttBinary': '/fixture/whisper', 'voice.local.sttModelPath': '/fixture/model.bin',
  };
  const inputs: Parameters<LocalEngineRunner>[0][] = [];
  const provider = createLocalVoiceProvider({ readConfig: key => config[key] ?? '', fileExists: () => true,
    runner: async input => { inputs.push(input); return runner(input); } });
  return { provider, config, inputs };
}
function success(input: Parameters<LocalEngineRunner>[0]) {
  const out = input.args.indexOf('--output_file');
  if (out !== -1) writeFileSync(input.args[out + 1]!, 'RIFFfixture');
  return { stdout: 'local transcript' };
}
type Mode = 'tts' | 'tts-stream' | 'stt';
function invoke(provider: VoiceProvider, mode: Mode = 'tts', signal?: AbortSignal) {
  if (mode === 'stt') return provider.transcribe!({ audio: { mimeType: 'audio/wav', format: 'wav',
    dataBase64: Buffer.from('PRIVATE_AUDIO_BYTES').toString('base64'), metadata: {} }, prompt: 'PRIVATE_TRANSCRIPTION_PROMPT' });
  const request = { text: 'PRIVATE_SYNTHESIS_TEXT', signal, metadata: { privateRequest: 'PRIVATE_METADATA' } };
  return mode === 'tts' ? provider.synthesize!(request) : Promise.resolve(provider.synthesizeStream!(request));
}
async function healthy(provider: VoiceProvider) { expect((await provider.status!()).state).toBe('healthy'); }
function scratch(input: Parameters<LocalEngineRunner>[0]): string {
  const index = input.args.indexOf('--output_file');
  return dirname(index !== -1 ? input.args[index + 1]! : input.args[input.args.indexOf('-f') + 1]!);
}

test('local failure battery is registered for calibration', () => {
  expect(registry.get(localEngineFailureReading.name)).toBe(localEngineFailureReading);
});

describe('actual local TTS, stream and STT catches consume semantic failure readings', () => {
  for (const mode of ['tts', 'tts-stream', 'stt'] as const) {
    for (const kind of ['model-load-incompatible', 'fatal-crash'] as const) {
      test(`${mode}: ${kind} from paraphrased diagnostics trips only its engine`, async () => {
        const port = reading(kind);
        const error = new Error('The loader could not initialize the network in this runtime.');
        const { provider, inputs } = fixture(async () => { throw error; });
        await expect(invoke(provider, mode)).rejects.toThrow('unavailable on this host');
        await expect(invoke(provider, mode)).rejects.toThrow('unavailable on this host');
        expect(inputs).toHaveLength(1); expect(port.requests).toHaveLength(1);
        const state = JSON.stringify(port.requests[0]!.state);
        expect(state).toContain(error.message);
        expect(state).not.toContain('PRIVATE_SYNTHESIS_TEXT'); expect(state).not.toContain('PRIVATE_AUDIO_BYTES');
        expect(state).not.toContain(Buffer.from('PRIVATE_AUDIO_BYTES').toString('base64'));
        expect(state).not.toContain('PRIVATE_TRANSCRIPTION_PROMPT'); expect(state).not.toContain('PRIVATE_METADATA');
        expect((await provider.status!()).detail).toContain(`Local ${mode === 'stt' ? 'STT' : 'TTS'} engine`);
        expect(existsSync(scratch(inputs[0]!))).toBe(false);
      });
    }
    test(`${mode}: warnings, quoted crash text and negation do not trip`, async () => {
      const port = reading('not-fatal');
      const error = new Error('No Unsupported model IR version or Ort::Exception occurred. "core dumped" is a documentation example. [W:onnxruntime] warning only; disk full.');
      const { provider, inputs } = fixture(async () => { throw error; });
      await expect(invoke(provider, mode)).rejects.toBe(error);
      await expect(invoke(provider, mode)).rejects.toBe(error);
      expect(inputs).toHaveLength(2); expect(port.requests).toHaveLength(2); await healthy(provider);
    });
  }
});

for (const signal of ['SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS']) test(`structured ${signal} is fatal with no installed reader`, async () => {
  const { provider, inputs } = fixture(async () => { throw Object.assign(new Error('opaque failure'), { signal }); });
  await expect(invoke(provider)).rejects.toThrow('unavailable on this host');
  await expect(invoke(provider)).rejects.toThrow(signal);
  expect(inputs).toHaveLength(1);
});
test('own killed SIGTERM and signal-less timeouts bypass a contrary fatal reading', async () => {
  const port = reading('fatal-crash');
  for (const signal of ['SIGTERM', undefined]) {
    const error = Object.assign(new Error('Ort::Exception core dumped'), { killed: true, signal });
    const { provider, inputs } = fixture(async () => { throw error; });
    await expect(invoke(provider)).rejects.toBe(error); await expect(invoke(provider)).rejects.toBe(error);
    expect(inputs).toHaveLength(2); await healthy(provider);
  }
  expect(port.requests).toHaveLength(0);
});

describe('unavailable readings preserve the original failure and never trip', () => {
  for (const mode of ['missing', 'weak', 'malformed', 'throwing'] as const) test(mode, async () => {
    if (mode === 'weak') reading('fatal-crash', 0.5);
    if (mode === 'malformed') installJudgmentPort(fakePort(() => ({ type: 'choice', choice: 'fatal-crash', confidence: 1,
      probabilities: { 'fatal-crash': Number.NaN } })).port);
    if (mode === 'throwing') { const port = reading('fatal-crash'); port.port.ask = async () => { throw new Error('offline reader'); }; }
    const error = new Error('Ort::Exception Unsupported model IR version');
    const { provider, inputs } = fixture(async () => { throw error; });
    await expect(invoke(provider)).rejects.toBe(error); await expect(invoke(provider)).rejects.toBe(error);
    expect(inputs).toHaveLength(2); await healthy(provider);
  });
  test('an empty diagnostic cannot acquire a fabricated fatal interpretation', async () => {
    const port = reading('fatal-crash'); const error = new Error('');
    const { provider } = fixture(async () => { throw error; });
    await expect(invoke(provider)).rejects.toBe(error); expect(port.requests).toHaveLength(0); await healthy(provider);
  });
});

describe('complete immutable protected diagnostic admission', () => {
  const privateTail = `${'ordinary '.repeat(25_000)} Authorization: Bearer private-tail`;
  for (const where of ['message', 'cause', 'stderr', 'extra', 'card'] as const) test(`protected ${where} never reaches a reader`, async () => {
    const port = reading('fatal-crash');
    const error = new Error(where === 'message' ? privateTail : 'opaque engine failure',
      where === 'cause' ? { cause: new Error(privateTail) } : undefined);
    if (where === 'stderr') Object.assign(error, { stderr: privateTail });
    if (where === 'extra') Object.assign(error, { diagnostic: { authorization: 'Bearer private-tail' } });
    if (where === 'card') Object.assign(error, { diagnostic: { cardNumber: '4111111111111111' } });
    const { provider } = fixture(async () => { throw error; });
    await expect(invoke(provider)).rejects.toBe(error);
    expect(port.requests).toHaveLength(0); await healthy(provider);
  });
  test('oversize public diagnostics are not truncated into a fatal decision', async () => {
    const port = reading('fatal-crash'); const error = new Error(`core dumped ${'ordinary '.repeat(80_000)}`);
    const { provider } = fixture(async () => { throw error; });
    await expect(invoke(provider)).rejects.toBe(error); expect(port.requests).toHaveLength(0); await healthy(provider);
  });
  test('getter and proxy failures are refused without invoking source behavior', async () => {
    const port = reading('fatal-crash'); let touched = 0;
    const getter = new Error('plain'); Object.defineProperty(getter, 'message', { get() { touched++; return 'core dumped'; } });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { touched++; throw new Error('must not inspect'); },
      getPrototypeOf() { touched++; throw new Error('must not inspect'); } });
    for (const error of [getter, proxy]) {
      const { provider } = fixture(async () => { throw error; });
      const caught = await invoke(provider).then(() => null, value => value as unknown);
      expect(caught === error).toBe(true); await healthy(provider);
    }
    expect(touched).toBe(0); expect(port.requests).toHaveLength(0);
  });
  test('admission precedes model rechecks and captures a complete immutable error', async () => {
    const port = reading('not-fatal'); const error = new Error('original complete failure'); let failed = false;
    Object.defineProperty(port.port, 'model', { get() {
      if (failed) error.message = 'mutated after failure: Authorization: Bearer private';
      return 'jev-1.13.0';
    } });
    const { provider } = fixture(async () => { failed = true; throw error; });
    await expect(invoke(provider)).rejects.toBe(error);
    expect(port.requests).toHaveLength(1);
    expect(JSON.stringify(port.requests[0]!.state)).toContain('original complete failure');
    expect(JSON.stringify(port.requests[0]!.state)).not.toContain('Bearer private');
  });
  test('attached request text/audio/stdout stay out of the semantic projection', async () => {
    const port = reading('not-fatal'); const error = Object.assign(new Error('disk write failed'), {
      request: { text: 'ATTACHED_SPEECH_TEXT', audio: 'ATTACHED_AUDIO' }, stdout: 'PRIVATE_TRANSCRIPT',
    });
    const { provider } = fixture(async () => { throw error; });
    await expect(invoke(provider)).rejects.toBe(error);
    const state = JSON.stringify(port.requests[0]!.state);
    expect(state).not.toContain('ATTACHED_SPEECH_TEXT'); expect(state).not.toContain('ATTACHED_AUDIO');
    expect(state).not.toContain('PRIVATE_TRANSCRIPT');
  });
});

describe('original engine incarnation, request and judgment authority own each decision', () => {
  for (const mode of ['tts', 'stt'] as const) {
    for (const transition of ['reset', 'replacement', 'observed-aba', 'absent-aba'] as const) test(`${mode}: ${transition} rejects late fatal reading`, async () => {
      const port = delayedReading('fatal-crash'); let fail = true;
      const { provider, config, inputs } = fixture(async input => { if (fail) throw new Error('opaque engine failure'); return success(input); });
      const pending = invoke(provider, mode).then(() => null, error => error as unknown);
      await port.entered;
      const key = `voice.local.${mode}Binary`; const old = config[key]!;
      if (transition === 'reset') provider.resetEngineFailureState!();
      else {
        config[key] = transition === 'absent-aba' ? '' : '/replacement/engine'; await provider.status!();
        if (transition.endsWith('aba')) { config[key] = old; await provider.status!(); }
      }
      fail = false;
      await invoke(provider, mode); expect(await pending).not.toBeNull();
      port.release(); await Promise.resolve(); await Promise.resolve();
      await healthy(provider); await invoke(provider, mode); expect(inputs).toHaveLength(3);
    });
  }
  test('reset releases a noncooperating runner and its eventual fatal rejection cannot poison the new engine', async () => {
    reading('fatal-crash'); const started = deferred<void>(), first = deferred<{ stdout: string }>(); let count = 0;
    const { provider, inputs } = fixture(async input => { if (++count === 1) { started.resolve(); return first.promise; } return success(input); });
    const pending = invoke(provider).then(() => null, error => error as unknown);
    await started.promise; provider.resetEngineFailureState!(); expect(await pending).not.toBeNull();
    expect(existsSync(scratch(inputs[0]!))).toBe(false);
    await invoke(provider);
    first.reject(Object.assign(new Error('old failure'), { signal: 'SIGABRT' }));
    await Promise.resolve(); await Promise.resolve(); await healthy(provider);
  });
  test('request cancellation interrupts a noncooperating judgment and retains no breaker', async () => {
    const port = delayedReading('fatal-crash'); const controller = new AbortController();
    const { provider, inputs } = fixture(async () => { throw new Error('opaque'); });
    const pending = invoke(provider, 'tts', controller.signal).then(() => null, error => error as unknown);
    await port.entered; controller.abort(); expect(await pending).not.toBeNull();
    expect(existsSync(scratch(inputs[0]!))).toBe(false); port.release(); await Promise.resolve(); await healthy(provider);
  });
  test('a replacement installed after invocation begins cannot classify its failure', async () => {
    const original = reading('fatal-crash'); const started = deferred<void>(), gate = deferred<{ stdout: string }>();
    const { provider } = fixture(async () => { started.resolve(); return gate.promise; });
    const pending = invoke(provider).then(() => null, error => error as unknown);
    await started.promise; const replacement = reading('fatal-crash'); gate.reject(new Error('opaque'));
    expect(await pending).not.toBeNull(); expect(original.requests).toHaveLength(0); expect(replacement.requests).toHaveLength(0);
    await healthy(provider);
  });
  test('a reader installed after a missing capture is not borrowed', async () => {
    const started = deferred<void>(), gate = deferred<{ stdout: string }>();
    const { provider } = fixture(async () => { started.resolve(); return gate.promise; });
    const pending = invoke(provider).then(() => null, error => error as unknown);
    await started.promise; const port = reading('fatal-crash'); const error = new Error('opaque'); gate.reject(error);
    expect(await pending).toBe(error); expect(port.requests).toHaveLength(0); await healthy(provider);
  });
  test('a bound source generation retired by invisible config ABA cannot classify a late failure', async () => {
    const port = reading('fatal-crash'); let generation = 0;
    bindJudgmentPortAuthority(port.port, () => {
      const captured = generation;
      return { identity: Object.freeze({}), assertCurrent: () => { if (generation !== captured) throw new Error('retired source'); } };
    });
    const { provider, config } = fixture(async () => {
      const old = config['voice.local.ttsBinary']!;
      config['voice.local.ttsBinary'] = '/temporary/engine'; generation++;
      config['voice.local.ttsBinary'] = old; generation++;
      throw new Error('opaque');
    });
    await expect(invoke(provider)).rejects.toThrow(); expect(port.requests).toHaveLength(0); await healthy(provider);
  });
  test('concurrent equal-wording requests keep independent cancellation and readings', async () => {
    const gates = [deferred<void>(), deferred<void>()], entered = deferred<void>(); let asks = 0;
    const port = fakePort((_name, question) => choiceAnswer(question, 'fatal-crash', 0.99));
    const ask = port.port.ask.bind(port.port);
    port.port.ask = async request => { const index = asks++; if (asks === 2) entered.resolve(); await gates[index]!.promise; return ask(request); };
    installJudgmentPort(port.port); const controller = new AbortController();
    const { provider, inputs } = fixture(async () => { throw new Error('same diagnostic'); });
    const first = invoke(provider, 'tts', controller.signal).then(() => null, error => error as unknown);
    const second = invoke(provider).then(() => null, error => error as unknown);
    await entered.promise; controller.abort(); expect(await first).not.toBeNull();
    await healthy(provider); gates[1]!.resolve(); expect(String(await second)).toContain('unavailable on this host');
    gates[0]!.resolve(); await Promise.resolve();
    expect(inputs).toHaveLength(2); expect(asks).toBe(2); expect((await provider.status!()).state).toBe('degraded');
  });
});

test('injected config revision rejects an invisible engine ABA independently of judgment source changes', async () => {
  const port = delayedReading('fatal-crash'); let revision = 0, binary = '/fixture/piper', fail = true;
  const provider = createLocalVoiceProvider({ fileExists: () => true, readConfigIncarnation: () => revision,
    readConfig: key => ({ 'voice.local.ttsEngine': 'piper', 'voice.local.ttsBinary': binary, 'voice.local.ttsModelPath': '/fixture/model' } as Record<string, string>)[key],
    runner: async input => { if (fail) throw new Error('opaque failure'); return success(input); } });
  const pending = invoke(provider).then(() => null, error => error as unknown);
  await port.entered; binary = '/temporary/engine'; revision++; binary = '/fixture/piper'; revision++;
  fail = false; await invoke(provider); expect(await pending).not.toBeNull();
  port.release(); await Promise.resolve(); await healthy(provider);
});

for (const [mode, echo] of [
  ['tts', 'PRIVATE_SYNTHESIS_TEXT'], ['stt', Buffer.from('PRIVATE_AUDIO_BYTES').toString('base64')],
  ['stt', 'PRIVATE_TRANSCRIPTION_PROMPT'],
] as const) test(`${mode}: exact original content echoed in diagnostics is not disclosed to classify the failure`, async () => {
  const port = reading('fatal-crash'); const error = new Error(`Engine rejected input: ${echo}`);
  const { provider } = fixture(async () => { throw error; });
  await expect(invoke(provider, mode)).rejects.toBe(error); expect(port.requests).toHaveLength(0); await healthy(provider);
});

test('transcription cancellation fences the same failure path', async () => {
  const port = delayedReading('fatal-crash'); const controller = new AbortController();
  const { provider } = fixture(async () => { throw new Error('opaque'); });
  const pending = provider.transcribe!({ signal: controller.signal,
    audio: { mimeType: 'audio/wav', format: 'wav', dataBase64: 'AA==', metadata: {} } }).then(() => null, error => error as unknown);
  await port.entered; controller.abort(); expect(await pending).not.toBeNull();
  port.release(); await Promise.resolve(); await healthy(provider);
});


test('label-prefixed nested credential syntax is refused before a semantic failure reading', async () => {
  const port = reading('fatal-crash');
  const error = new Error('opaque engine failure', { cause: new Error('- Jo: password=synthetic-secret') });
  const { provider } = fixture(async () => { throw error; });
  await expect(invoke(provider)).rejects.toBe(error); expect(port.requests).toHaveLength(0); await healthy(provider);
});

for (const probabilities of [
  { 'model-load-incompatible': 0, 'fatal-crash': 1, 'not-fatal': 0, unexpected: 0 },
  { 'model-load-incompatible': 0, 'fatal-crash': 0.9 },
  { 'model-load-incompatible': -0.1, 'fatal-crash': 1.1, 'not-fatal': 0 },
  { 'model-load-incompatible': 0.2, 'fatal-crash': 0.9, 'not-fatal': 0.2 },
]) test(`invalid probability domain or distribution cannot disable the engine: ${JSON.stringify(probabilities)}`, async () => {
  const port = fakePort(() => ({ type: 'choice', choice: 'fatal-crash', confidence: 1, probabilities }));
  installJudgmentPort(port.port); const error = new Error('opaque');
  const { provider } = fixture(async () => { throw error; });
  await expect(invoke(provider)).rejects.toBe(error); await healthy(provider);
});

test('serialized original synthesis text echoed in diagnostics is refused locally', async () => {
  const port = reading('fatal-crash'); const text = 'two lines\nof private speech';
  const error = new Error(`Engine rejected ${JSON.stringify(text)}`);
  const { provider } = fixture(async () => { throw error; });
  await expect(provider.synthesize!({ text })).rejects.toBe(error);
  expect(port.requests).toHaveLength(0); await healthy(provider);
});


test.skipIf(process.platform === 'win32')('real ConfigManager through builtin provider fences config ABA before breaker publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-local-config-incarnation-'));
  const binary = join(root, 'fixture-engine');
  const model = join(root, 'fixture-model');
  const port = delayedReading('fatal-crash');
  try {
    writeFileSync(binary, '#!/bin/sh\nprintf "opaque engine failure" >&2\nexit 1\n');
    chmodSync(binary, 0o700); writeFileSync(model, 'fixture');
    const config = new ConfigManager({ configDir: join(root, 'config'), readOnly: true });
    config.setRuntimeOverride('voice.local.ttsEngine', 'piper');
    config.setRuntimeOverride('voice.local.ttsBinary', binary);
    config.setRuntimeOverride('voice.local.ttsModelPath', model);
    const providers = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(providers, {
      readConfig: key => config.get(key as Parameters<typeof config.get>[0]),
      readConfigIncarnation: () => config.getConfigurationIncarnation(),
    });
    const provider = providers.get('local')!;
    const pending = invoke(provider).then(() => null, error => error as unknown);
    await port.entered;
    const originalRevision = config.getConfigurationIncarnation();
    // Neither provider status nor a request observes the temporary B value.
    config.setRuntimeOverride('voice.local.ttsBinary', join(root, 'temporary-engine'));
    config.setRuntimeOverride('voice.local.ttsBinary', binary);
    expect(config.getConfigurationIncarnation()).toBeGreaterThan(originalRevision);
    expect(config.get('voice.local.ttsBinary')).toBe(binary);
    // A fresh request uses the same binary/model strings under the new real
    // config incarnation; its successful result must survive the old failure.
    writeFileSync(binary, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output_file" ]; then shift; printf RIFFfixture > "$1"; exit 0; fi\n  shift\ndone\nexit 1\n');
    const replacement = await provider.synthesize!({ text: 'replacement speech' });
    expect(replacement.audio.dataBase64).toBe(Buffer.from('RIFFfixture').toString('base64'));
    expect(await pending).not.toBeNull();
    port.release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    await healthy(provider);
    const afterLateFailure = await provider.synthesize!({ text: 'still working' });
    expect(afterLateFailure.audio.dataBase64).toBe(replacement.audio.dataBase64);
  } finally { port.release(); rmSync(root, { recursive: true, force: true }); }
});
