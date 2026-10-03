#!/usr/bin/env bun
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildNpmPublishAuthEnv } from './npm-auth.ts';
import { getPublishedNpmVersion } from './npm-publish-state.ts';
import { syncProjectSurfaces } from './project-surfaces.ts';
import { withWorkspaceLock } from './workspace-lock.ts';
import { isForbiddenPackageTarballPath, packageDocPaths, requiredTarballPaths, verifyPackageFacingText, verifyReleaseMetadata } from '../src/cli/package-verification.ts';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const registry = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim() || 'https://registry.npmjs.org';
if (process.env.GOODVIBES_PUBLIC_PACKAGE_NAME?.trim()) {
  throw new Error('GOODVIBES_PUBLIC_PACKAGE_NAME is not supported. GoodVibes Agent only publishes @pellux/goodvibes-agent.');
}

const tempBase = join(root, '.test-tmp');
mkdirSync(tempBase, { recursive: true });
const tempRoot = mkdtempSync(join(tempBase, 'publish-'));
const stageDir = join(tempRoot, 'package');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: unknown };
const packageFileEntries: readonly string[] = Array.isArray(pkg.files)
  ? pkg.files.filter((entry: unknown): entry is string => typeof entry === 'string')
  : [];
const requiredDocs = packageDocPaths(root);
function expandPackageFileEntry(entry: string): readonly string[] {
  if (entry === 'docs/*.md') return requiredDocs;
  return [entry];
}
const stagedEntries = new Set<string>([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  ...(packageFileEntries
    .filter((entry) => !entry.startsWith('!'))
    .flatMap(expandPackageFileEntry)),
]);

function shouldExclude(relativePath: string) {
  return isForbiddenPackageTarballPath(relativePath);
}

function listFilesUnder(path: string, relativeRoot = ''): readonly string[] {
  if (!existsSync(path)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const relativePath = relativeRoot.length > 0 ? `${relativeRoot}/${entry.name}` : entry.name;
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesUnder(childPath, relativePath));
      continue;
    }
    if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function assertSourcePackagePolicy(validationRoot: string): void {
  const failures = [
    ...verifyReleaseMetadata(validationRoot),
    ...verifyPackageFacingText(validationRoot).failures,
  ];
  if (failures.length > 0) {
    throw new Error(`source package failed package policy checks:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

function assertStagedPackagePolicy(validationRoot: string): void {
  const failures = verifyPackageFacingText(validationRoot).failures;
  if (failures.length > 0) {
    throw new Error(`staged package failed package policy checks:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

function assertNoForbiddenStagedPaths(): void {
  const forbiddenPaths = listFilesUnder(stageDir).filter(isForbiddenPackageTarballPath);
  if (forbiddenPaths.length > 0) {
    throw new Error(`staged package contains forbidden paths:\n${forbiddenPaths.join('\n')}`);
  }
}

function assertRequiredStagedPaths(): void {
  const missingPaths = requiredTarballPaths(root).filter((relativePath) => !existsSync(join(stageDir, relativePath)));
  if (missingPaths.length > 0) {
    throw new Error(`staged package is missing required package paths:\n${missingPaths.join('\n')}`);
  }
}

function copyEntry(relativePath: string) {
  const source = join(root, relativePath);
  if (!existsSync(source)) {
    return;
  }

  const destination = join(stageDir, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (src) => {
      const normalized = src.startsWith(root) ? src.slice(root.length).replace(/^\/+/, '') : src;
      if (!normalized) return true;
      return !shouldExclude(normalized);
    },
  });
}

try {
  withWorkspaceLock('stage publish package', () => {
    syncProjectSurfaces(root);
    assertSourcePackagePolicy(root);
    execFileSync('bun', ['run', 'build:package-runtime'], {
      cwd: root,
      stdio: 'inherit',
    });

    mkdirSync(stageDir, { recursive: true });

    for (const entry of stagedEntries) {
      copyEntry(entry);
    }

    for (const docPath of requiredDocs) {
      const stagedDoc = join(stageDir, docPath);
      if (!existsSync(stagedDoc)) {
        throw new Error(`staged package is missing package-facing doc: ${stagedDoc}`);
      }
      if (statSync(stagedDoc).size <= 0) {
        throw new Error(`staged package-facing doc is empty: ${stagedDoc}`);
      }
    }
    assertNoForbiddenStagedPaths();
    assertRequiredStagedPaths();
    assertStagedPackagePolicy(stageDir);

    const publishAuth = buildNpmPublishAuthEnv({
      env: process.env,
      registry,
      tempRoot,
    });

    const stagedPackage = JSON.parse(readFileSync(join(stageDir, 'package.json'), 'utf8')) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };

    if (typeof stagedPackage.name !== 'string' || typeof stagedPackage.version !== 'string') {
      throw new Error('staged package.json is missing string name/version fields');
    }
    if (stagedPackage.name !== '@pellux/goodvibes-agent') {
      throw new Error(`staged package.json has unexpected package name: ${stagedPackage.name}`);
    }

    if (!dryRun) {
      const publishedVersion = getPublishedNpmVersion({
        name: stagedPackage.name,
        version: stagedPackage.version,
        registry,
        cwd: stageDir,
        env: publishAuth.env,
      });

      if (publishedVersion === stagedPackage.version) {
        console.log(`${stagedPackage.name}@${stagedPackage.version} is already published; skipping npm publish.`);
        return;
      }
    }

    const args = dryRun
      ? ['pack', '--json']
      : ['publish', '--access', 'public', '--registry', registry];

    execFileSync('npm', args, {
      cwd: stageDir,
      stdio: 'inherit',
      env: publishAuth.env,
    });
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
