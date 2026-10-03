/**
 * The process monitor (F2, or Enter on the process indicator): background
 * shell processes drawn with the modal surface kit. One kit row per process
 * (status marker, command, status and elapsed time right-aligned), keycap
 * hints. Enter opens the process full screen with its timestamped output
 * (the live tail modal where that view is not wired), k stops the selected
 * process. Esc only closes the view: the processes keep running.
 */

import { formatDuration } from './modal-utils.ts';
import type { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { activeTokens } from './theme.ts';
import { beginModal, drawWrapped, finishModal, scrollCountText, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { listHeight, modalHeightFor, modalTextWidth } from './surface-kit-extra.ts';

export interface ProcessEntry {
  readonly id: string;
  readonly label: string;
  readonly type: 'exec';
  readonly status: string;
  readonly elapsedMs: number;
}

const MAX_LABEL_LENGTH = 200;
const PROCESS_MODAL_TITLE = 'Runtime activity';
const PROCESS_MODAL_EMPTY_MESSAGE = 'No running shell processes.';
const PROCESS_MODAL_NOTE = 'Esc closes this view; processes keep running.';
const PROCESS_MODAL_HINTS: readonly KitHint[] = [['↑↓', 'move'], ['⏎', 'output'], ['k', 'stop process']];

export interface ProcessModalDeps {
  readonly processManager: Pick<ProcessManager, 'list' | 'getStatus' | 'stop'>;
}

function truncateCmd(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (firstLine.length > MAX_LABEL_LENGTH) return `${firstLine.slice(0, MAX_LABEL_LENGTH - 1)}…`;
  return firstLine;
}

export class ProcessModal {
  public active = false;
  public selectedIndex = 0;
  public entries: ProcessEntry[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onRefresh: (() => void) | null = null;

  constructor(private readonly deps: ProcessModalDeps) {}

  setOnRefresh(fn: () => void): void {
    this.onRefresh = fn;
  }

  open(): void {
    this.refresh();
    this.active = true;
    this.selectedIndex = 0;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.refresh();
      this.onRefresh?.();
    }, 1000);
  }

  close(): void {
    this.active = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  refresh(): void {
    const now = Date.now();
    const result: ProcessEntry[] = [];

    for (const process of this.deps.processManager.list()) {
      const current = this.deps.processManager.getStatus(process.id);
      if (!current || current.done) continue;
      const startTime = current.startTime;
      result.push({
        id: process.id,
        label: truncateCmd(process.cmd),
        type: 'exec',
        status: process.status,
        elapsedMs: now - startTime,
      });
    }

    this.entries = result;
    if (this.selectedIndex >= this.entries.length) {
      this.selectedIndex = Math.max(0, this.entries.length - 1);
    }
  }

  moveUp(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.entries.length) % this.entries.length;
  }

  moveDown(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.entries.length;
  }

  getSelected(): ProcessEntry | undefined {
    return this.entries[this.selectedIndex];
  }

  stopSelected(): boolean {
    const entry = this.getSelected();
    if (!entry) return false;
    return this.deps.processManager.stop(entry.id);
  }
}

/** The static strings this surface can show (checked by package verification). */
export function renderProcessModalPackageText(): string {
  return [
    PROCESS_MODAL_TITLE,
    PROCESS_MODAL_EMPTY_MESSAGE,
    PROCESS_MODAL_NOTE,
    '<n> running',
    'running',
    'failed',
    '<duration>',
    ...PROCESS_MODAL_HINTS.map(([, action]) => action),
  ].join('\n');
}

function rowFor(entry: ProcessEntry, selected: boolean): KitRow {
  const t = activeTokens();
  const running = entry.status === 'running';
  const failed = entry.status === 'failed';
  return {
    label: entry.label,
    right: `${entry.status} · ${formatDuration(entry.elapsedMs)}`,
    rightFg: failed ? t.error : undefined,
    mark: running ? '◐' : failed ? '✕' : '○',
    markFg: running ? t.brand : failed ? t.error : t.textFaint,
    selected,
  };
}

/** Render the process monitor as a SurfaceLayer in screen coordinates. */
export function renderProcessModal(modal: ProcessModal, screenWidth: number, screenHeight = 24): SurfaceLayer {
  modal.refresh();
  const t = activeTokens();
  const empty = modal.entries.length === 0;
  const hints = empty ? [] : PROCESS_MODAL_HINTS;
  const rows = modal.entries.map((entry, i) => rowFor(entry, i === modal.selectedIndex));
  const width = modalTextWidth(screenWidth, screenHeight);
  const body = (empty ? 1 : listHeight(rows, 0, width - 1)) + 2;
  const height = modalHeightFor(screenWidth, screenHeight, { hints }, body);
  const f = beginModal(screenWidth, screenHeight, {
    title: PROCESS_MODAL_TITLE,
    sub: empty ? undefined : `${modal.entries.length} running`,
    hints,
    height,
  });
  const noteRow = f.bottom;
  drawWrapped(f.canvas, f.l, noteRow, f.r - f.l + 1, PROCESS_MODAL_NOTE, { fg: t.textFaint }, f.bottom);
  if (empty) {
    drawWrapped(f.canvas, f.l, f.top, f.r - f.l + 1, PROCESS_MODAL_EMPTY_MESSAGE, { fg: t.textMuted }, noteRow - 2);
    return finishModal(f);
  }
  const res = drawList(f.canvas, { rows, top: f.top, bottom: Math.max(f.top, noteRow - 2), x0: f.l, x1: f.r, scrollKey: { owner: modal, name: 'processes' } });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}
