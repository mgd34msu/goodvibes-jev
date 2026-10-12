import type { CommandContext } from '../command-registry.ts';
import type { ScheduleReadingLifetime } from './schedule-reading-lifetime.ts';
import { assertJudgmentInput, retainStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';

export class CommandReadingHeldError extends Error {
  constructor() { super('Command reading is unavailable or retired.'); this.name = 'CommandReadingHeldError'; }
}

/** Retain original shell and effect owners before any semantic await. */
export function beginCommandReading(ctx: CommandContext, args: readonly string[], field: 'teamworkReading' | 'planningReading') {
  const original = retainStrictJudgmentJson(args);
  assertJudgmentInput(original.snapshot);
  const lifetime: ScheduleReadingLifetime | undefined = ctx[field];
  const submission = lifetime?.begin(field);
  if (!submission) throw new CommandReadingHeldError();
  try {
    const session = ctx.session, runtime = session.runtime, sessionId = runtime.sessionId;
    const workspace = ctx.workspace, paths = workspace.shellPaths, directory = paths?.workingDirectory;
    const clients = ctx.clients, ops = clients?.opsApi, tasks = ops?.tasks, create = tasks?.create;
    const intake = ctx.nativeConversationIntake, submit = intake?.submit, dispatch = ctx.dispatchNativeIntakeTurn;
    const platform = ctx.platform, config = platform.configManager, provider = ctx.provider, registry = provider.providerRegistry;
    const print = ctx.print, render = ctx.renderRequest;
    const assertCurrent = () => {
      submission.assertCurrent(); original.assertCurrent();
      if (ctx[field] !== lifetime || ctx.session !== session || session.runtime !== runtime || runtime.sessionId !== sessionId
        || ctx.workspace !== workspace || workspace.shellPaths !== paths || paths?.workingDirectory !== directory
        || ctx.clients !== clients || clients?.opsApi !== ops || ops?.tasks !== tasks || tasks?.create !== create
        || ctx.nativeConversationIntake !== intake || intake?.submit !== submit || ctx.dispatchNativeIntakeTurn !== dispatch
        || ctx.platform !== platform || platform.configManager !== config || ctx.provider !== provider || provider.providerRegistry !== registry
        || ctx.print !== print || ctx.renderRequest !== render) throw new CommandReadingHeldError();
    };
    assertCurrent();
    return Object.freeze({ signal: submission.signal, assertCurrent, finish: submission.finish });
  } catch (error) { submission.finish(); throw error; }
}
