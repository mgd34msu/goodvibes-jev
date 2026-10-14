import { peekSystemMessagePresentation, prepareSystemMessagePresentation } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { type Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { BORDERS } from './layout.ts';
import { renderConversationNotice } from './conversation-surface.ts';
import { activeUiTones } from './theme.ts';

/** Exported for use by typeOverride callers and tests. */
export type SystemMessageType = 'error' | 'warning' | 'info';

/** Explicit preparation for callers that need a semantic severity. */
export async function classifySystemMessage(content: string): Promise<SystemMessageType | undefined> {
  return (await prepareSystemMessagePresentation(content)).severity;
}

/**
 * Render a system message with a colored left border.
 */
export function renderSystemMessage(
  content: string,
  width: number,
  typeOverride?: SystemMessageType,
): Line[] {
  const msgType = typeOverride ?? peekSystemMessagePresentation(content)?.severity;
  const border = msgType === 'error' ? BORDERS.ERROR
    : msgType === 'warning' ? BORDERS.WARNING
    : BORDERS.INFO;
  // System-message notices paint the ▌ marker and body on the TRANSPARENT
  // terminal background, so the accent and body text resolve per render from
  // the active theme (activeUiTones()). The info body reads in the theme's
  // faint text token, which replaces the SGR dim this notice used to apply.
  // The ▌ marker glyph is still sourced from the BORDERS table.
  const t = activeUiTones();
  const accent = msgType === 'error' ? t.chrome.bad
    : msgType === 'warning' ? t.chrome.warn
    : t.state.info;
  const textColor = msgType === 'info' || msgType === undefined ? t.chrome.faint : accent;
  return renderConversationNotice(content, width, {
    accent,
    text: textColor,
  }, border.char);
}
