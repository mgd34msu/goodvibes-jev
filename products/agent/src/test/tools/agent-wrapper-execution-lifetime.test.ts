import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentAuditTool } from '../../tools/agent-audit-tool.ts';
import { registerAgentChannelsTool } from '../../tools/agent-channels-tool.ts';
import { registerAgentContextTool } from '../../tools/agent-context-tool.ts';
import { createAgentDeviceTool, registerAgentDeviceTool } from '../../tools/agent-device-tool.ts';
import { harnessCatalogExecutionGuard } from '../../tools/agent-harness-catalog-ingress.ts';
import { registerAgentSecurityTool } from '../../tools/agent-security-tool.ts';
import { registerAgentSessionsTool } from '../../tools/agent-sessions-tool.ts';
import { registerAgentSupportTool } from '../../tools/agent-support-tool.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function dispatchRefusalContext() {
  const dispatches: string[] = [];
  const dispatched = (service: string): never => {
    dispatches.push(service);
    throw new Error(`Retired wrapper reached ${service}`);
  };
  const context: CommandContext = {
    renderRequest: () => dispatched('render'),
    print: () => dispatched('print'),
    exit: () => dispatched('exit'),
    get session() { return dispatched('session'); },
    get provider() { return dispatched('provider'); },
    get workspace() { return dispatched('workspace'); },
    get platform() { return dispatched('platform'); },
    get ops() { return dispatched('ops'); },
    get extensions() { return dispatched('extensions'); },
    get clients() { return dispatched('clients'); },
  };
  return { context, dispatches };
}

function registered(registry: ToolRegistry, name: string): Tool {
  const tool = registry.list().find(candidate => candidate.definition.name === name);
  if (!tool) throw new Error(`Missing registered wrapper ${name}`);
  return tool;
}

interface WrapperControls {
  readonly name: string;
  readonly register: typeof registerAgentAuditTool;
  readonly invocations: readonly Record<string, unknown>[];
}

const wrappers: readonly WrapperControls[] = [
  {
    name: 'audit', register: registerAgentAuditTool,
    invocations: [{ action: 'readiness' }, { action: 'item', itemId: 'native-item' },
      { action: 'evidence' }, { action: 'artifact', artifactId: 'native-artifact' }],
  },
  {
    name: 'device', register: registerAgentDeviceTool,
    invocations: [{ action: 'status' }, { action: 'capability', capabilityId: 'native-capability' },
      { action: 'browser' }, { action: 'control' }, { action: 'voice' },
      { action: 'provider', providerId: 'native-provider' },
      { action: 'open_browser', confirm: true, explicitUserRequest: 'Open the synthetic browser.' },
      { action: 'open_tts_provider', confirm: true, explicitUserRequest: 'Open the synthetic provider picker.' },
      { action: 'open_tts_voice', providerId: 'native-provider', confirm: true,
        explicitUserRequest: 'Open the synthetic voice picker.' }],
  },
  {
    name: 'channels', register: registerAgentChannelsTool,
    invocations: [{ action: 'status' }, { action: 'channel', channelId: 'native-channel' },
      { action: 'setup', channelId: 'native-channel' }, { action: 'triage' }, { action: 'deliveries' }],
  },
  {
    name: 'context', register: registerAgentContextTool,
    invocations: [{ action: 'status' }, { action: 'prompt' }, { action: 'files' },
      { action: 'file', contextFileId: 'native-context' }, { action: 'receipts' },
      { action: 'receipt', receiptId: 'native-receipt' }],
  },
  { name: 'sessions', register: registerAgentSessionsTool,
    invocations: [{ action: 'list' }, { action: 'get', sessionId: 'native-session' }] },
  { name: 'support', register: registerAgentSupportTool,
    invocations: [{ action: 'status' }, { action: 'bundle', bundlePath: 'support/native.json' }] },
  { name: 'security', register: registerAgentSecurityTool,
    invocations: [{ action: 'status' }, { action: 'finding', findingId: 'native-finding' }] },
];

describe('registered Agent wrapper execution lifetimes', () => {
  for (const wrapper of wrappers) {
    for (const retirement of ['cancelled', 'caller-retired'] as const) {
      test(`${wrapper.name} keeps ${retirement} from reaching any harness dispatch branch`, async () => {
        for (const input of wrapper.invocations) {
          const { context, dispatches } = dispatchRefusalContext();
          const registry = new ToolRegistry();
          wrapper.register(registry, new CommandRegistry(), context);
          const tool = registered(registry, wrapper.name);
          const nativeExecute = tool.execute;
          const controller = new AbortController();
          const reason = retirement === 'cancelled'
            ? new Error('Synthetic wrapper caller cancelled') : new ToolInputProjectionError('stale');
          let entered = false, retired = false;
          let original: Record<string, unknown> | undefined;
          tool.execute = (args, options) => {
            entered = true; original = args;
            if (retirement === 'cancelled') controller.abort(reason);
            else retired = true;
            return nativeExecute(args, options);
          };
          const result = await registry.execute('native-wrapper-lifetime', wrapper.name, input, {
            signal: controller.signal,
            assertCurrent(effectiveArgs) {
              if (retired) {
                expect(effectiveArgs).toBe(original);
                throw reason;
              }
            },
          }).then(value => ({ kind: 'returned' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }));
          expect(entered).toBe(true);
          expect(dispatches).toEqual([]);
          if (result.kind !== 'rejected') throw new Error('Retired registered wrapper returned a result');
          expect(result.error).toMatchObject({ cause: reason });
        }
      });
    }
  }

  for (const retirement of ['live', 'cancelled', 'caller-retired'] as const) {
    test(`device keeps the same native options and original invocation during a pending ${retirement} effect`, async () => {
      const { context, dispatches } = dispatchRefusalContext();
      const registry = new ToolRegistry();
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const controller = new AbortController();
      const reason = retirement === 'cancelled'
        ? new Error('Synthetic pending effect cancelled') : new ToolInputProjectionError('stale');
      let retired = false, effects = 0;
      let original: Record<string, unknown> | undefined;
      let executionOptions: Parameters<Tool['execute']>[1];
      const harness: Tool = {
        definition: { name: 'agent_harness', description: 'Intercepted synthetic UI effect',
          parameters: { type: 'object', additionalProperties: true } },
        async execute(translated, options) {
          const assertCurrent = harnessCatalogExecutionGuard(translated, options);
          expect(options).toBe(executionOptions);
          expect(translated).toEqual({ mode: 'open_ui_surface', surfaceId: 'tts-provider-picker',
            confirm: true, explicitUserRequest: 'Open the synthetic provider picker.' });
          assertCurrent(); entered.resolve();
          await released.promise;
          assertCurrent(); effects++;
          return { success: true, output: 'Synthetic picker opened' };
        },
      };
      const tool = createAgentDeviceTool({ commandRegistry: new CommandRegistry(),
        commandContext: context, toolRegistry: registry, harnessTool: harness });
      const nativeExecute = tool.execute;
      tool.execute = (args, options) => {
        original = args; executionOptions = options;
        return nativeExecute(args, options);
      };
      registry.register(tool);
      const outcome = registry.execute('pending-native-wrapper', 'device', {
        action: 'open_tts_provider', confirm: true, explicitUserRequest: 'Open the synthetic provider picker.',
      }, { signal: controller.signal, assertCurrent(effectiveArgs) {
        if (original) expect(effectiveArgs).toBe(original);
        if (retired) throw reason;
      } }).then(value => ({ kind: 'returned' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }));
      try {
        const started = await Promise.race([entered.promise.then(() => true), outcome.then(() => false)]);
        if (!started) throw new Error('Pending native wrapper never reached the intercepted effect');
        if (retirement === 'cancelled') controller.abort(reason);
        if (retirement === 'caller-retired') retired = true;
        released.resolve();
        const result = await outcome;
        expect(dispatches).toEqual([]);
        expect(effects).toBe(retirement === 'live' ? 1 : 0);
        if (retirement === 'live') {
          if (result.kind !== 'returned') throw new Error('Live registered wrapper failed');
          expect(result.value.success).toBe(true);
        } else {
          if (result.kind !== 'rejected') throw new Error('Retired pending wrapper returned a result');
          expect(result.error).toMatchObject({ cause: reason });
        }
      } finally {
        released.resolve();
        await outcome;
      }
    });
  }
});
