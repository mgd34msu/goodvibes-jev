import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../../input/command-registry.ts';
import { describeBackgroundProcess } from '../../tools/agent-harness-background-processes.ts';

test('background process output screens complete credential roles before returning a tail', async () => {
  const material = 'synthetic violet lantern recovery material';
  const entry = { id: 'process-output-fixture', pid: 123, cmd: 'printf sample', startTime: 1, done: true, exitCode: 0 };
  const manager = {
    list: () => [entry], getStatus: () => entry,
    getOutput: () => ({ stdout: `accountRecoveryPhrase="${material}"`, stderr: '' }),
  } as unknown as ProcessManager;
  const context = { workspace: { processManager: manager } } as CommandContext;
  let matched = 0;
  const requests = fakePort((name, question, state) => {
    if (question.type !== 'noul') throw new Error(`Unexpected output reading: ${name}`);
    const wire = JSON.stringify(state);
    const command = JSON.stringify({ phase: 'source', parts: [{ kind: 'text', text: entry.cmd }], target: 'whole-line' });
    const protectedOutput = JSON.stringify({ phase: 'source', parts: [
      { kind: 'text', text: 'accountRecoveryPhrase=' },
      { kind: 'span', reference: 'span-1', syntax: 'assignment-value', field: 'accountRecoveryPhrase' },
      { kind: 'text', text: '' },
    ], target: 'span-1' });
    const residual = JSON.stringify({ parts: [{ kind: 'text', text: 'accountRecoveryPhrase=' }, { kind: 'withheld', reference: 'span-1' }, { kind: 'text', text: '' }] });
    if (['lineHasCredential', 'spanIsCredential'].includes(name) && wire === protectedOutput) { matched++; return noulAnswer(0.99); }
    if ((['lineHasCredential', 'spanIsCredential'].includes(name) && wire === command) || (name === 'credentialRemains' && wire === residual)) { matched++; return noulAnswer(0.01); }
    throw new Error(`Unexpected output projection: ${name}`);
  });
  const previous = installJudgmentPort(requests.port);
  try {
    const result = await describeBackgroundProcess(context, { processId: entry.id });
    expect(result.status).toBe('found');
    expect(JSON.stringify(result)).not.toContain(material);
    expect(JSON.stringify(result)).toContain('[REDACTED');
    expect(JSON.stringify(result)).toContain('accountRecoveryPhrase=[REDACTED]');
    expect(JSON.stringify(result)).toContain(entry.cmd);
    expect(matched).toBeGreaterThanOrEqual(3);
    expect(requests.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests.requests)).not.toContain(material);
    expect(requests.requests.some(request => request.context?.battery === 'engine.redaction.field-kind')).toBe(false);
  } finally { installJudgmentPort(previous); }
});

test('process inspection refuses a backend replaced while output screening is pending', async () => {
  const entry = { id: 'retained-process-fixture', pid: 123, cmd: 'printf sample', startTime: 1, done: true, exitCode: 0 };
  const backend = { list: () => [entry], getStatus: () => entry, getOutput: () => ({ stdout: '', stderr: '' }) };
  const context = { workspace: { processManager: backend as unknown as ProcessManager } } as CommandContext;
  let entered!: () => void, release!: () => void;
  const arrival = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const readings = fakePort(async (name, question, state) => {
    const command = { phase: 'source', parts: [{ kind: 'text', text: entry.cmd }], target: 'whole-line' };
    if (!['lineHasCredential', 'spanIsCredential'].includes(name) || question.type !== 'noul'
      || JSON.stringify(state) !== JSON.stringify(command)) throw new Error('Unexpected retained output projection');
    entered(); await held; return noulAnswer(0.01);
  });
  const previous = installJudgmentPort(readings.port);
  try {
    const pending = describeBackgroundProcess(context, { processId: entry.id });
    await arrival;
    backend.getOutput = () => ({ stdout: 'Replacement output must not publish.', stderr: '' });
    release();
    await expect(pending).rejects.toThrow();
  } finally { release(); installJudgmentPort(previous); }
});
