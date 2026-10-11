import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  prepareProfileRedactionRoles, redactSensitiveData, redactSensitiveDataAsync,
  redactStructuredData, redactStructuredDataAsync, registerAccountIdentityRedaction,
  registerProfileRedactionValues,
} from '../sdk/src/platform/utils/redaction.js';
import { exportToHTML, exportToJSON, exportToMarkdownExtended } from '../sdk/src/platform/export/session-export.js';
import type { ExportMessage } from '../sdk/src/platform/export/markdown.js';
import { fieldKind } from '../sdk/src/platform/utils/batteries/field-kind.js';
import { captureStructuredCredentialReferenceConfigValue } from '../sdk/src/platform/config/structured-credential-config.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { registerProfileRedactionValues(null); registerAccountIdentityRedaction(null); installJudgmentPort(previous); });

function publicReadings() {
  const port = fakePort((name, question, state) => {
    if (name === 'kind' && question.type === 'choice') {
      const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
      switch (field) {
        case 'unlockPassphrase': case 'password': return choiceAnswer(question, 'secret', 0.99);
        case 'shippingAddress': return choiceAnswer(question, 'owner_profile', 0.99);
        case 'body': return choiceAnswer(question, 'content', 0.99);
        case 'documentId': case 'phrase': case 'tokenCount': case 'nested': return choiceAnswer(question, 'other', 0.99);
        default: throw new Error(`No authored field fixture for ${String(field)}`);
      }
    }
    if (name === 'identifying') {
      const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
      if (field === 'commerce.currency') return noulAnswer(0.01);
      if (field === 'agent.privateAlias') return noulAnswer(0.99);
      throw new Error(`No authored profile role fixture for ${String(field)}`);
    }
    if (name === 'lineHasCredential' || name === 'spanIsCredential' || name === 'credentialRemains') return noulAnswer(0.01);
    throw new Error(`No authored redaction fixture for question ${name}`);
  });
  installJudgmentPort(port.port); return port;
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function pausedPort() {
  const normal = publicReadings();
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  installJudgmentPort({ ...normal.port, async ask(request) { ready.resolve(); await release.promise; return normal.port.ask(request); } });
  return { normal, ready: ready.promise, release: () => release.resolve() };
}

describe('canonical redaction source admission', () => {
  test('plain and unusual password values never enter field or line wire', async () => {
    const port = publicReadings();
    const text = 'unlockPassphrase=ordinary-unmarked-private-value\nThe password is another-private-value';
    const output = await redactSensitiveDataAsync(text);
    expect(output).not.toContain('ordinary-unmarked-private-value'); expect(output).not.toContain('another-private-value');
    const wire = JSON.stringify(port.requests);
    expect(wire).not.toContain('ordinary-unmarked-private-value'); expect(wire).not.toContain('another-private-value');
  });

  test('ordinary candidate roles preserve local originals without sending their values', async () => {
    const port = publicReadings();
    const policy = 'key-rotation-policy-for-tenants';
    const text = `documentId=${policy}\nThe bearer of bad news arrived.`;
    expect(await redactSensitiveDataAsync(text)).toBe(text);
    expect(JSON.stringify(port.requests)).not.toContain(policy);
    expect(port.requests.some((request) => request.context?.battery === 'engine.redaction.credential')).toBe(true);
  });

  test('an ordinary field role cannot release nested literal credential syntax', async () => {
    const port = publicReadings();
    const value = 'plain-nested-private-value';
    const output = await redactSensitiveDataAsync(`documentId="password=${value}"`);
    expect(output).not.toContain(value); expect(JSON.stringify(port.requests)).not.toContain(value);
  });

  test('short namespace-shaped candidates remain local before any credential reading', async () => {
    const port = publicReadings();
    const text = 'candidate sk-x and key-y';
    expect(await redactSensitiveDataAsync(text)).toBe(text);
    const wire = JSON.stringify(port.requests);
    expect(wire).not.toContain('sk-x'); expect(wire).not.toContain('key-y');
    expect(port.requests.some((request) => request.context?.battery === 'engine.redaction.credential')).toBe(true);
  });

  test('registered private prose, People, literal secrets and identity are masked before any reading', async () => {
    const port = publicReadings();
    registerProfileRedactionValues(() => ({ guarded: ['Home is the blue house'], absolute: ['Al'] }));
    registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/private-owner', userName: 'private-owner' }));
    const output = await redactSensitiveDataAsync('Home is the blue house; ask Al. Also /home/private-owner/code literal-private-value',
      { secretValues: ['literal-private-value'] });
    expect(output).not.toContain('Home is the blue house'); expect(output).not.toContain('ask Al.');
    expect(output).toContain('Also'); expect(output).not.toContain('private-owner'); expect(output).not.toContain('literal-private-value');
    const wire = JSON.stringify(port.requests);
    for (const value of ['Home is the blue house', 'private-owner', 'literal-private-value']) expect(wire).not.toContain(value);
  });

  test('private short values remain protected while an ordinary role needs a settled current reading', async () => {
    const port = publicReadings();
    registerProfileRedactionValues(() => ({ guarded: ['USD', 'Q7'], absolute: [], guardedFields: [
      { value: 'USD', field: 'commerce.currency', sourceKind: 'field' },
      { value: 'Q7', field: 'agent.privateAlias', sourceKind: 'field' },
    ] }));
    await prepareProfileRedactionRoles();
    const output = await redactSensitiveDataAsync('Amount USD; alias Q7; Q7extra remains separate.');
    expect(output).toContain('Amount USD'); expect(output).not.toContain('alias Q7;'); expect(output).toContain('Q7extra');
    expect(JSON.stringify(port.requests)).not.toContain('"value":"USD"'); expect(JSON.stringify(port.requests)).not.toContain('"value":"Q7"');
  });

  test('an ordinary/private role collision cannot release the shared local value', async () => {
    publicReadings();
    registerProfileRedactionValues(() => ({ guarded: ['USD', 'USD'], absolute: [], guardedFields: [
      { value: 'USD', field: 'commerce.currency', sourceKind: 'field' },
      { value: 'USD', field: 'agent.privateAlias', sourceKind: 'field' },
    ] }));
    expect(await redactSensitiveDataAsync('Use USD')).not.toContain('USD');
  });

  test('unavailable and unsettled candidate readings withhold the original', async () => {
    const value = 'key-unknown-private-material';
    expect(await redactSensitiveDataAsync(`identifier ${value}`)).not.toContain(value);
    installJudgmentPort(fakePort((_, question) => noulAnswer(0.45)).port);
    expect(await redactSensitiveDataAsync(`identifier ${value}`)).not.toContain(value);
  });

  test('the complete late source is protected before the first free-text request', async () => {
    const port = publicReadings();
    const tail = 'private-tail-value';
    const output = await redactSensitiveDataAsync(`${'ordinary prose '.repeat(1000)}\npassword=${tail}`);
    expect(output).not.toContain(tail); expect(JSON.stringify(port.requests)).not.toContain(tail);
  });

  test('sync boundaries reuse a current settled reading and retire it on port replacement', async () => {
    publicReadings();
    expect(await redactSensitiveDataAsync('Network failure')).toBe('Network failure');
    expect(redactSensitiveData('Network failure')).toBe('Network failure');
    installJudgmentPort(undefined);
    expect(redactSensitiveData('Network failure')).toBe('[REDACTED]');
    await settle();
  });

  test('non-cooperating cancellation cannot publish a late ordinary reading', async () => {
    const pending = pausedPort(), controller = new AbortController();
    const result = redactSensitiveDataAsync('public ordinary sentence', { signal: controller.signal });
    await pending.ready; controller.abort(); pending.release();
    expect(await result).toBe('[REDACTED]');
    expect(pending.normal.requests).toHaveLength(1);
  });

  test('same reader identity cannot authorize changed profile values', async () => {
    const pending = pausedPort();
    let privateValue = 'first-private-value';
    registerProfileRedactionValues(() => ({ guarded: [privateValue], absolute: [] }));
    const result = redactSensitiveDataAsync('public ordinary sentence');
    await pending.ready; privateValue = 'second-private-value'; pending.release();
    expect(await result).toBe('[REDACTED]');
  });

  test('replacing the literal secret list retires the retained source proof', async () => {
    const pending = pausedPort();
    const options = { secretValues: ['first-private-value'] };
    const result = redactSensitiveDataAsync('public ordinary sentence', options);
    await pending.ready; options.secretValues = ['new-private-value']; pending.release();
    expect(await result).toBe('[REDACTED]');
  });

  test('structured redaction preserves declared harmless fields and fixed secret sentinel', async () => {
    const port = publicReadings();
    const input = { tokenCount: 7, unlockPassphrase: 'plain-private-value', password: '<redacted>', nested: { body: 'ordinary text' } };
    const result = await redactStructuredDataAsync(input);
    expect(result).toEqual({ tokenCount: 7, unlockPassphrase: '[REDACTED]', password: '<redacted>', nested: { body: 'ordinary text' } });
    expect(JSON.stringify(port.requests)).not.toContain('plain-private-value');
    expect(input.unlockPassphrase).toBe('plain-private-value');
  });

  test('native fallback references survive only the exact config and bundle paths without child readings', async () => {
    const port = fakePort((name, question, state) => {
      const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
      if (name === 'kind' && question.type === 'choice' && (field === 'config' || field === 'judgment'))
        return choiceAnswer(question, 'other', 0.99);
      throw new Error(`No authored native reference fixture for ${name}:${String(field)}`);
    });
    installJudgmentPort(port.port);
    const primaryReference = { endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'env', keyName: 'SYNTHETIC_JEV_KEY' } satisfies ReturnType<typeof captureStructuredCredentialReferenceConfigValue>[number];
    const references = [primaryReference,
      { endpoint: 'https://fallback.example/v1', model: 'jev-1.13.0', keySource: 'secret', keyName: 'judgment/backup' },
    ] satisfies ReturnType<typeof captureStructuredCredentialReferenceConfigValue>;
    const sources = [{ 'judgment.fallbacks': references }, { judgment: { fallbacks: references } },
      { config: { 'judgment.fallbacks': references } }, { config: { judgment: { fallbacks: references } } }];
    for (const source of sources) expect(await redactStructuredDataAsync(source)).toEqual(source);
    const result = await redactStructuredDataAsync(sources[0]);
    if (result === null || typeof result !== 'object' || !('judgment.fallbacks' in result))
      throw new Error('Native reference output lost its exact declared key');
    expect(result['judgment.fallbacks']).not.toBe(references);
    expect(Object.isFrozen(result['judgment.fallbacks'])).toBe(true);
    expect(captureStructuredCredentialReferenceConfigValue('judgment.fallbacks', result['judgment.fallbacks'])).toEqual(references);
    primaryReference.keyName = 'REPLACED_REFERENCE';
    expect(JSON.stringify(result)).toContain('SYNTHETIC_JEV_KEY');
    const wire = JSON.stringify(port.requests);
    expect(wire).not.toContain('SYNTHETIC_JEV_KEY'); expect(wire).not.toContain('judgment/backup');
    expect(port.requests.every((request) => JSON.stringify(request.state) === '{"field":"config"}'
      || JSON.stringify(request.state) === '{"field":"judgment"}')).toBe(true);
  });

  test('unrelated reference-shaped subtrees and key names retain semantic containment', async () => {
    const port = fakePort((name, question, state) => {
      const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
      if (name === 'kind' && question.type === 'choice') {
        if (field === 'extension' || field === 'judgment') return choiceAnswer(question, 'other', 0.99);
        if (field === 'fallbacks' || field === 'keyName') return choiceAnswer(question, 'secret', 0.99);
      }
      throw new Error(`No authored extension reference fixture for ${name}:${String(field)}`);
    });
    installJudgmentPort(port.port);
    const references = [{ endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'env', keyName: 'PRIVATE_REFERENCE' }];
    expect(await redactStructuredDataAsync({ extension: { judgment: { fallbacks: references }, keyName: 'private-local-value' } }))
      .toEqual({ extension: { judgment: { fallbacks: '[REDACTED]' }, keyName: '[REDACTED]' } });
    const wire = JSON.stringify(port.requests);
    expect(wire).not.toContain('PRIVATE_REFERENCE'); expect(wire).not.toContain('private-local-value');
  });

  test('malformed native reference values are held whole without reading their fields', async () => {
    const port = fakePort(() => { throw new Error('Malformed reference values acquired a semantic reader'); });
    installJudgmentPort(port.port);
    const hiddenExtra = { endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'env', keyName: 'SYNTHETIC_JEV_KEY' };
    Object.defineProperty(hiddenExtra, 'rawKey', { value: 'hidden-private-value', enumerable: false });
    for (const references of [[{ endpoint: 'https://api.typesafe.ai', rawKey: 'inline-private-value' }], [hiddenExtra], undefined])
      expect(await redactStructuredDataAsync({ 'judgment.fallbacks': references })).toEqual({ 'judgment.fallbacks': '[REDACTED]' });
    expect(port.requests).toHaveLength(0);
  });

  test('a native reference declaration cannot release registered or issuer-protected literals', async () => {
    const port = fakePort(() => { throw new Error('Protected reference values acquired a semantic reader'); });
    installJudgmentPort(port.port);
    const source = (keyName: string) => ({ 'judgment.fallbacks': [
      { endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'secret', keyName },
    ] });
    expect(await redactStructuredDataAsync(source('SYNTHETIC_PRIVATE_KEY'), { secretValues: ['SYNTHETIC_PRIVATE_KEY'] }))
      .toEqual({ 'judgment.fallbacks': '[REDACTED]' });
    registerProfileRedactionValues(() => ({ guarded: ['private-profile-name'], absolute: [] }));
    expect(await redactStructuredDataAsync(source('private-profile-name'))).toEqual({ 'judgment.fallbacks': '[REDACTED]' });
    registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/privateOwner', userName: 'privateOwner' }));
    expect(await redactStructuredDataAsync(source('privateOwner'))).toEqual({ 'judgment.fallbacks': '[REDACTED]' });
    expect(await redactStructuredDataAsync(source(`ghp_${'A'.repeat(36)}`))).toEqual({ 'judgment.fallbacks': '[REDACTED]' });
    expect(await redactStructuredDataAsync(source('4111111111111111'))).toEqual({ 'judgment.fallbacks': '[REDACTED]' });
    expect(port.requests).toHaveLength(0);
  });

  test('native reference preservation still requires the original complete source lifetime', async () => {
    const port = fakePort(() => { throw new Error('Stale native references acquired a semantic reader'); });
    installJudgmentPort(port.port);
    const reference = { endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'env', keyName: 'ORIGINAL_REFERENCE' };
    const input = { 'judgment.fallbacks': [reference] };
    expect(await redactStructuredDataAsync(input, { assertCurrent() { reference.keyName = 'CHANGED_REFERENCE'; } }))
      .toBe('[REDACTED]');
    const controller = new AbortController(); controller.abort();
    expect(await redactStructuredDataAsync(input, { signal: controller.signal })).toBe('[REDACTED]');
    expect(port.requests).toHaveLength(0);
  });

  test('hidden native reference descriptor changes retire the retained parser capture', async () => {
    const pending = pausedPort();
    const reference = { endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0', keySource: 'env', keyName: 'SYNTHETIC_JEV_KEY' };
    const input = { 'judgment.fallbacks': [reference], tokenCount: 7 };
    const result = redactStructuredDataAsync(input);
    await pending.ready;
    Object.defineProperty(reference, 'rawKey', { value: 'late-hidden-private-value', enumerable: false });
    pending.release();
    expect(await result).toBe('[REDACTED]');
    expect(JSON.stringify(pending.normal.requests)).not.toContain('late-hidden-private-value');
  });

  test('equal uncertain fields stay masked and are read anew for another complete source', async () => {
    const port = fakePort((name, question) => {
      if (name === 'kind' && question.type === 'choice') return choiceAnswer(question, 'other', 0.45);
      throw new Error(`No authored uncertain-field fixture for ${name}`);
    });
    installJudgmentPort(port.port);
    const input = [{ unresolvedRole: 'first-private-value' }, { unresolvedRole: 'second-private-value' }];
    const expected = [{ unresolvedRole: '[REDACTED]' }, { unresolvedRole: '[REDACTED]' }];
    expect(await redactStructuredDataAsync(input)).toEqual(expected);
    expect(port.requests).toHaveLength(1);
    expect(await redactStructuredDataAsync(input)).toEqual(expected);
    expect(port.requests).toHaveLength(2);
    const wire = JSON.stringify(port.requests);
    expect(wire).not.toContain('first-private-value'); expect(wire).not.toContain('second-private-value');
  });

  test('public redaction refuses asynchronous source assertions before any reading', async () => {
    const port = publicReadings();
    const options = { assertCurrent: async () => { throw new Error('private-owner-error'); } };
    expect(await redactSensitiveDataAsync('ordinary public prose', options)).toBe('[REDACTED]');
    expect(await redactStructuredDataAsync({ documentId: 'ordinary-public-value' }, options)).toBe('[REDACTED]');
    expect(port.requests).toHaveLength(0);
    await expect(prepareProfileRedactionRoles(options)).rejects.toThrow('must be synchronous');
    expect(port.requests).toHaveLength(0);
    await settle();
  });

  test('an asynchronous profile lease cannot admit a public redaction source', async () => {
    const port = publicReadings();
    registerProfileRedactionValues(() => ({ guarded: ['private-profile-value'], absolute: [] }), undefined,
      () => ({ assertCurrent: async () => { throw new Error('private-lease-error'); } }));
    expect(await redactSensitiveDataAsync('ordinary public prose')).toBe('[REDACTED]');
    expect(port.requests).toHaveLength(0);
    await settle();
  });

  test('equal field readings cover local text spans without disclosing either original', async () => {
    const port = publicReadings();
    const input = { documentId: 'documentId=ordinary-one', nested: { documentId: 'documentId=ordinary-two' } };
    expect(await redactStructuredDataAsync(input)).toEqual(input);
    expect(port.requests.filter((request) => request.context?.battery === 'engine.redaction.field-kind'
      && JSON.stringify(request.state) === '{"field":"documentId"}')).toHaveLength(1);
    const wire = JSON.stringify(port.requests);
    expect(wire).not.toContain('ordinary-one'); expect(wire).not.toContain('ordinary-two');
  });

  test('changing a field contract retires operation-local readings before reuse', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(fieldKind.items.kind.question.criteria, 'other');
    if (descriptor === undefined) throw new Error('Expected the declared other criterion');
    let changed = false;
    const port = fakePort((name, question) => {
      if (name === 'kind' && question.type === 'choice') return choiceAnswer(question, 'other', 0.99);
      if (name === 'lineHasCredential' || name === 'spanIsCredential' || name === 'credentialRemains') {
        if (!changed) {
          changed = true;
          Object.defineProperty(fieldKind.items.kind.question.criteria, 'other', { ...descriptor, value: 'Changed contract' });
        }
        return noulAnswer(0.01);
      }
      throw new Error(`No authored contract-retirement fixture for ${name}`);
    });
    installJudgmentPort(port.port);
    try {
      expect(await redactStructuredDataAsync([{ documentId: 'documentId=ordinary-one' }, { documentId: 'ordinary-two' }]))
        .toBe('[REDACTED]');
      expect(changed).toBe(true);
      expect(JSON.stringify(port.requests)).not.toContain('ordinary-two');
    } finally { Object.defineProperty(fieldKind.items.kind.question.criteria, 'other', descriptor); }
  });

  test('cancellation drains four non-cooperating field reads before another group starts', async () => {
    const controller = new AbortController(), ready = Promise.withResolvers<void>();
    let calls = 0;
    const requests: unknown[] = [];
    const normal = publicReadings();
    installJudgmentPort({ ...normal.port, async ask(request) {
      requests.push(request.state);
      if (++calls === 4) ready.resolve();
      return new Promise<never>(() => {});
    } });
    const pending = redactStructuredDataAsync({ tokenCount: 7, password: 'private-one', shippingAddress: 'private-two',
      nested: {}, body: 'private-three' }, { signal: controller.signal });
    await ready.promise; controller.abort();
    expect(await pending).toBe('[REDACTED]'); expect(calls).toBe(4);
    const wire = JSON.stringify(requests);
    for (const value of ['private-one', 'private-two', 'private-three']) expect(wire).not.toContain(value);
  });

  test('registered private object keys remain local and retain distinct JSON slots', async () => {
    const port = publicReadings();
    const privateKeys: readonly [string, string] = ['first-unmarked-private-key', 'second-unmarked-private-key'];
    const input = { [privateKeys[0]]: 'first-private-child', [privateKeys[1]]: 'second-private-child', tokenCount: 7 };
    const result = await redactStructuredDataAsync(input, { secretValues: privateKeys });
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected a protected JSON object');
    expect(Object.keys(result)).toHaveLength(3);
    const output = JSON.stringify(result), wire = JSON.stringify(port.requests);
    for (const value of [...privateKeys, 'first-private-child', 'second-private-child']) {
      expect(output).not.toContain(value); expect(wire).not.toContain(value);
    }
    expect(result).toHaveProperty('tokenCount', 7);
  });

  test('source mutation by an external currentness guard is caught before dispatch', async () => {
    const port = publicReadings(), input = { tokenCount: 7 };
    expect(await redactStructuredDataAsync(input, { assertCurrent: () => { input.tokenCount = 9; } })).toBe('[REDACTED]');
    expect(port.requests).toHaveLength(0);
  });

  test('synchronous array cycles and accessors do not execute code or leak values', () => {
    const array: unknown[] = []; array.push(array);
    expect(redactStructuredData(array)).toEqual(['[Circular]']);
    let reads = 0;
    const input = Object.defineProperty({}, 'privateField', { enumerable: true, get() { reads++; return 'getter-private-value'; } });
    expect(redactStructuredData(input)).toEqual({ privateField: '[REDACTED]' }); expect(reads).toBe(0);
  });

  test('all three actual export formats cover reasoning, tool arguments, title and attachments', async () => {
    const port = publicReadings(), secret = 'registered-private-prose';
    const messages: ExportMessage[] = [{ role: 'assistant', content: `ordinary ${secret}`, reasoningContent: secret,
      reasoningSummary: secret, toolCalls: [{ id: 'call-1', name: 'tool', arguments: { unlockPassphrase: 'unknown-private-value', nested: { body: secret } } }] },
      { role: 'user', content: [{ type: 'image', data: 'private-image-data', mediaType: 'image/png' }] }];
    for (const exporter of [exportToJSON, exportToHTML, exportToMarkdownExtended]) {
      const output = await exporter(messages, { title: secret }, { redact: true, secretValues: [secret] });
      for (const value of [secret, 'unknown-private-value', 'private-image-data']) expect(output).not.toContain(value);
    }
    const wire = JSON.stringify(port.requests);
    for (const value of [secret, 'unknown-private-value', 'private-image-data']) expect(wire).not.toContain(value);
  });

  test('credential in residual prose cannot be cleared by an ordinary target span', async () => {
    const port = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, 'other', 0.99)
      : noulAnswer(name === 'lineHasCredential' ? 0.99 : 0.01));
    installJudgmentPort(port.port);
    const output = await redactSensitiveDataAsync('The recovery phrase is purple marsh fox; documentId=ordinary');
    expect(output).not.toContain('purple marsh fox');
    expect(JSON.stringify(port.requests)).not.toContain('purple marsh fox');
  });

  test('an independently protected password can coexist with an ordinary local span', async () => {
    const port = fakePort((name, question, state) => {
      if (question.type === 'choice') {
        const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
        return choiceAnswer(question, field === 'password' ? 'secret' : 'other', 0.99);
      }
      const liveSecret = JSON.stringify(state).includes('"field":"password"');
      return noulAnswer(name === 'lineHasCredential' && liveSecret ? 0.99 : 0.01);
    });
    installJudgmentPort(port.port);
    expect(await redactSensitiveDataAsync('password=private-value; documentId=ordinary'))
      .toBe('password=[REDACTED]; documentId=ordinary');
    expect(JSON.stringify(port.requests)).not.toContain('private-value');
  });

  test('a positive residual reading withholds the complete line despite a protected source span', async () => {
    const port = fakePort((name, question, state) => {
      if (question.type === 'choice') {
        const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
        return choiceAnswer(question, field === 'password' ? 'secret' : 'other', 0.99);
      }
      return noulAnswer(name === 'credentialRemains' ? 0.99 : 0.01);
    });
    installJudgmentPort(port.port);
    expect(await redactSensitiveDataAsync('password=private-value; documentId=ordinary')).toBe('[REDACTED]');
    expect(port.requests.some((request) => request.context?.battery === 'engine.redaction.residual-credential')).toBe(true);
    expect(JSON.stringify(port.requests)).not.toContain('private-value');
  });

  test('cancelled profile-role waiter promptly exits without poisoning another source-owned waiter', async () => {
    const pending = pausedPort(), controller = new AbortController();
    registerProfileRedactionValues(() => ({ guarded: ['USD'], absolute: [], guardedFields: [
      { value: 'USD', field: 'commerce.currency', sourceKind: 'field' },
    ] }));
    const cancelled = prepareProfileRedactionRoles({ signal: controller.signal });
    await pending.ready;
    const surviving = prepareProfileRedactionRoles();
    controller.abort();
    await expect(cancelled).rejects.toThrow('Redaction operation is no longer current');
    pending.release(); await surviving;
    expect(await redactSensitiveDataAsync('The USD amount is ordinary')).toContain('USD');
  });

  test('complete export source mutation prevents publication of a late result', async () => {
    const pending = pausedPort();
    const messages: ExportMessage[] = [{ role: 'user', content: 'public ordinary sentence' }];
    const result = exportToJSON(messages, undefined, { redact: true });
    await pending.ready; messages[0]!.content = 'changed private value'; pending.release();
    await expect(result).rejects.toThrow('Export source is no longer current');
    expect(JSON.stringify(pending.normal.requests)).not.toContain('changed private value');
  });

  test('redacted JSON excludes undeclared message, content-part and usage properties', async () => {
    const port = publicReadings();
    const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ordinary sentence',
      privateAnnotation: 'private-part-extra' }], privateAnnotation: 'private-message-extra',
      usage: { inputTokens: 2, outputTokens: 3, privateAnnotation: 'private-usage-extra' } };
    const output = await exportToJSON([message], undefined, { redact: true });
    for (const value of ['private-part-extra', 'private-message-extra', 'private-usage-extra']) {
      expect(output).not.toContain(value); expect(JSON.stringify(port.requests)).not.toContain(value);
    }
    const parsed = JSON.parse(output);
    expect(parsed.messages[0].content).toEqual([{ type: 'text', text: 'ordinary sentence' }]);
    expect(parsed.messages[0].usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  });

  test('export structural admission rejects getters before any wire or getter execution', async () => {
    const port = publicReadings(); let reads = 0;
    const message = { role: 'user' as const, get content() { reads++; return 'getter-private-value'; } };
    await expect(exportToJSON([message], undefined, { redact: true })).rejects.toThrow();
    expect(reads).toBe(0); expect(port.requests).toHaveLength(0);
  });
});
