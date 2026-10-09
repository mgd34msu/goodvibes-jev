// align-dist-tags.ts
//
// Post-publish repair for the `latest` dist-tag across the 11 public packages.
//
// The defect it exists for: `npm publish` with no `--tag` moves `latest` to
// whatever it just published. Two release runs for DIFFERENT versions that
// overlap in time therefore interleave per package, and every package where the
// older run's publish landed last is left with `latest` pointing BACKWARD, at
// 2.0.18 after 2.0.19 already shipped. Nothing in the publish loop notices,
// because each individual publish did exactly what it was asked to.
//
// The repair is stated as a convergent property rather than as ordering: for
// every public package, `latest` must point at the highest version the registry
// holds. Run at the end of any release, in any interleaving, and the tags end
// up correct; run it when nothing is wrong and it does nothing.
//
// Usage:
//   bun scripts/align-dist-tags.ts            # correct what is wrong
//   bun scripts/align-dist-tags.ts --dry-run  # report only, change nothing

import {
  type AuthEnv,
  cleanupAuthEnv,
  createAuthEnv,
  getPublishRegistryOverride,
  publicPackageDirs,
  readPackage,
  run,
} from './release-shared.ts';

// ---------------------------------------------------------------------------
// Semver ordering
// ---------------------------------------------------------------------------

// Keep the release tool's public names while sharing precedence with the runtime.
import {
  parseSemanticVersion as parseVersion,
  compareSemanticVersions as compareVersions,
  type ParsedSemanticVersion as ParsedVersion,
} from '../sdk/src/platform/runtime/semantic-version.js';
export { parseVersion, compareVersions };

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface LatestAlignment {
  /** True when `latest` must be moved. */
  readonly correct: boolean;
  /** Version `latest` should name, or null when the package has no usable version. */
  readonly target: string | null;
  /** Versions the registry reported that this tool could not parse (reported, never chosen). */
  readonly unparseable: readonly string[];
  readonly reason: string;
}

/**
 * Where `latest` belongs for one package.
 *
 * Stable-preferred: the target is the highest NON-prerelease version, and a
 * prerelease is chosen only when the package has nothing but prereleases. A
 * plain `npm publish` of an RC would otherwise drag `latest` onto it, which is
 * a worse failure than the backward tag this repair exists to fix.
 *
 * Pure: the caller supplies what the registry said.
 */
export function decideLatestAlignment(
  versions: readonly string[],
  currentLatest: string | null,
): LatestAlignment {
  const unparseable = versions.filter((version) => parseVersion(version) === null);
  const parsed = versions
    .map((version) => ({ version, parsed: parseVersion(version) }))
    .filter((entry): entry is { version: string; parsed: ParsedVersion } => entry.parsed !== null);

  if (parsed.length === 0) {
    return {
      correct: false,
      target: null,
      unparseable,
      reason: versions.length === 0
        ? 'the registry reports no versions for this package'
        : 'no version the registry reports is parseable as semver',
    };
  }

  const stable = parsed.filter((entry) => entry.parsed.prerelease.length === 0);
  const pool = stable.length > 0 ? stable : parsed;
  const highest = pool.reduce((best, entry) => (compareVersions(entry.parsed, best.parsed) > 0 ? entry : best));
  const target = highest.version;

  if (currentLatest === target) {
    return { correct: false, target, unparseable, reason: `latest already points at ${target}` };
  }
  return {
    correct: true,
    target,
    unparseable,
    reason: currentLatest === null
      ? `latest is unset; the highest ${stable.length > 0 ? 'stable ' : ''}version is ${target}`
      : `latest points at ${currentLatest} but the highest ${stable.length > 0 ? 'stable ' : ''}version is ${target}`,
  };
}

// ---------------------------------------------------------------------------
// Registry side
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');
const REGISTRY = getPublishRegistryOverride() || 'https://registry.npmjs.org';

function packageNameForDir(dir: string): string {
  const name = readPackage(dir).name;
  if (typeof name !== 'string' || !name) throw new Error(`Package ${dir} is missing a string name.`);
  return name;
}

function npmView(packageName: string, field: string, authEnv: AuthEnv | null): string {
  return run(
    'npm',
    ['view', packageName, field, '--json', '--registry', REGISTRY],
    process.cwd(),
    {
      auth: authEnv !== null,
      registry: REGISTRY,
      packageName,
      stdio: 'pipe',
      ...(authEnv ? { authEnv } : {}),
    },
  ).trim();
}

/** Every version string in an `npm view <name> versions --json` response. */
export function parseVersionsResponse(raw: string): readonly string[] {
  if (!raw.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  // A single-version package answers with a bare string, not an array.
  if (typeof parsed === 'string') return [parsed];
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The value in an `npm view <name> dist-tags.latest --json` response.
 *
 * npm answers with the value WRAPPED in a one-element array (`["2.0.17"]`), not
 * a bare string. Reading it as a string makes every package look like it has no
 * latest tag at all, which turns this repair into an unconditional rewrite of
 * all 11 tags (observed against the live registry before this was fixed). Both
 * shapes are accepted so an npm change in either direction stays correct.
 */
export function parseDistTagLatestResponse(raw: string): string | null {
  if (!raw.trim()) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) {
    const strings = parsed.filter((entry): entry is string => typeof entry === 'string');
    return strings.length > 0 ? strings[strings.length - 1]! : null;
  }
  return null;
}

function readVersions(packageName: string, authEnv: AuthEnv | null): readonly string[] {
  return parseVersionsResponse(npmView(packageName, 'versions', authEnv));
}

function readCurrentLatest(packageName: string, authEnv: AuthEnv | null): string | null {
  return parseDistTagLatestResponse(npmView(packageName, 'dist-tags.latest', authEnv));
}

function main(): void {
  const authEnv: AuthEnv | null = DRY_RUN ? null : createAuthEnv({}, { registry: REGISTRY });
  let corrected = 0;
  let alreadyCorrect = 0;
  let skipped = 0;

  try {
    for (const dir of publicPackageDirs) {
      const packageName = packageNameForDir(dir);
      const versions = readVersions(packageName, authEnv);
      const currentLatest = readCurrentLatest(packageName, authEnv);
      const decision = decideLatestAlignment(versions, currentLatest);

      if (decision.unparseable.length > 0) {
        console.warn(
          `[dist-tags] ${packageName}: ignoring unparseable version(s) ${decision.unparseable.join(', ')}`,
        );
      }
      if (decision.target === null) {
        console.log(`[dist-tags] ${packageName}: skipped, ${decision.reason}`);
        skipped += 1;
        continue;
      }
      if (!decision.correct) {
        console.log(`[dist-tags] ${packageName}: OK, ${decision.reason}`);
        alreadyCorrect += 1;
        continue;
      }

      // Loud by design: a correction means two releases interleaved, which the
      // operator wants to know about even though this fixed it.
      console.log(`[dist-tags] ${packageName}: CORRECTING, ${decision.reason}`);
      if (DRY_RUN) {
        console.log(`[dist-tags] ${packageName}: dry-run, would run npm dist-tag add ${packageName}@${decision.target} latest`);
      } else {
        if (!authEnv) throw new Error('dist-tag alignment auth environment was not initialized.');
        run(
          'npm',
          ['dist-tag', 'add', `${packageName}@${decision.target}`, 'latest', '--registry', REGISTRY],
          process.cwd(),
          { auth: true, registry: REGISTRY, packageName, authEnv },
        );
        console.log(`[dist-tags] ${packageName}: latest now points at ${decision.target}`);
      }
      corrected += 1;
    }
  } finally {
    if (authEnv) cleanupAuthEnv(authEnv);
  }

  console.log(
    `[dist-tags] summary: ${publicPackageDirs.length} package(s), ${corrected} corrected, `
    + `${alreadyCorrect} already correct, ${skipped} skipped${DRY_RUN ? ' (dry-run, nothing was changed)' : ''}.`,
  );
}

if (import.meta.main) {
  main();
}
