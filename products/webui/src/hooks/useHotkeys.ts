/**
 * useHotkeys
 *
 * Global keydown listener that fires bindings while guarding against
 * accidental fires when the user is typing in inputs.
 *
 * Supports:
 *  - Single combos: "mod+k", "mod+Enter", "Escape"
 *  - Two-key sequences: "g c" (press g, then c within 1 s)
 *  - Allow-list for combos that SHOULD fire inside inputs (e.g. mod+Enter)
 *
 * "mod" maps to Meta on Mac and Ctrl everywhere else.
 */

import { useEffect, useRef } from 'react';

export type HotkeyHandler = (event: KeyboardEvent) => void;

export interface HotkeyBinding {
  /** Combo string, e.g. "mod+k", "Escape", "g c" */
  combo: string;
  handler: HotkeyHandler;
  /**
   * When true, the binding fires even while focus is inside an
   * input / textarea / contenteditable element.
   * Default: false.
   */
  allowInInput?: boolean;
}

const SEQUENCE_TIMEOUT_MS = 1000;

/** Returns true when the element is an editable input-like target. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (target.isContentEditable) return true;
  return false;
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Prefer the non-deprecated userAgentData API when available
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent;
  return /mac/i.test(platform);
}

/**
 * Normalise a combo string to a canonical form.
 * e.g. "mod+K" → "Meta+k" (on Mac) or "Control+k" (elsewhere).
 */
function normaliseToken(token: string): string {
  const lower = token.toLowerCase();
  if (lower === 'mod') return isMac() ? 'Meta' : 'Control';
  if (lower === 'ctrl') return 'Control';
  if (lower === 'cmd' || lower === 'meta') return 'Meta';
  if (lower === 'alt') return 'Alt';
  if (lower === 'shift') return 'Shift';
  // Single letter, keep as lower
  if (token.length === 1) return token.toLowerCase();
  // Named keys, keep PascalCase
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

export function normaliseCombo(combo: string): string {
  // Two-key sequences are whitespace-separated (e.g. "g c").
  // Normalise each whitespace-token independently, then rejoin with a space.
  if (/\s/.test(combo)) {
    return combo
      .trim()
      .split(/\s+/)
      .map((token) => {
        // Each sequence token may itself be a modified combo (e.g. "Ctrl+x")
        const parts = token
          .split('+')
          .map((p) => p.trim())
          .filter(Boolean);
        return parts.map(normaliseToken).join('+');
      })
      .join(' ');
  }

  // Single combo, split on '+'
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map(normaliseToken).join('+');
}

/**
 * Build a canonical key string from a KeyboardEvent.
 * e.g. Ctrl+K event → "Control+k"
 */
export function eventToCombo(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  // Do NOT push Shift for BARE printable single characters (no other modifier held),
  // the character itself already encodes the shift state (e.g. Shift+/ yields "?" not "Shift+?").
  // Shift IS pushed for:
  //   - Named keys like Tab, Enter, ArrowUp, etc. (key.length > 1)
  //   - Single chars when Ctrl/Meta/Alt is ALSO held (e.g. Ctrl+Shift+N → "Control+Shift+n")
  //   - Space (key === ' ') which is treated as a named key
  const isBareShiftedChar =
    event.key.length === 1 &&
    event.key !== ' ' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey;
  if (event.shiftKey && !isBareShiftedChar) {
    parts.push('Shift');
  }
  // Key value, lower for single chars, preserve named keys
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  parts.push(key);
  return parts.join('+');
}

export function useHotkeys(bindings: HotkeyBinding[]): void {
  const bindingsRef = useRef(bindings);
  // eslint-disable-next-line react-hooks/refs -- intentional mutable ref pattern for stable handler closure
  bindingsRef.current = bindings;

  // Track the pending first key of a two-key sequence
  const pendingSeqRef = useRef<{ key: string; ts: number } | null>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const currentBindings = bindingsRef.current;
      const inEditable = isEditableTarget(event.target);
      const currentCombo = eventToCombo(event);

      for (const binding of currentBindings) {
        const { combo, handler: bindingHandler, allowInInput = false } = binding;

        // Guard: skip if in an editable element and binding doesn't opt in
        if (inEditable && !allowInInput) continue;

        const normCombo = normaliseCombo(combo);

        // Two-key sequence (contains a space but only one token part is a space separator)
        if (normCombo.includes(' ')) {
          const [firstKey, secondKey] = normCombo.split(' ');
          const pending = pendingSeqRef.current;

          if (
            pending?.key === firstKey &&
            Date.now() - (pending?.ts ?? Infinity) < SEQUENCE_TIMEOUT_MS &&
            currentCombo === secondKey
          ) {
            pendingSeqRef.current = null;
            event.preventDefault();
            bindingHandler(event);
            return;
          }

          // Do NOT preventDefault here so the raw keypress (e.g. 'g') is not
          // swallowed for any other listeners that may also care about it.
          if (currentCombo === firstKey) {
            // Only start sequence if not in editable (already guarded above)
            pendingSeqRef.current = { key: firstKey, ts: Date.now() };
            return;
          }
          continue;
        }

        // Single combo match
        if (currentCombo === normCombo) {
          pendingSeqRef.current = null;
          event.preventDefault();
          bindingHandler(event);
          return;
        }
      }

      // Any non-modifier keypress clears pending sequence
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key !== pendingSeqRef.current?.key) {
        // Only clear if it wasn't a first-key match (handled above)
        if (!currentBindings.some((b) => {
          const norm = normaliseCombo(b.combo);
          return norm.includes(' ') && norm.split(' ')[0] === currentCombo;
        })) {
          pendingSeqRef.current = null;
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, []); // stable, reads from ref
}
