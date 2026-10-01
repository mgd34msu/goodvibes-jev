/**
 * startup-theme-probe.ts, apply the configured theme and install the
 * terminal probe at startup.
 *
 * Thin composition seam extracted from main.ts. The configured `display.theme`
 * applies before the first paint; then it binds installBackgroundThemeProbe to
 * theme.ts: setActiveThemeMode (applyThemeMode) so forced dark/light applies
 * before first paint and auto (TTY only) probes and repaints once if light wins,
 * and refreshForTerminalPalette (onTerminalPalette) so the `system` theme is
 * regenerated from the terminal's own colours (OSC 10 + OSC 4;0..15, read in
 * the same write on any TTY) and repainted once. The returned handle's
 * filterInput() must gate the stdin data handler so the replies never reach the
 * tokenizer.
 */

import { installBackgroundThemeProbe, type ThemeProbeHandle } from './terminal-bg-probe.ts';
import { refreshForTerminalPalette, registerThemeRefresh, setActiveThemeMode, setActiveThemeName } from './theme.ts';
import { resolveConfiguredThemeName } from './theme-mode-config.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

export interface StartupThemeProbeDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly stdout: NodeJS.WriteStream;
  /** The caller's terminal-output guard wrapper (allowTerminalWrite). */
  readonly writeAllowed: (write: () => void) => void;
  /** Reset the compositor diff so the repaint after a light reply is full. */
  readonly resetDiff: () => void;
  readonly render: () => void;
  /**
   * Mark the rendered transcript stale. Rendered lines carry concrete colours,
   * so every theme or mode change must re-render them on the next paint.
   */
  readonly invalidateTranscript: () => void;
  /** Where an Esc / Alt+] key held at a palette read's close goes (the input pipeline). */
  readonly forwardInput?: (bytes: string) => void;
}

export function installStartupThemeProbe(deps: StartupThemeProbeDeps): ThemeProbeHandle {
  registerThemeRefresh(deps.invalidateTranscript);
  // The configured theme applies before the first paint; the probe below
  // completes the resolution (mode, and the palette for `system`).
  setActiveThemeName(resolveConfiguredThemeName(deps.configManager));
  return installBackgroundThemeProbe({
    configManager: deps.configManager,
    applyThemeMode: setActiveThemeMode,
    probePalette: true,
    onTerminalPalette: refreshForTerminalPalette,
    isTTY: Boolean(deps.stdout.isTTY),
    writeQuery: (b) => deps.writeAllowed(() => deps.stdout.write(b)),
    requestRepaint: () => { deps.resetDiff(); deps.render(); },
    // A palette the terminal did not give at startup (tmux with no client
    // attached yet) is asked for again on resize, focus-in or input.
    subscribeResize: (listener) => { deps.stdout.on('resize', listener); },
    ...(deps.forwardInput ? { forwardInput: deps.forwardInput } : {}),
  });
}
