import { center, getDisplayWidth } from './terminal-width.ts';
import { VERSION } from '../version.ts';

const ART_LINES = [
  ' ██████╗    ██████╗    ██████╗   ██████╗   ██╗   ██╗  ██╗  ██████╗   ███████╗  ███████╗',
  '██╔════╝   ██╔═══██╗  ██╔═══██╗  ██╔══██╗  ██║   ██║  ██║  ██╔══██╗  ██╔════╝  ██╔════╝',
  '██║  ███╗  ██║   ██║  ██║   ██║  ██║  ██║  ██║   ██║  ██║  ██████╔╝  █████╗    ███████╗',
  '██║   ██║  ██║   ██║  ██║   ██║  ██║  ██║  ╚██╗ ██╔╝  ██║  ██╔══██╗  ██╔══╝    ╚════██║',
  '╚██████╔╝  ╚██████╔╝  ╚██████╔╝  ██████╔╝   ╚████╔╝   ██║  ██████╔╝  ███████╗  ███████║',
  ' ╚═════╝    ╚═════╝    ╚═════╝   ╚═════╝     ╚═══╝    ╚═╝  ╚═════╝   ╚══════╝  ╚══════╝',
] as const;

const ART_W = Math.max(...ART_LINES.map((line) => getDisplayWidth(line)));
const TOP_BORDER = '━'.repeat(ART_W);
const SEPARATOR = '━'.repeat(ART_W);

/**
 * Audit Fix: Full-width English characters for vaporwave aesthetic.
 * ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気
 */
const TAGLINE = '[ ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気 ]';

/**
 * The splash wordmark gradient, protected: it is part of the GoodVibes mark,
 * identical under every theme and mode, and must never be routed through the
 * theme tokens. conversation-rendering.ts interpolates start to end across
 * each wordmark row. Byte-identical to the TUI's SPLASH_GRADIENT.
 */
export const SPLASH_GRADIENT = Object.freeze({ start: '#00ffff', end: '#d000ff' } as const);

function versionLine(version: string): string {
  return `　✦　v${version}　█　terminal AI assistant　█　自動ｺｰﾄﾞ 　✦`;
}

export interface SplashOptions {
  workingDir?: string;
  model?: string;
  provider?: string;
  toolCount?: number;
  /** Defaults to the live build VERSION; golden-frame fixtures pin one so frames do not change at a version bump. */
  version?: string;
}

export function getSplashLines(columns: number, opts: SplashOptions = {}): string[] {
  const splashHint = 'start chatting or type /help for commands';
  const lines: string[] = [
    center(TOP_BORDER, columns),
    ...ART_LINES.map((line) => center(line, columns)),
    center(SEPARATOR, columns),
    center(TAGLINE, columns),
    center(versionLine(opts.version ?? VERSION), columns),
    '',
  ];

  lines.push(center(splashHint, columns));

  return lines;
}
