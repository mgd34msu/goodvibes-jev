/** Agent adapter contracts: installable engine package, public exports and root lock. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AGENT_SDK_PIN,
  OVERLAY_MARKER_REL,
  SDK_PACKAGE,
  readSdkPin,
  sdkPinAgreementIssues,
  sdkReleaseGateIssues,
} from '../../../scripts/sdk-release-gates.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SDK = '@goodvibes-jev/engine';
const PUBLIC_IMPORT = `${SDK}/sdk/platform/state`;

interface FixtureSpec {
  readonly pin?: string;
  readonly installedVersion?: string | null;
  readonly lockPin?: string | null;
  readonly localLockPin?: string;
  readonly marker?: boolean;
  readonly devPin?: string;
  readonly srcFiles?: Record<string, string>;
}

const created: string[] = [];

function makeFixture(spec: FixtureSpec = {}): string {
  const repository = makeProjectTempDir('gv-sdk-gate');
  created.push(repository);
  const root = join(repository, 'products', 'agent');
  mkdirSync(root, { recursive: true });
  const pin = spec.pin ?? 'workspace:*';
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ private: true, workspaces: ['products/*', 'packages/*'] }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@goodvibes-jev/agent', version: '2.1.0', private: true,
    dependencies: { [SDK]: pin },
    ...(spec.devPin === undefined ? {} : { devDependencies: { [SDK]: spec.devPin } }),
  }));

  // The shared workspace branch proves manifest presence only. Exact registry
  // pins below separately exercise installed-version agreement.
  if (spec.installedVersion !== null) {
    const pkgDir = join(root, 'node_modules', SDK);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: SDK,
      version: spec.installedVersion ?? '2.0.23',
      exports: { '.': './index.js', './sdk': './sdk/index.js', './sdk/platform/state': './sdk/state.js', './sdk/platform/tools': './sdk/tools.js', './toolchain': './toolchain/index.js' },
    }));
    if (spec.marker) writeFileSync(join(pkgDir, '.local-sdk-overlay.json'), '{}');
  }

  const lockPin = spec.lockPin === undefined ? pin : spec.lockPin;
  const lockText = (value: string | null): string => JSON.stringify({
    lockfileVersion: 1,
    packages: value === null ? {} : { [SDK]: [`${SDK}@${value.startsWith('workspace:') ? 'workspace:packages/engine' : value}`] },
  });
  writeFileSync(join(repository, 'bun.lock'), lockText(lockPin));
  // A stale nested lock cannot rescue or invalidate the authoritative root lock.
  if (spec.localLockPin !== undefined) writeFileSync(join(root, 'bun.lock'), lockText(spec.localLockPin));

  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  for (const [relative, body] of Object.entries(spec.srcFiles ?? { 'clean.ts': `import { x } from '${PUBLIC_IMPORT}';\n` })) {
    const path = join(srcDir, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sdk-release-gates', () => {
  test('the adapter names the installable package, root lock and engine-owned marker', () => {
    expect(SDK_PACKAGE).toBe('@goodvibes-jev/engine');
    expect(AGENT_SDK_PIN).toMatchObject({ pinSource: 'dependencies', lockfile: '../../bun.lock', enforceExportsMap: true });
    expect(OVERLAY_MARKER_REL).toBe('node_modules/@goodvibes-jev/engine/.local-sdk-overlay.json');
  });

  test('the actual Agent workspace passes dependency, root-lock and installed-presence checks', () => {
    const root = resolve(import.meta.dir, '../../..');
    expect(readSdkPin(root)).toBe('workspace:*');
    expect(sdkPinAgreementIssues(root)).toEqual([]);
  });

  test('clean workspace fixture passes presence, root-lock and public-import gates', () => {
    expect(sdkReleaseGateIssues(makeFixture())).toEqual([]);
  });

  test('clean exact registry fixture passes installed-version agreement', () => {
    expect(sdkReleaseGateIssues(makeFixture({ pin: '2.0.23' }))).toEqual([]);
  });

  test('the engine-owned overlay marker is a blocking issue', () => {
    const issues = sdkPinAgreementIssues(makeFixture({ marker: true }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(`overlay marker present at ${OVERLAY_MARKER_REL}`);
  });

  test.each(['^2.0.23', '~2.0.23', 'latest', 'file:../../packages/engine'])('non-exact registry pin %s fails', (pin) => {
    expect(sdkPinAgreementIssues(makeFixture({ pin })).some((issue) => issue.includes('must be exact'))).toBe(true);
  });

  test.each(['workspace:*', '2.0.23'])('missing installed engine fails for %s', (pin) => {
    const issues = sdkPinAgreementIssues(makeFixture({ pin, installedVersion: null }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/not installed|@missing != pin/);
  });

  test('wrong installed version fails an exact registry pin', () => {
    const issues = sdkPinAgreementIssues(makeFixture({ pin: '2.0.23', installedVersion: '2.0.22' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('installed @goodvibes-jev/engine@2.0.22 != pin 2.0.23');
  });

  test.each([
    { pin: 'workspace:*', lockPin: '2.0.23' },
    { pin: 'workspace:*', lockPin: null },
    { pin: '2.0.23', lockPin: '2.0.22' },
  ])('root-lock mismatch blocks even when a local lock agrees: %j', (spec) => {
    const issues = sdkPinAgreementIssues(makeFixture({ ...spec, localLockPin: spec.pin }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('../../bun.lock does not resolve');
  });

  test('an obsolete local lock does not override a correct root lock', () => {
    expect(sdkReleaseGateIssues(makeFixture({ localLockPin: '0.1.0' }))).toEqual([]);
  });

  test.each([
    `../../../goodvibes-${'sdk'}/dist/secret.js`,
    `../../../packages/${'engine'}/sdk/src/private.ts`,
  ])('relative private engine/legacy imports are caught: %s', (specifier) => {
    const root = makeFixture({ srcFiles: { 'bad.ts': `import { secret } from '${specifier}';\n` } });
    expect(sdkReleaseGateIssues(root).some((issue) => issue.includes('non-npm goodvibes-sdk import'))).toBe(true);
  });

  test('package-qualified private engine imports are rejected by the exports map', () => {
    const root = makeFixture({ srcFiles: { 'bad.ts': `import { secret } from '${SDK}/sdk/src/private';\n` } });
    const issues = sdkReleaseGateIssues(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('not in the published exports map');
  });

  test('public engine SDK and toolchain exports pass', () => {
    const root = makeFixture({ srcFiles: {
      'public.ts': `import { sdk } from '${SDK}/sdk';\nimport { state } from '${PUBLIC_IMPORT}';\nimport { tools } from '${SDK}/toolchain';\n`,
    } });
    expect(sdkReleaseGateIssues(root)).toEqual([]);
  });

  test('readSdkPin reads the authoritative dependencies group rather than a stale dev pin', () => {
    expect(readSdkPin(makeFixture({ devPin: '0.38.0' }))).toBe('workspace:*');
  });
});
