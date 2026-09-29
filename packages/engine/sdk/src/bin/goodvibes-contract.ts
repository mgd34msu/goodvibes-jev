#!/usr/bin/env bun
/**
 * goodvibes-contract, the contract runner's command line
 * (docs/design/contract-runner.md 10.1). The commands and exit codes are
 * `runContractCli`'s (platform/contract/cli.ts); the process's side of them
 * (streams, SIGINT, the contract files on disk, and the live runner over the
 * client composition) is contract-cli-host.ts.
 *
 * Bun runs it: the decision log is a bun:sqlite database.
 */
import { runContractCli } from '../platform/contract/cli.js';
import { summarizeError } from '../platform/utils/error-display.js';
import { flushActivityLogSync } from '../platform/utils/logger.js';
import { createProcessIo, openContractRunner, readContracts } from './contract-cli-host.js';

async function main(): Promise<number> {
  const io = createProcessIo();
  try {
    return await runContractCli(process.argv.slice(2), io, {
      cwd: process.cwd(),
      readContracts,
      openRunner: (projectRoot) => openContractRunner(projectRoot, io),
    });
  } catch (error) {
    io.err(`goodvibes-contract: ${summarizeError(error)}`);
    return 1;
  } finally {
    io.close();
    flushActivityLogSync();
  }
}

process.exit(await main());
