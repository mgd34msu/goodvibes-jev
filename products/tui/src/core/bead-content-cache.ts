import type { ToolCall } from '@goodvibes-jev/engine/sdk/platform/types';
import { beadBody, beadSummary, needsAttention, type BeadBody, type BeadStatus, type BeadSummary } from '../renderer/lane-graph/bead.ts';

interface Entry {
  readonly args: string;
  readonly name: string;
  readonly status: BeadStatus;
  readonly content: string | undefined;
  readonly body: BeadBody | null;
  readonly summary: BeadSummary | null;
  readonly attention: boolean;
}

/** Parsed tool output belongs to its transcript, not to an animation frame.
 * Compare values because live snapshots clone their tool-call objects.
 */
export class BeadContentCache {
  private readonly entries = new Map<string, Entry>();
  private readonly touched = new Set<string>();
  begin(): void { this.touched.clear(); }
  end(): void { for (const id of this.entries.keys()) if (!this.touched.has(id)) this.entries.delete(id); }
  clear(): void { this.entries.clear(); this.touched.clear(); }
  needsAttention(id: string, call: ToolCall, content: string): boolean {
    const prior = this.entries.get(id);
    return prior && prior.name === call.name && prior.content === content ? prior.attention : needsAttention(call, content);
  }
  read(id: string, call: ToolCall, status: BeadStatus, content: string | undefined): Entry {
    this.touched.add(id);
    const args = JSON.stringify(call.arguments);
    const prior = this.entries.get(id);
    if (prior && prior.args === args && prior.name === call.name && prior.status === status && prior.content === content) return prior;
    const entry = { args, name: call.name, status, content, body: beadBody(call, status, content), summary: beadSummary(call, status, content), attention: content !== undefined && this.needsAttention(id, call, content) };
    this.entries.set(id, entry);
    return entry;
  }
}
