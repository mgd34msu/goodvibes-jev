/**
 * A platform that refuses SQLite extension loading (macOS system SQLite in a
 * compiled binary) is a capability limit, not a fault: the vector store must
 * degrade with platformLimitReason set and NO error field, while a genuine
 * packaging defect (missing extension file) must stay a loud error.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { loadSqliteVecExtension, SqliteVecPlatformUnsupportedError } from '../sdk/src/platform/state/sqlite-vec-loader.ts';

describe('sqlite-vec platform-limit classification', () => {
  test('the typed platform error carries the honest literal-fallback wording', () => {
    const err = new SqliteVecPlatformUnsupportedError('not authorized');
    expect(err.platformLimit).toBe(true);
    expect(err.message).toContain('does not allow loading extensions');
    expect(err.message).toContain('literal matching');
    // The reason must never read as a fault: release smokes grep for these.
    expect(err.message.toLowerCase()).not.toContain('error');
    expect(err.message.toLowerCase()).not.toContain('fail');
  });
  test('the real darwin refusal message classifies as the platform limit', () => {
    // Verbatim from a macOS-compiled binary (Apple system SQLite):
    const darwin = 'This build of sqlite3 does not support dynamic extension loading';
    const err = new SqliteVecPlatformUnsupportedError(darwin);
    expect(err.platformLimit).toBe(true);
  });
});

/**
 * Whether a load failure is the platform's refusal is read by Jev
 * (engine.state.sqlite-vec-refusal); this fake port answers it with the
 * probability the test sets, so each answer's handling is pinned.
 */
describe('a load failure is classified by the refusal reading', () => {
  let probability = 0.97;
  let requests: ReturnType<typeof fakePort>['requests'] = [];
  let previous: JudgmentPort | undefined;
  beforeEach(() => {
    const fake = fakePort((name) => {
      if (name !== 'platform_refuses') throw new Error(`unexpected question ${name}`);
      return noulAnswer(probability);
    });
    requests = fake.requests;
    previous = installJudgmentPort(fake.port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });

  const fakeDb = (msg: string) => ({ loadExtension: () => { throw new Error(msg); } });

  test('a yes throws the platform-limit error carrying the refusal', async () => {
    probability = 0.97;
    const refusal = 'This build of sqlite3 does not support dynamic extension loading';
    const failure = await loadSqliteVecExtension(fakeDb(refusal) as never).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SqliteVecPlatformUnsupportedError);
    expect((failure as Error).message).toContain(refusal);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toEqual({ message: refusal, platform: process.platform, bundled: false });
  });

  test('a no rethrows the original error, a loud defect', async () => {
    probability = 0.03;
    const missing = 'dlopen failed: no such file or directory';
    const failure = await loadSqliteVecExtension(fakeDb(missing) as never).catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(SqliteVecPlatformUnsupportedError);
    expect((failure as Error).message).toBe(missing);
  });

  test('a yes too weak to act on rethrows the original error', async () => {
    probability = 0.65;
    const failure = await loadSqliteVecExtension(fakeDb('not authorized') as never).catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(SqliteVecPlatformUnsupportedError);
    expect((failure as Error).message).toBe('not authorized');
  });

  test('a successful load asks nothing', async () => {
    await loadSqliteVecExtension({ loadExtension: () => undefined } as never);
    expect(requests).toHaveLength(0);
  });
});
