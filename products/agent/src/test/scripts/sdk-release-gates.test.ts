// ---------------------------------------------------------------------------
// sdk-release-gates.test.ts
//
// Drives the publish-blocking SDK release gates (scripts/sdk-release-gates.ts)
// against filesystem fixtures: each gate must FAIL when it should (overlay
// marker present, pin not an exact semver, pin/installed/lock disagreement,
// a non-npm SDK import injected into the source tree) and PASS on a clean tree.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSdkPin,
  sdkPinAgreementIssues,
  sdkReleaseGateIssues,
} from '../../../scripts/sdk-release-gates.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SDK = '@goodvibes-jev/engine/sdk';

interface FixtureSpec {
  readonly pin?: string; // devDependencies pin (default 0.38.0)
  readonly installedVersion?: string | null; // node_modules SDK version; null = not installed
  readonly lockPin?: string | null; // version string written into bun.lock; null = omit lockfile entry
  readonly marker?: boolean; // write the overlay marker
  readonly srcFiles?: Record<string, string>; // relative-to-src path -> file contents
}

const created: string[] = [];

function makeFixture(spec: FixtureSpec): string {
  const root = makeProjectTempDir('gv-sdk-gate');
  created.push(root);
  const pin = spec.pin ?? '0.38.0';

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@pellux/goodvibes-agent', version: '1.5.5', devDependencies: { [SDK]: pin } }, null, 2),
  );

  // Installed package
  if (spec.installedVersion !== null) {
    const pkgDir = join(root, 'node_modules', '@pellux', 'goodvibes-sdk');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: SDK, version: spec.installedVersion ?? pin }));
    if (spec.marker) writeFileSync(join(pkgDir, '.local-sdk-overlay.json'), JSON.stringify({ sdkGit: 'x@y' }));
  }

  // Lockfile
  const lockPin = spec.lockPin === undefined ? pin : spec.lockPin;
  const lockBody = lockPin === null ? '{"lockfileVersion": 1, "packages": {}}' : `{"packages": {"${SDK}": ["${SDK}@${lockPin}"]}}`;
  writeFileSync(join(root, 'bun.lock'), lockBody);

  // Source tree
  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  const files = spec.srcFiles ?? { 'clean.ts': `import { x } from '${SDK}/platform/state';\n` };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(srcDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }

  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('sdk-release-gates', () => {
  test('clean fixture passes every gate', () => {
    const root = makeFixture({});
    expect(sdkReleaseGateIssues(root)).toEqual([]);
  });

  test('overlay marker present is a publish-blocking issue', () => {
    const root = makeFixture({ marker: true });
    const issues = sdkPinAgreementIssues(root);
    expect(issues.some((i) => i.includes('overlay marker present'))).toBe(true);
  });

  test('a non-exact pin (caret range) fails the exact-semver gate', () => {
    const root = makeFixture({ pin: '^0.38.0' });
    const issues = sdkPinAgreementIssues(root);
    expect(issues.some((i) => i.includes('must be exact'))).toBe(true);
  });

  test('installed version disagreeing with the pin fails', () => {
    const root = makeFixture({ installedVersion: '0.37.2' });
    const issues = sdkPinAgreementIssues(root);
    expect(issues.some((i) => i.includes('!= pin'))).toBe(true);
  });

  test('lockfile lagging the pin bump fails', () => {
    const root = makeFixture({ lockPin: '0.35.0' });
    const issues = sdkPinAgreementIssues(root);
    expect(issues.some((i) => i.includes('does not resolve'))).toBe(true);
  });

  test('a non-npm SDK import injected into source is caught', () => {
    const root = makeFixture({
      srcFiles: {
        'ok.ts': `import { a } from '${SDK}/platform/tools';\n`,
        // Build the overlay specifier so THIS test file's own source text never
        // contains the contiguous literal "goodvibes-sdk". The written fixture is
        // byte-identical at runtime, but the release gate's source sweep
        // (publish:check → toolchain sdk-pin-gate) walks src/ including this
        // test file, and a raw literal here is flagged as a real offender.
        'bad.ts': `import { evil } from '../../../goodvibes-${'sdk'}/dist/secret.js';\n`,
      },
    });
    expect(sdkReleaseGateIssues(root).some((i) => i.includes('non-npm goodvibes-sdk import'))).toBe(true);
  });

  test('readSdkPin reads the devDependencies pin', () => {
    const root = makeFixture({ pin: '0.38.0' });
    expect(readSdkPin(root)).toBe('0.38.0');
  });
});
