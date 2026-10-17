import { expect, spyOn, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import * as contractRuntime from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { bootstrapRuntime, type BootstrapContext } from '../../runtime/bootstrap.ts';
import { makeHome, startStubModel } from '../e2e/harness.ts';

test('TUI bootstrap returns during contract recovery and shutdown stops then drains it', async () => {
  const model = startStubModel(() => ({ text: 'unused' }));
  const home = await makeHome(model);
  const configManager = new TuiConfigManager({ configDir: join(home.home, '.goodvibes/tui'), homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true }) as unknown as NodeJS.WriteStream;
  stdout.resume();
  let releaseRecovery!: () => void;
  const recovery = new Promise<void>(resolve => { releaseRecovery = resolve; });
  const resume = spyOn(contractRuntime, 'resumeContracts').mockImplementation(async () => {
    await recovery;
    return { resumed: [], queued: [], reaped: [], skipped: [] };
  });
  const boot = bootstrapRuntime(stdout, { configManager, workingDir: home.workspace, homeDirectory: home.home });
  let ctx: BootstrapContext | undefined;
  let restoreDispose: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    ctx = await Promise.race([boot, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Bootstrap waited for unfinished contract recovery')), 10_000);
    })]);
    clearTimeout(timeout);
    expect(resume).toHaveBeenCalledWith(ctx.services.contractRunner, home.workspace);
    expect(ctx.commandContext).toBeDefined();
    let stopped!: () => void;
    const stopping = new Promise<void>(resolve => { stopped = resolve; });
    const dispose = ctx.services.contractRunner.dispose;
    const spy = spyOn(ctx.services.contractRunner, 'dispose').mockImplementation(() => { dispose(); stopped(); });
    restoreDispose = () => spy.mockRestore();
    let finished = false;
    const closing = ctx.shutdown({ messages: [] }).then(() => { finished = true; });
    await stopping;
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseRecovery();
    await closing;
    expect(finished).toBe(true);
  } finally {
    clearTimeout(timeout);
    releaseRecovery();
    try {
      ctx ??= await boot;
      await ctx.shutdown({ messages: [] });
    }
    finally { restoreDispose?.(); resume.mockRestore(); stdout.destroy(); model.stop(); }
  }
}, 30_000);
