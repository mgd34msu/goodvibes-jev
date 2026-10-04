import { expect, test } from 'bun:test';
import { GatewayMethodCatalog, type GatewayMethodInvocation } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerNativeConversationIntakeGatewayMethods } from '../sdk/src/platform/control-plane/routes/native-intake.js';
import { NativeConversationIntakeError, type NativeConversationIntakeHost } from '../sdk/src/platform/workflow/work-ledger/native-intake.js';
import type { NativeConversationIntakeResult } from '../sdk/src/platform/workflow/work-ledger/native-intake-wire.js';
import type { NativePairedSnapshot } from '../sdk/src/platform/security/http-auth.js';
const scopes = ['read:work-ledger', 'write:work-ledger'];
const sourceRef = { version: 1 as const, inputId: 'input-1', sourceId: 'source-1', sourceRevision: 'revision-1', sessionId: 'session-1' };
const captured = (): NativeConversationIntakeResult => ({ kind: 'captured', projectId: 'project-1', requestId: 'request-1', sourceRef: { ...sourceRef } });
const captureRequest = () => ({ requestId: 'request-1', inputId: 'input-1', text: '  Exact source 🧭  ', unsupportedSources: [] });
const request = (operation: string) => operation === 'capture' ? captureRequest()
  : operation === 'get' ? { inputId: 'input-1' } : { inputId: 'input-1', sourceRevision: 'revision-1' };
function fixture(value: () => NativeConversationIntakeResult | Promise<NativeConversationIntakeResult> = captured) {
  let authorized = true;
  let current: NativePairedSnapshot | null = { kind: 'pairing-token', tokenId: 'token-1', principalId: 'pairing:token-1', authorityId: 'pairing:token-1', authorityRevision: 'token-1', scopes };
  const calls: string[] = []; const catalog = new GatewayMethodCatalog();
  const host: Pick<NativeConversationIntakeHost, 'capture' | 'get' | 'admit' | 'resume' | 'cancel'> = {
    capture: async (input, authority, options) => { calls.push('capture'); expect(input).toEqual(captureRequest()); expect(authority.current()).toEqual(current); expect(options?.isAuthorized?.()).toBe(true); return await value(); },
    get: async () => { calls.push('get'); return await value(); },
    admit: async () => { calls.push('admit'); return await value(); },
    resume: async () => { calls.push('resume'); return await value(); },
    cancel: async () => { calls.push('cancel'); return await value(); },
  };
  registerNativeConversationIntakeGatewayMethods(catalog, host);
  const invocation = (operation: string): GatewayMethodInvocation => ({ body: request(operation), context: { admin: true, principalKind: 'token', principalId: 'pairing:token-1', scopes },
    isAuthorized: () => authorized, nativeExecutionAuthority: { current: () => current, withCurrent: async (_expected, operation) => operation(() => current!) } });
  return { catalog, calls, invocation, revoke: () => { current = null; }, forbid: () => { authorized = false; } };
}
test('intake routes dispatch exact strict bodies under live paired owner authority', async () => {
  const f = fixture();
  for (const operation of ['capture', 'get', 'admit', 'resume', 'cancel']) expect(await f.catalog.invoke(`workLedger.intake.${operation}`, f.invocation(operation))).toEqual(captured());
  expect(f.calls).toEqual(['capture', 'get', 'admit', 'resume', 'cancel']);
});
test('intake routes reject stale auth and forged body authority before touching the host', async () => {
  for (const operation of ['capture', 'get', 'admit', 'resume', 'cancel']) {
    const f = fixture(); const original = f.invocation(operation);
    for (const context of [{ ...original.context, admin: false }, { ...original.context, principalKind: 'user' as const }, { ...original.context, scopes: ['read:work-ledger'] }, { ...original.context, scopes: ['read:work-ledger', 'write:fleet'] }]) {
      await expect(f.catalog.invoke(`workLedger.intake.${operation}`, { ...original, context })).rejects.toMatchObject({ status: 403 });
    }
    await expect(f.catalog.invoke(`workLedger.intake.${operation}`, { ...original, nativeExecutionAuthority: undefined })).rejects.toMatchObject({ status: 403 });
    await expect(f.catalog.invoke(`workLedger.intake.${operation}`, { ...original, body: { ...request(operation), projectId: 'other' } })).rejects.toMatchObject({ status: 400 });
    f.forbid(); await expect(f.catalog.invoke(`workLedger.intake.${operation}`, original)).rejects.toMatchObject({ status: 403 }); expect(f.calls).toHaveLength(0);
  }
});
test('response delivery rechecks revocation and scope authorization after an awaited host operation', async () => {
  for (const mode of ['revoke', 'forbid'] as const) {
    const f = fixture(() => { f[mode](); return captured(); });
    await expect(f.catalog.invoke('workLedger.intake.admit', f.invocation('admit'))).rejects.toMatchObject({ status: 403 }); expect(f.calls).toEqual(['admit']);
  }
});
test('source stale/conflict/recovery errors remain explicit and get does not fabricate not-found', async () => {
  for (const [code, status] of [['stale', 409], ['request-conflict', 409], ['recovery-required', 409], ['not-found', 404], ['indeterminate', 503]] as const) {
    const f = fixture(() => { throw new NativeConversationIntakeError(code); });
    await expect(f.catalog.invoke('workLedger.intake.get', f.invocation('get'))).rejects.toMatchObject({ status, code: `NATIVE_INTAKE_${code.replaceAll('-', '_').toUpperCase()}` });
  }
});
test('body limit, pre-abort, invalid host responses and post-host abort all fail closed', async () => {
  const f = fixture(); const invocation = f.invocation('capture');
  await expect(f.catalog.invoke('workLedger.intake.capture', { ...invocation, body: { ...request('capture'), text: 'x'.repeat(300_000) } })).rejects.toMatchObject({ status: 413 });
  const pre = new AbortController(); pre.abort();
  await expect(f.catalog.invoke('workLedger.intake.capture', { ...invocation, signal: pre.signal })).rejects.toMatchObject({ status: 503 }); expect(f.calls).toHaveLength(0);
  const invalid = fixture(() => Object.assign(captured(), { execution: {} }));
  await expect(invalid.catalog.invoke('workLedger.intake.capture', invalid.invocation('capture'))).rejects.toMatchObject({ status: 503 });
  const after = new AbortController(); const aborted = fixture(() => { after.abort(); return captured(); });
  await expect(aborted.catalog.invoke('workLedger.intake.capture', { ...aborted.invocation('capture'), signal: after.signal })).rejects.toMatchObject({ status: 503 });
});
