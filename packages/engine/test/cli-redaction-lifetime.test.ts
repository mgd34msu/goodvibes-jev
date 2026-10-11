import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStructuredCredentialReferenceConfigValue, readCredentialKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { collectSensitiveConfigValues, isSensitiveConfigPath, redactConfig, redactSerializedSecrets, REDACTED_VALUE } from '@goodvibes-jev/engine/terminal-shell';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function pausedReader() {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const recorded = fakePort(() => noulAnswer(0.03));
  const port: JudgmentPort = { model: recorded.port.model, async ask(request) {
    entered.resolve(); await release.promise; return recorded.port.ask(request);
  } };
  installJudgmentPort(port);
  return { entered: entered.promise, release: () => release.resolve(), recorded };
}

test('a new port reads the same path again instead of reusing an old ordinary decision', async () => {
  const ordinary = fakePort(() => noulAnswer(0.03)), credential = fakePort(() => noulAnswer(0.97));
  installJudgmentPort(ordinary.port);
  expect(await isSensitiveConfigPath('extension.unlockPassphrase')).toBe(false);
  installJudgmentPort(credential.port);
  expect(await isSensitiveConfigPath('extension.unlockPassphrase')).toBe(true);
  expect(ordinary.requests).toHaveLength(1); expect(credential.requests).toHaveLength(1);
});

test('pending config classification rejects source mutation and never sends raw values', async () => {
  const reader = pausedReader();
  const config = { extension: { setting: 'private-local-value' } };
  const work = redactConfig(config); await reader.entered;
  config.extension.setting = 'changed-local-value'; reader.release();
  await expect(work).rejects.toThrow();
  expect(JSON.stringify(reader.recorded.requests)).not.toContain('private-local-value');
  expect(JSON.stringify(reader.recorded.requests)).not.toContain('changed-local-value');
});

test('caller cancellation interrupts a non-cooperating pending config reader', async () => {
  const reader = pausedReader(), controller = new AbortController();
  const work = redactConfig({ extension: 'private-local-value' }, { signal: controller.signal });
  await reader.entered; controller.abort();
  await expect(work).rejects.toThrow();
  reader.release();
});

test('result publication remains bound to the original port', async () => {
  installJudgmentPort(fakePort(() => noulAnswer(0.03)).port);
  const result = await redactConfig({ extension: 'ordinary-value' }); result.assertCurrent();
  installJudgmentPort(fakePort(() => noulAnswer(0.03)).port);
  expect(() => result.assertCurrent()).toThrow();
});

test('result publication remains bound to the complete original config', async () => {
  installJudgmentPort(fakePort(() => noulAnswer(0.03)).port);
  const config: { extension: { setting: string; omitted?: undefined } } = { extension: { setting: 'ordinary-value', omitted: undefined } };
  const result = await redactConfig(config); result.assertCurrent();
  delete config.extension.omitted;
  expect(() => result.assertCurrent()).toThrow();
});

test('uncertain classifications mask values without retaining a clear decision', async () => {
  const recorded = fakePort(() => noulAnswer(0.5)); installJudgmentPort(recorded.port);
  const result = await redactConfig({ extension: 'private-local-value' });
  expect(result.value).toEqual({ extension: REDACTED_VALUE });
  expect(JSON.stringify(recorded.requests)).not.toContain('private-local-value');
});

test('protected field names fail locally before classification', async () => {
  const recorded = fakePort(() => noulAnswer(0.03)); installJudgmentPort(recorded.port);
  await expect(isSensitiveConfigPath('password=private-name-material')).rejects.toThrow();
  expect(recorded.requests).toHaveLength(0);
});

test('borrowed accessors are rejected without evaluating them', async () => {
  let reads = 0;
  const config = Object.defineProperty({}, 'extension', { enumerable: true, get() { reads++; return 'private-local-value'; } });
  await expect(redactConfig(config)).rejects.toThrow(); expect(reads).toBe(0);
});

test('prototype field data remains an own field in the redacted result', async () => {
  installJudgmentPort(fakePort(() => noulAnswer(0.03)).port);
  const config: unknown = JSON.parse('{"__proto__":{"ordinary":"value"}}');
  const result = await redactConfig(config);
  expect(result.value).toEqual(config);
  expect(result.value !== null && typeof result.value === 'object' && Object.hasOwn(result.value, '__proto__')).toBe(true);
});

test('declared schema decisions reject asynchronous ownership callbacks', async () => {
  await expect(isSensitiveConfigPath('display.themeMode', { async assertCurrent() {} })).rejects.toThrow('synchronous');
});

test('credential-key helper retains the complete field input until settlement', async () => {
  const reader = pausedReader();
  const state = { key: 'extension.setting', description: 'An ordinary setting.' };
  const work = readCredentialKey(state, 'test.credential-field'); await reader.entered;
  state.description = 'A changed setting.'; reader.release();
  await expect(work).rejects.toThrow();
});


test('valid structured fallback references stay detached and never enter credential path readings', async () => {
  const recorded = fakePort(() => { throw new Error('Declared references acquired a reader'); }); installJudgmentPort(recorded.port);
  const references = [{ endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'secret', keyName: 'judgment/backup' }];
  const source = { 'judgment.fallbacks': references };
  const result = await redactConfig(source);
  expect(result.value).toEqual(source); expect(result.redactedPaths).toEqual([]);
  expect(await collectSensitiveConfigValues(source)).toEqual([]); expect(recorded.requests).toHaveLength(0);
  references[0]!.keyName = 'judgment/replaced'; expect(() => result.assertCurrent()).toThrow();
});

test('malformed structured fallback values mask the complete value without reading child credentials', async () => {
  const recorded = fakePort(() => { throw new Error('Malformed references acquired a reader'); }); installJudgmentPort(recorded.port);
  const source = { 'judgment.fallbacks': [{ endpoint: 'https://api.typesafe.ai', rawKey: 'synthetic-private-value' }] };
  const result = await redactConfig(source);
  expect(result.value).toEqual({ 'judgment.fallbacks': REDACTED_VALUE });
  expect(result.redactedPaths).toEqual(['judgment.fallbacks']);
  expect(await collectSensitiveConfigValues(source)).toEqual([]); expect(recorded.requests).toHaveLength(0);
});

test('nested valid fallback references do not classify reference members as secret values', async () => {
  const recorded = fakePort(() => noulAnswer(0.03)); installJudgmentPort(recorded.port);
  const source = { judgment: { fallbacks: [{ endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'env', keyName: 'SYNTHETIC_JEV_KEY' }] } };
  const result = await redactConfig(source);
  expect(result.value).toEqual(source); expect(result.redactedPaths).toEqual([]);
  expect(JSON.stringify(recorded.requests)).not.toContain('SYNTHETIC_JEV_KEY');
  expect(recorded.requests.some(request => JSON.stringify(request.state).includes('judgment.fallbacks.0'))).toBe(false);
});


test('serialized support config retains canonical structured references even when a field reading calls keyName protected', async () => {
  const recorded = fakePort((name, question, state) => {
    if (name === 'kind' && question.type === 'choice') {
      const field = state !== null && typeof state === 'object' && !Array.isArray(state) ? state.field : undefined;
      return choiceAnswer(question, field === 'keyName' ? 'secret' : 'other', 0.999);
    }
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unexpected serialization fixture question ${name}`);
  });
  installJudgmentPort(recorded.port);
  const fallbacks = [
    { endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'env', keyName: 'SYNTHETIC_JEV_KEY' },
    { endpoint: 'https://fallback.example/v1', model: 'jev-1.13.0', keySource: 'secret', keyName: 'judgment/backup' },
  ] satisfies ReturnType<typeof captureStructuredCredentialReferenceConfigValue>;
  const config = { judgment: { fallbacks } };
  const serialized = await redactSerializedSecrets(JSON.stringify({ config, extension: { keyName: 'private-local-value' } }), []);
  const parsed: unknown = JSON.parse(serialized);
  expect(parsed).toEqual({ config, extension: { keyName: '[REDACTED]' } });
  if (parsed === null || typeof parsed !== 'object' || !('config' in parsed)
    || parsed.config === null || typeof parsed.config !== 'object' || !('judgment' in parsed.config)
    || parsed.config.judgment === null || typeof parsed.config.judgment !== 'object'
    || !('fallbacks' in parsed.config.judgment)) throw new Error('Serialized config lost its reference subtree');
  expect(captureStructuredCredentialReferenceConfigValue('judgment.fallbacks', parsed.config.judgment.fallbacks)).toEqual(config.judgment.fallbacks);
  expect(JSON.stringify(recorded.requests)).not.toContain('private-local-value');
});
