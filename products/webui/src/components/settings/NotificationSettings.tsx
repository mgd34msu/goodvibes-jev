/**
 * NotificationSettings, the settings-area surface for Web Push + install.
 *
 * Two capabilities, each with honest per-state copy (never a dead toggle):
 *
 *   Push notifications, subscribe/unsubscribe this device for the approval and
 *   completion pushes the daemon fans out. Every "can't" is named: an insecure
 *   context points at HTTPS (the Tailscale-serve pointer the dictation surface
 *   already uses); a blocked permission explains how to re-enable it; an
 *   unsupported browser says so plainly (iOS has real web-push caveats).
 *
 *   Install, add-to-home-screen. A button on Chromium (replaying the captured
 *   beforeinstallprompt); the Share-menu instructions on iOS; nothing when the
 *   app is already installed.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, BellOff, Send, ShieldAlert } from 'lucide-react';
import {
  currentSubscription,
  describePushSubscribeError,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
} from '../../lib/push/push-client';
import { detectPushSupport, readNotificationPermission } from '../../lib/push/push-support';
import type { PushSupport, NotificationPermissionState } from '../../lib/push/push-support';
import { useInstallPrompt } from '../../lib/pwa/install-prompt';
import { capabilityReason, useOriginPosture } from '../../hooks/useOriginPosture';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { SettingRow, SettingsBlock } from './dialog/parts';
import '../../styles/components/notifications.css';

const pushErrorMessage = describePushSubscribeError;

// The honest fallback while pairing.posture.get hasn't answered yet (or errored), still
// true, just less specific than the daemon's own wording about ITS deployment.
const PUSH_INSECURE_FALLBACK =
  'Web Push needs a secure (HTTPS) connection. Open this app over HTTPS, for a home '
  + 'machine, tailscale serve fronts the daemon with an HTTPS hostname, and push then '
  + 'works same-origin.';
const INSTALL_INSECURE_FALLBACK =
  'Installing needs a secure (HTTPS) connection; this browser will not register a '
  + 'service worker over plain HTTP to a LAN address. Open this app over HTTPS (for '
  + 'example via Tailscale) to install it.';

export function NotificationSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Support + permission read the DOM; both detectors are SSR/test-safe (they
  // fall back to 'unsupported' when window/Notification are absent), so a lazy
  // initializer reads them once at mount without a cascading effect.
  const [support] = useState<PushSupport>(() => detectPushSupport());
  const [permission, setPermission] = useState<NotificationPermissionState>(() => readNotificationPermission());
  const { affordance, promptInstall } = useInstallPrompt();
  // pairing.posture.get is the daemon's own labeled-degradation reason for this exact
  // origin ("needs https, available via tailscale"), never a client-fabricated guess.
  // The fallbacks above cover the brief window before it answers.
  const { posture } = useOriginPosture();
  const pushReason = capabilityReason(posture, 'push') ?? PUSH_INSECURE_FALLBACK;
  // Chromium never fires beforeinstallprompt over an insecure origin (its service worker
  // never registers there, register-sw.ts's shouldRegisterServiceWorker), so 'none' on a
  // non-iOS browser is ambiguous between "insecure origin" and "just no prompt yet". The
  // origin's own secureContext answers which one this is.
  const installBlockedByInsecureOrigin = affordance === 'none' && posture !== undefined && !posture.secureContext;
  const installReason = capabilityReason(posture, 'service-worker') ?? INSTALL_INSECURE_FALLBACK;

  const subscribed = useQuery({
    queryKey: ['push', 'subscribed'],
    queryFn: async () => (await currentSubscription()) !== null,
    enabled: support === 'ok',
  });

  const subscribe = useMutation({
    mutationFn: subscribeToPush,
    onSuccess: async () => {
      setPermission(readNotificationPermission());
      await queryClient.invalidateQueries({ queryKey: ['push', 'subscribed'] });
      toast({ title: 'Notifications on', description: 'This device will receive approval and completion pushes.', tone: 'success' });
    },
    onError: (error) => {
      setPermission(readNotificationPermission());
      toast({ title: 'Could not enable notifications', description: pushErrorMessage(error), tone: 'danger' });
    },
  });

  const unsubscribe = useMutation({
    mutationFn: unsubscribeFromPush,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['push', 'subscribed'] });
      toast({ title: 'Notifications off', description: 'This device will no longer receive pushes.', tone: 'success' });
    },
    onError: (error) => {
      toast({ title: 'Could not disable notifications', description: pushErrorMessage(error), tone: 'danger' });
    },
  });

  const test = useMutation({
    mutationFn: sendTestPush,
    onSuccess: () => toast({ title: 'Test push sent', description: 'Watch for a notification on this device.', tone: 'success' }),
    onError: (error) => toast({ title: 'Test push failed', description: pushErrorMessage(error), tone: 'danger' }),
  });

  const isSubscribed = subscribed.data === true;

  return (
    <SettingsBlock className="notifications-panel" title="Notifications & install">
      {support === 'insecure-context' ? (
        <div className="banner warning" role="status">
          <ShieldAlert size={16} aria-hidden="true" /> {pushReason}
        </div>
      ) : support === 'unsupported' ? (
        <div className="banner warning" role="status">
          <ShieldAlert size={16} aria-hidden="true" />{' '}
          This browser does not support Web Push. On iOS, add the app to your Home Screen first;
          iOS delivers push only to an installed app (iOS 16.4+).
        </div>
      ) : (
        <div className="notifications-push">
          {permission === 'denied' && (
            <div className="banner warning" role="status">
              <BellOff size={16} aria-hidden="true" />{' '}
              Notifications are blocked for this site. Re-enable them in your browser&rsquo;s
              site settings to subscribe.
            </div>
          )}
          <div className="settings-rows">
            <SettingRow
              label="Push notifications"
              description="Get an approval or completion as a notification on this device, even when the app isn’t open. They come straight from your daemon; nothing is stored elsewhere."
              control={(
                <div className="notifications-actions">
                  {isSubscribed ? (
                    <>
                      <Button
                        size="sm"
                        icon={<Send aria-hidden="true" />}
                        disabled={test.isPending}
                        onClick={() => test.mutate()}
                      >
                        {test.isPending ? 'Sending…' : 'Send a test push'}
                      </Button>
                      <Button
                        size="sm"
                        icon={<BellOff aria-hidden="true" />}
                        disabled={unsubscribe.isPending}
                        onClick={() => unsubscribe.mutate()}
                      >
                        {unsubscribe.isPending ? 'Turning off…' : 'Turn off notifications'}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<BellRing aria-hidden="true" />}
                      disabled={subscribe.isPending || permission === 'denied'}
                      onClick={() => subscribe.mutate()}
                    >
                      {subscribe.isPending ? 'Enabling…' : 'Turn on notifications'}
                    </Button>
                  )}
                </div>
              )}
            />
          </div>
        </div>
      )}

      <div className="notifications-install">
        {installBlockedByInsecureOrigin ? (
          <div className="banner warning" role="status">
            <ShieldAlert size={16} aria-hidden="true" /> {installReason}
          </div>
        ) : null}
        <div className="settings-rows">
          <SettingRow
            label="Install this app"
            description={
              affordance === 'installed' ? 'This app is installed and running from your Home Screen.'
                : affordance === 'ios-instructions' ? (
                  <>
                    To install on iOS: tap the Share button, then <strong>Add to Home Screen</strong>.
                    Open the installed app once to enable notifications.
                  </>
                )
                  : affordance === 'prompt' ? 'Adds this app to your Home Screen or apps.'
                    : installBlockedByInsecureOrigin ? undefined
                      : 'Use your browser’s menu to add this app to your Home Screen or apps.'
            }
            control={affordance === 'prompt' ? (
              <Button size="sm" onClick={() => void promptInstall()}>
                Add to Home Screen
              </Button>
            ) : null}
          />
        </div>
      </div>
    </SettingsBlock>
  );
}
