#!/usr/bin/env bun
/**
 * check-workflows.ts, structural validation gate for the GitHub Actions
 * workflow YAML under .github/workflows/.
 *
 * The repo has no actionlint/yaml-lint gate, so a broken workflow edit would
 * only surface at release time. This check runs in the ordinary gate battery and
 * validates the structure statically (it never executes a publish):
 *   - every workflow file parses as YAML;
 *   - every workflow declares `name`, `on`, and a non-empty `jobs` map;
 *   - every job declares `runs-on` and either `steps` or `uses` (reusable call);
 *   - no job carries `continue-on-error: true` (banned across the ecosystem,
 *     a run that reports success over a failing job is a false green);
 *   - the release workflow is wired onto the shared reusable workflows: by-
 *     reference validation (reusable-release-verify), the binary build matrix
 *     (reusable-binary-matrix), the GitHub Release (reusable-gh-release), and
 *     the npm publish (reusable-npm-publish), no hand-rolled CI poll, no
 *     throwaway validate build;
 *   - the release lane still carries every required job: tag/version check,
 *     by-reference verify, npm pack, the binary matrix, the asset assembly, the
 *     GitHub Release, the npm publish, and the registry install smoke;
 *   - the assembled release assets cover all four platform binaries, all four
 *     per-platform sqlite-vec native addon archives (sqlite-vec-<os>-<arch>.tar.gz),
 *     and the browser driver archive (browser-driver.tar.gz), each attached to
 *     the GitHub Release (whose reusable workflow generates the SHA256SUMS
 *     manifest, missing-asset-fatal), matching the naming the curl installer
 *     parses.
 *
 * Exit code 0 = green (0 problems), non-zero = the count of structural problems.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workflowsDir = join(root, '.github', 'workflows');

type Json = Record<string, unknown>;

const problems: string[] = [];
function fail(file: string, message: string): void {
  problems.push(`${file}: ${message}`);
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) {
  console.error('check-workflows: no workflow files found under .github/workflows');
  process.exit(1);
}

/** Jobs the release workflow must define to ship both the npm channel and binaries. */
const RELEASE_REQUIRED_JOBS: ReadonlyArray<string> = [
  'verify-tag-version',
  'release-verify',
  'pack',
  'binaries',
  'browser-driver',
  'assemble-release-assets',
  'github-release',
  'publish-npm',
  'registry-install-smoke',
];

/** Shared reusable workflows the release lane must consume (one implementation per concern). */
const RELEASE_REQUIRED_REUSABLES: ReadonlyArray<string> = [
  'reusable-release-verify.yml',
  'reusable-binary-matrix.yml',
  'reusable-gh-release.yml',
  'reusable-npm-publish.yml',
];

/** The four compiled binaries the curl installer resolves by platform. */
const PLATFORM_BINARIES: ReadonlyArray<string> = [
  'goodvibes-agent-linux-x64',
  'goodvibes-agent-linux-arm64',
  'goodvibes-agent-macos-x64',
  'goodvibes-agent-macos-arm64',
];

/**
 * The four per-platform sqlite-vec native addon archives. Each is checksummed in
 * SHA256SUMS.txt and attached to the release; an installer downloads the one that
 * matches the binary's platform and extracts it in place next to the binary
 * (interior layout: lib/sqlite-vec-<os>-<arch>/vec0.<suffix>).
 */
const PLATFORM_ADDON_ARCHIVES: ReadonlyArray<string> = [
  'sqlite-vec-linux-x64.tar.gz',
  'sqlite-vec-linux-arm64.tar.gz',
  'sqlite-vec-darwin-x64.tar.gz',
  'sqlite-vec-darwin-arm64.tar.gz',
];

/**
 * The browser driver archive. Platform-independent (the driver is plain
 * JavaScript), checksummed in the same SHA256SUMS.txt, and extracted beside the
 * binary as `playwright-core/`. Without it a downloaded binary has no
 * automation driver at all, which is what 1.18.1 shipped.
 */
const BROWSER_DRIVER_ARCHIVE = 'browser-driver.tar.gz';

function stepsContinueOnError(job: Json): boolean {
  // A step-level continue-on-error is an informational annotation and never
  // reds a check-run, only a JOB-level true is banned. This helper flags the
  // job-level form.
  return job['continue-on-error'] === true;
}

for (const file of files) {
  const raw = readFileSync(join(workflowsDir, file), 'utf8');
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(raw);
  } catch (err) {
    fail(file, `does not parse as YAML: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (!isObject(doc)) {
    fail(file, 'top-level document is not a mapping');
    continue;
  }
  if (typeof doc.name !== 'string' || doc.name.trim().length === 0) {
    fail(file, 'missing a non-empty `name`');
  }
  // Bun.YAML.parse follows the YAML 1.2 core schema and keeps a bare `on:` as
  // the string key "on". A YAML 1.1 parser instead resolves it to the boolean
  // true, which lands on the parsed object as the string key "true" (JS object
  // keys are always strings). Accept either so the check does not depend on
  // which schema the parser implements.
  if (!('on' in doc) && !('true' in doc)) {
    fail(file, 'missing an `on` trigger block');
  }
  const jobs = doc.jobs;
  if (!isObject(jobs) || Object.keys(jobs).length === 0) {
    fail(file, 'missing a non-empty `jobs` map');
    continue;
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isObject(job)) {
      fail(file, `job "${jobName}" is not a mapping`);
      continue;
    }
    const isReusableCall = typeof job.uses === 'string';
    if (!isReusableCall) {
      if (!('runs-on' in job)) fail(file, `job "${jobName}" is missing runs-on`);
      if (!Array.isArray(job.steps) || job.steps.length === 0) {
        fail(file, `job "${jobName}" has no steps`);
      }
    }
    if (stepsContinueOnError(job)) {
      fail(file, `job "${jobName}" declares job-level continue-on-error: true (banned: it hides a failing job behind a green run)`);
    }
  }

  if (file === 'release.yml') {
    for (const job of RELEASE_REQUIRED_JOBS) {
      if (!isObject((jobs as Json)[job])) {
        fail(file, `release workflow is missing the "${job}" job`);
      }
    }

    // The release lane must consume the shared reusable workflows (one
    // implementation per concern) rather than a hand-rolled copy.
    for (const reusable of RELEASE_REQUIRED_REUSABLES) {
      if (!raw.includes(reusable)) {
        fail(file, `release workflow does not consume the shared ${reusable} reusable workflow`);
      }
    }

    // Every platform binary must appear in both the assembled release-assets
    // upload and the GitHub Release asset glob. Assert on the raw text so a
    // dropped platform cannot slip through a structural pass.
    for (const binary of PLATFORM_BINARIES) {
      const occurrences = raw.split(binary).length - 1;
      if (occurrences < 2) {
        fail(
          file,
          `binary "${binary}" must appear in both the assembled assets and the GitHub Release glob (found ${occurrences} reference(s))`,
        );
      }
    }
    // Every per-platform sqlite-vec addon archive must appear in both the
    // assembled assets and the GitHub Release glob, a directly-downloaded binary
    // depends on the matching addon to restore the semantic vector index, so a
    // dropped archive is missing-entry-fatal, exactly like a dropped binary.
    for (const archive of PLATFORM_ADDON_ARCHIVES) {
      const occurrences = raw.split(archive).length - 1;
      if (occurrences < 2) {
        fail(
          file,
          `sqlite-vec addon archive "${archive}" must appear in both the assembled assets and the GitHub Release glob (found ${occurrences} reference(s))`,
        );
      }
    }
    // The browser driver archive rides the same two sinks. A binary with no
    // driver beside it cannot drive a page at all, so a dropped driver archive
    // is missing-entry-fatal exactly like a dropped addon.
    {
      const occurrences = raw.split(BROWSER_DRIVER_ARCHIVE).length - 1;
      if (occurrences < 2) {
        fail(
          file,
          `browser driver archive "${BROWSER_DRIVER_ARCHIVE}" must appear in both the assembled assets and the GitHub Release glob (found ${occurrences} reference(s))`,
        );
      }
    }
    // SHA256SUMS is generated + attached by the reusable GitHub Release workflow
    // (missing-asset-fatal, toolchain sha256sums); consuming that reusable is the
    // structural guarantee. The compiled-binary smoke is likewise owned by the
    // reusable binary matrix (post-build-smoke on the executable legs).
  }
}

if (problems.length > 0) {
  console.error(`check-workflows: ${problems.length} structural problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`check-workflows: OK, ${files.length} workflow file(s) validated, 0 problems.`);
