import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { insertChangelogSection, nextVersion as toolchainNextVersion } from '@goodvibes-jev/engine/toolchain';
import { packageDocPaths, verifyPackageFacingText, verifyReleaseMetadata, verifyReleaseStamps } from '../src/cli/package-verification.ts';

/**
 * Release script, bumps version, updates CHANGELOG, creates git tag.
 *
 * Defaults to patch bumps. Minor/major require explicit flags.
 *
 * Usage:
 *   bun run scripts/release.ts              # patch bump (0.9.10 -> 0.9.11)
 *   bun run scripts/release.ts --minor      # minor bump (0.9.10 -> 0.10.0)
 *   bun run scripts/release.ts --major      # major bump (1.2.3 -> 2.0.0)
 *   bun run scripts/release.ts --notes-file ./release-notes.md
 *   bun run scripts/release.ts --dry-run    # preview without writing
 *
 * What it does:
 *   1. Release evidence text hygiene (CI already validated the commit)
 *   2. Bump package.json version
 *   3. Regenerate every version stamp and pin (scripts/release-prepare.ts --no-bump --no-changelog)
 *   4. Prepend new section to CHANGELOG.md
 *   5. Verify release metadata and generated diff hygiene
 *   6. Stage changes, commit, create annotated git tag
 */

interface ReleaseOptions {
  readonly args: readonly string[];
  readonly dryRun: boolean;
  readonly skipValidation: boolean;
  readonly notesFileIndex: number;
  readonly bumpMode: 'patch' | 'minor' | 'major';
}

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseReleaseOptions(args: readonly string[]): ReleaseOptions {
  const dryRun = args.includes('--dry-run');
  const skipValidation = args.includes('--skip-validation');
  if (args.includes('--major') && args.includes('--minor')) {
    exitWithError('Error: choose only one of --minor or --major.');
  }
  if (skipValidation && !dryRun) {
    exitWithError('Error: --skip-validation is only allowed with --dry-run. Real releases must run validation gates.');
  }
  return {
    args,
    dryRun,
    skipValidation,
    notesFileIndex: args.indexOf('--notes-file'),
    bumpMode: args.includes('--major')
      ? 'major'
      : args.includes('--minor')
        ? 'minor'
        : 'patch',
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function releaseMetadataPaths(root = process.cwd()): readonly string[] {
  return [
    'package.json',
    'src/version.ts',
    'README.md',
    'CHANGELOG.md',
    '.github/workflows',
    ...releaseEvidenceInputPaths(),
    ...packageDocPaths(root),
  ];
}

export function releaseEvidenceInputPaths(): readonly string[] {
  return [
    'release/release-notes.md',
    'release/performance-snapshot.json',
    'release/release-readiness.json',
    'release/live-verification/live-verification.json',
    'release/live-verification/live-verification.md',
  ];
}

function gitStatusPath(line: string): string {
  if (line.length < 4) return '';
  const path = line.slice(3).trim();
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path.includes(' -> ') ? '' : path;
}

export function releaseBlockingGitStatusLines(
  gitStatus: string,
  allowedEvidencePaths: readonly string[] = releaseEvidenceInputPaths(),
): readonly string[] {
  const allowed = new Set(allowedEvidencePaths);
  return gitStatus
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const status = line.slice(0, 2);
      const path = gitStatusPath(line);
      if (!allowed.has(path)) return true;
      return status.includes('D') || status.includes('R') || status.includes('C');
    });
}

export function releaseEvidenceHygieneIssues(
  root = process.cwd(),
  paths: readonly string[] = releaseEvidenceInputPaths(),
): readonly string[] {
  const issues: string[] = [];
  for (const path of paths) {
    const absolutePath = join(root, path);
    if (!existsSync(absolutePath)) {
      issues.push(`${path}: required release evidence file is missing.`);
      continue;
    }
    const source = readFileSync(absolutePath, 'utf8');
    if (source.length === 0) {
      issues.push(`${path}: release evidence file is empty.`);
      continue;
    }
    if (!source.endsWith('\n')) {
      issues.push(`${path}: missing final newline.`);
    }
    const lines = source.split(/\n/);
    const lineCount = source.endsWith('\n') ? lines.length - 1 : lines.length;
    for (let index = 0; index < lineCount; index += 1) {
      const line = (lines[index] ?? '').replace(/\r$/, '');
      if (/[ \t]+$/.test(line)) {
        issues.push(`${path}:${index + 1}: trailing whitespace.`);
      }
      if (/^ +\t/.test(line)) {
        issues.push(`${path}:${index + 1}: space before tab in indent.`);
      }
    }
  }
  return issues;
}

function readReleaseNotesFromArgOrEnv(options: ReleaseOptions, root: string): readonly string[] {
  const notesFile = options.notesFileIndex >= 0 ? options.args[options.notesFileIndex + 1] : undefined;
  if (options.notesFileIndex >= 0 && (!notesFile || notesFile.startsWith('--'))) {
    exitWithError('Error: --notes-file requires a markdown file path.');
  }

  const raw = notesFile
    ? readFileSync(join(root, notesFile), 'utf8')
    : process.env.GOODVIBES_AGENT_RELEASE_NOTES;
  if (!raw || raw.trim().length === 0) {
    if (options.dryRun) {
      return [
        '- Product release notes required for real release. Pass --notes-file <path> or GOODVIBES_AGENT_RELEASE_NOTES.',
      ];
    }
    exitWithError('Error: product release notes are required. Pass --notes-file <path> or set GOODVIBES_AGENT_RELEASE_NOTES.');
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.startsWith('- ') ? line : `- ${line}`);
  if (lines.some((line) => /^- [0-9a-f]{7,40}\s/i.test(line))) {
    exitWithError('Error: release notes must describe product changes, not raw commit hashes.');
  }
  return lines;
}

function run(cmd: string, options: ReleaseOptions, root: string, opts: { readonly silent?: boolean } = {}): string {
  if (options.dryRun && !opts.silent) {
    console.log(`[dry-run] ${cmd}`);
    return '';
  }
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit' });
  } catch (error: unknown) {
    console.error(`\nCommand failed: ${cmd}`);
    if (typeof error === 'object' && error !== null) {
      const commandError = error as { stdout?: string | Uint8Array; stderr?: string | Uint8Array };
      if (commandError.stdout) console.error(String(commandError.stdout));
      if (commandError.stderr) console.error(String(commandError.stderr));
    }
    process.exit(1);
  }
}

function runSilent(cmd: string, root: string): string {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return '';
  }
}

function assertReleasePackagePolicy(label: string, root: string): void {
  const issues = [
    ...verifyReleaseMetadata(root),
    ...verifyPackageFacingText(root).failures,
    ...verifyReleaseStamps(root),
  ];
  if (issues.length === 0) return;
  console.error(`Error: ${label} failed.`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}

function assertReleaseEvidenceHygiene(label: string, root: string): void {
  const issues = releaseEvidenceHygieneIssues(root);
  if (issues.length === 0) return;
  console.error(`Error: ${label} failed.`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}

function nextVersion(current: string, bumpMode: ReleaseOptions['bumpMode']): string {
  // Delegated to the shared @goodvibes-jev/engine/toolchain release-cut mechanics
  // (one semver-bump implementation across the estate).
  try {
    return toolchainNextVersion(current, bumpMode);
  } catch {
    return exitWithError(`Error: cannot parse version '${current}' as semver`);
  }
}

export function formatLocalReleaseDate(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function main(argv = process.argv.slice(2), root = process.cwd()): void {
  const options = parseReleaseOptions(argv);

  // --- Pre-flight checks ---

  // Ensure product work is committed before release. Pre-generated release evidence is allowed.
  const gitStatus = runSilent('git status --porcelain --untracked-files=all', root);
  const blockingGitStatusLines = releaseBlockingGitStatusLines(gitStatus);
  if (gitStatus.trim()) {
    if (options.dryRun) {
      console.warn('Warning: working tree has uncommitted changes. Dry-run preview will use the current files.');
      console.warn(gitStatus);
    } else if (blockingGitStatusLines.length > 0) {
      console.error('Error: working tree has non-release-evidence changes. Commit or stash product changes before releasing.');
      console.error(blockingGitStatusLines.join('\n'));
      process.exit(1);
    } else {
      console.log('Pre-generated release evidence detected; it will be staged with the release commit.');
    }
  }

  // Ensure we are on main branch
  const currentBranch = runSilent('git rev-parse --abbrev-ref HEAD', root).trim();
  if (currentBranch !== 'main') {
    if (options.dryRun) {
      console.warn(`Warning: real releases must be cut from main (current branch: ${currentBranch}).`);
    } else {
      console.error(`Error: releases must be cut from main (current branch: ${currentBranch})`);
      process.exit(1);
    }
  }

  // --- Read current version ---

  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  const current = pkg.version;
  const next = nextVersion(current, options.bumpMode);

  console.log(`\nRelease: ${current} -> ${next}`);
  if (options.dryRun) console.log('(dry-run mode: no files will be written)\n');

  console.log('\n[preflight] Checking release evidence text hygiene...');
  assertReleaseEvidenceHygiene('release evidence text hygiene', root);

  // --- Pre-release validation: none (CI owns validation) ---
  //
  // Per the shared CI/CD design (principle 4) and the toolchain release-cut
  // contract, a release cut NEVER re-runs the gate battery. Validation happened
  // exactly once, on the release commit's push-CI run (per-job green); the tag
  // is cut from that already-green tree and verified by-reference downstream
  // (release.yml → reusable-release-verify). The old local [1/5] gate re-run
  // (typecheck/architecture/build/publish:check/package:install-check/pack/diff)
  // is intentionally gone. This step only prepares, bumps,
  // updates the changelog, and tags.

  // --- Bump package.json ---

  console.log(`\n[2/5] Updating package.json: ${current} -> ${next}`);
  if (!options.dryRun) {
    pkg.version = next;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  // --- Update src/version.ts via prebuild script ---

  console.log('\n[3/5] Regenerating version stamps and pins via release:prepare...');
  run('bun run scripts/release-prepare.ts --no-bump --no-changelog --no-install --no-live', options, root);

  // --- Update CHANGELOG.md ---

  console.log('\n[4/5] Updating CHANGELOG.md...');

  const changelogPath = join(root, 'CHANGELOG.md');
  const today = formatLocalReleaseDate();

  // Agent CHANGELOG format: a plain `## <version> - <date>` heading followed by
  // the product release notes. The section insertion (prepend above the first
  // existing `## ` heading) is delegated to the shared toolchain release-cut
  // mechanics (`insertChangelogSection`, 'top' marker).
  const newSection = [
    `## ${next} - ${today}`,
    '',
    ...readReleaseNotesFromArgOrEnv(options, root),
  ].join('\n');

  if (!options.dryRun) {
    const changelog = readFileSync(changelogPath, 'utf8');
    writeFileSync(changelogPath, insertChangelogSection(changelog, newSection, 'top'));
    console.log(`CHANGELOG.md: prepended section for ${next}`);
  } else {
    console.log('[dry-run] Would prepend to CHANGELOG.md:');
    console.log(newSection);
  }

  // --- Post-mutation metadata checks ---

  console.log('\n[post] Verifying release metadata and diff hygiene...');
  if (!options.dryRun) {
    assertReleasePackagePolicy('post-release package policy validation', root);
    assertReleaseEvidenceHygiene('post-release evidence text hygiene', root);
  }
  run('git diff --check', options, root);

  // --- Git commit + tag ---

  console.log(options.dryRun
    ? `\n[5/5] Previewing git commit and tag v${next}...`
    : `\n[5/5] Creating git commit and tag v${next}...`);

  const tag = `v${next}`;
  const commitMsg = `chore: release ${tag}`;

  run(`git add ${releaseMetadataPaths(root).map(shellQuote).join(' ')}`, options, root);
  run(`git commit -m "${commitMsg}"`, options, root);
  run(`git tag -a ${tag} -m "Release ${tag}"`, options, root);

  if (options.dryRun) {
    console.log(`\nDry-run release preview for ${tag} complete.`);
    console.log('No files, commits, or tags were written.');
    console.log('Next step: rerun without --dry-run from a clean main worktree after product changes are committed.');
    return;
  }

  console.log(`\nRelease ${tag} complete.`);
  console.log('Next step: git push && git push --tags');
}

if (import.meta.main) {
  main();
}
