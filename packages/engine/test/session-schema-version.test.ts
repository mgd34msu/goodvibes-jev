import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, CURRENT_SESSION_SCHEMA_VERSION } from '../sdk/src/platform/sessions/manager.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-schema-'));
}

const SAMPLE_META = {
  title: 'Test Session',
  model: 'claude:test',
  provider: 'anthropic',
  timestamp: 1_700_000_000_000,
  titleSource: 'system' as const,
};

const SAMPLE_MESSAGES = [{ role: 'user', content: 'hello' }];

describe('SessionManager schemaVersion', () => {
  test('saved files contain schemaVersion in meta line', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const { filePath } = mgr.save('test-session', SAMPLE_MESSAGES, SAMPLE_META);

      const raw = readFileSync(filePath, 'utf-8');
      const firstLine = raw.split('\n')[0]!;
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;

      expect(parsed.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
      expect(parsed.type).toBe('meta');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('load() returns schemaVersion from saved file', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('versioned', SAMPLE_MESSAGES, SAMPLE_META);
      const { meta } = mgr.load('versioned');

      expect(meta.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy files without schemaVersion load successfully (backward compat)', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      // Write a legacy file that has no schemaVersion field
      const legacyMeta = JSON.stringify({
        type: 'meta',
        timestamp: 1_000_000_000_000,
        title: 'Legacy',
        model: 'legacy-model',
        provider: 'legacy-provider',
        titleSource: 'system',
      });
      const legacyMsg = JSON.stringify({ type: 'message', role: 'user', content: 'old message' });
      writeFileSync(join(dir, 'legacy.jsonl'), `${legacyMeta}\n${legacyMsg}\n`, 'utf-8');

      const { meta, messages } = mgr.load('legacy');

      // Should load successfully with schemaVersion defaulted to 0
      expect(meta.title).toBe('Legacy');
      expect(meta.model).toBe('legacy-model');
      expect(meta.schemaVersion).toBe(0);
      expect(messages).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('future schemaVersion files load with a warning but do not throw', () => {
    const dir = makeTmpDir();
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const originalWarn = logger.warn.bind(logger);
    const mutableLogger = logger as unknown as {
      warn(msg: string, data?: Record<string, unknown>): void;
    };
    mutableLogger.warn = (msg, data) => warnings.push({ message: msg, ...(data !== undefined ? { data } : {}) });

    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const futureVersion = CURRENT_SESSION_SCHEMA_VERSION + 99;
      const futureMeta = JSON.stringify({
        type: 'meta',
        schemaVersion: futureVersion,
        timestamp: 1_000_000_000_000,
        title: 'Future',
        model: 'future-model',
        provider: 'future-provider',
        titleSource: 'user',
      });
      const futureMsg = JSON.stringify({ type: 'message', role: 'assistant', content: 'future content' });
      writeFileSync(join(dir, 'future.jsonl'), `${futureMeta}\n${futureMsg}\n`, 'utf-8');

      let meta: ReturnType<typeof mgr.load>['meta'];
      let messages: ReturnType<typeof mgr.load>['messages'];

      expect(() => {
        const result = mgr.load('future');
        meta = result.meta;
        messages = result.messages;
      }).not.toThrow();

      // Data should be best-effort parsed
      expect(meta!.title).toBe('Future');
      expect(meta!.schemaVersion).toBe(futureVersion);
      expect(messages!).toHaveLength(1);

      // A warning should have been logged
      const warnEntry = warnings.find(w =>
        w.message.includes('newer schemaVersion') &&
        w.data?.fileVersion === futureVersion &&
        w.data?.currentVersion === CURRENT_SESSION_SCHEMA_VERSION
      );
      expect(warnEntry).toBeDefined();
    } finally {
      mutableLogger.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getMeta() returns schemaVersion', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('meta-check', SAMPLE_MESSAGES, SAMPLE_META);
      const meta = mgr.getMeta('meta-check');

      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getMeta() returns schemaVersion 0 for legacy files', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const legacyMeta = JSON.stringify({
        type: 'meta',
        timestamp: 1_000_000_000_000,
        title: 'OldSession',
        model: 'm',
        provider: 'p',
        titleSource: 'system',
      });
      writeFileSync(join(dir, 'old.jsonl'), `${legacyMeta}\n`, 'utf-8');

      const meta = mgr.getMeta('old');
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('list() returns entries and getMeta() exposes schemaVersion for each', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('list-check', SAMPLE_MESSAGES, SAMPLE_META);
      const sessions = mgr.list();

      expect(sessions).toHaveLength(1);
      // SessionInfo itself does not carry schemaVersion (it is not part of the listing shape);
      // getMeta() is the accessor that exposes it for a named session.
      const meta = mgr.getMeta(sessions[0]!.name);
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);

      // load() also propagates schemaVersion
      const loaded = mgr.load('list-check');
      expect(loaded.meta.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rename() preserves schemaVersion in meta line', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('to-rename', SAMPLE_MESSAGES, SAMPLE_META);
      mgr.rename('to-rename', 'Renamed Title');

      const { meta } = mgr.load('to-rename');
      expect(meta.title).toBe('Renamed Title');
      expect(meta.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CURRENT_SESSION_SCHEMA_VERSION is exported and equals 2', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(2);
  });

  test('save() defaults saveSource to "auto" when the caller does not specify one', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const { filePath } = mgr.save('auto-default', SAMPLE_MESSAGES, SAMPLE_META);
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw.split('\n')[0]!) as Record<string, unknown>;
      expect(parsed.saveSource).toBe('auto');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('save() persists an explicit saveSource: "user", and load()/getMeta() round-trip it', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('user-saved', SAMPLE_MESSAGES, { ...SAMPLE_META, saveSource: 'user' });

      const { meta } = mgr.load('user-saved');
      expect(meta.saveSource).toBe('user');
      expect(mgr.getMeta('user-saved')?.saveSource).toBe('user');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy files without a saveSource field load with saveSource undefined (never fabricated)', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const legacyMeta = JSON.stringify({
        type: 'meta',
        schemaVersion: 1,
        timestamp: 1_000_000_000_000,
        title: 'Pre-saveSource',
        model: 'm',
        provider: 'p',
        titleSource: 'system',
      });
      writeFileSync(join(dir, 'pre-savesource.jsonl'), `${legacyMeta}\n`, 'utf-8');

      const { meta } = mgr.load('pre-savesource');
      expect(meta.saveSource).toBeUndefined();
      expect(mgr.getMeta('pre-savesource')?.saveSource).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('atomic write: saved file exists and is not a tmp file', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const { filePath, sanitizedName } = mgr.save('atomic-test', SAMPLE_MESSAGES, SAMPLE_META);

      expect(existsSync(filePath)).toBe(true);
      expect(filePath).toEndWith(`${sanitizedName}.jsonl`);
      // No lingering .tmp- files
      const files = readdirSync(dir);
      expect(files.filter(f => f.startsWith('.tmp-'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SessionManager contract lines (version 2)', () => {
  const contract = (id: string) => ({ id, status: 'running', sessionId: 'session-1', ask: 'Add a parser.', groups: [], units: [], criteria: [] });

  test('save writes one contract line per contract after the agent records, and load returns them', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const contracts = [contract('ctr-00000001'), contract('ctr-00000002')] as unknown as Parameters<SessionManager['save']>[4];
      const agent = { id: 'agent-1', status: 'completed', task: 'work' } as unknown as NonNullable<Parameters<SessionManager['save']>[3]>[number];
      const { filePath } = mgr.save('with-contracts', SAMPLE_MESSAGES, SAMPLE_META, [agent], contracts);
      const types = readFileSync(filePath, 'utf-8').trim().split('\n').map((line) => (JSON.parse(line) as { type: string }).type);
      expect(types).toEqual(['meta', 'message', 'agent_record', 'contract', 'contract']);
      const loaded = mgr.load('with-contracts');
      expect(loaded.contracts.map((entry) => entry.id)).toEqual(['ctr-00000001', 'ctr-00000002']);
      expect(loaded.agentRecords.map((entry) => entry.id)).toEqual(['agent-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a session saved without contracts loads with an empty list', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('no-contracts', SAMPLE_MESSAGES, SAMPLE_META);
      expect(mgr.load('no-contracts').contracts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a version 1 file loads with an empty contract list, whatever lines it carries', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const lines = [
        { type: 'meta', schemaVersion: 1, timestamp: 1, title: 'old', model: 'm', provider: 'p' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'contract', contract: contract('ctr-00000003') },
      ];
      writeFileSync(join(dir, 'version-one.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
      const loaded = mgr.load('version-one');
      expect(loaded.meta.schemaVersion).toBe(1);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.contracts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a contract line without the fields readers rely on is skipped, not returned', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const lines = [
        { type: 'meta', schemaVersion: 2, timestamp: 1, title: 't', model: 'm', provider: 'p' },
        { type: 'contract', contract: { id: 'ctr-00000004' } },
        { type: 'contract', contract: contract('ctr-00000005') },
      ];
      writeFileSync(join(dir, 'partial.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
      expect(mgr.load('partial').contracts.map((entry) => entry.id)).toEqual(['ctr-00000005']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
