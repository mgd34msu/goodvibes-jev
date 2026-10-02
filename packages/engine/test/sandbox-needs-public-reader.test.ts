import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  decideSandboxedExec,
  readCommandNeeds,
  type CommandNeeds,
} from '@goodvibes-jev/engine/sdk/platform/runtime/permissions/sandbox-policy';

let previous: ReturnType<typeof installJudgmentPort>;
let sequence = 0;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('public sandbox needs reader', () => {
  test('feeds the actual reading into the public policy and retains its cache', async () => {
    const fake = fakePort(() => noulAnswer(0.01));
    installJudgmentPort(fake.port);
    const command = `fixture-command-${++sequence}`;
    const needs: CommandNeeds = await readCommandNeeds(command, '/fixture/public-reader');
    expect(needs).toEqual({ needsNetwork: false, needsPrivilege: false });
    expect(decideSandboxedExec({ command, needs, sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' }).effect).toBe('allow');
    expect(await readCommandNeeds(command, '/fixture/public-reader')).toBe(needs);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.context?.site).toBe('engine.gate.sandbox-needs');
  });

  test('uncertain host needs retain the existing explicit ask', async () => {
    installJudgmentPort(fakePort(() => noulAnswer(0.5)).port);
    const command = `fixture-uncertain-${++sequence}`;
    const needs = await readCommandNeeds(command);
    expect(needs).toEqual({ needsNetwork: true, needsPrivilege: true });
    const decision = decideSandboxedExec({ command, needs, sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(decision.effect).toBe('ask');
    expect(decision.escalations).toHaveLength(2);
  });
});
