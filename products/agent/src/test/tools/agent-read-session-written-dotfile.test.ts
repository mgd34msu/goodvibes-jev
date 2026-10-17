/** Compatibility checks preserve cancellation; actual tool admission owns read authority. */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetReadSecrets } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { isBlockedReadPath } from '@/tools/agent-read-policy.ts';
import { recordAgentSessionWrite, wasWrittenInAgentSession, clearAgentSessionWrites, agentSessionWriteCount } from '@/tools/agent-session-write-ledger.ts';

const SCREENSHOT = '/synthetic/home/.screen.png';
const secretSubjects = new Set<string>();
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  clearAgentSessionWrites(); forgetReadSecrets(); secretSubjects.clear();
  previous = installJudgmentPort(fakePort((_name, _question, state) => {
    const path = (state as { arguments?: { path?: string } }).arguments?.path ?? '';
    return noulAnswer(secretSubjects.has(path) ? 0.999 : 0.001);
  }).port);
});
afterEach(() => { installJudgmentPort(previous); forgetReadSecrets(); });

describe('read compatibility does not add a filename or session-write approval gate', () => {
  for (const path of [SCREENSHOT, '.netrc', '.npmrc', '.env', '.aws/config', '.ssh/notes.txt',
    '.gnupg/keys.txt', '.secrets/id_rsa', '.keys/service.pem', '.config/credentials.json',
    '.ssh/known_hosts', 'deployment/ordinary-data.txt', 'src/main.ts']) {
    test(`${path} remains subject to the registered read tool admission`, async () => {
      secretSubjects.add(path);
      expect(await isBlockedReadPath(path)).toBe(false);
      recordAgentSessionWrite(path);
      expect(await isBlockedReadPath(path)).toBe(false);
    });
  }
  test('caller cancellation is retained before a read can proceed', async () => {
    const controller = new AbortController(); controller.abort(new Error('Read cancelled'));
    await expect(isBlockedReadPath('src/main.ts', controller.signal)).rejects.toBe(controller.signal.reason);
  });
});

describe('session write ledger', () => {
  test('lookups are independent of how the path was spelled', () => {
    // A purely lexical check, no file is ever created, but the path is still
    // built from tmpdir() so no test source names a location under the real
    // /tmp (see release-gates/test-temp-path-gate.test.ts).
    const dir = join(tmpdir(), 'goodvibes');
    // Record the DOTTED spelling and look up the plain one. The previous form
    // pre-normalized the path before recording it, so both sides were already
    // the same string and the claim in the test name was never exercised.
    recordAgentSessionWrite(`${dir}/./out.txt`);
    expect(wasWrittenInAgentSession(`${dir}/out.txt`)).toBe(true);
  });

  test('a relative path matches its own spelling and nothing else', () => {
    recordAgentSessionWrite('docs/.notes.md');
    expect(wasWrittenInAgentSession('docs/.notes.md')).toBe(true);
    // No ambient working directory is guessed, so an absolute read of the same
    // file simply stays blocked rather than being waived on a hunch.
    expect(wasWrittenInAgentSession('/anywhere/docs/.notes.md')).toBe(false);
  });

  test('clearing empties the ledger', () => {
    recordAgentSessionWrite(SCREENSHOT);
    expect(agentSessionWriteCount()).toBe(1);
    clearAgentSessionWrites();
    expect(agentSessionWriteCount()).toBe(0);
  });

  test('the ledger is bounded and evicts the oldest entries', () => {
    const ledgerDir = join(tmpdir(), 'gv');
    for (let i = 0; i < 600; i += 1) recordAgentSessionWrite(join(ledgerDir, `.f${i}`));
    expect(agentSessionWriteCount()).toBeLessThanOrEqual(512);
    // The oldest entry was evicted; the newest survives.
    expect(wasWrittenInAgentSession(join(ledgerDir, '.f0'))).toBe(false);
    expect(wasWrittenInAgentSession(join(ledgerDir, '.f599'))).toBe(true);
  });
});
