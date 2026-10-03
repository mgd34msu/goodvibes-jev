import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runStoreFileUpdate, writeStoreFile, writeStoreJson } from '../../utils/store-file.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { leftoverStoreTempFiles } from '../helpers/store-temp-files.ts';

const STORE_FILE_MODULE = join(import.meta.dir, '..', '..', 'utils', 'store-file.ts');

function withTempRoot<T>(fn: (root: string) => T): T {
  const root = makeProjectTempDir('gv-store-file');
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempRootAsync<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = makeProjectTempDir('gv-store-file');
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('writeStoreFile', () => {
  test('creates the parent directory and writes the exact contents', () => {
    withTempRoot((root) => {
      const path = join(root, 'nested', 'deeper', 'store.json');
      writeStoreFile(path, '{"a":1}\n');
      expect(readFileSync(path, 'utf-8')).toBe('{"a":1}\n');
      expect(leftoverStoreTempFiles(path)).toEqual([]);
    });
  });

  test('writeStoreJson round-trips as pretty JSON with a trailing newline', () => {
    withTempRoot((root) => {
      const path = join(root, 'store.json');
      writeStoreJson(path, { version: 1, items: ['a'] });
      const text = readFileSync(path, 'utf-8');
      expect(text.endsWith('\n')).toBe(true);
      expect(JSON.parse(text)).toEqual({ version: 1, items: ['a'] });
    });
  });

  test('a failed write leaves the previous file intact and removes its own temp file', () => {
    withTempRoot((root) => {
      const dir = join(root, 'readonly');
      const path = join(dir, 'store.json');
      writeStoreFile(path, 'original\n');
      chmodSync(dir, 0o500);
      try {
        expect(() => writeStoreFile(path, 'replacement\n')).toThrow();
        expect(readFileSync(path, 'utf-8')).toBe('original\n');
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(leftoverStoreTempFiles(path)).toEqual([]);
    });
  });

  test('two writes to one path from this process never share a temp path', () => {
    withTempRoot((root) => {
      const path = join(root, 'store.json');
      // The temp file only exists mid-write, so observe the names instead: a
      // directory made read-only after the first write forces each attempt to
      // fail with its own temp path in the error message.
      const dir = dirname(path);
      writeStoreFile(path, 'seed\n');
      chmodSync(dir, 0o500);
      const tempPaths: string[] = [];
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            writeStoreFile(path, 'blocked\n');
          } catch (error) {
            tempPaths.push(String((error as { path?: string }).path ?? error));
          }
        }
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(tempPaths).toHaveLength(2);
      expect(tempPaths[0]).not.toBe(tempPaths[1]);
    });
  });

  test('four concurrent OS processes hammering one store never leave a torn file', async () => {
    await withTempRootAsync(async (root) => {
      const path = join(root, 'store.json');
      const writerScript = join(root, 'writer.ts');
      // A payload far larger than any single filesystem write, so a shared temp
      // file would reliably interleave rather than only under a tight race.
      writeFileSync(
        writerScript,
        [
          `import { writeStoreFile } from ${JSON.stringify(STORE_FILE_MODULE)};`,
          'const [path, marker] = process.argv.slice(2);',
          'const body = marker!.repeat(300_000);',
          'for (let i = 0; i < 25; i += 1) writeStoreFile(path!, body);',
          '',
        ].join('\n'),
        'utf-8',
      );

      const markers = ['a', 'b', 'c', 'd'];
      const exits = await Promise.all(
        markers.map(async (marker) => {
          const proc = Bun.spawn(['bun', 'run', writerScript, path, marker], {
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
          return { marker, stderr, exitCode };
        }),
      );
      // These two assertions are the discriminator, not bookkeeping: against a
      // shared `${path}.tmp` at this exact pressure, three of the four children
      // die with ENOENT on rename because a sibling already renamed the temp
      // file they were still writing into.
      for (const exit of exits) {
        expect(exit.stderr).toBe('');
        expect(exit.exitCode).toBe(0);
      }

      const final = readFileSync(path, 'utf-8');
      const distinctCharacters = new Set(final);
      // One whole writer's payload, never a splice of two.
      expect(distinctCharacters.size).toBe(1);
      expect(markers).toContain([...distinctCharacters][0]!);
      expect(final).toHaveLength(300_000);
      expect(leftoverStoreTempFiles(path)).toEqual([]);
    });
  }, 60_000);
});

describe('runStoreFileUpdate', () => {
  /** A read-modify-write cycle with a real suspension point between the read and the write. */
  async function appendSlowly(path: string, value: number): Promise<void> {
    const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as number[]) : [];
    await new Promise((resolve) => setTimeout(resolve, 1));
    writeStoreJson(path, [...current, value]);
  }

  test('unqueued read-modify-write cycles that span an await lose updates', async () => {
    await withTempRootAsync(async (root) => {
      const path = join(root, 'store.json');
      mkdirSync(root, { recursive: true });
      await Promise.all([1, 2, 3, 4, 5].map((value) => appendSlowly(path, value)));
      // The premise of the queue below: without it, every writer reads the same
      // empty file and the last rename wins.
      expect((JSON.parse(readFileSync(path, 'utf-8')) as number[]).length).toBeLessThan(5);
    });
  });

  test('queued cycles on one path keep every update', async () => {
    await withTempRootAsync(async (root) => {
      const path = join(root, 'store.json');
      const values = [1, 2, 3, 4, 5, 6, 7, 8];
      await Promise.all(values.map((value) => runStoreFileUpdate(path, () => appendSlowly(path, value))));
      const stored = JSON.parse(readFileSync(path, 'utf-8')) as number[];
      expect([...stored].sort((a, b) => a - b)).toEqual(values);
    });
  });

  test('queues on the store path, not the caller, so separate owners still take turns', async () => {
    await withTempRootAsync(async (root) => {
      const path = join(root, 'store.json');
      // Two "registries" over one file, each with its own spelling of the same
      // path. Both must land in the same queue.
      const spellings = [path, `${root}/./store.json`];
      await Promise.all(
        [1, 2, 3, 4].map((value, index) =>
          runStoreFileUpdate(spellings[index % 2]!, () => appendSlowly(path, value)),
        ),
      );
      const stored = JSON.parse(readFileSync(path, 'utf-8')) as number[];
      expect([...stored].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    });
  });

  test('a rejected update does not wedge the ones behind it', async () => {
    await withTempRootAsync(async (root) => {
      const path = join(root, 'store.json');
      const failing = runStoreFileUpdate(path, () => {
        throw new Error('update failed');
      });
      const following = runStoreFileUpdate(path, () => appendSlowly(path, 1));
      await expect(failing).rejects.toThrow('update failed');
      await following;
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual([1]);
    });
  });
});
