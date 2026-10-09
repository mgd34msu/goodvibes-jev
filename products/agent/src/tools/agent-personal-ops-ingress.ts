import { types as nodeTypes } from 'node:util';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError, type ToolInputProjector, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';

const MODES = new Set(['personal_ops_queue', 'personal_ops_intake', 'personal_ops_lane', 'run_personal_ops_read']);
export function isPersonalOpsJudgmentMode(args: Record<string, unknown>): boolean {
  if (nodeTypes.isProxy(args)) throw new ToolInputProjectionError('held');
  const descriptor = Object.getOwnPropertyDescriptor(args, 'mode');
  if (descriptor && !('value' in descriptor)) throw new ToolInputProjectionError('held');
  return typeof descriptor?.value === 'string' && MODES.has(descriptor.value);
}

/** Protect invocation data before generic registry guards, repair readers, or logs. */
export function createPersonalOpsInputProjector(registry: ToolRegistry, fallback?: ToolInputProjector, selected = isPersonalOpsJudgmentMode): ToolInputProjector {
  return { async project(request) {
    // ToolRegistry supplies descriptor-safe captured data. Delegate unrelated
    // input to its original owner before applying any new privacy boundary.
    if (!selected(request.args)) {
      const result = fallback ? await fallback.project(request) : { status: 'projected' as const, args: request.args };
      if (result.status !== 'projected') return result;
      return { ...result, assertRepairedArgs(candidate) {
        if (selected(candidate)) throw new ToolInputProjectionError('held');
        result.assertRepairedArgs?.(candidate);
      } };
    }
    const args = snapshotJudgmentInput(request.args) as Record<string, unknown>;
    const owner = agentResearchSourceOwner(registry);
    if (!owner) return { status: 'held' };
    const serialized = JSON.stringify(args);
    if (serialized.length > SOURCE_SCREENING_LIMITS.characters) return { status: 'held' };
    request.assertCurrent(); request.signal?.throwIfAborted();
    const handle = owner.capture([serialized]);
    let released = false;
    let releasing: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (releasing) return releasing;
      released = true; request.signal?.removeEventListener('abort', abort);
      releasing = owner.release(handle); return releasing;
    };
    const abort = () => { void release().catch(() => {}); };
    const assertCurrent = () => {
      request.assertCurrent(); request.signal?.throwIfAborted();
      if (released || agentResearchSourceOwner(registry) !== owner) throw new ToolInputProjectionError('held');
    };
    try {
      request.signal?.addEventListener('abort', abort, { once: true });
      assertCurrent();
      const result = await owner.screen(handle);
      assertCurrent();
      if (result.status !== 'settled') { await release(); return { status: 'held' }; }
      const assertBound = () => {
        assertCurrent();
        const projected = owner.project(result.receipt);
        // Never silently rewrite an execution target, confirmation, or payload.
        // Protected invocation material remains held for its owning secure route.
        if (projected.length !== 1 || projected[0] !== serialized) throw new ToolInputProjectionError('held');
        assertCurrent();
      };
      assertBound();
      return { status: 'projected', args, assertCurrent: assertBound, release,
        assertRepairedArgs(candidate) {
          assertBound();
          if (JSON.stringify(snapshotJudgmentInput(candidate)) !== serialized) throw new ToolInputProjectionError('held');
        },
      };
    } catch (error) { await release(); throw error; }
  } };
}
