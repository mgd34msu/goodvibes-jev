import { DEFAULT_CONFIG, type PermissionMode, type PermissionsToolConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool, ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';

/** Real manager/registry admission; callers install recorded synthetic readings. */
export function recordedEffectFixture(tool: Tool, initialMode: PermissionMode = 'prompt', tools: PermissionsToolConfig = {}, directory = '/synthetic/effect-fixture') {
  let mode = initialMode, sequence = 0;
  let onAuthorityRead: (() => void) | undefined;
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode, tools });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => { onAuthorityRead?.(); return { permissions: permissions(), autoApprove: false, directory }; },
    getSnapshot: () => ({ permissions: permissions() }),
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager); registry.register(tool);
  return {
    registry,
    setMode(next: PermissionMode) { mode = next; },
    beforeAuthorityRead(callback: () => void) { onAuthorityRead = callback; },
    async run(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
      const id = `recorded-effect-${++sequence}`;
      const call = await registry.prepareCall(id, tool.definition.name, args, { signal });
      const admission = await manager.admitAutonomous(id, tool.definition.name, call.args, {
        sourceOf: () => ({ goal: 'Verify intercepted product effect boundaries with synthetic sources',
          criteria: ['Use isolated temporary files and intercepted effects only'] }),
        signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      if (!admission.result.approved) return { callId: id, success: false, error: admission.result.reasonCode };
      return registry.executePrepared(call, admission);
    },
  };
}
