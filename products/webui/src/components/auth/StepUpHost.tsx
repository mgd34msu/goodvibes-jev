/**
 * StepUpHost, the inline WebAuthn step-up ceremony, run at the point a mutating relay call
 * demands it.
 *
 * The transport layer (routedFetch) does not open modals; when a mutating relay call comes
 * back `401 step-up-required`, it calls the prompter this component registers. The prompter
 * opens a modal, runs the passkey ceremony (mint a server challenge, navigator.credentials.get,
 * encode the assertion header), and resolves the header value the transport then retries with.
 * Cancelling, or any ceremony failure, resolves null, so the original 401 surfaces honestly
 * rather than the call hanging or silently skipping verification.
 *
 * One ceremony runs at a time: a second requirement arriving while one is open is declined
 * (resolves null) rather than stacking a second modal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { sdk } from '../../lib/goodvibes';
import {
  describeStepUpError,
  getRegisteredCredential,
  runAssertion,
  stepUpAvailability,
} from '../../lib/stepup';
import { registerStepUpPrompter, type StepUpContext, type StepUpPrompter } from '../../lib/stepup-prompter';

export function StepUpHost() {
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const [request, setRequest] = useState<StepUpContext | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    setRunning(false);
    setError(null);
    resolve?.(value);
  }, []);

  const prompter = useCallback<StepUpPrompter>((context) => {
    // Only one ceremony at a time, decline a second requirement honestly rather than stack.
    if (resolverRef.current) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
      setRequest(context);
      setRunning(false);
      setError(null);
    });
  }, []);

  useEffect(() => {
    registerStepUpPrompter(prompter);
    return () => {
      registerStepUpPrompter(null);
      // If this host unmounts mid-ceremony, resolve any pending request so the caller does
      // not hang forever waiting on a prompter that no longer exists.
      resolverRef.current?.(null);
      resolverRef.current = null;
    };
  }, [prompter]);

  const verify = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const challenge = await sdk.operator.stepup.mintChallenge({});
      const registered = getRegisteredCredential();
      const { headerValue } = await runAssertion({
        challenge: challenge.challenge,
        credentialId: registered?.credentialId,
      });
      settle(headerValue);
    } catch (ceremonyError) {
      setRunning(false);
      setError(describeStepUpError(ceremonyError));
    }
  }, [settle]);

  if (!request) return null;

  const availability = stepUpAvailability();
  const registered = getRegisteredCredential();

  return (
    <Dialog
      open
      onClose={() => settle(null)}
      title="Verify to continue"
      footer={(
        <>
          <Button onClick={() => settle(null)} disabled={running}>
            Cancel
          </Button>
          {availability.supported && (
            <Button variant="primary" onClick={() => void verify()} disabled={running}>
              {running ? 'Waiting for passkey…' : 'Verify with passkey'}
            </Button>
          )}
        </>
      )}
    >
      <div className="stepup-ceremony">
        <p className="stepup-lead">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>This action changes something over the relay connection, so it needs a passkey confirmation.</span>
        </p>
        <p className="stepup-target">
          <code>{`${request.method} ${request.path}`}</code>
        </p>

        {!availability.supported ? (
          <div className="banner warning" role="alert">
            {availability.reason ?? 'Passkeys are not supported in this browser.'}
          </div>
        ) : !registered ? (
          <p className="stepup-note">
            No passkey is registered on this device yet. Your browser may still offer a saved
            passkey when you verify; otherwise register one first, in Settings under Account.
          </p>
        ) : null}

        {error && (
          <div className="banner warning" role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
