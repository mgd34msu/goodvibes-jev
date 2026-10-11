import { assertContractInputAuthority } from '../../contract/input-authority.js';
/** Retained captured jobs use the runtime's ProcessManager, never host spawn. */
import type { ProcessManager } from '../shared/process-manager.js';
import type { ExecCommandInput, ExecCommandResult } from './schema.js';
import { runCapturedCommand, type CapturedExecAuthority, type CapturedExecutionLease } from './captured-exec.js';

export async function startCapturedBackground(
  manager: ProcessManager,
  binding: CapturedExecAuthority,
  command: string,
  input: ExecCommandInput,
  workingDirectory: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  network: 'enabled' | 'disabled',
  environment: Readonly<Record<string, string>>,
  beforeSpawn?: () => void,
  beforePublish?: () => void,
): Promise<ExecCommandResult> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let lease: CapturedExecutionLease | undefined;
  let result: ExecCommandResult | undefined;
  let resolveStarted!: (started: { pid: number }) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<{ pid: number }>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  // A failed admission is observed by trackOwnedBoundary; suppress only the
  // transient unhandled-rejection window before that owner subscribes.
  void started.catch(() => {});
  const commandInput = input.background ? { ...input, background: false, until: undefined } : { ...input, background: false };
  const completion = runCapturedCommand(binding, command, commandInput, workingDirectory, timeoutMs,
    combined, network, environment, { beforeSpawn, beforePublish, onStarted: (active) => { lease = active; if (!commandInput.until) resolveStarted({ pid: active.pid }); },
      onUntilMatched: () => { if (lease) resolveStarted({ pid: lease.pid }); } })
    .then((completed) => {
      result = completed;
      return completed;
    }, (error: unknown) => {
      rejectStarted(error instanceof Error ? error : new Error('Captured execution failed before readiness'));
      throw error;
    });
  const readOutput = async (): Promise<ExecCommandResult> => {
    await Promise.race([started, completion]);
    if (result && (!lease || result.denied || result.cancelled || result.timed_out)) {
      await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
      return result;
    }
    const current = await lease!.readOutput();
    return result ?? current;
  };
  const stop = async (): Promise<void> => { controller.abort(); await completion; };
  const adopted = await manager.trackOwnedBoundary({ owner: binding.authority, cmd: command, includeReadyOutput: Boolean(input.until && !input.background), started, completion, readOutput, stop });
  if (!adopted.success) return adopted;
  return { ...adopted,
    sandboxed: true, sandbox_boundary: 'captured authorized projection retained by its runtime owner', sandbox_network: network,
    sandbox_note: 'Background file changes are published to the captured view after completion and current-authority/conflict checks.' };

}
