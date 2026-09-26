/**
 * types-resolution-check.ts, arethetypeswrong over every released package.
 *
 * attw packs a directory and resolves each export the way Node and the
 * bundler-style resolvers do. It runs over the release stage, not the
 * workspace, because the workspace manifests carry the `bun` source condition
 * that the published manifests drop.
 *
 * The ignored rules are the old package set's: every package is ESM only, so
 * there is no CommonJS resolution to check.
 */
import { cleanupStage, run, stagePackages } from './release-shared.ts';

const { tempRoot, publicStages } = await stagePackages();
try {
  for (const stage of publicStages) {
    run('bunx', ['attw', '--pack', stage.stageDir, '--ignore-rules', 'no-resolution', 'cjs-resolves-to-esm'], process.cwd());
  }
} finally {
  cleanupStage(tempRoot);
}

console.log('types resolution check passed for all public packages');
