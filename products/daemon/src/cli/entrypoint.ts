#!/usr/bin/env bun
import { initializeDaemonNativeSqlite } from './native-sqlite-runtime.js';

initializeDaemonNativeSqlite();
// Service imports occur only after the compiled Darwin database owner is selected.
const { runDaemonCli } = await import('./run.js');
const { resolveShippedServiceExecutable } = await import('./service-executable.js');

process.exitCode = await runDaemonCli(process.argv.slice(2), {
  createRuntime: async () => {
    const { createProductionDaemonRuntime } = await import('./production-runtime.js');
    return createProductionDaemonRuntime();
  },
  resolveServiceExecutable: resolveShippedServiceExecutable,
});
