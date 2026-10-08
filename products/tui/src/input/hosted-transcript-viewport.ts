import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { HostedSessionFeedState } from '../views/hosted-session-feed.ts';
import { hostedTranscriptLines, type HostedTranscriptLine } from './agents-modal-text.ts';

interface Anchor { readonly row: number; readonly offset: number; }

/** Local display ownership only. No attachment, stream, or execution controls. */
export class HostedTranscriptViewport {
  private generation: number | undefined;
  private sessionId: string | null = null;
  private anchor: Anchor | null = null;
  private lines: readonly HostedTranscriptLine[] = [];
  private droppedRows = 0;
  private height = 0;
  private start = 0;
  private follow = true;

  get following(): boolean { return this.follow; }
  get position(): { readonly above: number; readonly below: number } {
    return { above: this.start, below: Math.max(0, this.lines.length - this.start - this.height) };
  }

  reset(): void {
    this.generation = undefined; this.sessionId = null;
    this.anchor = null; this.lines = []; this.droppedRows = 0;
    this.height = 0; this.start = 0; this.follow = true;
  }

  synchronize(state: HostedSessionFeedState, generation: number): void {
    if (this.generation === generation && this.sessionId === (state.record?.id ?? null)) return;
    this.reset(); this.generation = generation; this.sessionId = state.record?.id ?? null;
  }

  render(state: HostedSessionFeedState, generation: number, width: number, height: number): readonly Line[] {
    this.synchronize(state, generation);
    this.lines = hostedTranscriptLines(state.rows, width);
    this.droppedRows = state.droppedRows; this.height = Math.max(0, height);
    const maxStart = Math.max(0, this.lines.length - this.height);
    let start = maxStart;
    if (!this.follow) {
      // An evicted row's character offset does not belong to its successor.
      if (this.anchor && this.anchor.row < state.droppedRows) this.anchor = { row: state.droppedRows, offset: 0 };
      const anchor = this.anchor;
      start = 0;
      if (anchor) {
        const row = Math.max(0, anchor.row - state.droppedRows);
        // Keep the logical anchor, rather than replacing it with a wrap start
        // on every resize. Repeated narrow/wide changes cannot drift it backward.
        for (let i = 0; i < this.lines.length; i++) {
          const line = this.lines[i]!;
          if (line.row > row || (line.row === row && line.offset > anchor.offset)) break;
          start = i;
        }
      }
      start = Math.min(start, maxStart);
    }
    this.start = start;
    return this.lines.slice(start, start + this.height).map(entry => entry.line);
  }

  move(delta: number): void {
    this.follow = false;
    const target = Math.max(0, Math.min(Math.max(0, this.lines.length - this.height), this.start + delta));
    const line = this.lines[target];
    this.anchor = line ? { row: this.droppedRows + line.row, offset: line.offset } : null;
    this.start = target;
  }

  page(direction: -1 | 1): void { this.move(direction * Math.max(1, this.height - 1)); }
  oldest(): void { this.move(-this.lines.length); }
  latest(): void { this.follow = true; this.anchor = null; }
}
