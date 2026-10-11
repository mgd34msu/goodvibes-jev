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

interface StepUpRequest {
  readonly context: StepUpContext;
  readonly resolve: (value: string | null) => void;
  readonly releaseAbort: () => void;
}

interface StepUpVerification {
  readonly request: StepUpRequest;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export function StepUpHost() {
  const requestRef = useRef<StepUpRequest | null>(null);
  const verificationRef = useRef<StepUpVerification | null>(null);
  const [request, setRequest] = useState<StepUpRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback((ownedRequest: StepUpRequest, value: string | null) => {
    if (requestRef.current !== ownedRequest) return;
    requestRef.current = null;
    ownedRequest.releaseAbort();
    const verification = verificationRef.current;
    if (value === null && verification?.request === ownedRequest) verification.controller.abort();
    setRequest(null);
    setRunning(false);
    setError(null);
    ownedRequest.resolve(value);
  }, []);

  const prompter = useCallback<StepUpPrompter>((context) => {
    // A cancelled verification still owns its native work until it settles.
    const signal = context.signal;
    if (signal?.aborted || requestRef.current || verificationRef.current) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const onAbort = () => settle(ownedRequest, null);
      const ownedRequest: StepUpRequest = { context, resolve,
        releaseAbort: () => signal?.removeEventListener('abort', onAbort) };
      requestRef.current = ownedRequest;
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { settle(ownedRequest, null); return; }
      setRequest(ownedRequest);
      setRunning(false);
      setError(null);
    });
  }, [settle]);

  useEffect(() => {
    registerStepUpPrompter(prompter);
    return () => {
      registerStepUpPrompter(null);
      const ownedRequest = requestRef.current;
      requestRef.current = null;
      ownedRequest?.releaseAbort();
      verificationRef.current?.controller.abort();
      ownedRequest?.resolve(null);
    };
  }, [prompter]);

  const verify = useCallback((ownedRequest: StepUpRequest) => {
    if (requestRef.current !== ownedRequest || verificationRef.current) return;
    const controller = new AbortController();
    const isCurrent = () => requestRef.current === ownedRequest && !controller.signal.aborted;
    setRunning(true);
    setError(null);
    const completion = Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) return;
        const challenge = await sdk.operator.stepup.mintChallenge({}, controller.signal);
        if (!isCurrent()) return;
        const registered = getRegisteredCredential();
        const { headerValue } = await runAssertion({
          challenge: challenge.challenge,
          credentialId: registered?.credentialId,
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        settle(ownedRequest, headerValue);
      } catch (ceremonyError) {
        if (!isCurrent()) return;
        setRunning(false);
        setError(describeStepUpError(ceremonyError));
      } finally {
        if (verificationRef.current?.controller === controller) verificationRef.current = null;
      }
    });
    verificationRef.current = { request: ownedRequest, controller, completion };
  }, [settle]);

  if (!request) return null;

  const availability = stepUpAvailability();
  const registered = getRegisteredCredential();

  return (
    <Dialog
      open
      onClose={() => settle(request, null)}
      title="Verify to continue"
      footer={(
        <>
          <Button onClick={() => settle(request, null)}>
            Cancel
          </Button>
          {availability.supported && (
            <Button variant="primary" onClick={() => verify(request)} disabled={running}>
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
          <code>{`${request.context.method} ${request.context.path}`}</code>
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
