#!/usr/bin/env bun
import { compileBunBinary, parseBunCompileArgs } from '@goodvibes-jev/engine/toolchain';
import { buildDaemonSqliteRuntime } from './build-sqlite-runtime.ts';

if (import.meta.main) {
  try {
    const root = process.cwd(), args = process.argv.slice(2);
    const owner = await buildDaemonSqliteRuntime(root, parseBunCompileArgs(args).target);
    await compileBunBinary(root, args, { define: { __DAEMON_NATIVE_SQLITE_OWNER__: JSON.stringify(owner) } });
  } catch (error) { console.error(error); process.exitCode = 1; }
}
