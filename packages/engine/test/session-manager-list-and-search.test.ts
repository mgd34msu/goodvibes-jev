/**
 * SessionManager.list counts messages from the parsed records, and search
 * logs the session it was reading. Both were found on the E.16 re-read:
 * list tested substrings of each line (a `"removed":true` written after the
 * first 60 characters was counted as live, and any record whose text held
 * `"type":"message"` was counted as a message), and search's warnings named
 * the global `name` rather than the session.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../sdk/src/platform/sessions/manager.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionsWith(name: string, lines: readonly unknown[]): { manager: SessionManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'session-list-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, `${name}.jsonl`),
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
  );
  return { manager: new SessionManager('/unused', { sessionsDir: dir }), dir };
}

const META = { type: 'meta', title: 'A session', model: 'm', provider: 'p', timestamp: 1, schemaVersion: 1 };

describe('SessionManager.list', () => {
  test('a removed message is not counted, wherever its removed field sits in the line', () => {
    const { manager } = sessionsWith('s1', [
      META,
      { role: 'user', content: 'hello', type: 'message' },
      { role: 'assistant', content: 'a reply long enough to push later fields past sixty characters', removed: true, type: 'message' },
    ]);
    expect(manager.list().find((session) => session.name === 's1')?.messageCount).toBe(1);
  });

  test('a record of another type that holds a nested message is not a message', () => {
    const { manager } = sessionsWith('s2', [
      META,
      { role: 'user', content: 'hi', type: 'message' },
      { type: 'agent_record', lastSeen: { type: 'message', content: 'nested' } },
      'not json at all',
    ]);
    expect(manager.list().find((session) => session.name === 's2')?.messageCount).toBe(1);
  });
});

describe('SessionManager.search', () => {
  test('a malformed line is logged with the session it came from', () => {
    const { manager } = sessionsWith('named-session', [META, { role: 'user', content: 'find me', type: 'message' }, '{not json']);
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const mutable = logger as unknown as { warn(message: string, data?: Record<string, unknown>): void };
    const original = mutable.warn;
    mutable.warn = (message, data) => {
      if (message.includes('during search')) warnings.push(data);
    };
    try {
      expect(manager.search('find')).toHaveLength(1);
    } finally {
      mutable.warn = original;
    }
    expect(warnings.map((data) => data?.['name'])).toEqual(['named-session']);
  });
});
