import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SharedSessionParticipant } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function hasAnyFlag(args: readonly string[], flags: readonly string[]): boolean {
  return flags.some((flag) => hasFlag(args, flag));
}

interface DelegationCommandInput {
  readonly task: string;
  readonly reviewRequested: boolean;
  readonly reason: string;
  readonly successCriteria: string;
  readonly workspaceHint: string;
  readonly priority: string;
}

function parseDelegationArgs(args: readonly string[], defaultReview: boolean): DelegationCommandInput {
  const taskValues: string[] = [];
  let reason = '';
  let successCriteria = '';
  let workspaceHint = '';
  let priority = '';
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--review' || token === '--wrfc') continue;
    if (token === '--reason') {
      reason = args[index + 1]?.trim() ?? '';
      index += 1;
      continue;
    }
    if (token === '--success' || token === '--success-criteria') {
      successCriteria = args[index + 1]?.trim() ?? '';
      index += 1;
      continue;
    }
    if (token === '--workspace' || token === '--worktree') {
      workspaceHint = args[index + 1]?.trim() ?? '';
      index += 1;
      continue;
    }
    if (token === '--priority') {
      priority = args[index + 1]?.trim() ?? '';
      index += 1;
      continue;
    }
    if (!token.startsWith('--')) {
      taskValues.push(token);
      continue;
    }
  }
  return {
    task: taskValues.join(' ').trim(),
    reviewRequested: defaultReview || hasAnyFlag(args, ['--review', '--wrfc']),
    reason,
    successCriteria,
    workspaceHint,
    priority,
  };
}

function buildDelegationBody(input: DelegationCommandInput): string {
  return [
    'GoodVibes Agent explicit build delegation.',
    '',
    'Original user ask',
    input.task,
    '',
    'Delegation reason',
    input.reason || '(not supplied)',
    '',
    'Success criteria or expected evidence',
    input.successCriteria || '(not supplied)',
    '',
    'Workspace or worktree hint',
    input.workspaceHint || '(not supplied)',
    '',
    'Priority or deadline',
    input.priority || '(not supplied)',
    '',
    'Agent policy',
    '- GoodVibes Agent is not the coding TUI.',
    '- Preserve the full original ask.',
    '- GoodVibes TUI owns file edits, git/worktree flows, execution isolation UX, and any delegated review owner chain.',
    input.reviewRequested
      ? '- Delegated review was explicitly requested by the Agent user for this build/fix/review handoff.'
      : '- Delegated review was not explicitly requested; do not add review solely because this came from Agent.',
  ].join('\n');
}

export function registerDelegationRuntimeCommands(registry: CommandRegistry): void {
  const makeHandler = () => async (args: string[], ctx: CommandContext): Promise<void> => {
    const input = parseDelegationArgs(args, false);
    if (!input.task) {
      ctx.print('Usage: /delegate [--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <build/fix/review task>');
      return;
    }
    const operator = ctx.clients?.operator;
    if (!operator) {
      ctx.print([
        'Delegation unavailable. No operator client is attached.',
        'Use the shared-session route from a configured Agent runtime, or open GoodVibes TUI in the target workspace.',
      ].join('\n'));
      return;
    }
    try {
      const participant = {
        surfaceKind: 'service',
        surfaceId: 'goodvibes-agent',
        externalId: ctx.session.runtime.sessionId,
        displayName: 'GoodVibes Agent',
        lastSeenAt: Date.now(),
      } satisfies SharedSessionParticipant;
      const session = await operator.sessions.ensureSession({
        title: `Agent delegation: ${input.task.slice(0, 72)}`,
        participant,
        metadata: {
          originSurface: 'goodvibes-agent',
          sourceSessionId: ctx.session.runtime.sessionId,
          task: input.task,
          reviewRequested: input.reviewRequested,
          wrfcRequested: input.reviewRequested,
          delegationReason: input.reason,
          successCriteria: input.successCriteria,
          workspaceHint: input.workspaceHint,
          priority: input.priority,
        },
      });
      await operator.sessions.submitMessage({
        sessionId: session.id,
        body: buildDelegationBody(input),
        surfaceKind: participant.surfaceKind,
        surfaceId: participant.surfaceId,
        externalId: participant.externalId,
        displayName: participant.displayName,
        title: `Agent delegation: ${input.task.slice(0, 72)}`,
        metadata: {
          originSurface: 'goodvibes-agent',
          sourceSessionId: ctx.session.runtime.sessionId,
          kind: 'task',
          task: input.task,
          reviewRequested: input.reviewRequested,
          wrfcRequested: input.reviewRequested,
          delegationReason: input.reason,
          successCriteria: input.successCriteria,
          workspaceHint: input.workspaceHint,
          priority: input.priority,
        },
        routing: {
          executionIntent: {
            riskClass: 'elevated',
            requiresApproval: true,
            networkPolicy: 'inherit',
            filesystemPolicy: 'workspace-write',
          },
        },
      });
      ctx.print([
        'Delegation submitted to GoodVibes TUI/shared-session routes.',
        `  session ${session.id}`,
        `  mode ${input.reviewRequested ? 'delegated review requested' : 'direct build delegation'}`,
        `  task ${input.task}`,
        ...(input.reason ? [`  reason ${input.reason}`] : []),
        ...(input.successCriteria ? [`  success ${input.successCriteria}`] : []),
        '  next check GoodVibes TUI shared-session/task status for the result.',
      ].join('\n'));
    } catch (error) {
      ctx.print([
        'Delegation failed.',
        `  error ${summarizeError(error)}`,
        '  fallback open GoodVibes TUI in the target workspace and paste the original task there.',
      ].join('\n'));
    }
  };

  registry.register({
    name: 'delegate',
    aliases: ['build'],
    description: 'Explicitly delegate build/fix/review work to GoodVibes TUI through shared-session routes',
    hidden: true,
    usage: '[--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <task>',
    argsHint: '[--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <task>',
    handler: makeHandler(),
  });
}
