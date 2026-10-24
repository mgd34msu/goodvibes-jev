import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { resolveProcessCapturedBunRuntimeExecutable } from '../../runtime/captured-bun-runtime.js';
import type { ExecSandboxPlan } from './sandbox.js';

export const SANDBOX_RUNTIME_BIN = '/run/goodvibes-runtime/bin';

/** Only native executables from the host's trusted startup configuration.
 * Shell shims can depend on private home configuration and are not projected. */
function nativeExecutable(path: string): string | undefined {
  let fd: number | undefined;
  try {
    const actual = realpathSync(path);
    if (!statSync(actual).isFile()) return undefined;
    accessSync(actual, constants.X_OK);
    fd = openSync(actual, 'r');
    const magic = Buffer.alloc(4);
    if (readSync(fd, magic, 0, 4, 0) !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return undefined;
    return actual;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function trustedExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(directory)) continue;
    const executable = nativeExecutable(join(directory, name));
    if (executable) return executable;
  }
  return undefined;
}

function npmPackage(node: string): string | undefined {
  const candidates = [join(dirname(node), '..', 'lib', 'node_modules', 'npm'),
    ...(process.env.PATH ?? '').split(':').filter(isAbsolute).flatMap(directory => {
      try {
        const entry = realpathSync(join(directory, 'npm'));
        return entry.endsWith('/bin/npm-cli.js') ? [dirname(dirname(entry))] : [];
      } catch { return []; }
    })];
  for (const candidate of candidates) {
    try {
      const npm = realpathSync(candidate);
      const manifest = JSON.parse(readFileSync(join(npm, 'package.json'), 'utf8')) as { name?: unknown };
      if (statSync(npm).isDirectory() && manifest.name === 'npm'
        && statSync(join(npm, 'bin', 'npm-cli.js')).isFile()) return npm;
    } catch { /* An installation may ship its native Node executable alone. */ }
  }
  return undefined;
}

/** Ordinary execution keeps home and service directories hidden. Admit only
 * standalone interpreters, the selected npm package and Go distribution
 * components; never mount a PATH directory, a version manager or a user's home.
 * Captured execution retains its separate construction-owned runtime inputs. */
export function withSandboxRuntimes(plan: ExecSandboxPlan, workspace: string): ExecSandboxPlan {
  if (!plan.sandboxed) return plan;
  const root = resolve(workspace), runtimeRoot = dirname(SANDBOX_RUNTIME_BIN);
  if (root === runtimeRoot || root.startsWith(`${runtimeRoot}${sep}`) || runtimeRoot.startsWith(`${root}${sep}`)) return plan;
  const bun = typeof Bun !== 'undefined'
    ? nativeExecutable(resolveProcessCapturedBunRuntimeExecutable()) : trustedExecutable('bun');
  const node = typeof Bun === 'undefined' ? nativeExecutable(process.execPath) : trustedExecutable('node');
  const go = trustedExecutable('go');
  if (!bun && !node && !go) return plan;
  const mounts = ['--dir', runtimeRoot, '--dir', SANDBOX_RUNTIME_BIN];
  if (bun) mounts.push('--ro-bind', bun, `${SANDBOX_RUNTIME_BIN}/bun`);
  if (node) {
    mounts.push('--ro-bind', node, `${SANDBOX_RUNTIME_BIN}/node`);
    const npm = npmPackage(node);
    if (npm) {
      mounts.push('--ro-bind', npm, `${runtimeRoot}/npm`, '--symlink', '../npm/bin/npm-cli.js', `${SANDBOX_RUNTIME_BIN}/npm`);
      try {
        if (statSync(join(npm, 'bin', 'npx-cli.js')).isFile())
          mounts.push('--symlink', '../npm/bin/npx-cli.js', `${SANDBOX_RUNTIME_BIN}/npx`);
      } catch { /* npm remains available when this installation omits npx. */ }
    }
  }
  if (go) {
    const goroot = dirname(dirname(go));
    // The compiler needs its standard-library sources and native toolchain,
    // not the surrounding version manager, shell configuration or credentials.
    try {
      if (statSync(join(goroot, 'src', 'runtime', 'runtime.go')).isFile()
        && statSync(join(goroot, 'pkg', 'tool')).isDirectory()) {
        for (const component of ['bin/go', 'bin/gofmt', 'pkg', 'src', 'lib', 'go.env', 'VERSION']) {
          const path = join(goroot, component);
          try { statSync(path); mounts.push('--ro-bind', path, path); } catch { /* Optional distribution component. */ }
        }
        mounts.push('--symlink', go, `${SANDBOX_RUNTIME_BIN}/go`);
        const gofmt = nativeExecutable(join(goroot, 'bin', 'gofmt'));
        if (gofmt) mounts.push('--symlink', gofmt, `${SANDBOX_RUNTIME_BIN}/gofmt`);
      }
    } catch { /* A standalone non-distribution executable is not a Go toolchain. */ }
  }
  return { ...plan, argvPrefix: [...plan.argvPrefix.slice(0, -1), ...mounts, '--'],
    boundary: `${plan.boundary}; installed language runtimes read-only` };
}
