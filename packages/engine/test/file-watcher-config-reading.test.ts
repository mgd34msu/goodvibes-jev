import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { FileWatcher } from '../sdk/src/platform/state/file-watcher.ts';
import type { FileStateCache } from '../sdk/src/platform/state/file-cache.ts';
import type { ProjectIndex } from '../sdk/src/platform/state/project-index.ts';

const ROOT_FILES = ['package.json', '.env.staging', 'pyproject.toml', 'README.md'];

let root: string;
let requests: ReturnType<typeof fakePort>['requests'] = [];
let previous: JudgmentPort | undefined;
const watchers: FileWatcher[] = [];

function makeWatcher(): FileWatcher {
  const fileCache = { invalidate: () => undefined } as unknown as FileStateCache;
  const projectIndex = { getFiles: () => [], upsertFile: () => undefined } as unknown as ProjectIndex;
  const watcher = new FileWatcher(fileCache, projectIndex, { projectRoot: root });
  watchers.push(watcher);
  return watcher;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-file-watcher-'));
  for (const name of ROOT_FILES) writeFileSync(join(root, name), '{}\n');
  mkdirSync(join(root, 'src'));
  const fake = fakePort(() => { throw new Error('Filename watching must stay local'); });
  requests = fake.requests;
  previous = installJudgmentPort(fake.port);
});

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  installJudgmentPort(previous);
  rmSync(root, { recursive: true, force: true });
});

describe('FileWatcher root configuration reading', () => {
  test('watches regular root files without interpreting names or reading their contents', async () => {
    const watcher = makeWatcher();
    await watcher.start();
    expect([...watcher.getWatchedPaths()].sort()).toEqual([...ROOT_FILES, '.goodvibes'].map(name => join(root, name)).sort());
    expect(requests).toHaveLength(0);
  });

  test('a stop while the root is being read leaves nothing watched', async () => {
    const watcher = makeWatcher();
    const starting = watcher.start();
    watcher.stop();
    await starting;
    expect(watcher.getWatchedPaths().size).toBe(0);
    expect(watcher.isWatching()).toBe(false);
  });

  test('watching is available without a judgment port', async () => {
    installJudgmentPort(undefined);
    const watcher = makeWatcher();
    await watcher.start();
    expect(watcher.isWatching()).toBe(true);
    expect(watcher.getWatchedPaths().has(join(root, 'pyproject.toml'))).toBe(true);
  });
});
