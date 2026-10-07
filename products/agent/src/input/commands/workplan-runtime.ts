import type { WorkPlanItemStatus } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { createAgentWorkPlanTool, type AgentWorkPlanToolArgs } from '../../tools/agent-work-plan-tool.ts';
import type { CommandRegistry } from '../command-registry.ts';

const LOCAL_STATUS: Readonly<Record<string, WorkPlanItemStatus>> = {
  pending: 'pending', start: 'in_progress', blocked: 'blocked', done: 'done', failed: 'failed', cancelled: 'cancelled',
};
const USAGE = '/workplan show|markdown|add <title> [--owner <label>] [--source <label>] [--notes <text>] | pending|start|blocked|done|failed|cancelled <id> | remove <id> --yes | clear-completed --yes | submit-file <JSON-path> | submission-status | submission-retry';
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');

/** Local todos never become authority. Native source submission remains on the existing owner/journal route. */
export function registerWorkPlanRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workplan',
    description: 'Manage local non-executing todos, or explicitly submit original source to native work',
    usage: USAGE.replace('/workplan ', ''),
    async handler(args, ctx) {
      const action = args[0] ?? 'show';
      if (['submit-file', 'submission-status', 'submission-retry'].includes(action)) {
        // Share the exact host/principal/source/journal controls, including detached/unknown outcomes.
        await registry.execute('work', args, ctx);
        return;
      }
      const store = ctx.workspace?.workPlanStore;
      if (!store) { ctx.print('Local work plan is unavailable in this shell. Native owner work uses /work submit-file <JSON-path>.'); return; }
      let input: AgentWorkPlanToolArgs;
      if ((action === 'show' || action === 'list') && args.length <= 1) input = { action: 'list' };
      else if (action === 'markdown' && args.length === 1) {
        ctx.print('Local todos only; local done is not native verified completion.');
        ctx.print(store.toMarkdown().split('\n').map(clean).join('\n'));
        return;
      } else if (action === 'add' && args[1]?.trim()) {
        const fields: Record<string, string> = {};
        for (let i = 2; i < args.length; i += 2) {
          const key = args[i]!;
          if (!['--owner', '--source', '--notes'].includes(key) || args[i + 1] === undefined || key in fields) {
            ctx.print(`Usage: ${USAGE}`); return;
          }
          fields[key] = args[i + 1]!;
        }
        input = { action: 'create', title: args[1], owner: fields['--owner'] || 'owner', source: fields['--source'] || 'manual', notes: fields['--notes'] };
      } else if (Object.hasOwn(LOCAL_STATUS, action) && args.length === 2) {
        input = { action: 'set_status', id: args[1], status: LOCAL_STATUS[action] };
      } else if (action === 'remove' && args.length === 3 && args[2] === '--yes') {
        input = { action: 'remove', id: args[1], confirm: true, explicitUserRequest: 'Remove this local todo via /workplan remove --yes.' };
      } else if (action === 'clear-completed' && args.length === 2 && args[1] === '--yes') {
        input = { action: 'clear_completed', confirm: true, explicitUserRequest: 'Clear completed local todos via /workplan clear-completed --yes.' };
      } else { ctx.print(`Usage: ${USAGE}`); return; }
      const result = await createAgentWorkPlanTool(store).execute({ ...input });
      ctx.print((result.output ?? result.error ?? 'No local work-plan result.').split('\n').map(clean).join('\n'));
    },
  });
}
