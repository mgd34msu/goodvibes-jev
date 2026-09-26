/**
 * types-resolution-check.ts, arethetypeswrong over every released package.
 *
 * attw resolves each export of a packed tarball the way Node and the
 * bundler-style resolvers do. The tarballs are packed from the release stage,
 * as publish packs them, not from the workspace, because the workspace
 * manifests carry the `bun` source condition that the published manifests
 * drop. The release tooling packs them (packStage reads every shape npm's
 * pack output takes); attw's own --pack step reads only one.
 *
 * The ignored rules are the old package set's: every package is ESM only, so
 * there is no CommonJS resolution to check.
 */
import {
  cleanupStage,
  collectTarballs,
  createSdkTempDir,
  packStage,
  run,
  stagePackages,
} from './release-shared.ts';

const { tempRoot, publicStages } = await stagePackages();
const packDestination = createSdkTempDir('goodvibes-sdk-attw-');
try {
  const tarballs = collectTarballs(publicStages.map((stage) => packStage(stage.stageDir, packDestination)), packDestination);
  for (const tarball of tarballs) {
    run('bunx', ['attw', tarball, '--ignore-rules', 'no-resolution', 'cjs-resolves-to-esm'], process.cwd());
  }
} finally {
  cleanupStage(packDestination);
  cleanupStage(tempRoot);
}

console.log('types resolution check passed for all public packages');
