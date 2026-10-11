#!/usr/bin/env bun
import { initializeDaemonNativeSqlite } from './native-sqlite-runtime.js';

initializeDaemonNativeSqlite();
// Service imports occur only after the compiled Darwin database owner is selected.
const { runDaemonCli } = await import('./run.js');
const { createProductionDaemonRuntime } = await import('./production-runtime.js');

process.exitCode = await runDaemonCli(process.argv.slice(2), { runtime: createProductionDaemonRuntime() });
