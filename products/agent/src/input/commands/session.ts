/**
 * /session command handler, Multi-session Orchestration.
 *
 * Implements read-only session graph inspection plus session continuity commands.
 * Local task graph mutation commands are blocked in Agent; explicit build/fix/review
 * handoff must use `/delegate` so GoodVibes TUI owns execution.
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import type { CrossSessionTaskRef } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { handleSessionWorkflowCommand } from './session-workflow.ts';
import { requireSessionOrchestration } from './runtime-services.ts';

// ── Argument parsing helpers ──────────────────────────────────────────────────

/**
 * Extract a named flag value from args (e.g. `--to <value>`).
 * Returns undefined if the flag is not present.
 */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Status badge for display. */
function statusBadge(status: string): string {
  switch (status) {
    case 'queued':    return '[ ]';
    case 'running':   return '[>]';
    case 'blocked':   return '[~]';
    case 'completed': return '[+]';
    case 'failed':    return '[!]';
    case 'cancelled': return '[x]';
    default:          return '[?]';
  }
}

/** Format a ref as a compact one-line string. */
function fmtRef(ref: CrossSessionTaskRef): string {
  const key = `${ref.sessionId.slice(0, 8)}...:${ref.taskId.slice(0, 8)}...`;
  const label = ref.label ? ` [${ref.label}]` : '';
  return `${statusBadge(ref.status)} ${key}${label}  "${ref.title}"`;
}

function printSessionGraphMutationBlocked(context: CommandContext): void {
  context.print([
    '[session] Local cross-session task graph mutation is blocked in GoodVibes Agent.',
    '[session] Use /session graph for read-only inspection.',
    '[session] Use /delegate <task> for explicit build/fix/review handoff to GoodVibes TUI.',
  ].join('\n'));
}

// ── /session graph ────────────────────────────────────────────────────────────

function handleGraph(args: string[], context: CommandContext): void {
  const filterSession = flagValue(args, '--session');
  const format = flagValue(args, '--format') ?? 'text';

  const orchestration = requireSessionOrchestration(context);
  const snap = orchestration.snapshot();

  const refs = Object.values(snap.refs);
  const filteredRefs = filterSession
    ? refs.filter((r) => r.sessionId === filterSession)
    : refs;

  if (format === 'json') {
    context.print(JSON.stringify(snap, null, 2));
    return;
  }

  // ── Text display ─────────────────────────────────────────────────────────────

  if (filteredRefs.length === 0) {
    if (filterSession) {
      context.print(`[session] No tasks registered for session ${filterSession.slice(0, 8)}...`);
    } else {
      context.print('[session] Task graph is empty. Local task graph mutation is blocked in Agent; use /delegate for explicit build/fix/review handoff.');
    }
    return;
  }

  const lines: string[] = [
    `[session] Cross-session task graph (${filteredRefs.length} task${filteredRefs.length !== 1 ? 's' : ''}):`,
  ];

  // Group by session for readability
  const bySession = new Map<string, CrossSessionTaskRef[]>();
  for (const ref of filteredRefs) {
    const group = bySession.get(ref.sessionId) ?? [];
    group.push(ref);
    bySession.set(ref.sessionId, group);
  }

  for (const [sid, sessionRefs] of bySession) {
    lines.push(`  Session ${sid.slice(0, 16)}...`);
    for (const ref of sessionRefs) {
      lines.push(`    ${fmtRef(ref)}`);

      // Show dependencies
      const deps = orchestration.getDependencies(ref.sessionId, ref.taskId);
      for (const dep of deps) {
        lines.push(
          `      depends-on: ${statusBadge(dep.status)} ${dep.sessionId.slice(0, 8)}...:${dep.taskId.slice(0, 8)}...  "${dep.title}"`,
        );
      }

      // Show dependents
      const dependents = orchestration.getDependents(ref.sessionId, ref.taskId);
      for (const d of dependents) {
        lines.push(
          `      depended-by: ${statusBadge(d.status)} ${d.sessionId.slice(0, 8)}...:${d.taskId.slice(0, 8)}...  "${d.title}"`,
        );
      }
    }
  }

  // Handoffs summary
  const handoffs = orchestration.getHandoffs();
  const filteredHandoffs = filterSession
    ? handoffs.filter((h) => h.fromSessionId === filterSession || h.toSessionId === filterSession)
    : handoffs;

  if (filteredHandoffs.length > 0) {
    lines.push(`  Handoffs (${filteredHandoffs.length}):`);
    for (const h of filteredHandoffs) {
      const ack = h.acknowledged ? 'ack' : 'pending';
      lines.push(
        `    ${h.handoffId.slice(0, 8)}...  ` +
        `${h.fromSessionId.slice(0, 8)}... → ${h.toSessionId.slice(0, 8)}...  ` +
        `task:${h.taskRef.taskId.slice(0, 8)}...  [${ack}]` +
        (h.reason ? `  reason: ${h.reason}` : ''),
      );
    }
  }

  context.print(lines.join('\n'));
}

// ── Top-level command definition ───────────────────────────────────────────────

/**
 * sessionCommand, The `/session` slash command.
 *
 * Routes to multi-session orchestration subcommand handlers based on args[0].
 */
export const sessionCommand: SlashCommand = {
  name: 'session',
  aliases: ['sess'],
  description: 'Session continuity and read-only cross-session graph inspection.',
  usage: '<subcommand> [args]',
  argsHint: 'list|resume|save|events|groups|hotspots|graph',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'link-task':
      case 'link':
        printSessionGraphMutationBlocked(context);
        break;

      case 'handoff':
      case 'ho':
        printSessionGraphMutationBlocked(context);
        break;

      case 'graph':
      case 'g':
        handleGraph(rest, context);
        break;

      case 'cancel':
        printSessionGraphMutationBlocked(context);
        break;

      default: {
        const handled = await handleSessionWorkflowCommand(args, context);
        if (!handled) {
          const usage = [
            'Usage: /session <subcommand>',
            '  list | rename <name> | resume <id|name> | fork [name] | save [name] | info [id] | export <id> [format] | search <query> | delete <id> --yes',
            '                                , Session continuity, export, resume, and pruning',
            '  events [kind] | groups [kind] | hotspots',
            '                                , Transcript structure: event log, grouped view, hotspot summary',
            '  graph [--session <sid>] [--format text|json]',
            '                                , Display the cross-session task dependency graph',
            '  link-task | handoff | cancel',
            '                                , Blocked in Agent; use /delegate for explicit build/fix/review handoff',
          ].join('\n');
          context.print(usage);
        }
        break;
      }
    }
  },
};
