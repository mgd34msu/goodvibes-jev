import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDENTIAL_SCOPE_DECLARATIONS,
  findCredentialScopeDeclaration,
  type CredentialScopeDeclaration,
} from '../sdk/src/platform/config/credential-scope-registry.ts';
import { BUILTIN_PROVIDER_ENV_KEYS } from '../sdk/src/platform/config/provider-credential-catalog.ts';

const fixtureDirectories: string[] = [];
afterAll(() => { for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true }); });

function declarations(native: readonly CredentialScopeDeclaration[]): readonly CredentialScopeDeclaration[] {
  const seen = new Set<string>();
  const providers: CredentialScopeDeclaration[] = [];
  for (const [providerId, keys] of Object.entries(BUILTIN_PROVIDER_ENV_KEYS)) {
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      providers.push({ key, match: 'exact', scope: 'daemon-needed',
        why: `The daemon calls the ${providerId} provider with it; a copy in one client's store is unreadable to the process that runs the model.` });
    }
  }
  return [...native, ...providers];
}

function exhaustive(rows: readonly CredentialScopeDeclaration[], key: string): CredentialScopeDeclaration | null {
  return rows.find(row => row.match === 'exact' ? key === row.key : key.startsWith(row.key) && key.length > row.key.length) ?? null;
}

async function isolated(scenario: string): Promise<typeof import('../sdk/src/platform/config/credential-scope-registry.ts')> {
  const url = new URL('../sdk/src/platform/config/credential-scope-registry.ts', import.meta.url);
  let source = readFileSync(url, 'utf8');
  for (const dependency of ['daemon-secret-keys', 'provider-credential-catalog']) {
    const original = `from './${dependency}.js';`;
    expect(source.split(original)).toHaveLength(2);
    source = source.replace(original, `from '${fileURLToPath(new URL(`./${dependency}.ts`, url))}';`);
  }
  // Bun's test loader merges query-qualified modules. A distinct owned file
  // keeps synthetic declarations isolated while executing the production body.
  const directory = mkdtempSync(join(tmpdir(), 'credential-scope-index-'));
  fixtureDirectories.push(directory);
  const path = join(directory, `${scenario}.ts`);
  writeFileSync(path, source);
  const module: typeof import('../sdk/src/platform/config/credential-scope-registry.ts') = await import(path);
  expect(module.CREDENTIAL_SCOPE_DECLARATIONS).not.toBe(CREDENTIAL_SCOPE_DECLARATIONS);
  return module;
}

function append(rows: readonly CredentialScopeDeclaration[], declaration: CredentialScopeDeclaration): void {
  Object.defineProperty(rows, String(rows.length), { value: declaration, writable: true, configurable: true, enumerable: true });
}

describe('Native credential scope index equivalence', () => {
  test('every native and provider-derived exact key returns the original first declaration', () => {
    const rows = declarations(CREDENTIAL_SCOPE_DECLARATIONS);
    for (const row of rows.filter(row => row.match === 'exact')) {
      expect(findCredentialScopeDeclaration(row.key)).toEqual(exhaustive(rows, row.key));
    }
    expect(findCredentialScopeDeclaration('relay.stepup.state')?.scope).toBe('surface-local');
    expect(findCredentialScopeDeclaration('TYPESAFE_API_KEY')?.why).toContain('asks Jev');
  });

  test('native prefixes preserve casing, a nonempty suffix and exact counterexamples', () => {
    const rows = declarations(CREDENTIAL_SCOPE_DECLARATIONS);
    for (const row of rows.filter(row => row.match === 'prefix')) {
      for (const key of [row.key, `${row.key}synthetic`, `${row.key}0`, row.key.toLowerCase() + 'synthetic',
        row.key.slice(0, -1) + 'synthetic', 'X' + row.key + 'synthetic']) {
        expect(findCredentialScopeDeclaration(key)).toEqual(exhaustive(rows, key));
      }
      expect(findCredentialScopeDeclaration(row.key)).toBeNull();
      expect(findCredentialScopeDeclaration(row.key + 'synthetic')?.key).toBe(row.key);
    }
    for (const key of ['', 'status', 'SLACK_BOT_TOKEN_suffix', 'slack_bot_token', 'MY_OWN_SCRATCH_KEY']) {
      expect(findCredentialScopeDeclaration(key)).toBeNull();
    }
  });

  test('overlapping exact and prefix declarations preserve original priority rather than exact or longest preference', async () => {
    const registry = await isolated('overlap');
    const fixtures: readonly CredentialScopeDeclaration[] = [
      { key: 'SYNTHETIC_FIRST_', match: 'prefix', scope: 'daemon-needed', why: 'First prefix owns the synthetic family.' },
      { key: 'SYNTHETIC_FIRST_child', match: 'exact', scope: 'surface-local', why: 'Later exact must not override the first prefix.' },
      { key: 'SYNTHETIC_EARLY_child', match: 'exact', scope: 'surface-local', why: 'Earlier exact owns the synthetic key.' },
      { key: 'SYNTHETIC_EARLY_', match: 'prefix', scope: 'daemon-needed', why: 'Later prefix must not override the earlier exact.' },
      { key: 'SYNTHETIC_NEST_', match: 'prefix', scope: 'surface-local', why: 'First broad prefix owns all descendants.' },
      { key: 'SYNTHETIC_NEST_deep_', match: 'prefix', scope: 'daemon-needed', why: 'Later longer prefix has no special priority.' },
      { key: 'SYNTHETIC_DUPLICATE', match: 'exact', scope: 'surface-local', why: 'First duplicate owns the synthetic key.' },
      { key: 'SYNTHETIC_DUPLICATE', match: 'exact', scope: 'daemon-needed', why: 'Later duplicate must not overwrite the first exact.' },
    ];
    for (const fixture of fixtures) append(registry.CREDENTIAL_SCOPE_DECLARATIONS, fixture);
    const rows = declarations(registry.CREDENTIAL_SCOPE_DECLARATIONS);
    for (const key of ['SYNTHETIC_FIRST_child', 'SYNTHETIC_FIRST_other', 'SYNTHETIC_EARLY_child',
      'SYNTHETIC_EARLY_other', 'SYNTHETIC_NEST_deep_child', 'SYNTHETIC_DUPLICATE',
      'SYNTHETIC_FIRST_', 'synthetic_first_child', 'SYNTHETIC_DUPLICATE_extra']) {
      expect(registry.findCredentialScopeDeclaration(key)).toEqual(exhaustive(rows, key));
    }
    expect(registry.findCredentialScopeDeclaration('SYNTHETIC_FIRST_child')?.scope).toBe('daemon-needed');
    expect(registry.findCredentialScopeDeclaration('SYNTHETIC_EARLY_child')?.scope).toBe('surface-local');
    expect(registry.findCredentialScopeDeclaration('SYNTHETIC_NEST_deep_child')?.key).toBe('SYNTHETIC_NEST_');
    expect(registry.findCredentialScopeDeclaration('SYNTHETIC_DUPLICATE')?.scope).toBe('surface-local');
  });

  test('compilation retains one declaration-population snapshot and settled object identity', async () => {
    const registry = await isolated('snapshot');
    const first = registry.findCredentialScopeDeclaration('SLACK_BOT_TOKEN');
    append(registry.CREDENTIAL_SCOPE_DECLARATIONS, {
      key: 'SYNTHETIC_ADDED_AFTER_COMPILE', match: 'exact', scope: 'daemon-needed', why: 'This row was absent at the original compile boundary.',
    });
    expect(registry.findCredentialScopeDeclaration('SLACK_BOT_TOKEN')).toBe(first);
    expect(registry.findCredentialScopeDeclaration('SYNTHETIC_ADDED_AFTER_COMPILE')).toBeNull();
    expect(findCredentialScopeDeclaration('SYNTHETIC_FIRST_child')).toBeNull();
    expect(findCredentialScopeDeclaration('SYNTHETIC_ADDED_AFTER_COMPILE')).toBeNull();
  });
});
