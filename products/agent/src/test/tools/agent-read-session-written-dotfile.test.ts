/**
 * The read guard must not refuse a dotted path this session's own tools wrote.
 *
 * A screenshot the agent saved to `~/.goodvibes-screen.png` was rejected as
 * secret-looking purely because the basename begins with a dot, and only became
 * readable after being copied to an undotted path. The hidden-name rule is now
 * waived for paths in the session write ledger; every other rule, secret-looking
 * segments, private-key extensions, known_hosts, and the credential dotfiles
 * that are never waived, still applies.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBlockedReadPath } from '@/tools/agent-read-policy.ts';
import {
  recordAgentSessionWrite,
  wasWrittenInAgentSession,
  clearAgentSessionWrites,
  agentSessionWriteCount,
} from '@/tools/agent-session-write-ledger.ts';

const SCREENSHOT = '/home/buzzkill/.goodvibes-screen.png';

beforeEach(() => {
  clearAgentSessionWrites();
});

describe('read guard: dotted paths this session wrote', () => {
  test('a dotted path is blocked when the session did not write it', () => {
    expect(isBlockedReadPath(SCREENSHOT)).toBe(true);
  });

  test('the same path is readable once the session has written it', () => {
    recordAgentSessionWrite(SCREENSHOT);
    expect(isBlockedReadPath(SCREENSHOT)).toBe(false);
  });

  test('a dotted directory on a session-written path is waived too', () => {
    const path = '/home/buzzkill/.cache/goodvibes/report.txt';
    expect(isBlockedReadPath(path)).toBe(true);
    recordAgentSessionWrite(path);
    expect(isBlockedReadPath(path)).toBe(false);
  });

  test('writing one dotted path does not unlock a different one', () => {
    recordAgentSessionWrite(SCREENSHOT);
    expect(isBlockedReadPath('/home/buzzkill/.other-screen.png')).toBe(true);
  });
});

describe('read guard: the waiver does not reach real secrets', () => {
  const stillBlocked = [
    '/home/buzzkill/.netrc',
    '/home/buzzkill/.npmrc',
    '/home/buzzkill/.env',
    '/home/buzzkill/.aws/config',
    '/home/buzzkill/.ssh/notes.txt',
    '/home/buzzkill/.gnupg/keys.txt',
    '/home/buzzkill/.secrets/id_rsa',
    '/home/buzzkill/.keys/service.pem',
    '/home/buzzkill/.config/credentials.json',
    '/home/buzzkill/.ssh/known_hosts',
  ];

  for (const path of stillBlocked) {
    test(`${path} stays blocked even after the session writes it`, () => {
      recordAgentSessionWrite(path);
      expect(isBlockedReadPath(path)).toBe(true);
    });
  }
});

describe('read guard: undotted paths are unaffected', () => {
  test('an ordinary project file is allowed with or without a ledger entry', () => {
    expect(isBlockedReadPath('src/main.ts')).toBe(false);
    recordAgentSessionWrite('src/main.ts');
    expect(isBlockedReadPath('src/main.ts')).toBe(false);
  });

  test('a secret-looking undotted file stays blocked after a write', () => {
    recordAgentSessionWrite('config/credentials.json');
    expect(isBlockedReadPath('config/credentials.json')).toBe(true);
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
    expect(isBlockedReadPath(SCREENSHOT)).toBe(true);
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
