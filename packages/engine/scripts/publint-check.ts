import { cleanupStage, run, stagePackages } from './release-shared.ts';

// publint judges the package as published, so it runs over the release stage:
// the normalized manifests without the workspace source condition, beside the
// files npm would pack.
const { tempRoot, publicStages } = await stagePackages();
try {
  for (const stage of publicStages) {
    run('bunx', ['publint', stage.stageDir], process.cwd());
  }
} finally {
  cleanupStage(tempRoot);
}

console.log('publint check passed for all public packages');
