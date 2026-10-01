#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { isForbiddenPackageTarballPath, requiredTarballPaths, verifyReleaseMetadata } from '../src/cli/package-verification.ts';
import { sdkReleaseGateIssues } from './sdk-release-gates.ts';

const root = process.cwd();

// SDK release gates: overlay-marker hard-fail, exact-pin, pin/lock/installed
// agreement, and npm-only import sweep. Keeps scripts/sdk-dev.ts's local-SDK
// overlay from ever leaking into a published @pellux/goodvibes-agent.
for (const issue of sdkReleaseGateIssues(root)) {
  throw new Error(issue);
}

for (const issue of verifyReleaseMetadata(root)) {
  throw new Error(issue);
}

execSync('bun run build:package-runtime', {
  cwd: root,
  stdio: 'inherit',
});

const packRaw = execSync('npm pack --json --dry-run', {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

/**
 * `npm pack --json` reports one entry per packed package, but not in one
 * shape: npm 11 and earlier emit an ARRAY of results, npm 12 emits an OBJECT
 * keyed by package name. Reading only the array shape made this check throw
 * "{} is not iterable" on npm 12, a crash before any tarball rule ran, so the
 * gate reported failure without having actually inspected anything. Accept
 * either, so the check depends on the tarball rather than on which npm the
 * machine happens to ship.
 */
type PackResult = {
  files?: Array<{ path: string }>;
  size?: number;
  entryCount?: number;
  unpackedSize?: number;
};
const packParsed: unknown = JSON.parse(packRaw);
const packResult = (Array.isArray(packParsed)
  ? packParsed[0]
  : Object.values((packParsed ?? {}) as Record<string, unknown>)[0]) as PackResult | undefined;
if (packResult === undefined) {
  throw new Error(`npm pack --json reported no packed package: ${packRaw.slice(0, 400)}`);
}
const filePaths = Array.isArray(packResult.files) ? packResult.files.map((entry) => entry.path) : [];
for (const filePath of filePaths) {
  if (isForbiddenPackageTarballPath(filePath)) {
    throw new Error(`published tarball includes forbidden path: ${filePath}`);
  }
}

for (const requiredPath of requiredTarballPaths(root)) {
  if (!filePaths.includes(requiredPath)) {
    throw new Error(`published tarball is missing required path: ${requiredPath}`);
  }
}

if (typeof packResult.size === 'number' && packResult.size > 50 * 1024 * 1024) {
  throw new Error(`published tarball is too large: ${packResult.size} bytes`);
}

// entryCount/unpackedSize are npm-version-dependent extras; fall back to the
// values this check derived itself so the summary never prints "undefined".
const entryCount = typeof packResult.entryCount === 'number' ? packResult.entryCount : filePaths.length;
const unpackedSize =
  typeof packResult.unpackedSize === 'number' ? `${packResult.unpackedSize} bytes unpacked` : 'unpacked size not reported';
console.log(`publish check passed (${entryCount} files, ${unpackedSize})`);
