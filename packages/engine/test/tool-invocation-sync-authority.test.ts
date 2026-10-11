import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, assertCurrentToolEffect } from '../sdk/src/platform/tools/registry.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/index.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';

const NAME = 'sync_authority_fixture';
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort([[NAME, READ_ONLY]]);
  const act = fakePort((_name, question) => choiceAnswer(question, 'act', 0.999));
  const port: JudgmentPort = { model: gate.port.model, ask(request) {
    return ('disposition' in request.questions ? act.port : gate.port).ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

test.each(['registered-projector', 'returned-projector', 'prepare-caller', 'admission-caller', 'execute-caller', 'sync-control'] as const)(
  '%s guard must finish synchronously before a recorded write body can run', async location => {
    const reader: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: DEFAULT_CONFIG.permissions, autoApprove: false,
        directory: '/synthetic/synchronous-authority', incarnation: 0 }),
      getSnapshot: () => ({ permissions: DEFAULT_CONFIG.permissions }),
      getWorkingDirectory: () => '/synthetic/synchronous-authority', isAutoApproveEnabled: () => false,
    };
    const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
    const registry = new ToolRegistry(manager);
    let effects = 0, guardStarts = 0;
    const unfinished = new Promise<void>(() => {});
    // TypeScript accepts async functions for () => void. An unfinished check
    // supplies no currentness evidence and must fail closed at this boundary.
    const assertCurrent = location === 'sync-control' ? () => { guardStarts++; }
      : async () => { guardStarts++; await unfinished; };
    registry.register({ definition: { name: NAME, description: 'An intercepted synthetic write.', parameters: {} },
      async execute(args, options) {
        if (!assertCurrentToolEffect(args, options, 'write')) return { success: false };
        effects++; return { success: true };
      } }, { inputProjection: {
        ...(location === 'registered-projector' ? { assertCurrent } : {}),
        async project(request) { return { status: 'projected', args: request.args,
          ...(location === 'returned-projector' ? { assertCurrent } : {}) }; },
      } });
    let refused = false;
    try {
      const call = await registry.prepareCall('sync-authority', NAME, {},
        location === 'prepare-caller' ? { assertCurrent } : undefined);
      const admission = await manager.admitAutonomous('sync-authority', NAME, call.args, {
        sourceOf: () => ({ goal: 'Perform the captured synthetic operation', criteria: [] }),
        schemaRevision: call.schemaRevision, preparedCall: { registry, call },
        ...(location === 'admission-caller' ? { assertPrepared: assertCurrent } : {}),
      });
      expect(admission.result.approved).toBe(true);
      await registry.executePrepared(call, admission,
        location === 'execute-caller' || location === 'sync-control' ? { assertCurrent } : undefined);
    } catch (error) { if (guardStarts === 0) throw error; refused = true; }
    expect(guardStarts).toBeGreaterThan(0);
    expect({ refused, effects }).toEqual(location === 'sync-control'
      ? { refused: false, effects: 1 } : { refused: true, effects: 0 });
  });
