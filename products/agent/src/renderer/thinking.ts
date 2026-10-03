import { type Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { BORDERS } from './layout.ts';
import { renderConversationNotice } from './conversation-surface.ts';
import { activeUiTones } from './theme.ts';

export function renderThinkingBlock(text: string, width: number): Line[] {
  // Thinking notices paint the ▌ marker and italic body on the TRANSPARENT
  // terminal background (renderConversationNotice passes no bodyBg), so both
  // colours resolve per render from the active theme: the accent is the
  // theme's reasoning token and the body its faint text token (which replaces
  // the SGR dim this block used to apply).
  const t = activeUiTones();
  return renderConversationNotice(
    text,
    width,
    {
      accent: t.state.reasoning,
      text: t.chrome.faint,
      italic: true,
    },
    BORDERS.THINKING.char,
  );
}
