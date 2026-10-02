#!/usr/bin/env bun
/**
 * package-install-check.ts, private workspace readiness and published-package verification.
 *
 * The shared tarball path/size policy + bin-shim (present/executable/shebang)
 * checks are owned by @pellux/goodvibes-toolchain and driven by this repo's
 * toolchain.config.json (publish section). Private workspace builds use their
 * actual source-tarball paths while retaining the same forbidden paths/size cap.
 * Local binary readiness and legacy published fallbacks are distribution-specific
 * checks in src/cli/package-verification.ts,
 * which is product source with its own unit test.
 */
import {
  loadToolchainConfig,
  runPackageInstallCheck,
} from '@goodvibes-jev/engine/toolchain';
import { verifyPackageCliInstall, WORKSPACE_REQUIRED_TARBALL_PATHS } from '../src/cli/package-verification.ts';

const root = process.cwd();
const config = loadToolchainConfig(root);
const report = verifyPackageCliInstall(root);
let failed = 0;

// Shared tarball + bin-shim policy (toolchain, config-driven).
if (config.publish) {
  const install = runPackageInstallCheck({
    cwd: root,
    config: report.distribution === 'private-workspace'
      ? { ...config.publish, requiredTarballPaths: WORKSPACE_REQUIRED_TARBALL_PATHS }
      : config.publish,
    bins: [
      { name: 'goodvibes', path: 'bin/goodvibes', shebang: '#!/usr/bin/env bun' },
    ],
  });
  for (const issue of install.issues) console.error(`package-install-check: ${issue}`);
  if (!install.ok) failed += 1;
}

// TUI-specific distribution contract and local workspace build readiness.
if (report.issues.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  failed += 1;
}

if (failed > 0) process.exit(1);
console.log(`${report.distribution} install check passed (${report.bins.length} bins, ${report.tarball.entryCount} packed files)`);
