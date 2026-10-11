import { type Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { BORDERS } from './layout.ts';
import { renderConversationNotice } from './conversation-surface.ts';
import { activeUiTones } from './theme.ts';

/** Exported for use by typeOverride callers and tests. */
export type SystemMessageType = 'error' | 'warning' | 'info';

/**
 * Render a system message with a colored left border.
 */
export function renderSystemMessage(
  content: string,
  width: number,
  typeOverride?: SystemMessageType,
): Line[] {
  const msgType = typeOverride ?? 'unclassified';
  // System-message notices paint the ▌ marker and body text on the TRANSPARENT
  // terminal background (renderConversationNotice passes no bodyBg), so the
  // accent and dim text resolve per-render through activeUiTones() to stay
  // legible on a light terminal. Dark values are byte-identical to the prior
  // static reads (chrome.bad == state.bad, chrome.warn == state.warn,
  // state.info unchanged, chrome.faint == fg.dim). The ▌ marker glyph is still
  // sourced from the BORDERS table.
  const t = activeUiTones();
  const border = msgType === 'error' ? BORDERS.ERROR
    : msgType === 'warning' ? BORDERS.WARNING
    : BORDERS.INFO;
  const accent = msgType === 'error' ? t.chrome.bad
    : msgType === 'warning' ? t.chrome.warn
    : msgType === 'info' ? t.state.info : t.chrome.faint;
  const textColor = msgType === 'info' || msgType === 'unclassified' ? t.chrome.faint : accent;
  return renderConversationNotice(content, width, {
    accent,
    text: textColor,
  }, border.char);
}
