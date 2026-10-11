/** Explicit native-priority launch of a complete owned installation, never a bare executable. */
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { assertNativeInstallHost, inspectInstallation, targetPaths, validateOwner, type DaemonInstallOwner } from './native-installation.ts';

export function assertNativeInstallationIdle(prefix: string): void {
  for (const target of targetPaths(prefix)) for (const suffix of ['.update-transaction', '.update-download', '.update-previous', '.rollback-exchange']) {
    try { lstatSync(target.path + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error('Native installation has an active transaction or retained recovery files; inspect them before launch');
  }
}

export function verifiedDaemonNativePath(prefix: string, expected: string | DaemonInstallOwner): string {
  assertNativeInstallHost(); assertNativeInstallationIdle(prefix);
  const receipt = inspectInstallation(prefix, '');
  if (!receipt) throw new Error('No owned native installation is available; explicitly acquire a qualified CI cohort first');
  if (typeof expected === 'string') {
    if (receipt.version !== expected) throw new Error('Native installation version differs from this daemon package');
  } else {
    validateOwner(expected);
    if (receipt.artifact.target !== expected.target) throw new Error('Native installation differs from the requested target');
    for (const key of ['sourceCommit', 'sourceTree', 'headCommit'] as const) if (receipt.artifact[key] !== expected[key]) throw new Error('Native installation differs from the requested source identity');
    if (receipt.version !== expected.version) throw new Error('Native installation differs from the requested product version');
  }
  assertNativeInstallationIdle(prefix);
  return join(prefix, targetPaths(prefix)[0]!.label);
}

/** Termination signals reach the child; the launcher waits for its exit instead of detaching it. */
export async function runVerifiedDaemonNative(prefix: string, expected: string | DaemonInstallOwner, args: readonly string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const command = verifiedDaemonNativePath(prefix, expected);
  const env = { ...process.env }; delete env.GOODVIBES_DAEMON_NATIVE_PREFIX;
  const child = spawn(command, [...args], { stdio: 'inherit', env });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  const listeners = signals.map(signal => { const handler = () => { child.kill(signal); }; process.on(signal, handler); return { signal, handler }; });
  const onParentExit = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  process.on('exit', onParentExit);
  try {
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  } finally {
    process.off('exit', onParentExit);
    for (const { signal, handler } of listeners) process.off(signal, handler);
  }
}

export function finishDaemonNativeLaunch(result: { code: number | null; signal: NodeJS.Signals | null }): void {
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
