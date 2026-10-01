/**
 * generate-config-ownership.test.ts: the generator renders a module whose exports
 * are the snapshot it was given (proven by importing what it rendered), reads a
 * non-empty snapshot from the installed SDK, and writes the artifact only when its
 * content changes. The checked-in artifact is compared with the SDK in
 * src/lib/config-ownership.test.ts, not here.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './helpers/project-temp';
import { loadOwnershipSnapshot, renderTs, writeIfChanged } from './generate-config-ownership';

describe('generate-config-ownership', () => {
  test('the emitted module is valid TypeScript whose exports equal the snapshot it was rendered from', async () => {
    const snapshot = {
      prefixes: ['alpha.', 'beta.'],
      keys: ['gamma.timezone'],
      nonSchemaPaths: ['delta.secretRef'],
    };
    const dir = makeProjectTempDir('webui-gen-ownership-roundtrip-');
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'config-ownership.ts');
      writeFileSync(path, renderTs(snapshot), 'utf8');
      const emitted = await import(path) as {
        DAEMON_OWNED_CONFIG_PREFIXES: readonly string[];
        DAEMON_OWNED_CONFIG_KEYS: readonly string[];
        DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS: readonly string[];
      };
      expect([...emitted.DAEMON_OWNED_CONFIG_PREFIXES]).toEqual(snapshot.prefixes);
      expect([...emitted.DAEMON_OWNED_CONFIG_KEYS]).toEqual(snapshot.keys);
      expect([...emitted.DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS]).toEqual(snapshot.nonSchemaPaths);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the snapshot read from the installed SDK carries every table, none empty', () => {
    const snapshot = loadOwnershipSnapshot();
    expect(snapshot.prefixes.length).toBeGreaterThan(0);
    expect(snapshot.keys.length).toBeGreaterThan(0);
    expect(snapshot.nonSchemaPaths.length).toBeGreaterThan(0);
  });

  test('writeIfChanged writes new content and leaves identical content untouched', () => {
    const dir = makeProjectTempDir('webui-gen-ownership-');
    try {
      const path = join(dir, 'out', 'config-ownership.ts');
      expect(writeIfChanged(path, 'one')).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('one');
      const mtime = statSync(path).mtimeMs;
      expect(writeIfChanged(path, 'one')).toBe(false);
      expect(statSync(path).mtimeMs).toBe(mtime);
      expect(writeIfChanged(path, 'two')).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('two');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
