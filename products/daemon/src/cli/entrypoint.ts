#!/usr/bin/env bun
import { runDaemonCli } from './run.js';

process.exitCode = await runDaemonCli(process.argv.slice(2));
