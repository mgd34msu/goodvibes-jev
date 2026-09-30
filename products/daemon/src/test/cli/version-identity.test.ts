import { afterEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from '../../version.ts';
import { getPackageVersion, renderGoodVibesVersion } from '../../cli/help.ts';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const source = fileURLToPath(new URL('../../version.ts', import.meta.url));
const fallback = /let _version = '([^']+)'/.exec(readFileSync(source, 'utf8'))?.[1];

async function fixtureVersion(name: string, version: string): Promise<string> {
  if (process.env.GOODVIBES_SDK_TEST_RUNNER !== '1') throw new Error('Run this fixture through the guarded test script.');
  const directory = await mkdtemp(join(tmpdir(), 'daemon-version-identity-'));
  fixtures.push(directory);
  await mkdir(join(directory, 'src'));
  await copyFile(source, join(directory, 'src', 'version.ts'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, type: 'module' }));
  const loaded = await import(pathToFileURL(join(directory, 'src', 'version.ts')).href) as { VERSION: string };
  return loaded.VERSION;
}

describe('daemon package identity during migration', () => {
  test('source and rendered version match this workspace manifest', () => {
    expect(VERSION).toBe(manifest.version);
    expect(getPackageVersion()).toBe(manifest.version);
    expect(renderGoodVibesVersion()).toBe(`goodvibes-daemon ${manifest.version}`);
  });

  test('the scoped product identity can supply a different version from the compiled fallback', async () => {
    expect(await fixtureVersion(manifest.name, '99.8.7-fixture')).toBe('99.8.7-fixture');
  });

  test('an unrelated package cannot impersonate this binary version', async () => {
    expect(fallback).toBeDefined();
    expect(await fixtureVersion('@fixture/unrelated', '99.8.7-fixture')).toBe(fallback!);
  });
});
