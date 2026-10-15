import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';

/** Hit-test the last painted frame, with the top modal owning the pointer. */
export class SurfacePointer {
  layers: readonly SurfaceLayer[] = [];
  private down: { id: string; row: number; col: number } | null = null;

  route(token: InputToken): readonly InputToken[] {
    if (token.type !== 'mouse') return [token];
    const layer = this.layers.findLast(l => l.dim || (l.hitTargets?.length ?? 0) > 0);
    if (!layer) { this.down = null; return [token]; }
    const x = token.col - layer.x, y = token.row - layer.y;
    const hit = layer.hitTargets?.findLast(h => x >= h.x && x < h.x + h.width && y >= h.y && y < h.y + h.height);
    if (token.button === 64 || token.button === 65) {
      this.down = null;
      return Array.from({ length: 3 }, () => pointerKey(token.button === 64 ? 'up' : 'down'));
    }
    if (token.button === 0 && token.action === 'press') this.down = hit ? { id: hit.id, row: token.row, col: token.col } : null;
    if (token.action === 'release') {
      const down = this.down; this.down = null;
      if (hit && down?.id === hit.id && down.row === token.row && Math.abs(down.col - token.col) <= 1) {
        hit.onClick?.();
        return (hit.keys ?? []).map(pointerKey);
      }
    }
    return []; // Never click through a modal into the transcript underneath.
  }
}

export function pointerKey(name: string): InputToken {
  if (name.length === 1) return { type: 'text', value: name };
  return { type: 'key', name, logicalName: name, ctrl: false, meta: false, shift: false };
}

