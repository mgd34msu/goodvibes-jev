import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { FilePickerModal } from '../../input/file-picker.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
afterEach(() => installJudgmentPort(previous));
function fixture() {
  const root = makeProjectTempDir('gv-file-picker-reading');
  for (const path of ['src/dist', 'node_modules', 'target', '.hidden', 'dist']) mkdirSync(join(root, path), { recursive: true });
  for (const path of ['src/dist/authored.ts', 'node_modules/dependency.ts', 'target/generated.ts', '.hidden/private.ts', 'dist/authored.ts', 'README.md', '.dotfile']) writeFileSync(join(root, path), 'fixture');
  const paths = { workingDirectory: root };
  return { root, paths, picker: new FilePickerModal(paths) };
}
function fakeDirectories(probability: (path: string) => number) {
  return fakePort((name, _question, state) => {
    const directories = (state as { directories: { id: string; name: string; relativePath: string }[] }).directories;
    return noulAnswer(probability(directories.find(directory => directory.id === name)!.relativePath));
  });
}
function open(picker: FilePickerModal): Promise<void> {
  return new Promise(resolve => { picker.setOnUpdate(resolve); picker.open(4, true); });
}

describe('file picker canonical directory readings', () => {
  test('one fan-out per level, exact identities and authored dist; hidden paths never submitted', async () => {
    const f = fixture(); const fake = fakeDirectories(path => ['node_modules', 'target'].includes(path) ? 0.99 : 0.01);
    previous = installJudgmentPort(fake.port); await open(f.picker);
    expect(f.picker.allFiles).toEqual(['README.md', 'dist/', 'dist/authored.ts', 'src/', 'src/dist/', 'src/dist/authored.ts']);
    expect(fake.requests).toHaveLength(2);
    expect((fake.requests[0]!.state as { directories: unknown[] }).directories).toHaveLength(4);
    expect(JSON.stringify(fake.requests)).not.toContain('.hidden');
    expect(JSON.stringify(fake.requests)).not.toContain('.dotfile');
    f.picker.setQuery('s/d/a'); expect(f.picker.results).toEqual(['src/dist/authored.ts']);
    expect(f.picker.getSelected()).toBe('src/dist/authored.ts');
    expect(f.picker.insertPos).toBe(4); expect(f.picker.injectMode).toBe(true);
    f.picker.close(); f.picker.open(2); expect(fake.requests).toHaveLength(2);
    expect(f.picker.results).toEqual(f.picker.allFiles);
  });

  test('directory names never exclude ordinary files', async () => {
    const root = makeProjectTempDir('gv-file-picker-names');
    writeFileSync(join(root, 'node_modules'), 'authored'); writeFileSync(join(root, 'dist'), 'authored');
    const fake = fakeDirectories(() => 0.99); previous = installJudgmentPort(fake.port);
    const picker = new FilePickerModal({ workingDirectory: root }); await open(picker);
    expect(picker.results).toEqual(['dist', 'node_modules']); expect(fake.requests).toHaveLength(0);
  });

  for (const failure of ['held', 'failed'] as const) {
    test(`${failure} directory reading exposes no partial cache and reopening retries`, async () => {
      const f = fixture(); previous = installJudgmentPort(failure === 'held' ? fakeDirectories(() => 0.5).port : fakePort(() => { throw new Error('reader unavailable'); }).port);
      await open(f.picker); expect(f.picker.results).toEqual([]); expect(f.picker.allFiles).toEqual([]);
      expect(f.picker.loadError).toContain('unavailable');
      f.picker.close(); const fake = fakeDirectories(() => 0.01); installJudgmentPort(fake.port);
      await open(f.picker); expect(f.picker.loadError).toBeUndefined(); expect(f.picker.results).toContain('target/generated.ts');
    });
  }

  for (const interrupt of ['close', 'invalidate', 'root', 'reopen'] as const) {
    test(`${interrupt} revokes pending list and prevents stale UI/cache writes`, async () => {
      const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
      const fake = fakeDirectories(() => 0.01);
      previous = installJudgmentPort({ ...fake.port, async ask(request) { requested(); await gate; return fake.port.ask(request); } });
      let updates = 0; f.picker.setOnUpdate(() => updates++); f.picker.open(0); await started;
      if (interrupt === 'close') f.picker.close();
      if (interrupt === 'invalidate') f.picker.invalidateCache();
      if (interrupt === 'root' || interrupt === 'reopen') {
        const other = makeProjectTempDir('gv-file-picker-other'); writeFileSync(join(other, 'fresh.ts'), 'fresh'); f.paths.workingDirectory = other;
        if (interrupt === 'reopen') await open(f.picker);
      }
      release(); await new Promise(resolve => setTimeout(resolve, 20));
      if (interrupt === 'reopen') expect(f.picker.results).toEqual(['fresh.ts']);
      else { expect(f.picker.results).toEqual([]); expect(updates).toBe(0); }
      expect(f.picker.allFiles).not.toContain('target/generated.ts');
      expect(fake.requests).toHaveLength(1);
    });
  }
});

test('root takeover fences transport reattempts before another request', async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
  let reattempts = 0;
  const fake = fakeDirectories(() => 0.01);
  previous = installJudgmentPort({ ...fake.port, async ask(request) {
    request.beforeAttempt?.(); requested(); await gate;
    request.beforeAttempt?.(); reattempts++;
    return fake.port.ask(request);
  } });
  f.picker.open(0); await started;
  f.paths.workingDirectory = makeProjectTempDir('gv-file-picker-takeover'); release();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(reattempts).toBe(0); expect(fake.requests).toHaveLength(0); expect(f.picker.allFiles).toEqual([]);
});
