import { describe, expect, test } from 'bun:test';
import { buildErrorResponseBody, jsonErrorResponse } from '../daemon-sdk/src/error-response.ts';
import { createHttpStatusError } from '../errors/src/index.ts';

const reference = '11111111-1111-4111-8111-111111111111';
const body = { error: 'Synthetic operation failure', status: 409 };
describe('server-issued error reference wire field', () => {
  test('only an explicit privileged issuer option attaches an opaque reference', async () => {
    expect(buildErrorResponseBody(body, { isPrivileged: true, errorRef: reference })).toEqual({ ...body, errorRef: reference });
    expect(await jsonErrorResponse(body, { isPrivileged: true, errorRef: reference }).json()).toEqual({ ...body, errorRef: reference });
    for (const options of [{ errorRef: reference }, { isPrivileged: false, errorRef: reference }, { isPrivileged: true, errorRef: 'not-a-receipt' }]) {
      expect(Object.hasOwn(buildErrorResponseBody(body, options), 'errorRef')).toBe(false);
    }
  });

  test.each([false, true])('a thrown or upstream reference is never copied, privileged=%s', (isPrivileged) => {
    for (const error of [{ ...body, errorRef: reference }, Object.assign(new Error('synthetic'), { errorRef: reference })]) {
      const result = buildErrorResponseBody(error, { isPrivileged });
      expect(Object.hasOwn(result, 'errorRef')).toBe(false); expect(JSON.stringify(result)).not.toContain(reference);
    }
  });

  test('an untrusted own or inherited reference getter is neither evaluated nor forwarded', () => {
    let reads = 0;
    const own = { ...body }; Object.defineProperty(own, 'errorRef', { enumerable: true, get() { reads++; throw new Error('synthetic-private-getter'); } });
    const inherited = Object.assign(Object.create({ get errorRef() { reads++; return reference; } }), body) as typeof body;
    for (const error of [own, inherited]) {
      const result = buildErrorResponseBody(error, { isPrivileged: true });
      expect('errorRef' in result).toBe(false); expect(result.error).toBe(body.error);
    }
    expect(reads).toBe(0);
    expect(buildErrorResponseBody(own, { isPrivileged: true, errorRef: reference }).errorRef).toBe(reference);
    expect(reads).toBe(0);
  });

  test('the client keeps the parsed receipt body without turning inferred HTTP codes into explicit daemon codes', () => {
    const canonical = buildErrorResponseBody(body, { isPrivileged: true, errorRef: reference });
    const error = createHttpStatusError(409, 'http://localhost/api/sessions/synthetic/steer', 'POST', canonical);
    expect(error.body).toBe(canonical); expect((error.body as typeof canonical).errorRef).toBe(reference);
    expect(Object.hasOwn(canonical, 'code')).toBe(false);
    expect(error.code).toBe('CONFLICT');
  });

  test('the no-reference result owns canonical frozen fields without caller identity', () => {
    const result = buildErrorResponseBody(body, { isPrivileged: true });
    expect(result).not.toBe(body); expect(result).toEqual(body); expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
  test.each([false, true])('actual JSON refuses unissued toJSON references, with trusted issuer=%s', async (trusted) => {
    let calls = 0; const issued = '22222222-2222-4222-8222-222222222222';
    for (const untrusted of [undefined, 'untrusted']) {
      const error = { ...body, ...(untrusted === undefined ? {} : { errorRef: untrusted }),
        toJSON() { calls++; return { ...body, errorRef: reference }; } };
      const response = jsonErrorResponse(error, { isPrivileged: true, ...(trusted ? { errorRef: issued } : {}) });
      const wire = await response.json() as Record<string, unknown>;
      expect(wire.errorRef).toBe(trusted ? issued : undefined); expect(wire.error).toBe(body.error);
    }
    expect(calls).toBe(0);
  });

  test('inherited JSON hooks cannot replace or inject the actual wire reference', async () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'); let calls = 0; let response: Response;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() { calls++; throw new Error('synthetic-private-serialization'); } });
      response = jsonErrorResponse(body, { isPrivileged: true, errorRef: reference });
    } finally { if (original) Object.defineProperty(Object.prototype, 'toJSON', original); else Reflect.deleteProperty(Object.prototype, 'toJSON'); }
    expect(calls).toBe(0); expect((await response!.json() as Record<string, unknown>).errorRef).toBe(reference);
  });

  test('the trusted reference getter is captured once before validation and use', () => {
    let reads = 0;
    const result = buildErrorResponseBody(body, { isPrivileged: true, get errorRef() { reads++; return reads <= 2 ? reference : 'synthetic-unvalidated'; } });
    expect(reads).toBe(1); expect(result.errorRef).toBe(reference);
  });

  test('malformed documented fields and field accessors cannot contribute serialization callbacks', async () => {
    let calls = 0;
    const error = { ...body, provider: { toJSON() { calls++; return 'private'; } }, recoverable: 'yes', retryAfterMs: Infinity,
      get hint() { calls++; throw new Error('private'); } };
    const response = jsonErrorResponse(error, { isPrivileged: true });
    const wire = await response.json() as Record<string, unknown>;
    expect(wire).toEqual(body); expect(calls).toBe(0);
  });

});
