/** Deterministic, exhaustive partitions of the exports in the actual npm tarballs. */
export interface PackedExports {
  name: string;
  tarball: string;
  entrypoints: string[];
}
export type CheckChunk = PackedExports;
export const CHUNK_SIZE = 4;
export const RESOLVERS = ['node10', 'node16-cjs', 'node16-esm', 'bundler'] as const;
export const IGNORE_RULES = ['no-resolution', 'cjs-resolves-to-esm'] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function packedExports(manifest: unknown, tarball: string): PackedExports {
  if (!record(manifest) || typeof manifest.name !== 'string' || !manifest.name) {
    throw new Error(`Invalid packed manifest: ${tarball}`);
  }
  const exports = manifest.exports;
  // Fail closed if publishing adopts a new export shape; never silently drop
  // wildcard, null, conditional-root, or legacy entrypoints from the gate.
  if (!record(exports) || Object.keys(exports).length === 0) throw new Error('Expected explicit subpath exports');
  const target = (value: unknown): boolean => typeof value === 'string'
    ? value.startsWith('./') && !value.includes('*')
    : record(value) && Object.keys(value).length > 0 && Object.values(value).every(target);
  const entrypoints = Object.keys(exports).sort();
  for (const key of entrypoints) {
    if ((key !== '.' && !key.startsWith('./')) || key.includes('*') || !target(exports[key])) {
      throw new Error(`Unsupported export shape: ${manifest.name} ${key}`);
    }
  }
  return { name: manifest.name, tarball, entrypoints };
}

export function assertExactCoverage(expected: readonly string[], actual: readonly string[]): void {
  if (new Set(expected).size !== expected.length || new Set(actual).size !== actual.length ||
      expected.length !== actual.length || actual.some((key) => !expected.includes(key))) {
    throw new Error('Export coverage mismatch (missing, duplicate, or unexpected entrypoint)');
  }
}

export function planChecks(packages: readonly PackedExports[], shardCount: number): CheckChunk[][] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 256) throw new Error('Invalid shard count');
  if (packages.length === 0 || packages.some((pkg) => pkg.entrypoints.length === 0)) throw new Error('Empty packed export inventory');
  const lanes: CheckChunk[][] = Array.from({ length: shardCount }, () => []);
  const expected: string[] = [];
  let offset = 0;
  for (const pkg of [...packages].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const perLane: string[][] = Array.from({ length: shardCount }, () => []);
    for (const entrypoint of [...pkg.entrypoints].sort()) {
      expected.push(`${pkg.name}:${entrypoint}`);
      perLane[offset++ % shardCount]!.push(entrypoint);
    }
    perLane.forEach((entrypoints, lane) => {
      for (let i = 0; i < entrypoints.length; i += CHUNK_SIZE) {
        lanes[lane]!.push({ ...pkg, entrypoints: entrypoints.slice(i, i + CHUNK_SIZE) });
      }
    });
  }
  assertExactCoverage(expected, lanes.flat().flatMap((chunk) => chunk.entrypoints.map((key) => `${chunk.name}:${key}`)));
  return lanes;
}

export function parseShard(args: readonly string[]): { index: number; count: number } {
  if (args.length === 0) return { index: 0, count: 1 };
  if (args.length !== 2 || args[0] !== '--shard' || !/^\d+\/\d+$/.test(args[1]!)) throw new Error('Usage: --shard INDEX/COUNT (zero-based)');
  const [index, count] = args[1]!.split('/').map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count! < 1 || count! > 256 || index! < 0 || index! >= count!) {
    throw new Error('Invalid shard index/count');
  }
  return { index: index!, count: count! };
}

export function verifyAnalysis(output: string, chunk: CheckChunk): void {
  const result: unknown = JSON.parse(output);
  if (!record(result) || !record(result.analysis)) throw new Error('Missing attw analysis');
  const analysis = result.analysis;
  if (analysis.packageName !== chunk.name || !analysis.types || !record(analysis.entrypoints)) throw new Error('Invalid attw package analysis');
  assertExactCoverage(chunk.entrypoints, Object.keys(analysis.entrypoints));
  for (const [key, value] of Object.entries(analysis.entrypoints)) {
    if (!record(value) || !record(value.resolutions)) throw new Error(`Missing resolutions: ${key}`);
    assertExactCoverage(RESOLVERS, Object.keys(value.resolutions));
    for (const resolver of RESOLVERS) {
      const resolution = value.resolutions[resolver];
      if (!record(resolution) || resolution.resolutionKind !== resolver) throw new Error(`Missing resolver analysis: ${key} ${resolver}`);
    }
  }
}
