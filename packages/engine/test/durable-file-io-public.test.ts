import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireCrossProcessLock, writeJsonFileAtomic, confirmFileDurable, AtomicWriteDurabilityError,
  type AtomicJsonWriteOptions, type CrossProcessLockOptions } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import * as originalFile from '../sdk/src/platform/utils/atomic-json-store.js';
import * as originalLock from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';

test('public Node journal seam retains the existing strict lock and required publication implementations', async () => {
  expect(writeJsonFileAtomic).toBe(originalFile.writeJsonFileAtomic);
  expect(confirmFileDurable).toBe(originalFile.confirmFileDurable);
  expect(AtomicWriteDurabilityError).toBe(originalFile.AtomicWriteDurabilityError);
  expect(acquireCrossProcessLock).toBe(originalLock.acquireCrossProcessLock);
  const root = mkdtempSync(join(tmpdir(), 'durable-file-public-'));
  const file = join(root, 'pending.json'); const lock = join(root, 'pending.lock');
  const writes: AtomicJsonWriteOptions = { durable: true, mode: 0o600 };
  const locks: CrossProcessLockOptions = { strictOwnership: true, totalTimeoutMs: 100 };
  let release: (() => void) | undefined;
  try {
    release = await acquireCrossProcessLock(lock, locks);
    writeJsonFileAtomic(file, { requestId: 'owned-request', state: 'pending' }, writes);
    confirmFileDurable(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ requestId: 'owned-request', state: 'pending' });
    release(); release = await acquireCrossProcessLock(lock, locks);
    expect(typeof release).toBe('function');
  } finally { release?.(); rmSync(root, { recursive: true, force: true }); }
});
