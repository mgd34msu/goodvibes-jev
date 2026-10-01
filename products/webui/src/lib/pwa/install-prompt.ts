/**
 * install-prompt.ts, add-to-home-screen, honest per platform.
 *
 * Chromium fires `beforeinstallprompt`, which we capture and replay behind an
 * explicit "Install app" button (Chrome swallows the automatic banner once we
 * preventDefault). iOS Safari does NOT fire it and has no programmatic install
 * at all, the only path is the Share → "Add to Home Screen" menu, so on iOS we
 * surface those plain instructions instead of a button that would do nothing.
 *
 * Already-installed (running in standalone display mode) reports as such, so we
 * never offer to install an app that is already installed.
 */

import { useCallback, useEffect, useState } from 'react';

/** The Chromium beforeinstallprompt event (not in the DOM lib types). */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallAffordance = 'prompt' | 'ios-instructions' | 'installed' | 'none';

export interface InstallPlatformEnv {
  readonly userAgent: string;
  readonly standalone: boolean;
  readonly hasPromptEvent: boolean;
}

/**
 * True for iOS devices (iPhone/iPad/iPod). Every iOS browser is WebKit and none
 * fires `beforeinstallprompt`, so the add-to-home-screen path is always the
 * Share-menu one there, the specific browser does not matter.
 */
export function isIos(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent);
}

/** Which install affordance to show, from the platform + captured-event state. */
export function resolveInstallAffordance(env: InstallPlatformEnv): InstallAffordance {
  if (env.standalone) return 'installed';
  if (env.hasPromptEvent) return 'prompt';
  if (isIos(env.userAgent)) return 'ios-instructions';
  return 'none';
}

function readStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const displayStandalone = typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return displayStandalone || iosStandalone;
}

export interface UseInstallPrompt {
  readonly affordance: InstallAffordance;
  /** Replay the captured Chromium prompt; resolves to the user's choice. */
  readonly promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): UseInstallPrompt {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState<boolean>(() => readStandalone());

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setPromptEvent(null);
      setStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!promptEvent) return 'unavailable' as const;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    setPromptEvent(null);
    return choice.outcome;
  }, [promptEvent]);

  const affordance = resolveInstallAffordance({
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    standalone,
    hasPromptEvent: promptEvent !== null,
  });

  return { affordance, promptInstall };
}
