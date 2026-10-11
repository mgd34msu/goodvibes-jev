/** SemVer parsing and precedence shared by release discovery and dist-tag tooling. */
export interface ParsedSemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

/** Strict SemVer with safely representable numeric core components. */
export function parseSemanticVersion(raw: string): ParsedSemanticVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(raw.trim());
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null;
  return { major: major!, minor: minor!, patch: patch!, prerelease };
}

function compareIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  // Length then lexical comparison avoids rounding arbitrary-size numeric IDs.
  if (numericA && numericB && a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemanticVersions(a: ParsedSemanticVersion, b: ParsedSemanticVersion): -1 | 0 | 1 {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const order = compareIdentifiers(a.prerelease[index]!, b.prerelease[index]!);
    if (order !== 0) return order;
  }
  return a.prerelease.length < b.prerelease.length ? -1 : a.prerelease.length > b.prerelease.length ? 1 : 0;
}
