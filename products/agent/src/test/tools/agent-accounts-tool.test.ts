import { useSecurityReadings } from '../helpers/security-readings.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentAccountsTool } from '../../tools/agent-accounts-tool.ts';
import { AgentAccountRegistry } from '@goodvibes-jev/engine/sdk/platform/google';
import { containsSecretLikeText } from '../../agent/memory-safety.ts';
import {
  getSessionUntrustedContentLedger,
  resetSessionUntrustedContentLedgerForTests,
} from '../../trust/untrusted-content.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Creating accounts autonomously is authorized; doing it invisibly is not.
 * These cover both halves: the record actually lands and is enumerable and
 * revocable, and the one boundary that does not move, content the agent read
 * this turn cannot be what causes a signup to be registered.
 */

let home = '';
let tool: ReturnType<typeof createAgentAccountsTool>;

function run(args: Record<string, unknown>) {
  return tool.execute(args) as Promise<{ success: boolean; output?: string; error?: string }>;
}

const VALID = {
  action: 'record',
  serviceDomain: 'example.com',
  serviceUrl: 'https://example.com/signup',
  aliasAddress: 'agent+example@owner.test',
  purpose: 'reading the docs behind a sign-in wall',
  credentialSecretKey: 'GOODVIBES_ACCOUNT_EXAMPLE_COM',
};

useSecurityReadings();

describe('the account register', () => {
  beforeEach(() => {
    home = makeProjectTempDir('accounts-tool');
    resetSessionUntrustedContentLedgerForTests();
    tool = createAgentAccountsTool({
      registry: new AgentAccountRegistry({ storePath: join(home, 'accounts.json'), containsSecretLikeText }),
      baseAddress: () => 'owner@example.com',
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetSessionUntrustedContentLedgerForTests();
  });

  test('each signup gets its own delivery address, minted from the owner mailbox', async () => {
    const alias = await run({ action: 'alias', serviceDomain: 'github.com' });

    expect(alias.success).toBe(true);
    // The +tag is the correlation key a verification mail is matched on, so it
    // has to be per-signup rather than the bare mailbox.
    expect(alias.output).toMatch(/owner\+gv-github-com-[a-z0-9]{8}@example\.com/);
    expect(alias.output).toContain('delivers to owner@example.com');
  });

  test('minting an alias without a connected mailbox says which step is missing', async () => {
    const without = createAgentAccountsTool({
      registry: new AgentAccountRegistry({ storePath: join(home, 'accounts.json'), containsSecretLikeText }),
      baseAddress: () => null,
    });
    const result = await (without.execute({ action: 'alias', serviceDomain: 'github.com' }) as Promise<{ success: boolean; error?: string }>);

    expect(result.success).toBe(false);
    expect(result.error).toContain('/google connect');
  });

  test('an account the agent creates is recorded and can be listed', async () => {
    const recorded = await run(VALID);
    expect(recorded.success).toBe(true);

    const listed = await run({ action: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('example.com');
    expect(listed.output).toContain('reading the docs behind a sign-in wall');
    expect(listed.output).toContain('agent+example@owner.test');
    // Revocation starts from the key name, so it has to be in the listing.
    expect(listed.output).toContain('GOODVIBES_ACCOUNT_EXAMPLE_COM');
  });

  test('the record is revocable, and forgetting says what it did not do', async () => {
    await run(VALID);
    const forgotten = await run({ action: 'forget', id: 'example-com' });

    expect(forgotten.success).toBe(true);
    // The account still exists on the service; only the record went away.
    expect(forgotten.output).toContain('still exists');
    expect(forgotten.output).toContain('GOODVIBES_ACCOUNT_EXAMPLE_COM');
    expect((await run({ action: 'list' })).output).toContain('No accounts have been recorded');
  });

  test('a credential value is refused; only the secret-store key name is stored', async () => {
    const result = await run({ ...VALID, credentialSecretKey: 'hunter2-actual-password!' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('secret-store key NAME');
  });

  test('content read this turn cannot cause an account to be registered', async () => {
    // A page the agent just read is exactly the thing that would try to drive
    // a signup. Reading it arms the guard for the rest of the turn.
    getSessionUntrustedContentLedger().record({
      surface: 'web-page',
      origin: 'evil.example',
      at: new Date().toISOString(),
    });

    const result = await run(VALID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('evil.example');
    // The origin is named as the KIND of thing it is. It used to say "those
    // pages" about everything, including a mailbox, which read as a boundary
    // that did not know what it had just looked at.
    expect(result.error).toContain('web page');

    // What it must NOT say. This request came from the owner, so telling him to
    // "tell the owner ... and let them ask for it" instructs him to obtain
    // authority he already holds, from himself. That line is correct when a
    // schedule or a channel drove the action and wrong here, so it is gone from
    // the owner-direct path and this pins it.
    expect(result.error).not.toContain('let them ask for it');
    expect(result.error).not.toContain('Tell the owner');
  });

  test('with nothing read this turn, recording proceeds', async () => {
    const result = await run(VALID);
    expect(result.success).toBe(true);
  });
});
