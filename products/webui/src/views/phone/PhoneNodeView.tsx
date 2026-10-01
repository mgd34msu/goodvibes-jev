/**
 * PhoneNodeView, this browser acting as a paired device node.
 *
 * Open it on a phone, pair once, and the phone's cameras, screen, location,
 * clipboard, and device commands become capabilities the agent can ask for.
 * The agent never gets them silently: the host confirms every capture and
 * effect with the person before any work reaches this page, and this page shows
 * an honest log of everything it served.
 *
 * What is announced is what this browser can actually do. A capability whose
 * API is missing, or that a browser gates behind a secure context this origin
 * does not have, is not announced at all, the desktop then says why it is
 * unavailable instead of offering a control that would fail.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { GOODVIBES_BASE_URL } from '../../lib/goodvibes';
import {
  PhoneNodeClient,
  browserPhoneNodeStorage,
  type PhoneNodeState,
} from '../../lib/device-node/phone-node-client';
import { RowGroup } from '../../components/data-view/DataView';
import { DeviceGrants } from '../../components/settings/DeviceGrants';
import { whenLabel } from '../../lib/when-label';
import { Button } from '../../components/ui/Button';
import { Row } from '../../components/ui/Row';
import { StatusDot } from '../../components/ui/StatusDot';
import '../../styles/components/device.css';

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  'device.camera.rear.capture': 'Rear camera picture',
  'device.camera.front.capture': 'Front camera picture',
  'device.screen.capture': 'Screen picture',
  'device.location.coarse': 'Approximate location',
  'device.location.precise': 'Precise location',
  'device.clipboard.read': 'Read the clipboard',
  'device.clipboard.write': 'Put text on the clipboard',
  'device.command.notify': 'Show a notification',
  'device.command.open_url': 'Open a link',
  'device.command.vibrate': 'Vibrate',
};

function defaultLabel(): string {
  if (typeof navigator === 'undefined') return 'Phone';
  const platform = navigator.platform || '';
  return platform ? `Phone (${platform})` : 'Phone';
}

type PhoneNodeActionKind = 'pair' | 'verify' | 'unpair';

/** The one header action for each pairing state that has one. */
const PHONE_NODE_ACTIONS: Readonly<Record<PhoneNodeActionKind, { label: string; primary: boolean }>> = {
  pair: { label: 'Pair this phone', primary: true },
  verify: { label: 'Finish pairing', primary: true },
  unpair: { label: 'Unpair this phone', primary: false },
};

export function PhoneNodeView() {
  const label = useMemo(() => defaultLabel(), []);
  const clientRef = useRef<PhoneNodeClient | null>(null);
  const [state, setState] = useState<PhoneNodeState | null>(null);

  useEffect(() => {
    const client = new PhoneNodeClient({
      baseUrl: GOODVIBES_BASE_URL,
      label,
      storage: browserPhoneNodeStorage(),
      onState: (next) => setState(next),
    });
    clientRef.current = client;
    setState(client.getState());
    if (client.getState().status === 'connected') client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [label]);

  useEffect(() => {
    if (state?.status === 'connected') clientRef.current?.start();
  }, [state?.status]);

  if (!state) return null;

  const secureContextOk = typeof window !== 'undefined' && window.isSecureContext;

  const actionKind: PhoneNodeActionKind | null = state.status === 'unpaired' || state.status === 'error'
    ? 'pair'
    : state.status === 'awaiting-approval'
      ? 'verify'
      : state.status === 'connected'
        ? 'unpair'
        : null;
  const action = actionKind ? PHONE_NODE_ACTIONS[actionKind] : null;

  // The client is read only here, when the button is pressed, never during render.
  function runAction(): void {
    const client = clientRef.current;
    if (!client) return;
    if (actionKind === 'pair') void client.requestPairing();
    else if (actionKind === 'verify') void client.verifyPairing();
    else if (actionKind === 'unpair') client.unpair();
  }

  return (
    <div className="view phone-node-view">
      <section className="device-page" aria-labelledby="phone-node-title">
        <header className="device-page__header">
          <div className="device-page__text">
            <h2 id="phone-node-title" className="device-page__title">This phone as a capability</h2>
            <p className="device-page__description">{state.message}</p>
          </div>
          {action ? (
            <Button variant={action.primary ? 'primary' : 'secondary'} onClick={runAction}>
              {action.label}
            </Button>
          ) : null}
        </header>

        {!secureContextOk ? (
          <div role="note" className="banner warning">
            This page is not on a secure connection, so the browser will not give it the camera,
            the screen, location, or the clipboard. Everything else still works. An https address
            (Tailscale gives you one without minting certificates) unlocks the rest.
          </div>
        ) : null}

        <RowGroup label="What this phone offers" count={state.announced.length}>
          {state.announced.length === 0 ? (
            <li className="device-page__empty">
              Nothing yet: this browser offers none of the device capabilities on this connection.
            </li>
          ) : (
            state.announced.map((id) => (
              <Row key={id} title={CAPABILITY_LABELS[id] ?? id} meta="Asks before every use" />
            ))
          )}
        </RowGroup>

        <RowGroup label="What this phone has served" count={state.activity.length}>
          {state.activity.length === 0 ? (
            <li className="device-page__empty">Nothing yet.</li>
          ) : (
            state.activity.map((entry) => (
              <Row
                key={`${String(entry.at)}-${entry.capabilityId}`}
                leading={<StatusDot tone={entry.ok ? 'ok' : 'bad'} />}
                title={CAPABILITY_LABELS[entry.capabilityId] ?? entry.capabilityId}
                meta={[entry.ok ? 'Served' : 'Refused', entry.detail, whenLabel(entry.at)].filter(Boolean).join(' · ')}
              />
            ))
          )}
        </RowGroup>
      </section>

      <DeviceGrants />
    </div>
  );
}
