#!/usr/bin/env bun
/**
 * sdk-release-gates, publish-blocking SDK-pin checks.
 *
 * The pin/lock/installed tri-agreement, overlay-marker hard-fail, and non-npm
 * import sweep now live in the shared @goodvibes-jev/engine/toolchain `sdk-pin-gate`
 * (one implementation across tui/agent/webui). This file is a thin adapter that
 * drives that gate with the Agent's pin shape (the SDK is a devDependency here,
 * it is bundled into the compiled binary at build time, not shipped as a runtime
 * node_modules dependency) and maps the gate results to the issue-string surface
 * that publish-check and `sdk:gate` already consume.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realFsReader, runSdkPinGate, type SdkPinConfig } from '@goodvibes-jev/engine/toolchain';

export const SDK_PACKAGE = '@goodvibes-jev/engine/sdk';
export const OVERLAY_MARKER_REL = 'node_modules/@goodvibes-jev/engine/sdk/.local-sdk-overlay.json';

/**
 * The Agent's sdk-pin shape. Kept inline (rather than read from
 * toolchain.config.json) so the pure gate stays drivable against the temp-dir
 * fixtures in sdk-release-gates.test.ts, which never write a config file.
 */
export const AGENT_SDK_PIN: SdkPinConfig = {
  sdkPackage: SDK_PACKAGE,
  pinSource: 'devDependencies',
  lockfile: 'bun.lock',
  overlayMarker: OVERLAY_MARKER_REL,
  sourceRoots: ['src'],
  enforceExportsMap: false,
};

/** Gate ids that concern pin ⇄ lockfile ⇄ installed agreement (not the import sweep). */
const PIN_AGREEMENT_GATE_IDS = new Set([
  'local-sdk-overlay-absent',
  'sdk-pin-exact-semver',
  'installed-matches-pin',
  'lockfile-resolves-pin',
]);

/** Read the SDK pin from the Agent's devDependencies (then dependencies). */
export function readSdkPin(root: string = process.cwd()): string | undefined {
  const group = AGENT_SDK_PIN.pinSource;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const pin = group === 'devDependencies'
    ? pkg.devDependencies?.[SDK_PACKAGE] ?? pkg.dependencies?.[SDK_PACKAGE]
    : pkg.dependencies?.[SDK_PACKAGE] ?? pkg.devDependencies?.[SDK_PACKAGE];
  return pin;
}

/** Overlay-marker + exact-pin + pin/lock/installed agreement (the non-import gates). */
export function sdkPinAgreementIssues(root: string = process.cwd()): string[] {
  return runSdkPinGate(realFsReader(root), AGENT_SDK_PIN)
    .filter((result) => !result.ok && PIN_AGREEMENT_GATE_IDS.has(result.id))
    .map((result) => result.detail);
}

/** Every SDK release-gate issue combined, for a single publish-check call site. */
export function sdkReleaseGateIssues(root: string = process.cwd()): string[] {
  return runSdkPinGate(realFsReader(root), AGENT_SDK_PIN)
    .filter((result) => !result.ok)
    .map((result) =>
      result.id === 'npm-specifier-only-imports'
        ? `non-npm goodvibes-sdk import found in source: ${result.detail}`
        : result.detail,
    );
}

if (import.meta.main) {
  const root = process.cwd();
  const issues = sdkReleaseGateIssues(root);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`sdk-release-gate: ${issue}`);
    process.exit(1);
  }
  console.log('sdk-release-gate: pin/lock/installed agree, overlay absent, all SDK imports are npm-specifier.');
}
