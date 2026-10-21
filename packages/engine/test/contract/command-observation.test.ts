import { expect, test } from 'bun:test';
import { hashState } from '@goodvibes-jev/judgment';
import { commandObservation } from '../../sdk/src/platform/contract/command-observation.js';

test('native exec output is exposed without confusing the executed script with stdout', () => {
  const raw = JSON.stringify({ cmd: 'verify archive', exit_code: 0, success: true,
    stdout: 'CRC passed; current sha256 abc123', stderr: '', withheld_env: ['A_SECRET_NAME'], sandboxed: true });
  const receipt = { command: 'verify archive', success: true, head: raw, agentId: 'original-worker', turn: 2, callId: 'exec-7' };
  expect(commandObservation(receipt)).toMatchObject({ ...receipt, head: 'CRC passed; current sha256 abc123', stderr: '',
    exitCode: 0, executionSucceeded: true, toolCallSucceeded: true, sourceCapture: { digest: hashState(raw), bytes: Buffer.byteLength(raw) } });
  expect(receipt.head).toBe(raw);
});

test('outer tool success cannot hide a failed child execution', () => {
  const receipt = { command: 'verify', success: true, head: JSON.stringify({ cmd: 'verify', exit_code: 2, success: false, stdout: '', stderr: 'verification failed' }) };
  expect(commandObservation(receipt)).toMatchObject({ success: true, toolCallSucceeded: true, executionSucceeded: false, exitCode: 2, stderr: 'verification failed' });
});

test('unmatched and malformed envelopes remain exact raw evidence', () => {
  for (const head of ['plain stdout', JSON.stringify({ cmd: 'another command', exit_code: 0, success: true, stdout: 'PASS', stderr: '' }),
    JSON.stringify({ cmd: 'verify', success: true, stdout: 'Started in background', stderr: '' })]) {
    const receipt = { command: 'verify', success: true, head };
    expect(commandObservation(receipt)).toBe(receipt);
  }
});
