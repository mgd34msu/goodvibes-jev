#!/usr/bin/env bun
/**
 * goodvibes-contract, the contract runner's command line
 * (docs/design/contract-runner.md 10.1). The commands and exit codes are
 * `runContractCli`'s (platform/contract/cli.ts); this file is the process's
 * side of them:
 *
 * - stdout, stderr, the terminal's line reader and SIGINT;
 * - `readContracts`: the contract files under the project, read with the
 *   ContractStore without running anything;
 * - `openRunner`: claims the project's contract runs for this process
 *   (`<project>/.goodvibes/contract-cli/owner.json`, so a second process does
 *   not resume and run the same contracts from disk), then boots the client
 *   composition, which composes the contract runner, installs the judgment
 *   port (settings plus the decision log, runtime/judgment-services.ts) and
 *   resumes the contracts on disk. It also hosts the conversation sessions a
 *   session-mode contract's unit is worked in (design 6.6).
 *
 * Bun runs it: the decision log is a bun:sqlite database.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { CONVERSATIONAL_DIAGNOSIS_SECTION } from '../platform/agents/conversational-contract.js';
import { ConfigManager } from '../platform/config/manager.js';
import { runContractCli, type ContractCliIo, type ContractSessionDriver, type OpenedContractRunner } from '../platform/contract/cli.js';
import { ContractStore } from '../platform/contract/store.js';
import type { ContractView } from '../platform/contract/types.js';
import { createHostedSessionRuntime, type HostedSessionRuntime } from '../platform/hosted-sessions/session-runtime.js';
import type { HostedWorkspaceFloor } from '../platform/hosted-sessions/workspace-floor.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../platform/permissions/prompt.js';
import { createClientRuntimeServices } from '../platform/runtime/client-services.js';
import { resumeContracts } from '../platform/runtime/contract-composition.js';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '../platform/runtime/events/index.js';
import { claimSurfaceHome } from '../platform/runtime/home-single-writer.js';
import { GlobalNetworkTransportInstaller } from '../platform/runtime/network/index.js';
import { createRuntimeStore } from '../platform/runtime/store/index.js';
import { summarizeError } from '../platform/utils/error-display.js';
import { configureActivityLogger, flushActivityLogSync } from '../platform/utils/logger.js';

/** The surface root the CLI's claim on a project lives under. */
const CLAIM_SURFACE_ROOT = 'contract-cli';
/** The surface whose settings, state and decision log the CLI's composition uses: the same as every other GoodVibes surface over the project. */
const SURFACE_ROOT = 'goodvibes';

interface ProcessIo extends ContractCliIo {
  close(): void;
}

/** stdout and stderr lines, a line reader over stdin, and SIGINT (from the process, or from the reader while it holds the terminal). */
function createProcessIo(): ProcessIo {
  const lines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  const interruptHandlers = new Set<() => void>();
  let reader: Interface | null = null;
  let ended = false;
  const fireInterrupt = (): void => {
    for (const handler of [...interruptHandlers]) handler();
  };
  process.on('SIGINT', fireInterrupt);

  function openReader(): void {
    if (reader !== null || ended) return;
    reader = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    reader.on('line', (line) => {
      const waiter = waiters.shift();
      if (waiter === undefined) lines.push(line);
      else waiter(line);
    });
    reader.on('close', () => {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    });
    reader.on('SIGINT', fireInterrupt);
  }

  return {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    isTTY: process.stdin.isTTY === true,
    readLine(prompt) {
      openReader();
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (ended) return Promise.resolve(null);
      process.stderr.write(prompt);
      return new Promise((resolveLine) => { waiters.push(resolveLine); });
    },
    onInterrupt(handler) {
      interruptHandlers.add(handler);
      return () => { interruptHandlers.delete(handler); };
    },
    close() {
      process.off('SIGINT', fireInterrupt);
      reader?.close();
    },
  };
}

/** The contracts stored under the project. Refused files are quarantined by the store, as at every load. */
function readContracts(projectRoot: string): ContractView[] {
  const store = new ContractStore({ projectRoot, sweepIntervalMs: 0 });
  return store.listStoredIds().flatMap((id) => {
    const contract = store.load(id);
    return contract === null ? [] : [contract];
  });
}

/**
 * A permission ask from the work this process runs. At a terminal the person
 * answers yes or no; without one nobody can, so the ask is refused and the
 * refusal said on stderr.
 */
function approvalThroughTerminal(io: ContractCliIo) {
  return async (input: { readonly request: PermissionPromptRequest }): Promise<PermissionPromptDecision> => {
    const { request } = input;
    const what = `${request.tool}: ${request.analysis.summary}`;
    if (!io.isTTY) {
      io.err(`Refused ${what} (no terminal to ask for permission).`);
      return { approved: false };
    }
    io.err(`Permission asked (${request.analysis.riskLevel} risk) for ${what}`);
    const answer = await io.readLine('Allow? [y/N] ');
    // The prompt states its format: y or yes allows, anything else (and the end of input) refuses.
    const approved = answer !== null && ['y', 'yes'].includes(answer.trim().toLowerCase());
    if (!approved) io.err(`Refused ${what}.`);
    return { approved };
  };
}

function cliSystemPrompt(projectRoot: string): string {
  return [
    [
      'You are running as a GoodVibes session hosted by the goodvibes-contract command line.',
      `Your working directory is ${projectRoot}.`,
      'The person who ran the command asked for this work in their own project; the contract\'s checks read your work as you go and tell you what is still missing.',
    ].join(' '),
    CONVERSATIONAL_DIAGNOSIS_SECTION,
  ].join('\n\n');
}

/** The conversation sessions a session-mode contract's unit is worked in, one per contract session id, made on first use. */
function createSessionDriver(floor: HostedWorkspaceFloor, projectRoot: string): ContractSessionDriver & { dispose(): void } {
  const sessions = new Map<string, HostedSessionRuntime>();
  function sessionFor(sessionId: string): HostedSessionRuntime {
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = createHostedSessionRuntime({
        sessionId,
        workspaceRoot: projectRoot,
        floor,
        systemPrompt: cliSystemPrompt(projectRoot),
        // The person running the command authorized this work in their own project.
        execPosture: 'workstream',
      });
      sessions.set(sessionId, session);
    }
    return session;
  }
  return {
    isRunning: (sessionId) => sessions.get(sessionId)?.isRunning() ?? false,
    submit: (sessionId, text) => sessionFor(sessionId).submit(text),
    cancelAll: () => {
      for (const session of sessions.values()) session.cancel();
    },
    dispose: () => {
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
    },
  };
}

/** Claims the project's contract runs, then boots the client composition over the project. */
async function openRunner(projectRoot: string, io: ContractCliIo): Promise<OpenedContractRunner> {
  // Throws SurfaceHomeInUseError, whose message names the holding process.
  const claim = claimSurfaceHome({ homeDirectory: projectRoot, surfaceRoot: CLAIM_SURFACE_ROOT });
  try {
    configureActivityLogger(join(projectRoot, '.goodvibes', 'logs'));
    const homeDirectory = homedir();
    const configManager = new ConfigManager({ workingDir: projectRoot, homeDir: homeDirectory, surfaceRoot: SURFACE_ROOT });
    new GlobalNetworkTransportInstaller().install(configManager);
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => configManager.get(key)));
    const services = createClientRuntimeServices({
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      configManager,
      surfaceRoot: SURFACE_ROOT,
      workingDir: projectRoot,
      homeDirectory,
      requestApproval: approvalThroughTerminal(io),
      // The runner routes every unit over the provider catalog, so discovered models must be in it.
      modelDiscovery: 'run',
      // This process's claim is the project's contract-cli claim above, not the surface home.
      homeSingleWriter: 'off',
    });
    const floor: HostedWorkspaceFloor = { services, contractRunner: services.contractRunner, dispose: () => {} };
    const sessions = createSessionDriver(floor, projectRoot);
    return {
      runner: services.contractRunner,
      // The same promise the composition started at boot (once per root in the process).
      resumed: () => resumeContracts(services.contractRunner, projectRoot),
      sessions,
      dispose: async () => {
        sessions.dispose();
        services.dispose();
        claim.release();
      },
    };
  } catch (error) {
    claim.release();
    throw error;
  }
}

async function main(): Promise<number> {
  const io = createProcessIo();
  try {
    return await runContractCli(process.argv.slice(2), io, {
      cwd: process.cwd(),
      readContracts,
      openRunner: (projectRoot) => openRunner(projectRoot, io),
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
