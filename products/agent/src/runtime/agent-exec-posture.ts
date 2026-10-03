/**
 * agent-exec-posture.ts, what this product states about commands its own
 * turns run.
 *
 * A turn hosted by the daemon already runs under the platform's exec postures:
 * the daemon's composition states them, and the SDK enforces them. A turn this
 * process runs LOCALLY, routing off, no connected host, a message carrying
 * attachments, reaches the same machine through the same exec tool, so a rule
 * stated only on the hosted side holds on only one of the two paths a person
 * can reach.
 *
 * This file is where the local half is stated, as a value both the composition
 * and its tests read, so the thing proven is the thing that ships.
 */
import type { OwnerTerminalGuard } from '@goodvibes-jev/engine/sdk/platform/tools';

/**
 * The owner's terminal is not a surface this product types into.
 *
 * `enforced` refuses a command that DRIVES an existing tmux session, window or
 * pane whose name this platform did not create, send-keys, kill, resize,
 * attach, respawn, rename, with a refusal naming the rule. Ownership is by
 * name (`goodvibes-…`), because a pane id proves nothing about who made it.
 *
 * What it does not do: reading tmux state stays allowed (the fleet view lists
 * panes to notice externally-launched agents, and refusing to look would break
 * that while protecting nothing), and the platform's own sessions stay fully
 * drivable. It is not the frozen catastrophic block, which is unconditional
 * and untouched by this.
 */
export const AGENT_OWNER_TERMINAL_GUARD: OwnerTerminalGuard = { posture: 'enforced' };
