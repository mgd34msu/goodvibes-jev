/**
 * Package verification: what a published @pellux/goodvibes-agent tarball must
 * hold, what it must never hold, and the package.json shape npm and `bun add -g`
 * rely on. publish:check and package:install-check run it per push; the
 * package-facing text rule and the version-stamp agreement run at the version
 * bump (scripts/release-prepare.ts) and in the release cut (scripts/release.ts).
 *
 * It deliberately does not read scripts, workflows or product source as text:
 * the 2026-09 testing overhaul removed those policies (they pinned wording, not
 * behavior). See docs/testing-and-validation.md.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

export interface PackageCliBinVerification {
  readonly command: 'goodvibes-agent';
  readonly target: string;
  readonly exists: boolean;
  readonly executable: boolean;
  readonly usesBunShebang: boolean;
  readonly hasSourceEntrypoint: boolean;
}

export interface PackageCliVerificationReport {
  readonly packageName: string;
  readonly version: string;
  readonly bins: readonly PackageCliBinVerification[];
  readonly tarball: {
    readonly entryCount: number;
    readonly unpackedSize: number;
    readonly requiredPathsPresent: readonly string[];
    readonly forbiddenPaths: readonly string[];
  };
  readonly issues: readonly string[];
}

const REQUIRED_BIN_COMMANDS = ['goodvibes-agent'] as const;
/**
 * The release artifacts under release/ ship because the agent_harness tool's
 * release-evidence route reads them from the installed package
 * (src/tools/agent-harness-release-evidence.ts). They are regenerated at the
 * version bump, not checked for age.
 */
const BASE_REQUIRED_TARBALL_PATHS = [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'src/main.ts',
  'dist/package/main.js',
  'bin/goodvibes-agent.ts',
  'tsconfig.json',
  'release/release-notes.md',
  'release/performance-snapshot.json',
  'release/release-readiness.json',
  'release/live-verification/live-verification.json',
  'release/live-verification/live-verification.md',
] as const;
const REQUIRED_PACKAGE_FILE_ENTRIES = [
  'bin',
  'dist/package',
  'src',
  'LICENSE',
  'tsconfig.json',
  'README.md',
  'CHANGELOG.md',
  'docs/*.md',
  'release/release-notes.md',
  'release/performance-snapshot.json',
  'release/release-readiness.json',
  'release/live-verification/live-verification.json',
  'release/live-verification/live-verification.md',
] as const;
const REQUIRED_PACKAGE_FILE_EXCLUSIONS = [
  '!src/test',
  '!src/**/*.test.ts',
  '!src/**/__tests__',
  '!src/cli/package-verification.ts',
  '!src/verification',
] as const;
const FORBIDDEN_TARBALL_PREFIXES = ['.github/', 'src/test/', 'src/.test/', 'src/verification/', 'src/daemon/', '.goodvibes/', 'vendor/'] as const;
const FORBIDDEN_TARBALL_DOCS = [
  ['docs/cloud', 'flare-batch.md'].join(''),
  ['docs/home', 'assistant-surface.md'].join(''),
  'docs/wrfc/',
  'docs/competitive-parity-plan.md',
] as const;
const FORBIDDEN_TARBALL_FILES = new Set([
  'src/cli/package-verification.ts',
  'src/input/commands/quit-shared.ts',
  'src/cli/service-command.ts',
  'src/cli/surface-command.ts',
  'src/tools/wrfc-agent-guard.ts',
  'src/renderer/agent-detail-modal.ts',
  'src/renderer/git-status.ts',
  'src/renderer/process-summary.ts',
]);
const BASE_PACKAGE_FACING_TEXT_PATHS = [
  'README.md',
  'CHANGELOG.md',
] as const;
const PACKAGE_FACING_FORBIDDEN_TEXT = [
  ['/api/', 'knowledge'].join(''),
  ['/api/home', 'assistant'].join(''),
  ['home', 'assistant.home', 'Graph'].join(''),
  ['include', 'AllSpaces'].join(''),
  ['knowledge', 'SpaceId'].join(''),
  ['@pellux/goodvibes-', 'tui'].join(''),
  // The scoped name stays banned: it is the internal library the Agent links
  // against, not something a reader installs. The UNSCOPED `goodvibes-daemon`
  // is not banned: it is this package's one declared dependency (see
  // src/test/deps/dependency-check.test.ts), and the install instructions have
  // to name it, `bun pm trust -g goodvibes-daemon` is the step that lets the
  // daemon's postinstall place its binary, and `goodvibes-daemon --version` is
  // how a reader checks both commands landed. Banning the string would make
  // the README and docs/getting-started.md unwritable.
  ['@pellux/goodvibes-', 'daemon'].join(''),
  ['~/.goodvibes/', 'tui'].join(''),
  ['Home', ' Assistant'].join(''),
  ['Home', 'Graph'].join(''),
  ['near', '-fork'].join(''),
  ['Optional ', 'Browser Access'].join(''),
  ['Optional ', 'Other-Device Access'].join(''),
  ['Optional ', 'Incoming Events'].join(''),
  ['Service ', '& Network'].join(''),
  ['Surfaces ', '& Integrations'].join(''),
  ['runtime', '-isolation'].join(''),
  ['goodvibes-agent', 'serve'].join(' '),
  ['goodvibes-agent', 'service'].join(' '),
  ['goodvibes-agent', 'services'].join(' '),
  ['goodvibes-agent', 'surfaces'].join(' '),
  ['goodvibes-agent', 'surface'].join(' '),
  ['goodvibes-agent', 'listener'].join(' '),
  ['goodvibes-agent', 'control-plane'].join(' '),
  ['goodvibes-agent', 'remote'].join(' '),
  ['goodvibes-agent', 'bridge'].join(' '),
  ['goodvibes-agent', 'web'].join(' '),
  ['goodvibes-agent', 'launch'].join(' '),
  ['goodvibes-agent', 'start'].join(' '),
  ['tui ', '[path]'].join(''),
  ['tui', '|launch'].join(''),
  ['tui', '|launch|start'].join(''),
  'Every plan must have a multi-agent execution strategy',
  'ALWAYS work in parallel when implementing a plan',
  'PRIMARY GOAL: Fully complete and functional code',
  'ReviewerReport',
  '"wrfcId"',
] as const;
const EXACT_SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/**
 * Package-facing text names no GoodVibes package but this one: the platform
 * runtime the Agent bundles is "the bundled GoodVibes platform runtime" there.
 */
const ALLOWED_PACKAGE_FACING_PACKAGE_NAMES = new Set([
  '@pellux/goodvibes-agent',
]);
const NON_BUN_INSTALL_COMMAND_PATTERN = /(?:^|[\s`])(?:npm\s+(?:install|i|exec)|npx|pnpm\s+(?:add|dlx|exec)|yarn\s+(?:add|global\s+add|dlx|exec))\b.*(?:@pellux\/goodvibes-agent|goodvibes-agent)/i;
const RELEASE_NOTES_STAMP_PATTERN = /^GoodVibes Agent ([0-9]+\.[0-9]+\.[0-9]+)\s+(?:-|\u2014)\s+([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

/**
 * Release-notes problems that are a property of the TEXT, so they can be tested
 * against a string instead of against a whole repository on disk.
 *
 * The version check exists because this file went seven releases without being
 * rewritten, 1.15.0's notes, describing the phone tool and triggers, shipped
 * inside the published package as late as 1.21.0. Nothing caught it: the only
 * rules here counted bullets and banned marketing words, and stale notes pass
 * both. `release/release-notes.md` is in package.json's `files` list, so what
 * this misses is what a reader opens.
 *
 * A stamp naming the release is used rather than "the notes mention the
 * version somewhere": the stale file DID contain a version string, the
 * platform runtime's, in its last bullet, and for several releases the two
 * numbers happened to coincide, so a substring rule would have been green
 * against exactly the file this is meant to reject.
 */
function matchesForbiddenPrefix(path: string, prefix: string): boolean {
  const directory = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === directory || path.startsWith(prefix);
}

export function isForbiddenPackageTarballPath(path: string): boolean {
  if (FORBIDDEN_TARBALL_PREFIXES.some((prefix) => matchesForbiddenPrefix(path, prefix))) return true;
  if (path.endsWith('.test.ts')) return true;
  if (path.includes('/__tests__/') || path.endsWith('/__tests__')) return true;
  if (FORBIDDEN_TARBALL_FILES.has(path)) return true;
  return FORBIDDEN_TARBALL_DOCS.some((docPath) => {
    if (docPath.endsWith('/')) return matchesForbiddenPrefix(path, docPath);
    return path === docPath || path.startsWith(docPath);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPackageJson(root: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as unknown;
  if (!isRecord(parsed)) throw new Error('package.json must contain a JSON object.');
  return parsed;
}

function readStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function isExactSemver(value: string): boolean {
  return EXACT_SEMVER_PATTERN.test(value);
}

const ALLOWED_PACKAGE_DOC_FILENAMES = [
  'README.md',
  'channels-remote-and-api.md',
  'connected-host.md',
  'getting-started.md',
  // The Google pages are user-facing package docs: the runbook is the written
  // fallback for the /google setup automation (generated from the SDK's setup
  // plan) and the scope strategy explains exactly what that integration
  // requests. They ship via the package `files` glob either way; listing them
  // here brings them under the same required-path, docs-index, and
  // package-facing text policy as every other shipped docs page instead of
  // leaving them packaged but un-policed.
  'google-scope-strategy.md',
  'google-setup-runbook.md',
  'knowledge-artifacts-and-multimodal.md',
  'providers-and-routing.md',
  'release-and-publishing.md',
  'tools-and-commands.md',
  'voice-and-live-tts.md',
] as const;

export function packageDocPaths(root: string): readonly string[] {
  const docsPath = join(root, 'docs');
  if (!existsSync(docsPath)) return [];
  return ALLOWED_PACKAGE_DOC_FILENAMES
    .map((entry) => `docs/${entry}`)
    .filter((docPath) => existsSync(join(root, docPath)))
    .sort();
}

export function requiredTarballPaths(root: string): readonly string[] {
  return [...BASE_REQUIRED_TARBALL_PATHS, ...packageDocPaths(root)];
}

function normalizedPackageFileEntry(entry: string): string {
  return normalize(entry).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function packageManifestPositiveEntryCoversPath(entry: string, path: string): boolean {
  if (entry.startsWith('!')) return false;
  const normalizedEntry = normalizedPackageFileEntry(entry);
  if (normalizedEntry.length === 0) return false;
  if (normalizedEntry.endsWith('/*.md')) {
    const directory = normalizedEntry.slice(0, -'/*.md'.length);
    const relativePath = path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : '';
    return relativePath.length > 0 && !relativePath.includes('/') && relativePath.endsWith('.md');
  }
  return path === normalizedEntry || path.startsWith(`${normalizedEntry}/`);
}

function existingForbiddenPackagePathsCoveredByManifest(root: string, files: readonly string[]): readonly string[] {
  const forbiddenCandidates = [
    ...FORBIDDEN_TARBALL_PREFIXES,
    ...FORBIDDEN_TARBALL_DOCS,
    ...FORBIDDEN_TARBALL_FILES,
  ].map(normalizedPackageFileEntry);
  return [...new Set(forbiddenCandidates)]
    .filter((path) => existsSync(join(root, path)))
    .filter((path) => files.some((entry) => packageManifestPositiveEntryCoversPath(entry, path)))
    .sort();
}

function verifyPackageFilesManifest(root: string, files: readonly string[]): readonly string[] {
  const issues: string[] = [];
  for (const requiredFile of REQUIRED_PACKAGE_FILE_ENTRIES) {
    if (!files.includes(requiredFile)) {
      issues.push(`package.json files must include ${requiredFile}.`);
    }
  }
  for (const excludedFile of REQUIRED_PACKAGE_FILE_EXCLUSIONS) {
    if (!files.includes(excludedFile)) {
      issues.push(`package.json files must exclude ${excludedFile}.`);
    }
  }
  for (const entry of files) {
    if (entry.startsWith('!')) continue;
    const normalizedEntry = normalizedPackageFileEntry(entry);
    if (isForbiddenPackageTarballPath(normalizedEntry)) {
      issues.push(`package.json files must not include forbidden Agent package path: ${entry}.`);
    }
  }
  for (const path of existingForbiddenPackagePathsCoveredByManifest(root, files)) {
    const exclusion = `!${path}`;
    if (!files.includes(exclusion)) {
      issues.push(`package.json files must exclude existing forbidden Agent package path covered by broad includes: ${exclusion}.`);
    }
  }
  return issues;
}

function hasExecutableBit(path: string): boolean {
  return existsSync(path) && (statSync(path).mode & 0o111) !== 0;
}

function verifyBin(root: string, command: typeof REQUIRED_BIN_COMMANDS[number], target: string | undefined): PackageCliBinVerification {
  const binPath = target ? join(root, target) : '';
  const source = target && existsSync(binPath) ? readFileSync(binPath, 'utf-8') : '';
  return {
    command,
    target: target ?? '',
    exists: Boolean(target) && existsSync(binPath),
    executable: Boolean(target) && hasExecutableBit(binPath),
    usesBunShebang: source.startsWith('#!/usr/bin/env bun'),
    hasSourceEntrypoint: source.includes('dist') && source.includes('package') && source.includes('main.js'),
  };
}

function verifyPackageBinIssues(root: string, pkg: Record<string, unknown>): readonly string[] {
  const issues: string[] = [];
  const bin = readStringRecord(pkg.bin);
  for (const command of REQUIRED_BIN_COMMANDS) {
    const item = verifyBin(root, command, bin[command]);
    if (!item.target) issues.push(`package.json bin is missing ${item.command}.`);
    if (!item.exists) issues.push(`bin target does not exist: ${item.command} -> ${item.target}`);
    if (!item.executable) issues.push(`bin target is not executable: ${item.command} -> ${item.target}`);
    if (!item.usesBunShebang) issues.push(`bin target does not use Bun shebang: ${item.command} -> ${item.target}`);
    if (!item.hasSourceEntrypoint) issues.push(`bin target does not load the packaged Agent runtime: ${item.command}`);
  }
  return issues;
}

/**
 * The package.json fields a publish and a `bun add -g` depend on: the name and
 * visibility npm publishes under, the module entry and bin the install links,
 * the files manifest that decides what the tarball holds, and an exact version.
 */
export function verifyReleaseMetadata(root: string): readonly string[] {
  const issues: string[] = [];
  const pkg = readPackageJson(root);
  if (pkg.name !== '@pellux/goodvibes-agent') issues.push('package.json name must be @pellux/goodvibes-agent.');
  if (pkg.private !== false) issues.push('package.json private must be false for the public Agent package.');
  if (pkg.type !== 'module') issues.push('package.json type must be module.');
  if (pkg.main !== 'dist/package/main.js') issues.push('package.json main must be dist/package/main.js.');
  const publishConfig = isRecord(pkg.publishConfig) ? pkg.publishConfig : {};
  if (publishConfig.access !== 'public') issues.push('package.json publishConfig.access must be public.');
  const bin = readStringRecord(pkg.bin);
  if (bin['goodvibes-agent'] !== 'bin/goodvibes-agent.ts') issues.push('package.json bin.goodvibes-agent must be bin/goodvibes-agent.ts.');
  issues.push(...verifyPackageBinIssues(root, pkg));
  issues.push(...verifyPackageFilesManifest(root, readStringArray(pkg.files)));
  const version = readStringValue(pkg.version);
  if (!isExactSemver(version)) issues.push(`package.json version must be an exact semver like 1.2.3: ${version || '(missing)'}.`);
  return issues;
}

export function releaseNotesTextIssues(content: string, packageVersion: string): readonly string[] {
  const issues: string[] = [];
  const stampLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? '';
  const stamp = RELEASE_NOTES_STAMP_PATTERN.exec(stampLine);
  if (stamp === null) {
    issues.push(`release notes must end with a line naming the release, like "GoodVibes Agent ${packageVersion} - YYYY-MM-DD".`);
  } else {
    if (packageVersion.length > 0 && stamp[1] !== packageVersion) {
      issues.push(`release notes describe ${stamp[1]} but this release is ${packageVersion}, rewrite them for what is shipping.`);
    }
    const date = new Date(`${stamp[2]!}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== stamp[2]) {
      issues.push(`release notes date must be a real YYYY-MM-DD date: ${stamp[2]}.`);
    }
  }
  return issues;
}

function readTopChangelogVersion(root: string): string | null {
  const changelogPath = join(root, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) return null;
  const heading = readFileSync(changelogPath, 'utf-8').split(/\r?\n/).find((line) => line.startsWith('## '));
  const match = heading ? /^##\s+\[?([0-9]+\.[0-9]+\.[0-9]+)\]?\s+-\s+[0-9]{4}-[0-9]{2}-[0-9]{2}\s*$/.exec(heading) : null;
  return match ? match[1]! : null;
}

/**
 * Every file that carries the release version agrees with package.json. Run
 * after scripts/release-prepare.ts rewrites them, and by the release cut; a
 * mismatch here means a stamp was edited by hand, not a regression.
 */
export function verifyReleaseStamps(root: string): readonly string[] {
  const issues: string[] = [];
  const version = readStringValue(readPackageJson(root).version);
  const changelogVersion = readTopChangelogVersion(root);
  if (changelogVersion !== version) issues.push(`CHANGELOG.md top release ${changelogVersion ?? '(none)'} does not match package.json ${version}.`);
  const versionTs = existsSync(join(root, 'src', 'version.ts')) ? readFileSync(join(root, 'src', 'version.ts'), 'utf-8') : '';
  const fallback = /let _version = '([^']*)'/.exec(versionTs)?.[1];
  if (fallback !== version) issues.push(`src/version.ts fallback ${fallback ?? '(missing)'} does not match package.json ${version}.`);
  const notesPath = join(root, 'release', 'release-notes.md');
  if (!existsSync(notesPath)) issues.push('release/release-notes.md is missing.');
  else issues.push(...releaseNotesTextIssues(readFileSync(notesPath, 'utf-8'), version));
  return issues;
}

function verifyPackageFacingInstallAndPackageNames(path: string, content: string): readonly string[] {
  const failures: string[] = [];
  const lines = content.split(/\r?\n/);
  const packageNamePattern = /@pellux\/goodvibes-[a-z0-9-]+/g;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (NON_BUN_INSTALL_COMMAND_PATTERN.test(line)) {
      failures.push(`package-facing text ${path}:${lineIndex + 1} contains non-Bun Agent install/run instruction.`);
    }
    packageNamePattern.lastIndex = 0;
    for (let match = packageNamePattern.exec(line); match !== null; match = packageNamePattern.exec(line)) {
      const packageName = match[0] ?? '';
      if (!ALLOWED_PACKAGE_FACING_PACKAGE_NAMES.has(packageName)) {
        failures.push(`package-facing text ${path}:${lineIndex + 1} references non-Agent GoodVibes package: ${packageName}`);
      }
    }
  }
  return failures;
}

/**
 * The text a reader sees on the npm page and in the installed docs (README,
 * CHANGELOG, the shipped docs pages) names no GoodVibes package but this one,
 * gives Bun install instructions only, and carries none of the retired routes
 * and TUI-only wording in PACKAGE_FACING_FORBIDDEN_TEXT. Checked at the version
 * bump (release:prepare) and in the release cut, where that text is written.
 */
export function verifyPackageFacingText(root: string): { readonly checkedPaths: readonly string[]; readonly failures: readonly string[] } {
  const failures: string[] = [];
  const paths = [...BASE_PACKAGE_FACING_TEXT_PATHS, ...packageDocPaths(root)];
  for (const path of paths) {
    const absolutePath = join(root, path);
    if (!existsSync(absolutePath)) {
      failures.push(`package-facing text is missing: ${path}`);
      continue;
    }
    const content = readFileSync(absolutePath, 'utf-8');
    failures.push(...verifyPackageFacingInstallAndPackageNames(path, content));
    for (const forbidden of PACKAGE_FACING_FORBIDDEN_TEXT) {
      if (content.includes(forbidden)) {
        failures.push(`package-facing text ${path} contains forbidden default/TUI route or policy: ${forbidden}`);
      }
    }
  }
  return { checkedPaths: paths, failures };
}

export interface NpmPackDryRunResult {
  readonly files: readonly string[];
  readonly entryCount: number;
  readonly unpackedSize: number;
}

interface NpmPackJsonEntry {
  readonly files?: ReadonlyArray<{ readonly path?: string } | null>;
  readonly entryCount?: number;
  readonly unpackedSize?: number;
}

function describeNpmPackOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'no output at all';
  const preview = trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
  return `${trimmed.length} characters of output beginning: ${preview}`;
}

// npm wrappers (version-manager shims, "npm notice" lines) sometimes print plain text
// on stdout alongside the JSON document. Take the first balanced JSON value and ignore
// whatever surrounds it, tracking string literals so braces inside paths do not confuse
// the depth count.
function extractJsonDocument(raw: string): string | undefined {
  const start = raw.search(/[[{]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}

function looksLikePackEntry(value: unknown): value is NpmPackJsonEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.files) || typeof candidate.entryCount === 'number' || typeof candidate.unpackedSize === 'number';
}

function selectPackEntry(parsed: unknown): NpmPackJsonEntry | undefined {
  // npm 10/11 emit `[{ files, entryCount, unpackedSize }]`.
  if (Array.isArray(parsed)) return parsed.find(looksLikePackEntry);
  // npm 12 emits `{ "<package-name>": { files, entryCount, unpackedSize } }`.
  if (looksLikePackEntry(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>).find(looksLikePackEntry);
  return undefined;
}

export function parseNpmPackJson(raw: string): NpmPackDryRunResult {
  const document = extractJsonDocument(raw);
  if (document === undefined) {
    throw new Error(`npm pack --json --dry-run printed no JSON document; npm emitted ${describeNpmPackOutput(raw)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`npm pack --json --dry-run printed JSON that could not be parsed (${reason}); npm emitted ${describeNpmPackOutput(raw)}`);
  }
  const entry = selectPackEntry(parsed);
  if (!entry) {
    throw new Error(
      `npm pack --json --dry-run returned an unrecognized JSON shape; expected an array of pack results or an object keyed by package name, but npm emitted ${describeNpmPackOutput(raw)}`,
    );
  }
  return {
    files: Array.isArray(entry.files) ? entry.files.map((file) => String(file?.path ?? '')) : [],
    entryCount: Number(entry.entryCount ?? 0),
    unpackedSize: Number(entry.unpackedSize ?? 0),
  };
}

function registryPackDryRun(root: string): NpmPackDryRunResult {
  execSync('bun run build:package-runtime', {
    cwd: root,
    stdio: 'inherit',
  });
  const raw = execSync('npm pack --json --dry-run', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return parseNpmPackJson(raw);
}

export function verifyPackageCliInstall(root: string): PackageCliVerificationReport {
  const pkg = readPackageJson(root);
  const bin = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin as Record<string, string | undefined> : {};
  const bins = REQUIRED_BIN_COMMANDS.map((command) => verifyBin(root, command, bin[command]));
  const pack = registryPackDryRun(root);
  const requiredPaths = requiredTarballPaths(root);
  const requiredPathsPresent = requiredPaths.filter((path) => pack.files.includes(path));
  const forbiddenPaths = pack.files.filter(isForbiddenPackageTarballPath);
  const issues: string[] = [];
  for (const path of requiredPaths) {
    if (!pack.files.includes(path)) issues.push(`registry tarball missing required path: ${path}`);
  }
  for (const path of forbiddenPaths) {
    issues.push(`registry tarball includes forbidden path: ${path}`);
  }
  issues.push(...verifyReleaseMetadata(root));
  return {
    packageName: String(pkg.name ?? ''),
    version: String(pkg.version ?? ''),
    bins,
    tarball: {
      entryCount: pack.entryCount,
      unpackedSize: pack.unpackedSize,
      requiredPathsPresent,
      forbiddenPaths,
    },
    issues,
  };
}
