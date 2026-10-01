import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { allowTerminalWrite } from '@goodvibes-jev/engine/terminal-shell';

/**
 * copyToClipboard - Uses OSC 52 escape sequence to copy text to the terminal clipboard.
 * Terminal-specific: only works in terminals that support OSC 52.
 */
export function copyToClipboard(text: string) {
  if (!text) return;
  logger.info('Clipboard: Attempting to copy via OSC 52', { length: text.length });
  try {
    const base64 = Buffer.from(text).toString('base64');
    const sequence = `\x1b]52;c;${base64}\x07`;
    allowTerminalWrite(() => process.stdout.write(sequence));
    logger.info('Clipboard: OSC 52 sequence written');
  } catch (err: unknown) {
    logger.error('Clipboard: OSC 52 copy failed', { error: summarizeError(err) });
  }
}

export { pasteFromClipboard, pasteImageFromClipboard, MIN_IMAGE_BYTES } from '@goodvibes-jev/engine/sdk/platform/utils';

// The detector lives beside the clipboard readers in the SDK; the agent's
// pinned platform runtime now carries it, so this file only re-exports.
export { missingClipboardReaderHint } from '@goodvibes-jev/engine/sdk/platform/utils';

