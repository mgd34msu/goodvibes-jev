import { getPackageDirectoryPath, publicPackageDirs, run } from './release-shared.ts';

for (const dir of publicPackageDirs) {
  // Package dirs are relative to the engine root, not the caller's directory.
  run('bunx', ['publint', getPackageDirectoryPath(dir)], process.cwd());
}

console.log('publint check passed for all public packages');
