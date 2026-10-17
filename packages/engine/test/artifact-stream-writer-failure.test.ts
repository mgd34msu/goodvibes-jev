import { expect, test } from 'bun:test';
import { chmodSync, readdirSync, rmSync } from 'node:fs';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

test('a spool open failure rejects and cancels a producer waiting for its next chunk', async () => {
  const root = makeProjectTempDir('artifact-spool-failure');
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const store = new ArtifactStore({ rootDir: root });
  let checks = 0;
  try {
    await expect(store.createFromStream({ stream, mimeType: 'image/png', filename: 'test.png', acquisitionMode: 'inline-data', fetchMode: 'not-applicable' }, {
      assertCurrent() { if (++checks === 2) chmodSync(root, 0o500); },
    })).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  } finally { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }
});
