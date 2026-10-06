import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createOperatorNativeConversationIntakeClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { NATIVE_INTAKE_CAPTURES } from './native-intake-fixture';

test('real auth captures identify a paired admin with both ledger scopes, without retaining credentials', () => {
  for (const capture of Object.values(NATIVE_INTAKE_CAPTURES)) {
    const auth = JSON.parse(capture.auth.body);
    expect(auth).toMatchObject({ authenticated: true, admin: true, principalKind: 'token' });
    expect(auth.principalId).toStartWith('pairing:');
    expect(auth.scopes).toContain('read:work-ledger'); expect(auth.scopes).toContain('write:work-ledger');
    expect(JSON.stringify(capture)).not.toContain('Bearer ');
    expect(capture.input.text).toStartWith('  '); expect(capture.input.text).toEndWith('  ');
    expect(capture.input.text).toContain('🌻'); expect(capture.input.text.match(/Keep CSV output unchanged\./g)).toHaveLength(2);
    expect(capture.capture.method).toBe('POST');
    expect(capture.get.method).toBe('POST');
  }
});

test('genuine work and turn outcomes retain the whole original input', async () => {
  for (const name of ['work', 'turn'] as const) {
    const capture = NATIVE_INTAKE_CAPTURES[name];
    const project = JSON.parse(capture.project.body) as { projectId: string };
    const client = createOperatorNativeConversationIntakeClient({ invoke: async <T>(method: string) => {
      const operation = method.slice('workLedger.intake.'.length) as 'capture' | 'admit' | 'get' | 'resume' | 'cancel';
      return JSON.parse(capture[operation].body) as T;
    } }, project.projectId);
    try {
      await client.capture(capture.input);
      const result = await client.admit(capture.transition);
      expect(result.kind).toBe(name);
      expect(await client.get({ inputId: capture.input.inputId })).toEqual(result);
      expect(await client.resume(capture.transition)).toEqual(result);
      expect(await client.cancel(capture.transition)).toEqual(result);
      if (result.kind === 'work') {
        expect(result.receipt.goal).toBe(capture.input.text); expect(result.receipt.criteria).toEqual([capture.input.text]);
        expect(result.receipt.source.version).toBe(2); expect(result.receipt.source.offsetEncoding).toBe('utf16');
      } else if (result.kind === 'turn') expect(result.text).toBe(capture.input.text);
    } finally { client.dispose(); }
  }
});

test('captured terminal and interrupted states retain their actual semantics', () => {
  expect(NATIVE_INTAKE_CAPTURES.blocked.result).toMatchObject({ kind: 'blocked', reason: 'unsupported-source' });
  expect(NATIVE_INTAKE_CAPTURES.blocked.input.unsupportedSources).toEqual([{ kind: 'file', label: 'referenced-specification.pdf' }]);
  expect(NATIVE_INTAKE_CAPTURES.refused.result).toMatchObject({ kind: 'refused', reason: 'semantic' });
  const cancelled = NATIVE_INTAKE_CAPTURES.cancelled;
  expect(JSON.parse(cancelled.pending!.body)).toMatchObject({ kind: 'processing', recovery: 'pending' });
  expect(cancelled.admit.status).toBeGreaterThanOrEqual(400);
  expect(cancelled.result).toMatchObject({ kind: 'cancelled' });
  expect(cancelled.resume.body).toBe(cancelled.cancel.body);
  const recovery = NATIVE_INTAKE_CAPTURES.recovery;
  expect(recovery.admit.status).toBeGreaterThanOrEqual(400);
  expect(recovery.result).toMatchObject({ kind: 'processing', recovery: 'required' });
  expect(recovery.repeatAdmit!.body).toBe(recovery.get.body);
  expect(JSON.parse(recovery.resume.body)).toMatchObject({ kind: 'work' });
  expect(recovery.afterResume!.body).toBe(recovery.resume.body);
});

test('real HTTP rejects anonymous, shared-token, user-session, deficient scopes and injected proof', () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/native-intake/auth-denied.json', import.meta.url), 'utf8')) as { denied: { status: number }[] };
  expect(capture.denied.filter(wire => wire.status === 401)).toHaveLength(2);
  expect(capture.denied.filter(wire => wire.status === 403)).toHaveLength(12);
  expect(capture.denied.filter(wire => wire.status === 400)).toHaveLength(6);
});
