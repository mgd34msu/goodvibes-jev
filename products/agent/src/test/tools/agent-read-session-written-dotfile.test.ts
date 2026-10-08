/** Standalone read observations use Jev; the write ledger is not read authority. */
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

describe('read observations do not infer secrecy or authority from a filename or session write', () => {
  test('an ordinary dotted path is readable before and after this session writes it', async () => {
    expect(await isBlockedReadPath(SCREENSHOT)).toBe(false);
    recordAgentSessionWrite(SCREENSHOT);
    expect(await isBlockedReadPath(SCREENSHOT)).toBe(false);
  });
  test('an ordinary secret-looking name is readable when its observation says non-secret', async () => {
    expect(await isBlockedReadPath('novel/secret.txt')).toBe(false);
  });
  test('an ordinary-named secret is refused even if the session wrote it', async () => {
    const path = 'deployment/ordinary-data.txt';
    secretSubjects.add(path);
    expect(await isBlockedReadPath(path)).toBe(true);
    recordAgentSessionWrite(path);
    expect(await isBlockedReadPath(path)).toBe(true);
  });
  test('one path observation does not classify another subject', async () => {
    secretSubjects.add('one.txt');
    expect(await isBlockedReadPath('one.txt')).toBe(true);
    expect(await isBlockedReadPath('two.txt')).toBe(false);
  });
  test('an ordinary dotted directory does not need a session-written waiver', async () => {
    const path = '/synthetic/home/.cache/report.txt';
    expect(await isBlockedReadPath(path)).toBe(false);
    recordAgentSessionWrite(path);
    expect(await isBlockedReadPath(path)).toBe(false);
  });
  test('writing one dotted file does not authorize a different classified secret', async () => {
    const other = '/synthetic/home/.other-screen.png'; secretSubjects.add(other);
    recordAgentSessionWrite(SCREENSHOT);
    expect(await isBlockedReadPath(other)).toBe(true);
  });
  for (const path of ['.netrc', '.npmrc', '.env', '.aws/config', '.ssh/notes.txt', '.gnupg/keys.txt',
    '.secrets/id_rsa', '.keys/service.pem', '.config/credentials.json', '.ssh/known_hosts']) {
    test(`${path} remains refused when its observation identifies secrets despite a session write`, async () => {
      secretSubjects.add(path); recordAgentSessionWrite(path);
      expect(await isBlockedReadPath(path)).toBe(true);
    });
  }
  test('an ordinary project file is readable with or without a ledger entry', async () => {
    expect(await isBlockedReadPath('src/main.ts')).toBe(false);
    recordAgentSessionWrite('src/main.ts');
    expect(await isBlockedReadPath('src/main.ts')).toBe(false);
  });
  test('a classified undotted secret remains refused after a write', async () => {
    secretSubjects.add('config/credentials.json'); recordAgentSessionWrite('config/credentials.json');
    expect(await isBlockedReadPath('config/credentials.json')).toBe(true);
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
