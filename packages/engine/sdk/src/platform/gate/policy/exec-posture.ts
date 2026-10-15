import type { OwnerTerminalGuard } from '../../tools/exec/owner-terminal-guard.js';

/** Terminal actions use the same owner-configured tool permissions as other commands. */
export const AGENT_OWNER_TERMINAL_GUARD: OwnerTerminalGuard = { posture: 'off' };
