#!/usr/bin/env bun
/** Explicit first-run acquisition and native priority, selected by immutable CI/source identity. */
import { resolve } from 'node:path';
import { acquireDaemonNative } from './acquire-native.ts';
import { readDaemonInstallOwner } from './install-native.ts';
import { inspectInstallation } from '../src/cli/native-installation.ts';
import { assertNativeInstallationIdle, finishDaemonNativeLaunch, runVerifiedDaemonNative, verifiedDaemonNativePath } from '../src/cli/native-launch.ts';
import { UpdateTransactionError } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';

if (import.meta.main) {
  try {
    const args = process.argv.slice(2); const separator = args.indexOf('--');
    if (separator !== 8) throw new Error('Usage: native:run --run-id ID --prefix ABSOLUTE_PATH --source-commit SHA --head-commit SHA -- [daemon args]');
    const values = new Map<string, string>();
    for (let i = 0; i < separator; i += 2) {
      const key = args[i]!; const value = args[i + 1];
      if (!['--run-id', '--prefix', '--source-commit', '--head-commit'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('Expected one exact CI run, prefix, source commit and head commit');
      values.set(key, value);
    }
    if (!/^[1-9]\d*$/.test(values.get('--run-id')!) || !Number.isSafeInteger(Number(values.get('--run-id')))) throw new Error('Expected an exact positive CI run ID');
    const owner = readDaemonInstallOwner(resolve(import.meta.dir, '../../..'), values.get('--source-commit')!, values.get('--head-commit')!);
    const prefix = values.get('--prefix')!;
    // Only an absent cohort is eligible for first-run repair. Corrupt, unowned,
    // stale or fenced installations refuse instead of silently replacing state.
    assertNativeInstallationIdle(prefix);
    if (!inspectInstallation(prefix, '')) await acquireDaemonNative({ runId: values.get('--run-id')!, prefix, owner });
    verifiedDaemonNativePath(prefix, owner);
    finishDaemonNativeLaunch(await runVerifiedDaemonNative(prefix, owner, args.slice(separator + 1)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UpdateTransactionError && error.receipt.recoveryRequired) console.error(JSON.stringify(error.receipt));
    process.exitCode = 1;
  }
}
