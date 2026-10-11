import { describe, expect, test } from 'bun:test';
import {
  BROWSER_JUDGMENT_BATTERY_IDS,
  BROWSER_JUDGMENT_LIMITS as LIMIT,
  BROWSER_JUDGMENT_PATH,
  BROWSER_JUDGMENT_PROTOCOL_VERSION,
  BrowserJudgmentError,
  browserJudgmentRefusal,
  type BrowserJudgmentErrorCode,
} from '../daemon-sdk/src/browser-judgment-contract.js';
import {
  captureBrowserJudgmentJson,
  judgmentRecord,
  judgmentText,
  parseBrowserJudgmentRequest,
} from '../daemon-sdk/src/browser-judgment-validation.js';

// Synthetic protocol fixtures only: no daemon, provider, credential, or live proof.
const REQUEST_ID = '12345678-1234-4234-9234-123456789abc';
const ERROR_BATTERY = 'webui.errors.daemon-refusal';
const STATUS_BATTERY = 'webui.status.badge-tone';
const RANK_BATTERY = 'webui.palette.command-rank';

function envelope(battery: string = ERROR_BATTERY, input: unknown = { errorRef: 'fixture-error' }) {
  return { protocolVersion: 1, requestId: REQUEST_ID, battery, batteryVersion: 1, input };
}

function rankInput(overrides: Record<string, unknown> = {}) {
  return {
    query: { kind: 'inline', text: 'fixture query' },
    registryVersion: 'fixture-registry-v1',
    candidates: [{ kind: 'builtin', commandId: 'fixture-command' }],
    ...overrides,
  };
}

function expectRefusal(action: () => unknown, code: BrowserJudgmentErrorCode, status = 400): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(BrowserJudgmentError);
  expect(caught).toMatchObject({ name: 'BrowserJudgmentError', code, status });
}

function invalidRequest(value: unknown): void {
  expectRefusal(() => parseBrowserJudgmentRequest(value), 'JUDGMENT_INVALID_INPUT');
}

function tooLarge(action: () => unknown): void {
  expectRefusal(action, 'JUDGMENT_INPUT_TOO_LARGE', 413);
}

describe('browser judgment closed envelope', () => {
  test('publishes the fixed protocol and closed battery IDs', () => {
    expect(BROWSER_JUDGMENT_PROTOCOL_VERSION).toBe(1);
    expect(BROWSER_JUDGMENT_PATH).toBe('/api/judgment/batteries/run');
    expect(BROWSER_JUDGMENT_BATTERY_IDS).toEqual(['webui.voice.speech-seams', ERROR_BATTERY, STATUS_BATTERY, RANK_BATTERY, 'webui.mail.reply-subject', 'webui.pwa.install-platform', 'webui.credentials.provider-key', 'webui.code.language', 'webui.config.credential-key', 'webui.settings.card-material-key', 'webui.models.catalog-provider-match']);
    expect(Object.isFrozen(LIMIT)).toBe(true);
  });

  test('accepts a complete request and rejects each missing envelope field', () => {
    expect<unknown>(parseBrowserJudgmentRequest(envelope())).toEqual(envelope());
    for (const key of Object.keys(envelope())) {
      const value: Record<string, unknown> = { ...envelope() };
      delete value[key];
      invalidRequest(value);
    }
  });

  test('rejects unknown envelope fields, including caller-owned execution settings', () => {
    for (const key of ['extra', 'prompt', 'model', 'route', 'credentials']) {
      invalidRequest({ ...envelope(), [key]: 'synthetic-untrusted-value' });
    }
  });

  test('rejects non-record envelopes', () => {
    for (const value of [null, false, 1, 'request', [], new Date(0)]) invalidRequest(value);
  });

  test('distinguishes unsupported protocol versions from malformed versions', () => {
    for (const protocolVersion of [0, -1, 2]) {
      expectRefusal(() => parseBrowserJudgmentRequest({ ...envelope(), protocolVersion }),
        'JUDGMENT_PROTOCOL_VERSION_UNSUPPORTED', 409);
    }
    for (const protocolVersion of ['1', 1.5, null, true, NaN, Infinity]) {
      invalidRequest({ ...envelope(), protocolVersion });
    }
  });

  test('distinguishes unsupported battery versions from malformed versions', () => {
    expectRefusal(() => parseBrowserJudgmentRequest({ ...envelope(), batteryVersion: 2 }),
      'JUDGMENT_BATTERY_VERSION_UNSUPPORTED', 409);
    for (const batteryVersion of [0, -1, '1', 1.5, null, true, NaN, Infinity]) {
      invalidRequest({ ...envelope(), batteryVersion });
    }
  });

  test('rejects unknown or malformed battery names without accepting caller-selected batteries', () => {
    expectRefusal(() => parseBrowserJudgmentRequest(envelope('fixture.unknown')),
      'JUDGMENT_BATTERY_UNKNOWN', 404);
    expectRefusal(() => parseBrowserJudgmentRequest(envelope('x'.repeat(128))),
      'JUDGMENT_BATTERY_UNKNOWN', 404);
    tooLarge(() => parseBrowserJudgmentRequest(envelope('x'.repeat(129))));
    for (const battery of ['', null, 1, []]) invalidRequest({ ...envelope(), battery });
  });

  test('accepts UUID versions 1 through 8, valid variants, and upper-case hex', () => {
    for (const version of '12345678') {
      for (const variant of '89ab') {
        const requestId = `12345678-1234-${version}234-${variant}234-123456789abc`;
        expect(parseBrowserJudgmentRequest({ ...envelope(), requestId }).requestId).toBe(requestId);
      }
    }
    expect(parseBrowserJudgmentRequest({ ...envelope(), requestId: REQUEST_ID.toUpperCase() }).requestId)
      .toBe(REQUEST_ID.toUpperCase());
  });

  test('rejects malformed request IDs and enforces their length bound', () => {
    for (const requestId of [
      '', 'not-a-uuid', REQUEST_ID.replaceAll('-', ''),
      REQUEST_ID.replace('-4234-', '-0234-'), REQUEST_ID.replace('-4234-', '-9234-'),
      REQUEST_ID.replace('-9234-', '-7234-'), REQUEST_ID.replace('abc', 'abg'), null, 123,
    ]) invalidRequest({ ...envelope(), requestId });
    tooLarge(() => parseBrowserJudgmentRequest({ ...envelope(), requestId: `${REQUEST_ID} ` }));
  });
});

describe('browser judgment battery input variants', () => {
  test('daemon refusal admits only a bounded, nonempty error reference', () => {
    expect(parseBrowserJudgmentRequest(envelope(ERROR_BATTERY, { errorRef: 'x'.repeat(LIMIT.referenceChars) })))
      .toMatchObject({ battery: ERROR_BATTERY });
    tooLarge(() => parseBrowserJudgmentRequest(envelope(ERROR_BATTERY, { errorRef: 'x'.repeat(LIMIT.referenceChars + 1) })));
    for (const input of [null, {}, { errorRef: '' }, { errorRef: 1 },
      { errorRef: 'fixture-error', message: 'caller-supplied error text' }]) {
      invalidRequest(envelope(ERROR_BATTERY, input));
    }
  });

  test('accepts both status vocabularies with each registered source variant', () => {
    for (const vocabulary of ['badge', 'library-dot']) {
      for (const source of [{ kind: 'catalog', labelId: 'fixture-label' }, { kind: 'daemon', statusRef: 'fixture-status' }]) {
        const request = envelope(STATUS_BATTERY, { vocabulary, source });
        expect<unknown>(parseBrowserJudgmentRequest(request)).toEqual(request);
      }
    }
  });

  test('status input and discriminated source records reject missing and extra fields', () => {
    for (const input of [
      null, {}, { vocabulary: 'other', source: { kind: 'catalog', labelId: 'fixture-label' } },
      { vocabulary: 'badge' }, { source: { kind: 'catalog', labelId: 'fixture-label' } },
      { vocabulary: 'badge', source: { kind: 'catalog', labelId: 'fixture-label' }, text: 'untrusted' },
    ]) invalidRequest(envelope(STATUS_BATTERY, input));
    for (const source of [
      null, false, 'catalog', [], {}, { kind: 'other', labelId: 'fixture-label' },
      { kind: 'catalog' }, { kind: 'catalog', labelId: '' }, { kind: 'catalog', labelId: 1 },
      { kind: 'catalog', labelId: 'fixture-label', statusRef: 'fixture-status' },
      { kind: 'daemon' }, { kind: 'daemon', statusRef: '' }, { kind: 'daemon', statusRef: 1 },
      { kind: 'daemon', statusRef: 'fixture-status', labelId: 'fixture-label' },
    ]) invalidRequest(envelope(STATUS_BATTERY, { vocabulary: 'badge', source }));
  });

  test('bounds references in both status source variants', () => {
    for (const [kind, key] of [['catalog', 'labelId'], ['daemon', 'statusRef']] as const) {
      expect(parseBrowserJudgmentRequest(envelope(STATUS_BATTERY, {
        vocabulary: 'badge', source: { kind, [key]: 'x'.repeat(LIMIT.referenceChars) },
      }))).toMatchObject({ battery: STATUS_BATTERY });
      tooLarge(() => parseBrowserJudgmentRequest(envelope(STATUS_BATTERY, {
        vocabulary: 'badge', source: { kind, [key]: 'x'.repeat(LIMIT.referenceChars + 1) },
      })));
    }
  });

  test('accepts both palette query variants and both candidate variants', () => {
    for (const query of [{ kind: 'inline', text: 'fixture query' }, { kind: 'reference', queryRef: 'fixture-query' }]) {
      const request = envelope(RANK_BATTERY, rankInput({ query, candidates: [
        { kind: 'builtin', commandId: 'fixture-same-id' },
        { kind: 'chat', sessionId: 'fixture-same-id' },
      ] }));
      expect<unknown>(parseBrowserJudgmentRequest(request)).toEqual(request);
    }
  });

  test('palette input has exactly its three required fields', () => {
    for (const key of ['query', 'registryVersion', 'candidates']) {
      const input: Record<string, unknown> = rankInput();
      delete input[key];
      invalidRequest(envelope(RANK_BATTERY, input));
    }
    invalidRequest(envelope(RANK_BATTERY, rankInput({ prompt: 'caller-supplied prompt' })));
    for (const registryVersion of ['', null, 1]) invalidRequest(envelope(RANK_BATTERY, rankInput({ registryVersion })));
  });

  test('palette query union rejects malformed, mixed, and extra fields', () => {
    for (const query of [
      null, [], 'fixture-query', {}, { kind: 'other', text: 'fixture query' },
      { kind: 'inline' }, { kind: 'inline', text: '' }, { kind: 'inline', text: 1 },
      { kind: 'inline', text: 'fixture query', queryRef: 'fixture-query' },
      { kind: 'reference' }, { kind: 'reference', queryRef: '' }, { kind: 'reference', queryRef: 1 },
      { kind: 'reference', queryRef: 'fixture-query', text: 'fixture query' },
    ]) invalidRequest(envelope(RANK_BATTERY, rankInput({ query })));
  });

  test('bounds palette queries, registry version, and candidate identifiers at the exact limit', () => {
    for (const [kind, key, bound] of [
      ['inline', 'text', LIMIT.queryChars], ['reference', 'queryRef', LIMIT.referenceChars],
    ] as const) {
      expect(parseBrowserJudgmentRequest(envelope(RANK_BATTERY, rankInput({ query: { kind, [key]: 'x'.repeat(bound) } }))))
        .toMatchObject({ battery: RANK_BATTERY });
      tooLarge(() => parseBrowserJudgmentRequest(envelope(RANK_BATTERY,
        rankInput({ query: { kind, [key]: 'x'.repeat(bound + 1) } }))));
    }
    expect(parseBrowserJudgmentRequest(envelope(RANK_BATTERY,
      rankInput({ registryVersion: 'x'.repeat(LIMIT.referenceChars) })))).toMatchObject({ battery: RANK_BATTERY });
    tooLarge(() => parseBrowserJudgmentRequest(envelope(RANK_BATTERY,
      rankInput({ registryVersion: 'x'.repeat(LIMIT.referenceChars + 1) }))));
    for (const [kind, key] of [['builtin', 'commandId'], ['chat', 'sessionId']] as const) {
      expect(parseBrowserJudgmentRequest(envelope(RANK_BATTERY,
        rankInput({ candidates: [{ kind, [key]: 'x'.repeat(LIMIT.referenceChars) }] }))))
        .toMatchObject({ battery: RANK_BATTERY });
      tooLarge(() => parseBrowserJudgmentRequest(envelope(RANK_BATTERY,
        rankInput({ candidates: [{ kind, [key]: 'x'.repeat(LIMIT.referenceChars + 1) }] }))));
    }
  });

  test('palette candidates require a nonempty bounded array of unique typed identifiers', () => {
    for (const candidates of [null, {}, 'fixture', [],
      [{ kind: 'builtin', commandId: 'fixture' }, { kind: 'builtin', commandId: 'fixture' }],
      [{ kind: 'chat', sessionId: 'fixture' }, { kind: 'chat', sessionId: 'fixture' }],
    ]) invalidRequest(envelope(RANK_BATTERY, rankInput({ candidates })));
    const candidates = Array.from({ length: LIMIT.candidates }, (_, index) => ({ kind: 'builtin', commandId: `fixture-${index}` }));
    expect(parseBrowserJudgmentRequest(envelope(RANK_BATTERY, rankInput({ candidates }))))
      .toMatchObject({ input: { candidates } });
    tooLarge(() => parseBrowserJudgmentRequest(envelope(RANK_BATTERY,
      rankInput({ candidates: [...candidates, { kind: 'builtin', commandId: 'fixture-overflow' }] }))));
  });

  test('candidate unions reject malformed, mixed, and extra fields', () => {
    for (const candidate of [
      null, [], 'fixture-command', {}, { kind: 'other', commandId: 'fixture-command' },
      { kind: 'builtin' }, { kind: 'builtin', commandId: '' }, { kind: 'builtin', commandId: 1 },
      { kind: 'builtin', commandId: 'fixture-command', sessionId: 'fixture-session' },
      { kind: 'chat' }, { kind: 'chat', sessionId: '' }, { kind: 'chat', sessionId: 1 },
      { kind: 'chat', sessionId: 'fixture-session', commandId: 'fixture-command' },
    ]) invalidRequest(envelope(RANK_BATTERY, rankInput({ candidates: [candidate] })));
  });
});

describe('bounded JSON capture before admission', () => {
  test('captures ordinary and null-prototype records into immutable detached snapshots', () => {
    const source = Object.assign(Object.create(null) as Record<string, unknown>, {
      items: [{ value: 'before' }], truth: true, empty: null,
    });
    const captured = captureBrowserJudgmentJson(source) as { items: { value: string }[]; truth: boolean; empty: null };
    expect(captured).toEqual(source);
    expect(captured).not.toBe(source);
    expect(Object.getPrototypeOf(captured)).toBeNull();
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.items)).toBe(true);
    expect(Object.isFrozen(captured.items[0])).toBe(true);
    (source.items as { value: string }[])[0]!.value = 'after';
    expect(captured.items[0]!.value).toBe('before');
  });

  test('the admitted request is also a deep snapshot, including discriminants and candidate IDs', () => {
    const input = rankInput();
    const request = envelope(RANK_BATTERY, input);
    const captured = parseBrowserJudgmentRequest(request);
    request.battery = ERROR_BATTERY;
    input.candidates[0]!.commandId = 'changed-after-admission';
    expect(captured).toMatchObject({ battery: RANK_BATTERY, input: {
      candidates: [{ kind: 'builtin', commandId: 'fixture-command' }],
    } });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.input)).toBe(true);
  });

  test('only finite numeric JSON values are captured', () => {
    for (const value of [0, -1, 0.5, Number.MIN_VALUE, Number.MAX_VALUE]) expect(captureBrowserJudgmentJson(value)).toBe(value);
    for (const value of [NaN, Infinity, -Infinity]) {
      expectRefusal(() => captureBrowserJudgmentJson({ value }), 'JUDGMENT_INVALID_INPUT');
    }
  });

  test('rejects values that JSON cannot represent faithfully', () => {
    for (const value of [undefined, 1n, Symbol('fixture'), () => null, new Date(0), new Map(), new Set(), /fixture/, new Uint8Array(1)]) {
      expectRefusal(() => captureBrowserJudgmentJson(value), 'JUDGMENT_INVALID_INPUT');
      expectRefusal(() => captureBrowserJudgmentJson({ value }), 'JUDGMENT_INVALID_INPUT');
    }
  });

  test('rejects foreign prototypes, symbols, hidden properties, and prototype-pollution keys', () => {
    const hidden = Object.defineProperty({}, 'hidden', { value: 'fixture', enumerable: false });
    const symbol = { [Symbol('fixture')]: 'value' };
    for (const value of [Object.create({ inherited: true }), hidden, symbol, Object.setPrototypeOf([], null)]) {
      expectRefusal(() => captureBrowserJudgmentJson(value), 'JUDGMENT_INVALID_INPUT');
    }
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const value = Object.create(null) as Record<string, unknown>;
      value[key] = 'fixture';
      expectRefusal(() => captureBrowserJudgmentJson(value), 'JUDGMENT_INVALID_INPUT');
    }
  });

  test('never invokes envelope or nested object accessors', () => {
    let reads = 0;
    const getter = { enumerable: true, get() { reads++; throw new Error('getter must never run'); } };
    for (const key of ['protocolVersion', 'battery', 'input']) {
      invalidRequest(Object.defineProperty(envelope(), key, getter));
    }
    invalidRequest(envelope(STATUS_BATTERY, { vocabulary: 'badge', source: Object.defineProperty({}, 'kind', getter) }));
    invalidRequest(envelope(ERROR_BATTERY, Object.defineProperty({}, 'errorRef', getter)));
    const setter = Object.defineProperty({}, 'value', { enumerable: true, set(_value: unknown) { reads++; } });
    expectRefusal(() => captureBrowserJudgmentJson(setter), 'JUDGMENT_INVALID_INPUT');
    expect(reads).toBe(0);
  });

  test('never invokes array element accessors or serialization hooks', () => {
    let calls = 0;
    const array = Object.defineProperty([null], '0', { enumerable: true, get() { calls++; return null; } });
    expectRefusal(() => captureBrowserJudgmentJson(array), 'JUDGMENT_INVALID_INPUT');
    const withHook = { toJSON() { calls++; return envelope(); } };
    invalidRequest(withHook);
    expect(calls).toBe(0);
  });

  test('rejects object, array, and indirect cycles but accepts repeated noncyclic references', () => {
    const self: Record<string, unknown> = {};
    self.self = self;
    const array: unknown[] = [];
    array.push(array);
    const indirect: Record<string, unknown> = {};
    indirect.child = { root: indirect };
    for (const value of [self, array, indirect]) expectRefusal(() => captureBrowserJudgmentJson(value), 'JUDGMENT_INVALID_INPUT');
    const shared = { value: 'fixture' };
    expect(captureBrowserJudgmentJson([shared, shared])).toEqual([{ value: 'fixture' }, { value: 'fixture' }]);
  });

  test('rejects sparse arrays and array properties outside indexed JSON elements', () => {
    const sparse = new Array(2);
    sparse[1] = null;
    const extra = Object.assign([null], { extra: 'fixture' });
    const symbol = Object.assign([null], { [Symbol('fixture')]: true });
    for (const value of [sparse, extra, symbol]) expectRefusal(() => captureBrowserJudgmentJson(value), 'JUDGMENT_INVALID_INPUT');
  });

  test('accepts the array item ceiling and rejects the next item', () => {
    expect(captureBrowserJudgmentJson(Array(LIMIT.arrayItems).fill(null))).toHaveLength(LIMIT.arrayItems);
    tooLarge(() => captureBrowserJudgmentJson(Array(LIMIT.arrayItems + 1).fill(null)));
  });

  test('accepts exactly the depth ceiling and rejects one deeper', () => {
    let value: unknown = null;
    for (let depth = 0; depth < LIMIT.depth; depth++) value = [value];
    expect(() => captureBrowserJudgmentJson(value)).not.toThrow();
    tooLarge(() => captureBrowserJudgmentJson([value]));
  });

  test('counts primitive and container nodes against the exact node ceiling', () => {
    // Root + 32 child arrays + 4,063 nulls = 4,096 nodes; every array remains bounded.
    const value = Array.from({ length: 32 }, (_, index) => Array(index === 31 ? 126 : 127).fill(null));
    expect(LIMIT.nodes).toBe(4096);
    expect(() => captureBrowserJudgmentJson(value)).not.toThrow();
    value[31]!.push(null);
    tooLarge(() => captureBrowserJudgmentJson(value));
  });

  test('counts both keys and values against the total text ceiling', () => {
    expect(captureBrowserJudgmentJson('x'.repeat(LIMIT.textChars))).toHaveLength(LIMIT.textChars);
    tooLarge(() => captureBrowserJudgmentJson('x'.repeat(LIMIT.textChars + 1)));
    expect(() => captureBrowserJudgmentJson({ a: 'x'.repeat(LIMIT.textChars - 1) })).not.toThrow();
    tooLarge(() => captureBrowserJudgmentJson({ a: 'x'.repeat(LIMIT.textChars) }));
    tooLarge(() => captureBrowserJudgmentJson({ ['x'.repeat(LIMIT.textChars + 1)]: null }));
  });

  test('rejects malformed nested values before reading version or battery discriminants', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    invalidRequest({ ...envelope('fixture.unknown', cyclic), protocolVersion: 2 });
    tooLarge(() => parseBrowserJudgmentRequest({ ...envelope('fixture.unknown', 'x'.repeat(LIMIT.textChars + 1)), protocolVersion: 2 }));
  });
});

describe('closed-schema primitives and safe refusals', () => {
  test('record helper requires exactly named own data properties without calling accessors', () => {
    const record = Object.assign(Object.create(null) as Record<string, unknown>, { field: 'fixture' });
    expect(judgmentRecord(record, ['field'])).toBe(record);
    let calls = 0;
    for (const value of [null, [], {}, { field: 'fixture', extra: true },
      Object.create({ field: 'fixture' }), { field: 'fixture', [Symbol('fixture')]: true },
      Object.defineProperty({}, 'field', { enumerable: true, get() { calls++; return 'fixture'; } }),
    ]) expectRefusal(() => judgmentRecord(value, ['field']), 'JUDGMENT_INVALID_INPUT');
    expect(calls).toBe(0);
  });

  test('text helper rejects empty/nontext values and distinguishes overflow', () => {
    expect(judgmentText('fixture', 7)).toBe('fixture');
    tooLarge(() => judgmentText('fixture!', 7));
    for (const value of ['', null, 1, false, []]) expectRefusal(() => judgmentText(value), 'JUDGMENT_INVALID_INPUT');
  });

  test('maps a registered refusal to its fixed held envelope', () => {
    expect(browserJudgmentRefusal(new BrowserJudgmentError('JUDGMENT_INVALID_INPUT'))).toEqual({
      status: 400,
      body: { protocolVersion: 1, status: 'held', error: {
        code: 'JUDGMENT_INVALID_INPUT', message: 'The judgment request does not match its closed schema.',
      } },
    });
  });

  test('does not expose arbitrary error messages, stacks, or lookalike error payloads', () => {
    const marker = 'synthetic-private-detail';
    const expected = browserJudgmentRefusal(new BrowserJudgmentError('JUDGMENT_UNAVAILABLE'));
    for (const error of [new Error(marker), marker, null, { code: 'JUDGMENT_INVALID_INPUT', status: 400, message: marker }]) {
      const refusal = browserJudgmentRefusal(error);
      expect(refusal).toEqual(expected);
      expect(JSON.stringify(refusal)).not.toContain(marker);
      expect(JSON.stringify(refusal)).not.toContain('stack');
    }
  });
  test('reconstructs fixed refusals when another layer alters an actual error instance', () => {
    const error = new BrowserJudgmentError('JUDGMENT_INVALID_INPUT');
    const expected = browserJudgmentRefusal(error);
    Object.defineProperties(error, { message: { get() { throw new Error('synthetic-private-detail'); } }, status: { value: 200 } });
    expect(browserJudgmentRefusal(error)).toEqual(expected);
    Object.defineProperty(error, 'code', { get() { throw new Error('synthetic-private-detail'); } });
    expect(browserJudgmentRefusal(error)).toEqual(browserJudgmentRefusal(null));
  });
});
