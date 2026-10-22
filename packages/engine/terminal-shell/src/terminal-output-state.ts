import type { TerminalOutputGuard } from './terminal-output-guard.js';

/** Shared by guard installation and the renderer's dependency-free write path. */
export const terminalOutputState: { current: TerminalOutputGuard | null } = { current: null };
