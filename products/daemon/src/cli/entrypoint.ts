#!/usr/bin/env bun
import { runDaemonCli } from './run.js';
import { createProductionDaemonRuntime } from './production-runtime.js';

process.exitCode = await runDaemonCli(process.argv.slice(2), { runtime: createProductionDaemonRuntime() });
