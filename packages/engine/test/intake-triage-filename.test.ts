import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createOwnedTriagedInboxSource } from '../sdk/src/platform/intake/triage/owned.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const logger = { info() {}, warn() {}, error() {} };
function options(storeFileName: string) {
  return { providerId: 'fixture', accountScopeId: 'native-account', storeFileName,
    adapters: new Map([['fixture', { id: 'fixture', pollIntervalMs: 3_600_000,
      poll: async () => ({ items: [], state: 'empty' as const, configured: true }) }]]),
    acquireReadLease: async () => Object.assign(async () => {}, { assertCurrent() {} }),
  };
}

test('triage preserves the captured native mirror filename without creating a replacement mirror', async () => {
  const workingDirectory = makeProjectTempDir('triage-native-filename');
  const captured = options('inbox-fixture-native-account.sqlite');
  const pending = createOwnedTriagedInboxSource({ workingDirectory, logger }, captured);
  captured.storeFileName = 'redirected.sqlite';
  const owned = await pending;
  try {
    await owned.ready;
    const storage = join(workingDirectory, '.goodvibes', 'tui', 'operator');
    expect(existsSync(join(storage, 'inbox-fixture-native-account.sqlite'))).toBe(true);
    expect(readdirSync(storage).filter(name => name.endsWith('.sqlite'))).toEqual(['inbox-fixture-native-account.sqlite']);
    const read = await owned.acquireRead(true);
    try { await read.validate(); } finally { read.release(); }
  } finally { await owned.close(); }
});

test('native mirror filename accepts only a local SQLite basename before acquiring storage', async () => {
  for (const fileName of ['../outside.sqlite', 'nested/inside.sqlite', 'nested\\inside.sqlite', '.hidden.sqlite', 'no-extension', `${'x'.repeat(201)}.sqlite`]) {
    const workingDirectory = makeProjectTempDir('triage-invalid-filename');
    await expect(createOwnedTriagedInboxSource({ workingDirectory, logger }, options(fileName)))
      .rejects.toThrow('local SQLite filename');
    expect(existsSync(join(workingDirectory, '.goodvibes', 'tui', 'operator'))).toBe(false);
  }
});
