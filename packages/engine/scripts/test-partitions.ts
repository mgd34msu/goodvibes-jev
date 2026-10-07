import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultTestArgs } from './test-discovery.ts';

// Capacity changes belong here, not in the runner's deadlines. CI runs these
// on separate hosts; a local invocation still owns one sequential Bun child.
export const ENGINE_TEST_PARTITIONS = 4;
const MAX_PARTITIONS = 16;

export function partitionTestFiles(files: readonly string[], count: number): readonly (readonly string[])[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PARTITIONS || count > files.length) {
    throw new Error(`Test partition count must be 1..${MAX_PARTITIONS} and cannot create empty partitions`);
  }
  if (new Set(files).size !== files.length) throw new Error('Test manifest contains duplicate files');
  const partitions: string[][] = Array.from({ length: count }, () => []);
  // A sorted round-robin spreads neighboring subsystem files rather than
  // concentrating all expensive daemon/contract fixtures in one contiguous leg.
  [...files].sort().forEach((file, index) => partitions[index % count]!.push(file));
  return partitions;
}

export function engineTestManifest(engineRoot: string, count = ENGINE_TEST_PARTITIONS) {
  const files = defaultTestArgs(engineRoot);
  const sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return {
    version: 1,
    sha256,
    files,
    partitions: partitionTestFiles(files, count).map((selected, index) => ({
      id: `${index + 1}/${count}`, files: selected,
    })),
  };
}

/** Select only the canonical default manifest; never combine a shard with filters. */
export function partitionTestArgs(engineRoot: string, args: readonly string[]): readonly string[] | null {
  if (!args.some((arg) => arg.startsWith('--partition') || arg.startsWith('--manifest-sha256'))) return null;
  const partition = args.filter((arg) => arg.startsWith('--partition='));
  const digest = args.filter((arg) => arg.startsWith('--manifest-sha256='));
  if (partition.length !== 1 || digest.length > 1 || args.length !== partition.length + digest.length) {
    throw new Error('Use --partition=INDEX/COUNT with optional --manifest-sha256=HASH and no other test arguments');
  }
  const match = /^--partition=([1-9]\d*)\/([1-9]\d*)$/.exec(partition[0]!);
  if (!match) throw new Error('Invalid test partition; expected --partition=INDEX/COUNT');
  const index = Number(match[1]);
  const count = Number(match[2]);
  const manifest = engineTestManifest(engineRoot, count);
  if (!Number.isSafeInteger(index) || index > count) throw new Error('Test partition index is outside its manifest');
  if (digest.length > 0 && digest[0] !== `--manifest-sha256=${manifest.sha256}`) {
    throw new Error('Test manifest differs from the CI build discovery');
  }
  const selected = manifest.partitions[index - 1]!;
  console.log(`[engine-tests] partition ${selected.id}: ${selected.files.length}/${manifest.files.length} files; manifest ${manifest.sha256}`);
  // Bun treats bare test/... arguments as substring filters. Explicit paths
  // prevent test/a.test.ts from also selecting test/nested/test/a.test.ts in
  // another partition. Keep the canonical manifest/hash independent of argv.
  return selected.files.map((file) => `./${file}`);
}

/** Complete platform matrix, generated from the very manifest each runner selects. */
export function platformTestMatrix(engineRoot: string) {
  const manifest = engineTestManifest(engineRoot);
  return { include: [
    ...manifest.partitions.map((partition, index) => ({
      platform: 'bun',
      name: `bun ${partition.id}`,
      'node-version': '22',
      foundation: index === 0,
      'test-cmd': `GOODVIBES_TEST_CEILING_MS=900000 bun packages/engine/scripts/test.ts --partition=${partition.id} --manifest-sha256=${manifest.sha256}`,
    })),
    ...[
      ['rn-bundle', 'test:rn'], ['workers', 'test:workers'], ['workers-wrangler', 'test:workers:wrangler'],
    ].map(([platform, script]) => ({
      platform: platform!, name: platform!, 'node-version': '22', foundation: false, 'test-cmd': `bun run ${script}`,
    })),
  ] };
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['matrix', 'manifest'].includes(mode ?? '')) {
    throw new Error('Usage: bun packages/engine/scripts/test-partitions.ts matrix|manifest');
  }
  const root = resolve(import.meta.dir, '..');
  console.log(JSON.stringify(mode === 'matrix' ? platformTestMatrix(root) : engineTestManifest(root)));
}
