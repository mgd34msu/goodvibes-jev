/**
 * FileWatcher.start reads which project-root files are configuration or
 * environment files (engine.state.watched-config, one yes/no per root entry)
 * and watches the ones read yes with an act outcome. The fake port answers
 * each entry with the probability the test gives its name.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { FileWatcher } from '../sdk/src/platform/state/file-watcher.ts';
import type { FileStateCache } from '../sdk/src/platform/state/file-cache.ts';
import type { ProjectIndex } from '../sdk/src/platform/state/project-index.ts';
import { WATCHED_CONFIG_QUERY } from '../sdk/src/platform/state/batteries/watched-config.ts';

const ANSWERS: Record<string, number> = {
  'package.json': 0.97,
  '.env.staging': 0.97,
  'pyproject.toml': 0.58,
  'README.md': 0.03,
};

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
  for (const name of Object.keys(ANSWERS)) writeFileSync(join(root, name), '{}\n');
  mkdirSync(join(root, 'src'));
  const fake = fakePort((name, _question, state) => {
    if (name !== 'match') throw new Error(`unexpected question ${name}`);
    const entry = (state as { candidate: { name: string } }).candidate.name;
    return noulAnswer(ANSWERS[entry] ?? 0.03);
  });
  requests = fake.requests;
  previous = installJudgmentPort(fake.port);
});

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  installJudgmentPort(previous);
  rmSync(root, { recursive: true, force: true });
});

describe('FileWatcher root configuration reading', () => {
  test('reads each regular root file by name and watches only a confident yes', async () => {
    const watcher = makeWatcher();
    await watcher.start();
    const watched = [...watcher.getWatchedPaths()].sort();
    expect(watched).toEqual([join(root, '.env.staging'), join(root, '.goodvibes'), join(root, 'package.json')].sort());
    // One request per regular file (the src directory is not read), names only.
    const states = requests.map((request) => request.state as { query: string; candidate: { name: string } });
    expect(states.every((state) => state.query === WATCHED_CONFIG_QUERY)).toBe(true);
    expect(states.map((state) => state.candidate).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      ['.env.staging', 'package.json', 'pyproject.toml', 'README.md'].sort((a, b) => a.localeCompare(b)).map((name) => ({ name })),
    );
  });

  test('a stop while the root is being read leaves nothing watched', async () => {
    const watcher = makeWatcher();
    const starting = watcher.start();
    watcher.stop();
    await starting;
    expect(watcher.getWatchedPaths().size).toBe(0);
    expect(watcher.isWatching()).toBe(false);
  });

  test('with no judgment port, start rejects and the watcher is not left started', async () => {
    installJudgmentPort(undefined);
    const watcher = makeWatcher();
    await expect(watcher.start()).rejects.toBeInstanceOf(JudgmentPortMissingError);
    expect(watcher.isWatching()).toBe(false);
  });
});
