import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getOrCreateCompanionToken,
  regenerateCompanionToken,
  type CompanionTokenRecord,
} from '../sdk/src/platform/pairing/companion-token.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'gv-companion-atomic-'));
  roots.push(root);
  return { root, file: join(root, 'operator-tokens.json') };
}

function publicationFailure(operation: () => unknown): Error {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

const previousRecord: CompanionTokenRecord = {
  token: 'gv_owned_synthetic_previous_token',
  peerId: 'owned-synthetic-peer',
  createdAt: 1,
};

describe('companion token atomic publication', () => {
  test('creates nested daemon homes with the existing JSON format, owner-only mode, and no temp files', () => {
    const { root } = fixture();
    const daemonHomeDir = join(root, 'new', 'daemon-home');
    const file = join(daemonHomeDir, 'operator-tokens.json');

    const result = getOrCreateCompanionToken({ daemonHomeDir });

    expect(result.token).toMatch(/^gv_[A-Za-z0-9_-]{32}$/);
    expect(result.peerId).toMatch(/^[a-f0-9]{24}$/);
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(result, null, 2));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(daemonHomeDir)).toEqual(['operator-tokens.json']);
  });

  test('reuses a readable record without changing its bytes or inode', () => {
    const { root, file } = fixture();
    const bytes = JSON.stringify({ ...previousRecord, extra: 'preserved' }) + '\n';
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const original = fs.statSync(file);

    expect(getOrCreateCompanionToken({ daemonHomeDir: root })).toEqual(previousRecord);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.statSync(file).ino).toBe(original.ino);
    expect(fs.readdirSync(root)).toEqual(['operator-tokens.json']);
  });

  test('reset publishes a complete 0600 temp file over the untouched old image', () => {
    const { root, file } = fixture();
    const oldBytes = JSON.stringify(previousRecord, null, 2);
    fs.writeFileSync(file, oldBytes, { mode: 0o644 });
    let publishedBytes: string | undefined;
    const actualRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      expect(target).toBe(file);
      expect(String(source)).toStartWith(`${file}.tmp-`);
      expect(fs.readFileSync(file, 'utf8')).toBe(oldBytes);
      expect(fs.statSync(source).mode & 0o777).toBe(0o600);
      publishedBytes = fs.readFileSync(source, 'utf8');
      expect(JSON.parse(publishedBytes).token).toStartWith('gv_');
      actualRename(source, target);
    });
    let result: CompanionTokenRecord;
    try { result = regenerateCompanionToken({ daemonHomeDir: root }); }
    finally { rename.mockRestore(); }

    expect(result.token).not.toBe(previousRecord.token);
    expect(publishedBytes).toBe(JSON.stringify(result, null, 2));
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(result, null, 2));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(['operator-tokens.json']);
  });

  test.each([false, true])('a real partial temp write fails without publication (reset: %s)', (reset) => {
    const { root, file } = fixture();
    const oldBytes = JSON.stringify(previousRecord, null, 2);
    if (reset) fs.writeFileSync(file, oldBytes, { mode: 0o600 });
    const actualWrite = fs.writeSync;
    const write = spyOn(fs, 'writeSync').mockImplementation((fd, contents) => {
      // Actually leave partial bytes in the owned temp file, rather than
      // replacing the shared atomic writer with an early throwing stub.
      return actualWrite(fd, String(contents).slice(0, 12), null, 'utf8');
    });
    let error: Error;
    try {
      error = publicationFailure(() => getOrCreateCompanionToken({ daemonHomeDir: root, regenerate: reset }));
      expect(write).toHaveBeenCalledTimes(1);
    } finally { write.mockRestore(); }

    expect(error.message).toBe('Incomplete atomic file write');
    if (reset) expect(fs.readFileSync(file, 'utf8')).toBe(oldBytes);
    else expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(root)).toEqual(reset ? ['operator-tokens.json'] : []);
  });

  test.each(['fsync', 'chmod', 'rename'] as const)('%s failure preserves the old token and removes the temp file', (phase) => {
    const { root, file } = fixture();
    const oldBytes = JSON.stringify(previousRecord, null, 2);
    fs.writeFileSync(file, oldBytes, { mode: 0o600 });
    const failure = new Error(`Owned synthetic ${phase} failure`);
    const fail = () => { throw failure; };
    const operation = phase === 'fsync' ? spyOn(fs, 'fsyncSync').mockImplementation(fail)
      : phase === 'chmod' ? spyOn(fs, 'chmodSync').mockImplementation(fail)
        : spyOn(fs, 'renameSync').mockImplementation(fail);
    let error: Error;
    try {
      error = publicationFailure(() => regenerateCompanionToken({ daemonHomeDir: root }));
      expect(operation).toHaveBeenCalledTimes(1);
    } finally { operation.mockRestore(); }

    expect(error).toBe(failure);
    expect(fs.readFileSync(file, 'utf8')).toBe(oldBytes);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(['operator-tokens.json']);
    expect(getOrCreateCompanionToken({ daemonHomeDir: root })).toEqual(previousRecord);
  });

  test('creation retains file-only fsync without imposing directory durability support', () => {
    const { root, file } = fixture();
    const actualSync = fs.fsyncSync;
    const synced: string[] = [];
    const sync = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
      synced.push(kind);
      if (kind === 'directory') throw new Error('Owned synthetic unsupported directory fsync');
      actualSync(fd);
    });
    let result: CompanionTokenRecord;
    try {
      result = getOrCreateCompanionToken({ daemonHomeDir: root });
    } finally { sync.mockRestore(); }

    expect(synced).toEqual(['file']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(result);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(['operator-tokens.json']);
  });

  test('a failed write after quarantine preserves the unreadable original', () => {
    const { root, file } = fixture();
    const oldBytes = '{ owned synthetic truncated record';
    fs.writeFileSync(file, oldBytes, { mode: 0o600 });
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('Owned synthetic temp fsync failure'); });
    try {
      expect(() => getOrCreateCompanionToken({ daemonHomeDir: root })).toThrow('Owned synthetic temp fsync failure');
    } finally { sync.mockRestore(); }

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}.unrecognized`, 'utf8')).toBe(oldBytes);
    expect(fs.readdirSync(root)).toEqual(['operator-tokens.json.unrecognized']);
  });
});
