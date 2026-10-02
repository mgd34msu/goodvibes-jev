import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteStorePersistence, SQLitePublicationError, type SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function path() { const root = fs.mkdtempSync(join(tmpdir(), 'ledger-publication-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
const old = Buffer.from('old-image'), next = Buffer.from('new-image');
function setup(fault: string | null) {
  const file = path(); fs.writeFileSync(file, old); const calls: string[] = []; const kinds = new Map<number, string>();
  const io: SQLitePublicationIO = {
    ...fs,
    openSync(...args) { const kind = String(args[0]).includes('.pending-') ? 'temp' : String(args[0]) === file ? 'file' : 'dir'; calls.push(`open:${kind}`); if (fault === `open:${kind}`) throw new Error('injected'); const fd = fs.openSync(...args); kinds.set(fd, kind); return fd; },
    writeFileSync(...args) { calls.push('write'); if (fault === 'write') throw new Error('injected'); fs.writeFileSync(...args); },
    fsyncSync(fd) { const operation = `sync:${kinds.get(fd)}`; calls.push(operation); if (fault === operation) throw new Error('injected'); fs.fsyncSync(fd); },
    closeSync(fd) { const operation = `close:${kinds.get(fd)}`; calls.push(operation); fs.closeSync(fd); if (fault === operation) throw new Error('injected'); },
    renameSync(...args) { calls.push('rename'); if (fault === 'rename') throw new Error('injected'); fs.renameSync(...args); },
    unlinkSync(...args) { calls.push('unlink'); if (fault === 'unlink') throw new Error('injected'); fs.unlinkSync(...args); },
  };
  const persistence = new SQLiteStorePersistence(file, io); persistence.acceptBaseline(persistence.read());
  return { file, persistence, calls };
}
for (const phase of ['open:temp', 'write', 'sync:temp', 'close:temp', 'rename']) {
  test(`before-publication ${phase} failure leaves original image unchanged`, () => {
    const { file, persistence } = setup(phase);
    let error: unknown; try { persistence.writeIfCurrent(next); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SQLitePublicationError); expect((error as SQLitePublicationError).phase).toBe('before-publication');
    expect(fs.readFileSync(file)).toEqual(old);
  });
}
for (const phase of ['open:dir', 'sync:dir']) {
  test(`after-rename ${phase} failure is indeterminate, exact observation resyncs file and directory`, () => {
    const { file, persistence } = setup(phase);
    let error: unknown; try { persistence.writeIfCurrent(next); } catch (caught) { error = caught; }
    expect((error as SQLitePublicationError).phase).toBe('indeterminate'); expect(fs.readFileSync(file)).toEqual(next);
    const recovered = new SQLiteStorePersistence(file); recovered.confirmDurable(); expect(recovered.read()).toEqual(next);
  });
}
test('publication orders file fsync before rename before parent fsync; cleanup cannot undo success', () => {
  const { file, persistence, calls } = setup('unlink'); persistence.writeIfCurrent(next);
  expect(fs.readFileSync(file)).toEqual(next);
  expect(calls.indexOf('sync:temp')).toBeLessThan(calls.indexOf('rename'));
  expect(calls.indexOf('rename')).toBeLessThan(calls.indexOf('sync:dir'));
  expect(calls.indexOf('sync:dir')).toBeLessThan(calls.indexOf('unlink'));
});
test('directory-close failure after fsync does not masquerade as rollback', () => {
  const { file, persistence } = setup('close:dir'); persistence.writeIfCurrent(next); expect(fs.readFileSync(file)).toEqual(next);
});
test('durable receipt reconciliation synchronizes current file and directory again', () => {
  const { file, persistence, calls } = setup(null); persistence.confirmDurable();
  const expected = ['open:file', 'sync:file', 'close:file'];
  for (let path = dirname(file);; path = dirname(path)) {
    expected.push('open:dir', 'sync:dir', 'close:dir');
    if (dirname(path) === path) break;
  }
  expect(calls).toEqual(expected);
});
