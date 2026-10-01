/**
 * term-caps.ts, the color level the compositor draws at.
 *
 * The shared probe (probeTermCaps in @goodvibes-jev/engine/terminal-shell) reads
 * the stream's own color depth, which only trusts COLORTERM and a short list
 * of terminals. It reports 256 colors for Ghostty, kitty, Alacritty and foot,
 * and a 256-color downsample turns every gradient (the brand wordmark, the
 * selected row, the modal caps) into visible bands. The painters are smooth
 * per cell; the bands came only from that downsample.
 *
 * probeColorCaps keeps every answer of the shared probe (NO_COLOR, TERM=dumb,
 * 16 colors) and changes one: a 256-color depth becomes truecolor when the
 * environment says the terminal draws 24-bit color.
 */

import { probeTermCaps, type TermColorCaps } from '@goodvibes-jev/engine/terminal-shell';

/** TERM values of terminals that draw 24-bit color without saying so in COLORTERM. */
const TRUECOLOR_TERMS: ReadonlySet<string> = new Set([
  'xterm-ghostty', 'xterm-kitty', 'alacritty', 'foot', 'foot-extra', 'wezterm', 'contour', 'rio', 'xterm-direct',
]);

/** TERM_PROGRAM values of terminals that draw 24-bit color. */
const TRUECOLOR_PROGRAMS: ReadonlySet<string> = new Set([
  'ghostty', 'wezterm', 'iterm.app', 'vscode', 'hyper', 'tabby', 'rio', 'warpterminal',
]);

/**
 * Whether the environment says the terminal draws 24-bit color: COLORTERM
 * (truecolor / 24bit), a TERM ending in "-direct" (the terminfo convention for
 * direct color), or TERM / TERM_PROGRAM values of terminals known to draw it.
 */
function advertisesTruecolor(env: Readonly<Record<string, string | undefined>>): boolean {
  const colorterm = (env['COLORTERM'] ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;
  const term = (env['TERM'] ?? '').toLowerCase();
  if (term.endsWith('-direct') || TRUECOLOR_TERMS.has(term)) return true;
  return TRUECOLOR_PROGRAMS.has((env['TERM_PROGRAM'] ?? '').toLowerCase());
}

/** The shared probe's answer, with a 256-color depth raised to truecolor when the environment advertises it. */
export function probeColorCaps(stdout: NodeJS.WriteStream): TermColorCaps {
  const caps = probeTermCaps(stdout);
  if (caps.capability === 'ansi256' && advertisesTruecolor(process.env)) return { ...caps, capability: 'truecolor' };
  return caps;
}
