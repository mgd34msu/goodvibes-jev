/**
 * The live tail of one background process (Enter in the process monitor),
 * drawn with the modal surface kit: the command in the title (crumb under
 * "Runtime activity"), the output in an element panel with every line
 * wrapped in full, following the newest output unless scrolled back. Esc
 * goes back to the process monitor; the process keeps running (k stops it).
 */

import type { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ProcessEntry } from './process-modal.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, scrollCountText, wrapLines, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { panel } from './surface-kit-parts.ts';

const LIVE_TAIL_EMPTY_OUTPUT = '(no output yet)';
const LIVE_TAIL_HINTS: readonly KitHint[] = [['↑↓', 'scroll'], ['k', 'stop process'], ['esc', 'back, the process keeps running']];

/** The static strings this surface can show (checked by package verification). */
export function renderLiveTailModalPackageText(): string {
  return [
    'Runtime activity',
    'Live output',
    '$ <process>',
    LIVE_TAIL_EMPTY_OUTPUT,
    '<n> more ↑',
    '<n> more ↓',
    ...LIVE_TAIL_HINTS.map(([, action]) => action),
  ].join('\n');
}

export interface LiveTailModalDeps {
  readonly processManager: Pick<ProcessManager, 'stop' | 'getOutput'>;
}

export class LiveTailModal {
  public active = false;
  public entry: ProcessEntry | null = null;
  public scrollOffset = 0;

  constructor(private readonly deps: LiveTailModalDeps) {}

  open(entry: ProcessEntry): void {
    this.entry = entry;
    this.scrollOffset = 0;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.entry = null;
    this.scrollOffset = 0;
  }

  scrollUp(): void {
    this.scrollOffset += 1;
  }

  scrollDown(): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - 1);
  }

  stopProcess(): boolean {
    if (!this.entry) return false;
    return this.deps.processManager.stop(this.entry.id);
  }

  getOutput(): string {
    if (!this.entry) return '';
    const output = this.deps.processManager.getOutput(this.entry.id);
    if (!output) return '';
    const combined = [output.stdout, output.stderr].filter(Boolean).join('\n').trim();
    return combined || LIVE_TAIL_EMPTY_OUTPUT;
  }
}

/** Render the live tail as a SurfaceLayer in screen coordinates (null when no process is open). */
export function renderLiveTailModal(
  modal: LiveTailModal,
  screenWidth: number,
  screenHeight = 24,
): SurfaceLayer | null {
  const entry = modal.entry;
  if (!entry) return null;
  const t = activeTokens();
  const f = beginModal(screenWidth, screenHeight, {
    title: 'Runtime activity',
    crumbs: ['Live output'],
    hints: LIVE_TAIL_HINTS,
    // Esc is a hint of its own here: it goes back to the process list.
    escKey: false,
  });
  // The command leads the body, wrapped in full (a title row would have to cut it).
  const command = wrapLines(`$ ${entry.label}`, f.r - f.l + 1);
  command.forEach((line, k) => f.canvas.put(f.l, f.top + k, line, { fg: t.text, bold: true }));
  const panelTop = f.top + command.length + 1;
  const p = panel(f.canvas, f.l - 2, panelTop, f.r - f.l + 5, Math.max(3, f.bottom - panelTop + 1));
  const textW = p.r - p.l + 1;
  const lines = (modal.getOutput() || LIVE_TAIL_EMPTY_OUTPUT).split('\n').flatMap((line) => wrapLines(line, textW));
  const capacity = Math.max(1, p.bottom - p.top + 1);
  const maxScroll = Math.max(0, lines.length - capacity);
  modal.scrollOffset = Math.min(modal.scrollOffset, maxScroll);
  const end = lines.length - modal.scrollOffset;
  const start = Math.max(0, end - capacity);
  lines.slice(start, end).forEach((line, k) => {
    f.canvas.put(p.l, p.top + k, line, { fg: line === LIVE_TAIL_EMPTY_OUTPUT ? t.textFaint : t.text, bg: p.bg });
  });
  f.hintRight = scrollCountText(start, lines.length - end);
  return finishModal(f);
}
