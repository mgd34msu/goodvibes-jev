import { expect, test } from 'bun:test';
import {
  beginConcealedInputFor, cancelConcealedInputFor, submitConcealedInputFor,
  waitForConcealedSubmission, maskConcealedText, type ConcealedInputHost,
} from '../../input/concealed-input.ts';
import { startCardEntryFlow } from '../../input/commands/payment-card-intake.ts';
import type { CommandContext } from '../../input/command-registry.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function host(): ConcealedInputHost {
  return { prompt: '', cursorPos: 0, concealedInput: null, requestRender: () => {} };
}

test('pending concealed submit keeps typing masked, consumes repeat Enter, and exposes real completion', async () => {
  const h = host(); const gate = deferred(); const calls: string[] = [];
  beginConcealedInputFor(h, { onSubmit: async value => { calls.push(value); await gate.promise; } });
  expect(submitConcealedInputFor(h, 'synthetic-first')).toBe(true);
  h.prompt = 'synthetic-second';
  expect(h.concealedInput).not.toBeNull();
  expect(maskConcealedText(h.prompt)).not.toContain('synthetic');
  expect(submitConcealedInputFor(h, h.prompt)).toBe(true);
  expect(h.concealedInput).not.toBeNull();
  expect(h.prompt).toBe('');
  expect(calls).toEqual(['synthetic-first']);
  const settled = waitForConcealedSubmission(h);
  gate.resolve(); await settled;
  expect(h.concealedInput).toBeNull();
});

function paymentFixture() {
  const h = host(); const gate = deferred(); const prints: string[] = []; let writes = 0;
  const values = new Map<string, unknown>();
  const context = {
    print: (text: string) => prints.push(text), renderRequest: () => {},
    beginConcealedInput: (request: Parameters<typeof beginConcealedInputFor>[1]) => beginConcealedInputFor(h, request),
    platform: {
      configManager: { get: (key: string) => key === 'storage.secretPolicy' ? 'plaintext_allowed' : values.get(key), setDynamic: (key: string, value: unknown) => values.set(key, value) },
      secretsManager: { set: async () => { writes++; await gate.promise; }, delete: async () => {} },
    },
  } as unknown as CommandContext;
  startCardEntryFlow(context);
  return { h, gate, prints, writes: () => writes };
}

test.each(['cancel', 'replace'] as const)('payment %s while storage waits cannot open a late next prompt', async action => {
  const f = paymentFixture();
  expect(submitConcealedInputFor(f.h, 'synthetic-card-field')).toBe(true);
  const completion = waitForConcealedSubmission(f.h);
  expect(f.writes()).toBe(1);
  expect(submitConcealedInputFor(f.h, 'synthetic-repeat')).toBe(true);
  expect(f.writes()).toBe(1);
  if (action === 'cancel') expect(cancelConcealedInputFor(f.h)).toBe(true);
  else beginConcealedInputFor(f.h, { label: 'Replacement', onSubmit: () => {} });
  f.gate.resolve(); await completion;
  expect(f.h.concealedInput?.label ?? null).toBe(action === 'cancel' ? null : 'Replacement');
  expect(f.prints.join('\n')).not.toContain('Expiry');
  expect(f.prints.join('\n')).not.toContain('synthetic-card-field');
});

test('payment chain offers its next masked field only after storage completion', async () => {
  const f = paymentFixture();
  submitConcealedInputFor(f.h, 'synthetic-card-field');
  expect(f.h.concealedInput?.label).toBe('Saving concealed input');
  const completion = waitForConcealedSubmission(f.h);
  f.gate.resolve(); await completion;
  expect(f.h.concealedInput?.label).toBe('Expiry (MM/YY)');
  expect(f.prints.join('\n')).not.toContain('Stopped');
  expect(f.prints.join('\n')).not.toContain('synthetic-card-field');
});

test('payment failure stays on the same masked field and never prints credential-bearing errors', async () => {
  const f = paymentFixture();
  submitConcealedInputFor(f.h, 'synthetic-card-field');
  const completion = waitForConcealedSubmission(f.h);
  f.gate.reject(new Error('failed synthetic-card-field'));
  await completion;
  expect(f.h.concealedInput?.label).toBe('Card number');
  expect(f.prints.join('\n')).toContain('Failed to store Card number');
  expect(f.prints.join('\n')).not.toContain('synthetic-card-field');
  expect(f.prints.join('\n')).not.toContain('Expiry');
});
