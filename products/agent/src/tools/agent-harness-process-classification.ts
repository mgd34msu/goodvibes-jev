import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type SourceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Battery, YesNoItem } from '@goodvibes-jev/judgment';

export interface ProcessClassificationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

const BATTERY = 'agent.tools.long-lived-process';
const SITE = 'agent.tools.background-process.classification';

/** Keep the protected receipt alive through the last check and the actual spawn. */
export async function withLongLivedProcessReading<T>(
  command: string,
  options: ProcessClassificationOptions,
  consume: (longLived: boolean, assertCurrent: () => void) => T | Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const state = snapshotJudgmentInput({ command, platform: process.platform }) as { readonly command: string; readonly platform: string };
  if (typeof state.command !== 'string' || state.command.length > SOURCE_SCREENING_LIMITS.characters) throw new ToolInputProjectionError('held');
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('held');
  const handle = owner.capture([state.command]);
  let receipt: SourceScreeningReceipt | undefined;
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true; options.signal?.removeEventListener('abort', abort);
    releasing = owner.release(handle); return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  const assertSourceCurrent = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (released) throw new ToolInputProjectionError('held');
    if (receipt) owner.project(receipt);
    options.assertCurrent?.(); options.signal?.throwIfAborted();
  };
  try {
    options.signal?.addEventListener('abort', abort, { once: true });
    assertSourceCurrent();
    const screened = await owner.screen(handle);
    assertSourceCurrent();
    if (screened.status !== 'settled') throw new ToolInputProjectionError('held');
    receipt = screened.receipt;
    const projected = owner.project(receipt);
    if (projected.length !== 1 || typeof projected[0] !== 'string') throw new ToolInputProjectionError('held');
    // Neither a registry lookup nor a port/cache/log/transport is reached until
    // the complete source has a settled, current local screening projection.
    assertSourceCurrent();
    const decision = gateJudgmentRegistry.get(BATTERY);
    if (!decision || !('run' in decision) || typeof decision.run !== 'function') throw new ToolInputProjectionError('unavailable');
    const port = judgmentPort(SITE);
    const portModel = port.model, portAsk = port.ask, recorder = port.recorder;
    const assertCurrent = () => {
      assertSourceCurrent();
      if (judgmentPort(SITE) !== port || port.model !== portModel || port.ask !== portAsk
        || port.recorder !== recorder || gateJudgmentRegistry.get(BATTERY) !== decision) throw new ToolInputProjectionError('held');
    };
    const guardedPort: typeof port = { model: portModel, ...(recorder ? { recorder } : {}), ...(port.health ? { health: port.health } : {}), ask: async (request) => {
      assertCurrent();
      const result = await port.ask({ ...request,
        beforeAttempt: () => { request.beforeAttempt?.(); assertCurrent(); },
        assertLogCurrent: () => { request.assertLogCurrent?.(); assertCurrent(); },
      });
      assertCurrent(); return result;
    } };
    assertCurrent();
    const run = await (decision as Battery<{ readonly long_lived: YesNoItem }>).run(guardedPort,
      { command: projected[0], platform: state.platform }, { site: SITE, ...(options.signal ? { signal: options.signal } : {}) });
    assertCurrent();
    const reading = run.readings.long_lived;
    if (reading?.kind !== 'yes-no' || reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) {
      run.recordAction('process launch held: unsettled lifetime classification');
      throw new ToolInputProjectionError('held');
    }
    run.recordAction(reading.verdict === 'yes' ? 'classified long_lived' : 'classified command');
    assertCurrent();
    return await consume(reading.verdict === 'yes', assertCurrent);
  } finally { await release(); }
}
