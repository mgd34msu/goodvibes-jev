import { nativeConversationIntakeLines } from '../../runtime/native-conversation-intake.ts';
import { nativeWorkSubmissionLines } from '../../runtime/native-work-submission.ts';
import { nativeWorkExecutionLines } from '../../runtime/native-work-execution.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { AGENT_WORKSPACE_CATEGORY_IDS } from '../agent-workspace-types.ts';

const AGENT_WORKSPACE_ARGS_HINT = `${AGENT_WORKSPACE_CATEGORY_IDS.join('|')}|connected-host`;

export function registerAgentWorkspaceRuntimeCommands(registry: CommandRegistry): void {
  function openAgentWorkspace(ctx: CommandContext, categoryId: string | undefined): void {
    if (!ctx.openAgentWorkspace) {
      ctx.print('Agent operator workspace is not available in this runtime.');
      return;
    }
    ctx.openAgentWorkspace(categoryId);
  }

  registry.register({
    name: 'work',
    description: 'Inspect native work, recover ordinary input, or explicitly start, cancel or resume an existing attempt',
    usage: '[daemon-project-id] | start|status|cancel|resume <work-id> | submit-file <JSON-path> | submission-status | submission-retry | intake-status | intake-retry | intake-resume | intake-cancel',
    async handler(args, ctx) {
      const action = args[0];
      if (action === 'intake-status' || action === 'intake-retry' || action === 'intake-resume' || action === 'intake-cancel') {
        if (args.length !== 1) { ctx.print('Usage: /work intake-status | intake-retry | intake-resume | intake-cancel'); return; }
        const intake = ctx.nativeConversationIntake;
        if (!intake) { ctx.print('Native conversation intake is unavailable in this shell.'); return; }
        const result = await (action === 'intake-status' ? intake.status() : action === 'intake-retry' ? intake.retry() : action === 'intake-resume' ? intake.resume() : intake.cancel());
        ctx.print(nativeConversationIntakeLines(result).join('\n'));
        if (result?.turnReady) await ctx.dispatchNativeIntakeTurn?.(result);
        return;
      }
      if (action === 'submit-file' || action === 'submission-status' || action === 'submission-retry') {
        if (args.length !== (action === 'submit-file' ? 2 : 1)) { ctx.print('Usage: /work submit-file <JSON-path> | submission-status | submission-retry'); return; }
        const view = ctx.nativeWorkLedger;
        if (!view?.submitFile || !view.submissionStatus || !view.retrySubmission) { ctx.print('Native source submission is unavailable in this shell.'); return; }
        const result = action === 'submit-file' ? await view.submitFile(args[1]!) : action === 'submission-status' ? await view.submissionStatus() : await view.retrySubmission();
        ctx.print(nativeWorkSubmissionLines(result).map(line => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')).join('\n'));
        return;
      }
      if (action === 'start' || action === 'status' || action === 'cancel' || action === 'resume') {
        if (args.length !== 2) { ctx.print('Usage: /work start|status|cancel|resume <work-id>'); return; }
        if (!ctx.nativeWorkLedger?.execute) { ctx.print('Native execution controls are unavailable on this host.'); return; }
        const result = await ctx.nativeWorkLedger.execute(action, args[1]!);
        const state = ctx.nativeWorkLedger.state;
        const lines = result ? nativeWorkExecutionLines(result) : [state.status !== 'ready' ? state.reason : 'No new native execution result. A request may already be pending or this action was superseded.'];
        ctx.print((lines.length ? lines : ['No native execution binding is available.']).map(line => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')).join('\n'));
        return;
      }
      if (args.length > 1) { ctx.print('Usage: /work [daemon-project-id] | start|status|cancel|resume <work-id>'); return; }
      if (args[0]) ctx.nativeWorkLedger?.selectProject(args[0]);
      openAgentWorkspace(ctx, 'work');
    },
  });
  registry.register({
    name: 'agent',
    aliases: ['home', 'operator'],
    description: 'Open the GoodVibes Agent operator workspace',
    usage: '[category]',
    argsHint: AGENT_WORKSPACE_ARGS_HINT,
    handler(args, ctx) {
      openAgentWorkspace(ctx, args[0]);
    },
  });
  registry.register({
    name: 'notes',
    aliases: ['scratchpad'],
    description: 'Open Agent-local scratchpad notes in the operator workspace',
    usage: '',
    handler(_args, ctx) {
      openAgentWorkspace(ctx, 'notes');
    },
  });
}
