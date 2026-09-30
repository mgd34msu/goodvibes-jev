/** Check every published export with all four attw resolvers and unchanged rules.
 * Small direct-Node subprocesses bound memory and provide progress/deadlines;
 * CI distributes the same exhaustive plan over independent runners.
 */
import { execFileSync } from 'node:child_process';
import { cleanupStage, collectTarballs, createSdkTempDir, packStage, stagePackages } from './release-shared.ts';
import { packedExports, parseShard, planChecks } from './types-resolution-plan.ts';
import { checkChunk } from './types-resolution-runner.ts';

const shard = parseShard(process.argv.slice(2));
const { tempRoot, publicStages } = await stagePackages();
const packDestination = createSdkTempDir('goodvibes-sdk-attw-');
try {
  const tarballs = collectTarballs(publicStages.map((stage) => packStage(stage.stageDir, packDestination)), packDestination);
  // Inspect the actual shipped manifest, not the source-condition workspace one.
  const packages = tarballs.map((tarball) => packedExports(JSON.parse(execFileSync('tar',
    ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })), tarball));
  const lanes = planChecks(packages, shard.count);
  const chunks = lanes[shard.index]!;
  console.log(`attw shard ${shard.index}/${shard.count}: ${chunks.reduce((n, chunk) => n + chunk.entrypoints.length, 0)} of ${packages.reduce((n, pkg) => n + pkg.entrypoints.length, 0)} exports`);
  for (const chunk of chunks) await checkChunk(chunk);
} finally {
  cleanupStage(packDestination);
  cleanupStage(tempRoot);
}
console.log(`types resolution check passed for shard ${shard.index}/${shard.count}`);
