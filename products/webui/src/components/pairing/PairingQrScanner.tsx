/**
 * PairingQrScanner, scan a pairing QR with this device's camera.
 *
 * This is the replacement for the retired Android companion app, whose whole
 * job was pointing a camera at the QR that `goodvibes pair` (or the desktop
 * app's pairing panel) puts on a screen. A phone browser can do the same thing,
 * with one condition the native app did not have: the camera needs a secure
 * context, so a web UI served over plain http cannot scan. That case gets its
 * own wording pointing at Tailscale, because it is the difference between "this
 * is broken" and "serve the app over HTTPS and it works".
 *
 * The component only DECODES and PARSES. It hands a validated ScannedPairing to
 * onScanned and lets the sign-in screen route it into the paths it already has;
 * it never signs anyone in itself, and it never reads or renders the secret it
 * just carried.
 *
 * Camera hygiene: the stream is stopped on cancel, on a successful scan, and in
 * the effect cleanup that runs on unmount. Combined with Modal unmounting its
 * children when closed, that means the camera is never live while the dialog is
 * not on screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff } from 'lucide-react';
import { formatError } from '../../lib/errors';
import { parseScannedPairing, type ScannedPairing } from '../../lib/pairing-qr';
import {
  openScannerCamera,
  readPairingScannerBindings,
  stopScannerCamera,
  type PairingScannerBindings,
  type ScannerFailure,
} from '../../lib/pairing-qr-camera';
import type { QrDetector } from '../../lib/pairing-qr-detector';
import { Button } from '../ui/Button';
import '../../styles/components/pairing-scanner.css';

/** How often a frame is pulled off the preview and handed to the decoder. */
const SCAN_INTERVAL_MS = 180;

type ScanPhase =
  | { readonly status: 'starting' }
  | { readonly status: 'scanning' }
  | { readonly status: 'unreadable'; readonly message: string }
  | { readonly status: 'failed'; readonly failure: ScannerFailure };

export interface PairingQrScannerProps {
  /** Called once with a validated payload. The scanner has already stopped the camera. */
  onScanned: (scanned: ScannedPairing) => void;
  /** Called when the person backs out without scanning anything. */
  onCancel: () => void;
  /** Injected in tests; defaults to the live browser. */
  bindings?: PairingScannerBindings;
}

const FAILURE_TITLES: Readonly<Record<ScannerFailure, string>> = {
  'insecure-context': 'Scanning needs a secure (HTTPS) connection',
  'no-camera-api': 'This browser does not offer camera access',
  'permission-denied': 'This page does not have permission to use the camera',
  'no-camera': 'No camera was found on this device',
  'camera-busy': 'The camera is already in use',
  'camera-failed': 'The camera could not be started',
  'no-detector': 'This browser has no QR decoder available',
};

function FailureBody({ failure }: { failure: ScannerFailure }) {
  switch (failure) {
    case 'insecure-context':
      return (
        <p>
          Browsers only hand the camera to pages on a secure origin, and this page is on
          plain http. Serve the daemon over HTTPS and scanning works: on the machine
          running the daemon, <code>tailscale serve --bg 3421</code> gives you an https
          address on your tailnet, then open the app there. See
          {' '}<code>docs/deployment.md</code> under "Moving the host: reaching the
          daemon over Tailscale". Until then, paste the operator token instead.
        </p>
      );
    case 'no-camera-api':
      return (
        <p>
          This browser does not expose a camera to web pages at all. Use a different
          browser, or paste the operator token instead.
        </p>
      );
    case 'permission-denied':
      return (
        <p>
          Allow camera access for this site and try again. On a phone the permission is
          usually behind the padlock or the "site settings" item in the address
          bar. You can also paste the operator token instead.
        </p>
      );
    case 'no-camera':
      return (
        <p>
          The browser reported no usable camera on this device. Paste the operator token
          instead.
        </p>
      );
    case 'camera-busy':
      return (
        <p>
          Another app or tab is holding the camera. Close it and try again, or paste the
          operator token instead.
        </p>
      );
    case 'camera-failed':
      return (
        <p>
          The camera opened but would not start. Try again, or paste the operator token
          instead.
        </p>
      );
    case 'no-detector':
      return (
        <p>
          This browser has no built-in QR decoder, and the bundled one could not be
          loaded. Reload the page while online and try again, or paste the operator token
          instead.
        </p>
      );
  }
}

export function PairingQrScanner({ onScanned, onCancel, bindings }: PairingQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Pauses the decode loop without tearing the camera down, so "Try again" after
  // an unrecognized QR resumes instantly instead of re-prompting for permission.
  const pausedRef = useRef(false);
  const [phase, setPhase] = useState<ScanPhase>({ status: 'starting' });

  // Resolved once per mount via a lazy initializer: re-reading the live browser
  // surface on every render would hand the effect a new object every time and
  // restart the camera mid-scan.
  const [active] = useState<PairingScannerBindings>(() => bindings ?? readPairingScannerBindings());

  // The success callback is read through a ref so a parent that passes an inline
  // arrow does not restart the camera on every one of its own renders.
  const onScannedRef = useRef(onScanned);
  useEffect(() => {
    onScannedRef.current = onScanned;
  }, [onScanned]);

  useEffect(() => {
    // One mutable record owns this run's lifetime, rather than three separate
    // `let`s. Every await below is a point where the dialog may already have
    // closed, so each one is followed by an isCancelled() check before anything
    // else happens.
    const session: {
      cancelled: boolean;
      stream: MediaStream | null;
      timer: ReturnType<typeof setTimeout> | null;
    } = { cancelled: false, stream: null, timer: null };

    // Read through a call, not as a field. The flag is only ever set from the
    // cleanup path, which runs between an await and its continuation, so
    // reading it directly makes every post-await check look statically dead.
    const isCancelled = (): boolean => session.cancelled;

    function stopEverything(): void {
      session.cancelled = true;
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = null;
      stopScannerCamera(session.stream);
      session.stream = null;
    }

    /** Returns true when the scan is finished and the loop must not resume. */
    function consume(text: string): boolean {
      let scanned: ScannedPairing;
      try {
        scanned = parseScannedPairing(text);
      } catch (error) {
        // The decoded text is never put in this message: an unrecognized QR can
        // be anyone's, and the one thing it might be is somebody's credential.
        setPhase({ status: 'unreadable', message: formatError(error) });
        return false;
      }
      stopEverything();
      onScannedRef.current(scanned);
      return true;
    }

    /** One frame the decoder choked on is not a failure state; the next tick gets a fresh one. */
    async function decodeFrame(decoder: QrDetector, frame: ImageData): Promise<string | null> {
      try {
        return await decoder.detect(frame);
      } catch {
        return null;
      }
    }

    // The decoder rides in as an argument rather than being captured, so the
    // loop does not depend on narrowing surviving into a hoisted declaration.
    async function tick(decoder: QrDetector): Promise<void> {
      if (isCancelled()) return;
      if (!pausedRef.current) {
        const element = videoRef.current;
        const frame = element ? active.grabFrame(element) : null;
        if (frame) {
          const text = await decodeFrame(decoder, frame);
          if (isCancelled()) return;
          if (text && consume(text)) return;
          // Reached only when the QR decoded but was not ours: hold here until
          // "Try again" clears the pause, rather than re-reporting every tick.
          if (text) pausedRef.current = true;
        }
      }
      session.timer = setTimeout(() => void tick(decoder), SCAN_INTERVAL_MS);
    }

    async function start(): Promise<void> {
      const camera = await openScannerCamera(active);
      if (isCancelled()) {
        if (camera.ok) stopScannerCamera(camera.stream);
        return;
      }
      if (!camera.ok) {
        setPhase({ status: 'failed', failure: camera.failure });
        return;
      }
      session.stream = camera.stream;

      const detector = await active.createDetector();
      if (isCancelled()) {
        stopEverything();
        return;
      }
      if (!detector) {
        // Nothing can be decoded, so the camera must not stay open behind a
        // dead-end message.
        stopEverything();
        setPhase({ status: 'failed', failure: 'no-detector' });
        return;
      }

      const video = videoRef.current;
      if (video) {
        try {
          await active.attachPreview(video, camera.stream);
        } catch {
          // A preview that will not start is not fatal on its own; the decode
          // loop reads frames from the same element and reports its own trouble.
        }
      }
      if (isCancelled()) {
        stopEverything();
        return;
      }
      setPhase({ status: 'scanning' });
      void tick(detector);
    }

    void start();
    return stopEverything;
  }, [active]);

  const retry = useCallback(() => {
    pausedRef.current = false;
    setPhase({ status: 'scanning' });
  }, []);

  const showPreview = phase.status !== 'failed';

  return (
    <div className="pairing-scanner">
      {showPreview ? (
        <div className="pairing-scanner__stage">
          {/* A live camera preview has no caption track to offer; the scan
              outcome is announced in the role="status"/role="alert" text below. */}
          <video
            ref={videoRef}
            className="pairing-scanner__video"
            // No audio track is ever requested, but a muted element is what lets
            // autoplay start without a gesture on every browser that gates it.
            muted
            playsInline
            aria-label="Camera preview"
          />
          <div className="pairing-scanner__reticle" aria-hidden="true" />
        </div>
      ) : null}

      {phase.status === 'starting' ? (
        <p className="pairing-scanner__status" role="status">
          <Camera size={14} aria-hidden="true" /> Starting the camera&hellip;
        </p>
      ) : null}

      {phase.status === 'scanning' ? (
        <p className="pairing-scanner__status" role="status">
          <Camera size={14} aria-hidden="true" /> Point the camera at the QR code.
        </p>
      ) : null}

      {phase.status === 'unreadable' ? (
        <div className="banner warning" role="alert">
          {phase.message}. Line up the pairing QR from <code>goodvibes pair</code> or the
          desktop app&rsquo;s pairing panel and try again.
        </div>
      ) : null}

      {phase.status === 'failed' ? (
        <div className="pairing-scanner__failure" role="alert">
          <p className="pairing-scanner__failure-title">
            <CameraOff size={16} aria-hidden="true" /> {FAILURE_TITLES[phase.failure]}
          </p>
          <FailureBody failure={phase.failure} />
        </div>
      ) : null}

      <div className="pairing-scanner__actions">
        {phase.status === 'unreadable' ? (
          <Button onClick={retry}>
            Try again
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onCancel}>
          {phase.status === 'failed' ? 'Back to sign-in' : 'Cancel'}
        </Button>
      </div>
    </div>
  );
}
