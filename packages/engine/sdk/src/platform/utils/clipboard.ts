import { logger } from './logger.js';
import { summarizeError } from './error-display.js';

/** Bytes that open a file of each image type, as each format defines it. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

function startsWithBytes(data: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (data.length < offset + signature.length) return false;
  return signature.every((byte, index) => data[offset + index] === byte);
}

function startsWithText(data: Uint8Array, text: string, offset = 0): boolean {
  return startsWithBytes(data, [...text].map((char) => char.charCodeAt(0)), offset);
}

/**
 * isImageData - Whether `data` is image data of `mediaType`: it opens with the
 * signature that format defines (PNG 89 50 4E 47 0D 0A 1A 0A, JPEG FF D8 FF,
 * GIF "GIF87a" or "GIF89a", WebP "RIFF" with "WEBP" at byte 8). A clipboard
 * tool that answers with an error text, an empty buffer or another format's
 * bytes for the requested type is not an image of that type.
 */
export function isImageData(data: Uint8Array, mediaType: string): boolean {
  switch (mediaType) {
    case 'image/png':
      return startsWithBytes(data, PNG_SIGNATURE);
    case 'image/jpeg':
      return startsWithBytes(data, JPEG_SIGNATURE);
    case 'image/gif':
      return startsWithText(data, 'GIF87a') || startsWithText(data, 'GIF89a');
    case 'image/webp':
      return startsWithText(data, 'RIFF') && startsWithText(data, 'WEBP', 8);
    default:
      return false;
  }
}

/**
 * ClipboardWriteFunction - Type for surface-specific clipboard write implementations.
 * Surfaces (e.g., TUI) inject their own implementation (e.g., OSC 52 for terminals).
 */
export type ClipboardWriteFunction = (text: string) => void;

/**
 * missingClipboardReaderHint - Why the clipboard could not be read, in words a
 * person can act on, or undefined when the tooling to read it is present.
 *
 * A terminal cannot be handed an image by the terminal itself: bracketed paste
 * and OSC 52 carry text, so a pasted image has to be read from the system
 * clipboard directly. On Linux that means a helper program, and when it is
 * absent the honest answer names the package rather than reporting an empty
 * clipboard, "nothing happened" is what an uninstalled package looked like
 * before this existed.
 */
export function missingClipboardReaderHint(
  env: { readonly platform?: string; readonly wayland?: boolean; readonly has?: (tool: string) => boolean } = {},
): string | undefined {
  const platform = env.platform ?? process.platform;
  if (platform !== 'linux') return undefined;
  const has = env.has ?? ((tool: string): boolean => {
    try {
      return Bun.which(tool) !== null;
    } catch {
      return false;
    }
  });
  if (has('wl-paste') || has('xclip')) return undefined;
  const wayland = env.wayland ?? Boolean(process.env['WAYLAND_DISPLAY']);
  const preferred = wayland
    ? 'wl-clipboard (this session is Wayland)'
    : 'xclip (this session is X11)';
  return (
    `No clipboard reader is installed, so images cannot be read from the clipboard. `
    + `Install ${preferred}, for example "sudo pacman -S wl-clipboard" on Arch or `
    + `"sudo apt install wl-clipboard" on Debian and Ubuntu. Use xclip instead if you run X11.`
  );
}

const IMAGE_MIME_TYPES: { mime: string; mediaType: string }[] = [
  { mime: 'image/png', mediaType: 'image/png' },
  { mime: 'image/jpeg', mediaType: 'image/jpeg' },
  { mime: 'image/webp', mediaType: 'image/webp' },
  { mime: 'image/gif', mediaType: 'image/gif' },
];

type ClipboardAttempt = {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr?: string | undefined;
};

function bytesToString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  return String(value);
}

function recordClipboardAttempt(
  attempts: ClipboardAttempt[],
  command: string,
  result: { readonly exitCode: number | null; readonly stderr?: unknown },
): void {
  if (attempts.length >= 8) return;
  const stderr = bytesToString(result.stderr).trim();
  attempts.push({
    command,
    exitCode: result.exitCode,
    stderr: stderr ? stderr.slice(0, 300) : undefined,
  });
}

function logClipboardAttempts(message: string, attempts: readonly ClipboardAttempt[]): void {
  if (attempts.length === 0) return;
  logger.debug(message, { attempts: [...attempts] });
}

/**
 * pasteFromClipboard - Attempts to read from system clipboard using platform tools.
 */
export function pasteFromClipboard(): string {
  const attempts: ClipboardAttempt[] = [];
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) then xclip (X11)
      const wl = Bun.spawnSync(['wl-paste', '--no-newline'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (wl.exitCode === 0 && wl.stdout) {
        return Buffer.from(wl.stdout).toString();
      }
      recordClipboardAttempt(attempts, 'wl-paste', wl);
      const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-o'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (xclip.exitCode === 0 && xclip.stdout) {
        return Buffer.from(xclip.stdout).toString();
      }
      recordClipboardAttempt(attempts, 'xclip', xclip);
    } else if (process.platform === 'darwin') {
      const pb = Bun.spawnSync(['pbpaste'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (pb.exitCode === 0 && pb.stdout) {
        return Buffer.from(pb.stdout).toString();
      }
      recordClipboardAttempt(attempts, 'pbpaste', pb);
    }
  } catch (err: unknown) {
    logger.error('Clipboard: Paste failed', { error: summarizeError(err) });
  }
  logClipboardAttempts('Clipboard text read returned no data', attempts);
  return '';
}

/**
 * pasteImageFromClipboard - Attempts to read image data from system clipboard.
 * Returns base64-encoded image data and mediaType, or null if no image is available.
 */
export function pasteImageFromClipboard(): { data: string; mediaType: string } | null {
  const attempts: ClipboardAttempt[] = [];
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) for each supported MIME type
      for (const { mime, mediaType } of IMAGE_MIME_TYPES) {
        const wl = Bun.spawnSync(['wl-paste', '--type', mime, '--no-newline'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 3000,
        });
        if (wl.exitCode === 0 && wl.stdout) {
          const buf = Buffer.from(wl.stdout);
          if (isImageData(buf, mediaType)) {
            return { data: buf.toString('base64'), mediaType };
          }
        }
        recordClipboardAttempt(attempts, `wl-paste ${mime}`, wl);
      }
      // Try xclip (X11) for each supported MIME type
      for (const { mime, mediaType } of IMAGE_MIME_TYPES) {
        const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-t', mime, '-o'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 3000,
        });
        if (xclip.exitCode === 0 && xclip.stdout) {
          const buf = Buffer.from(xclip.stdout);
          if (isImageData(buf, mediaType)) {
            return { data: buf.toString('base64'), mediaType };
          }
        }
        recordClipboardAttempt(attempts, `xclip ${mime}`, xclip);
      }
    } else if (process.platform === 'darwin') {
      // macOS: try pngpaste first (brew install pngpaste), then fall back to osascript
      const pp = Bun.spawnSync(['pngpaste', '-'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (pp.exitCode === 0 && pp.stdout) {
        const ppBuf = Buffer.from(pp.stdout);
        if (isImageData(ppBuf, 'image/png')) {
          return { data: ppBuf.toString('base64'), mediaType: 'image/png' };
        }
      }
      recordClipboardAttempt(attempts, 'pngpaste', pp);
      // Next try osascript, which reads clipboard as PNG hex data.
      // Output format: «data PNGf<hex>», extract hex after 'PNGf'
      const osa = Bun.spawnSync(
        ['osascript', '-e', 'the clipboard as «class PNGf»'],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 5000,
        },
      );
      if (osa.exitCode === 0 && osa.stdout) {
        const raw = Buffer.from(osa.stdout).toString('utf8').trim();
        // raw is like: «data PNGf89504e47...»
        const match = raw.match(/«data PNGf([0-9a-fA-F]+)»/);
        if (match) {
          const osaBuf = Buffer.from(match[1]!, 'hex');
          if (isImageData(osaBuf, 'image/png')) {
            return { data: osaBuf.toString('base64'), mediaType: 'image/png' };
          }
        }
      }
      recordClipboardAttempt(attempts, 'osascript PNGf', osa);
    }
  } catch (err: unknown) {
    logger.warn('Clipboard image access failed', { error: summarizeError(err) });
  }
  logClipboardAttempts('Clipboard image read returned no data', attempts);
  return null;
}
