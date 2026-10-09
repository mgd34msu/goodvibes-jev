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

import { useCallback, useEffect, useRef, useState } from 'react';

import { readInstallPlatform, type InstallPlatform, type PlatformResult } from './platform-judgment';
import { subscribeClientLifetime } from '../client-lifetime';

/** The Chromium beforeinstallprompt event (not in the DOM lib types). */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallAffordance = 'prompt' | 'ios-instructions' | 'installed' | 'none';

export interface InstallPlatformEnv {
  readonly platform?: InstallPlatform;
  readonly standalone: boolean;
  readonly hasPromptEvent: boolean;
}

/** Which install affordance to show, from the platform + captured-event state. */
export function resolveInstallAffordance(env: InstallPlatformEnv): InstallAffordance {
  if (env.standalone) return 'installed';
  if (env.hasPromptEvent) return 'prompt';
  if (env.platform === 'ios-share-menu') return 'ios-instructions';
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

  const [platform, setPlatform] = useState<PlatformResult>({ status: 'held' });
  const [identityRevision, setIdentityRevision] = useState(0);
  const currentPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const prompting = useRef(false);
  useEffect(() => subscribeClientLifetime(() => { setPlatform({ status: 'held' }); setIdentityRevision(value => value + 1); }), []);
  useEffect(() => {
    if (standalone || promptEvent) return;
    const abort = new AbortController();
    void readInstallPlatform({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints ?? 0 }, abort.signal)
      .then(result => { if (!abort.signal.aborted) setPlatform(result); });
    return () => abort.abort();
  }, [standalone, promptEvent, identityRevision]);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      currentPrompt.current = event as BeforeInstallPromptEvent;
      setPromptEvent(currentPrompt.current);
    };
    const onInstalled = () => {
      currentPrompt.current = null;
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
    const event = currentPrompt.current;
    if (!event || prompting.current) return 'unavailable' as const;
    prompting.current = true;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice.outcome;
    } catch { return 'unavailable' as const; }
    finally {
      prompting.current = false;
      if (currentPrompt.current === event) { currentPrompt.current = null; setPromptEvent(null); }
    }
  }, []);

  const affordance = resolveInstallAffordance({
    platform: platform.status === 'ready' && platform.isCurrent() ? platform.platform : undefined,
    standalone,
    hasPromptEvent: promptEvent !== null,
  });

  return { affordance, promptInstall };
}
