import { types as nodeTypes } from 'node:util';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError, type ToolInputProjector, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createPersonalOpsInputProjector } from './agent-personal-ops-ingress.ts';

/** Reuse the complete-input screening lease before generic registry readers. */
export function createProcessInputProjector(registry: ToolRegistry, tool: 'terminal' | 'process' | 'agent_harness', fallback?: ToolInputProjector): ToolInputProjector {
  return createPersonalOpsInputProjector(registry, fallback, (raw) => {
    if (nodeTypes.isProxy(raw)) throw new ToolInputProjectionError('held');
    if (tool === 'agent_harness') {
      const mode = Object.getOwnPropertyDescriptor(raw, 'mode');
      if (mode && !('value' in mode)) throw new ToolInputProjectionError('held');
      if (mode?.value !== 'run_background_process') return false;
    }
    const args = snapshotJudgmentInput(raw) as Record<string, unknown>;
    // Protect any supplied command even on a route that will reject/ignore it.
    if (tool === 'terminal' || typeof args.command === 'string' && args.command.trim()) return true;
    const fields = args.fields && typeof args.fields === 'object' ? args.fields as Record<string, unknown> : {};
    if (typeof fields.command === 'string' && fields.command.trim()) return true;
    return [args.action, args.processAction, fields.action].some(value => typeof value === 'string' && ['start', 'spawn', 'run'].includes(value.trim().toLowerCase()));
  });
}
