import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertStaticCapturePathsDistinct } from '../scripts/read-static-source.ts';

test('publication aliases reject before any input, checkpoint, journal or log writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'static-capture-paths-'));
  try {
    const privatePath = join(root, 'private.json');
    const journalPath = `${privatePath}.journal`;
    const inputPath = join(root, 'inputs.json');
    const logPath = join(root, 'calls.sqlite');
    const privateBytes = '{"originalPrivateHistory":0.989999}\n';
    const journalBytes = '{"originalAnsweredCall":0.123456789}\n';
    writeFileSync(privatePath, privateBytes); writeFileSync(journalPath, journalBytes);
    for (const output of [privatePath, journalPath]) {
      const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../scripts/read-static-source.ts'),
        '--out', output, '--checkpoint', privatePath, '--inputs', inputPath, '--log', logPath],
      { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must point to distinct files');
      expect(readFileSync(privatePath, 'utf8')).toBe(privateBytes);
      expect(readFileSync(journalPath, 'utf8')).toBe(journalBytes);
      expect(existsSync(inputPath)).toBe(false);
      expect(existsSync(logPath)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing directory links, file links and hard links cannot alias publication history', () => {
  const root = mkdtempSync(join(tmpdir(), 'static-capture-link-paths-'));
  try {
    const directory = join(root, 'real');
    const linkedDirectory = join(root, 'linked');
    mkdirSync(directory); symlinkSync(directory, linkedDirectory, 'junction');
    const output = join(directory, 'receipt.json');
    writeFileSync(output, 'unchanged full history');
    const linkedFile = join(root, 'file-link.json');
    const hardLink = join(root, 'hard-link.json');
    symlinkSync(output, linkedFile); linkSync(output, hardLink);
    for (const checkpoint of [join(linkedDirectory, 'receipt.json'), linkedFile, hardLink]) {
      expect(() => assertStaticCapturePathsDistinct({ output, checkpoint })).toThrow('must point to distinct files');
    }
    expect(() => assertStaticCapturePathsDistinct({ output: join(directory, 'future', 'receipt.json'),
      checkpoint: join(linkedDirectory, 'future', 'receipt.json') })).toThrow('must point to distinct files');
    expect(readFileSync(output, 'utf8')).toBe('unchanged full history');
    expect(() => assertStaticCapturePathsDistinct({ output, checkpoint: join(root, 'separate.json'), journal: join(root, 'separate.json.journal') })).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('atomic staging files and SQLite sidecars cannot overwrite another owned evidence path', () => {
  const root = mkdtempSync(join(tmpdir(), 'static-capture-stage-paths-'));
  try {
    const output = join(root, 'current.json');
    const checkpoint = join(root, 'private.json');
    const log = join(root, 'calls.sqlite');
    const marker = 'immutable prior raw capture history';
    for (const [outputPath, checkpointPath, logPath] of [
      [output, `${output}.next`, log],
      [`${checkpoint}.next`, checkpoint, log],
      [output, checkpoint, `${output}.next`],
      [`${log}-wal`, checkpoint, log],
      [`${log}-shm`, checkpoint, log],
    ]) {
      if (!outputPath || !checkpointPath || !logPath) throw new Error('Missing exact owned path control');
      writeFileSync(checkpointPath, marker);
      const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../scripts/read-static-source.ts'),
        '--out', outputPath, '--checkpoint', checkpointPath, '--log', logPath],
      { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must point to distinct files');
      expect(readFileSync(checkpointPath, 'utf8')).toBe(marker);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unresolved staging link cannot redirect preexisting private history into publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'static-capture-unresolved-link-'));
  try {
    const output = join(root, 'not-yet-published.json');
    const checkpoint = join(root, 'private.json');
    const inputs = join(root, 'inputs.json');
    const log = join(root, 'calls.sqlite');
    const marker = '{"originalRawHistory":0.123456789}\n';
    writeFileSync(checkpoint, marker);
    symlinkSync(output, `${checkpoint}.next`);
    expect(() => assertStaticCapturePathsDistinct({ output, checkpoint, checkpointStage: `${checkpoint}.next` })).toThrow();
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../scripts/read-static-source.ts'),
      '--out', output, '--checkpoint', checkpoint, '--inputs', inputs, '--log', log],
    { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(readFileSync(checkpoint, 'utf8')).toBe(marker);
    for (const path of [output, inputs, log, `${checkpoint}.journal`]) expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
