import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { findContentTaint, evaluateOutwardEffect, UntrustedContentLedger } from '@goodvibes-jev/engine/sdk/platform/security';
import { securityPort } from './helpers/security-readings.ts';

const sources = [{ surface: 'web-page', origin: 'https://example.test', text: 'Unrelated source material.' }];

test('already cancelled taint checks reject even without sources or with an exact match', async () => {
  const fake = securityPort({ derives: () => false }); const previous = installJudgmentPort(fake.port);
  const controller = new AbortController(); controller.abort(new Error('private abort reason'));
  try {
    for (const retained of [[], sources]) await expect(findContentTaint({ body: 'Unrelated' }, retained, { signal: controller.signal, exactMatchFields: ['body'] })).rejects.toMatchObject({ kind: 'aborted' });
    await expect(evaluateOutwardEffect({ request: { toolName: 'accounts', action: 'record', description: 'record account' }, ledger: new UntrustedContentLedger(), taintOptions: { signal: controller.signal } })).rejects.toMatchObject({ kind: 'aborted' });
    expect(fake.requests).toHaveLength(0);
  } finally { installJudgmentPort(previous); }
});

test('pending taint abort drains late provider completion without queued asks or recording', async () => {
  const fake = securityPort({ derives: () => false });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let enter!: () => void; const started = new Promise<void>((resolve) => { enter = resolve; });
  let asks = 0; let records = 0;
  const previous = installJudgmentPort({ ...fake.port, recorder: { recordReadings() { records++; }, recordAction() { records++; } }, async ask(request) { asks++; enter(); await gate; return fake.port.ask(request); } });
  const controller = new AbortController();
  try {
    const work = findContentTaint({ a: 'First field', b: 'Second field', c: 'Third', d: 'Fourth', e: 'Fifth' }, sources, { signal: controller.signal });
    const outcome = work.catch((error: unknown) => error);
    await started; const before = asks; controller.abort(new Error('private abort reason'));
    const early = await Promise.race([outcome, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
    release(); const result = await outcome; await new Promise((resolve) => setTimeout(resolve, 20));
    expect(early).not.toBeNull(); expect(result).toMatchObject({ kind: 'aborted' });
    expect(String(result)).not.toContain('private abort reason'); expect(asks).toBe(before); expect(records).toBe(0);
  } finally { release(); installJudgmentPort(previous); }
});

test('an active signal preserves benign allowance and taint refusal', async () => {
  for (const derives of [false, true, 'unsure'] as const) {
    const fake = securityPort({ derives: () => derives }); const previous = installJudgmentPort(fake.port);
    try {
      const findings = await findContentTaint({ body: 'Owner composed content' }, sources, { signal: new AbortController().signal });
      expect(findings.length).toBe(derives === false ? 0 : 1); expect(fake.requests).toHaveLength(1);
    } finally { installJudgmentPort(previous); }
  }
});
