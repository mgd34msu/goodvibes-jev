/**
 * sessions-command.ts, `goodvibes-daemon sessions list|kill <id>`.
 *
 * The sessions this daemon HOSTS: conversation loops running inside it, which
 * outlive the client that started them. That is the whole reason they need a
 * command, a terminal's own session dies with the terminal and never needs
 * listing from outside, while a hosted one can be running on a headless box
 * with nothing attached to it at all.
 *
 * The verbs are `sessions.hosted.list` and `sessions.hosted.kill`, and both are
 * declared ws-only in the method catalog, they have no REST binding, so they
 * go through `callDaemonWsVerb` rather than `callDaemonVerb`. Same target, same
 * operator token, same --host/--port/--token convention; only the transport is
 * different. A daemon built without hosted sessions answers "does not know the
 * verb", which is reported as exactly that.
 *
 * This module decides nothing about what a session IS. It parses, calls, and
 * renders.
 */
import { callDaemonWsVerb } from '@goodvibes-jev/engine/terminal-shell';
import {
  resolveTargetOrFailure,
  type DaemonCommandResult,
  type RemoteCommandDeps,
  type RemoteCommandFlags,
} from './status-command.js';

export const SESSIONS_SUBCOMMANDS = ['list', 'kill'] as const;
export type SessionsSubcommand = (typeof SESSIONS_SUBCOMMANDS)[number];

export function isSessionsSubcommand(value: string | undefined): value is SessionsSubcommand {
  return typeof value === 'string' && (SESSIONS_SUBCOMMANDS as readonly string[]).includes(value);
}

/** Only the fields this command prints; the daemon's record carries more. */
export interface HostedSessionRecord {
  readonly id?: string;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly status?: string;
  readonly detachPolicy?: string;
  readonly effectiveDetachPolicy?: string;
  readonly attachedClients?: number | readonly string[];
  readonly updatedAt?: number;
  readonly turnCount?: number;
  readonly restoredFromDisk?: boolean;
  readonly endedReason?: string;
}

interface HostedListPayload {
  readonly sessions?: readonly HostedSessionRecord[];
}

interface HostedKillPayload {
  readonly session?: HostedSessionRecord;
}

export interface SessionsCommandFlags extends RemoteCommandFlags {
  /** `--all`: include sessions that have already ended. */
  readonly all: boolean;
}

export interface RunSessionsCommandInput extends RemoteCommandDeps {
  readonly flags: SessionsCommandFlags;
  /** Positional words after `sessions`, the subcommand and its argument. */
  readonly args: readonly string[];
}

function usage(binary = 'goodvibes-daemon'): string[] {
  return [
    `  ${binary} sessions list [--all] [--json]`,
    `  ${binary} sessions kill <id> [--json]`,
  ];
}

function refusal(message: string, json: boolean): DaemonCommandResult {
  return {
    exitCode: 2,
    lines: json
      ? [JSON.stringify({ ok: false, error: message, fix: usage().join(' | ') }, null, 2)]
      : [`sessions: ${message}`, ...usage()],
  };
}

function attachedCount(value: HostedSessionRecord['attachedClients']): number | undefined {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function describeAge(at: number | undefined, now: number): string {
  if (at === undefined) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function renderSession(session: HostedSessionRecord, now: number): string[] {
  const attached = attachedCount(session.attachedClients);
  const head = `${session.id ?? '(no id)'}  ${session.status ?? 'unknown'}`;
  const lines = [head];
  if (session.title) lines.push(`    ${session.title}`);
  if (session.workspaceRoot) lines.push(`    in ${session.workspaceRoot}`);
  const facts: string[] = [];
  if (session.turnCount !== undefined) facts.push(`${session.turnCount} turns`);
  if (attached !== undefined) facts.push(attached === 1 ? '1 client attached' : `${attached} clients attached`);
  if (session.effectiveDetachPolicy) facts.push(`on last detach: ${session.effectiveDetachPolicy}`);
  if (session.updatedAt !== undefined) facts.push(describeAge(session.updatedAt, now));
  if (session.restoredFromDisk === true) facts.push('restored from disk');
  if (session.endedReason) facts.push(`ended: ${session.endedReason}`);
  if (facts.length > 0) lines.push(`    ${facts.join('  ·  ')}`);
  return lines;
}

/**
 * `sessions list` / `sessions kill <id>`.
 *
 * Exit 0 when the daemon answered, 1 when it refused or could not be reached,
 * 2 when the command line was wrong. A `kill` with no id is a usage refusal
 * rather than a "kill everything", there is no shape of this command that ends
 * more than the one session named.
 */
export async function runSessionsCommand(input: RunSessionsCommandInput): Promise<DaemonCommandResult> {
  const { flags, args } = input;
  const subcommand = args[0];
  if (subcommand === undefined) {
    return refusal('name what to do with the sessions.', flags.json);
  }
  if (!isSessionsSubcommand(subcommand)) {
    return refusal(`'${subcommand}' is not a sessions command; try list or kill.`, flags.json);
  }
  const sessionId = args[1];
  if (subcommand === 'kill' && sessionId === undefined) {
    return refusal('kill needs the session to end; run `sessions list` to see them.', flags.json);
  }
  if (args.length > (subcommand === 'kill' ? 2 : 1)) {
    return refusal(`'${args[subcommand === 'kill' ? 2 : 1]}' is one argument too many.`, flags.json);
  }

  const resolved = resolveTargetOrFailure(flags, input);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;
  const socketOption = input.socketFactory ? { socketFactory: input.socketFactory } : {};
  const now = input.now?.() ?? Date.now();

  if (subcommand === 'kill') {
    const outcome = await callDaemonWsVerb<HostedKillPayload>(target, 'sessions.hosted.kill', {
      body: { sessionId },
      ...socketOption,
    });
    if (!outcome.ok) {
      return {
        exitCode: 1,
        lines: flags.json
          ? [JSON.stringify({ ok: false, error: outcome.error, fix: outcome.fix }, null, 2)]
          : [outcome.error, `  ${outcome.fix}`],
      };
    }
    if (flags.json) {
      return { exitCode: 0, lines: [JSON.stringify({ ok: true, data: outcome.data }, null, 2)] };
    }
    const session = outcome.data.session;
    return {
      exitCode: 0,
      lines: [
        `ended ${session?.id ?? sessionId}`,
        ...(session ? renderSession(session, now).slice(1) : []),
        'the record is kept, with the reason it ended, until the retention window retires it.',
      ],
    };
  }

  const outcome = await callDaemonWsVerb<HostedListPayload>(target, 'sessions.hosted.list', {
    body: { includeTerminated: flags.all },
    ...socketOption,
  });
  if (!outcome.ok) {
    return {
      exitCode: 1,
      lines: flags.json
        ? [JSON.stringify({ ok: false, error: outcome.error, fix: outcome.fix }, null, 2)]
        : [outcome.error, `  ${outcome.fix}`],
    };
  }
  if (flags.json) {
    return { exitCode: 0, lines: [JSON.stringify({ ok: true, data: outcome.data }, null, 2)] };
  }

  const sessions = outcome.data.sessions ?? [];
  const where = target.isLocal ? 'this machine' : target.baseUrl;
  if (sessions.length === 0) {
    return {
      exitCode: 0,
      lines: [
        `the daemon on ${where} is hosting no sessions${flags.all ? '' : ' (add --all to include ones that have ended)'}.`,
      ],
    };
  }
  return {
    exitCode: 0,
    lines: [
      `${sessions.length} session${sessions.length === 1 ? '' : 's'} hosted by the daemon on ${where}:`,
      '',
      ...sessions.flatMap((session) => [...renderSession(session, now), '']),
    ],
  };
}
