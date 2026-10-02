import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isExactSemver } from '../src/cli/package-verification.ts';

const ROOT = join(import.meta.dir, '..');

function readRequiredExactSemver(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isExactSemver(value)) {
    throw new Error(`${label} must be an exact semver like 1.2.3.`);
  }
  return value;
}

export function syncVersionSurfaces(root = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    readonly version?: unknown;
  };
  const version = readRequiredExactSemver(pkg.version, 'package.json version');

  const versionTsPath = join(root, 'src', 'version.ts');
  if (existsSync(versionTsPath)) {
    let versionTs = readFileSync(versionTsPath, 'utf8');
    const versionFallbackPattern = /let _version = '[^']*'/;
    if (!versionFallbackPattern.test(versionTs)) {
      throw new Error('src/version.ts is missing the _version fallback literal.');
    }
    versionTs = versionTs.replace(versionFallbackPattern, `let _version = '${version}'`);
    writeFileSync(versionTsPath, versionTs);
    console.log(`prebuild: src/version.ts fallback -> ${version}`);
  } else {
    console.log('prebuild: src/version.ts - not found, skipping');
  }

  const readmePath = join(root, 'README.md');
  try {
    let readme = readFileSync(readmePath, 'utf8');
    const versionRe = /version-[0-9]+\.[0-9]+\.[0-9]+-blue\.svg/;
    if (versionRe.test(readme)) {
      readme = readme.replace(versionRe, `version-${version}-blue.svg`);
      writeFileSync(readmePath, readme);
      console.log(`prebuild: README.md -> ${version}`);
    } else {
      console.log('prebuild: README.md - no version badge found, skipping');
    }
  } catch {
    console.log('prebuild: README.md - not found, skipping');
  }

  // docs/README.md pins the `X.Y.x` release line and is gated against
  // package.json's major.minor (agent-boundary-docs test). Every minor/major
  // release used to trip that gate because nothing bumped it, sync it here
  // alongside the badge so a release commit can never ship a stale line.
  const docsReadmePath = join(root, 'docs', 'README.md');
  try {
    let docsReadme = readFileSync(docsReadmePath, 'utf8');
    const lineRe = /`[0-9]+\.[0-9]+\.x` release line/;
    const majorMinor = version.split('.').slice(0, 2).join('.');
    if (lineRe.test(docsReadme)) {
      docsReadme = docsReadme.replace(lineRe, `\`${majorMinor}.x\` release line`);
      writeFileSync(docsReadmePath, docsReadme);
      console.log(`prebuild: docs/README.md release line -> ${majorMinor}.x`);
    } else {
      console.log('prebuild: docs/README.md - no release line found, skipping');
    }
  } catch {
    console.log('prebuild: docs/README.md - not found, skipping');
  }

  return version;
}

export function syncProjectSurfaces(root = ROOT): string {
  const version = syncVersionSurfaces(root);
  console.log(`prebuild: done (v${version})`);
  return version;
}
