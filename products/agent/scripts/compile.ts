#!/usr/bin/env bun
import { compileBunBinary } from '@goodvibes-jev/engine/toolchain';

export { compileBunBinary as compileAgent, parseBunCompileArgs as parseCompileArgs } from '@goodvibes-jev/engine/toolchain';

if (import.meta.main) {
  try { await compileBunBinary(process.cwd(), process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
