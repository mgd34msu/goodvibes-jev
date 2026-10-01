/**
 * pairing-qr-camera.ts, the browser surface the pairing scanner needs.
 *
 * Same shape and the same reason as device-node/capability-bindings.ts's
 * BrowserBindings: the camera, the preview element, and the frame grab are
 * gathered behind one injected record so the scanner component can be driven in
 * a test without a real camera, and so the one file that knows it is running in
 * a browser is this one rather than the component.
 *
 * Availability is reported honestly, the same way capability-bindings.ts does
 * it: getUserMedia is probed BY TYPE on navigator.mediaDevices (reading the
 * method off the object to test its truthiness hands around an unbound
 * reference), and a non-secure origin is reported as such instead of being
 * discovered as a confusing permission rejection.
 */

import { createQrDetector, type QrDetector } from './pairing-qr-detector';

/** Why a scan could not start, or could not continue. */
export type ScannerFailure =
  | 'insecure-context'
  | 'no-camera-api'
  | 'permission-denied'
  | 'no-camera'
  | 'camera-busy'
  | 'camera-failed'
  | 'no-detector';

/** Everything the scanner touches outside React. Injected so tests supply their own. */
export interface PairingScannerBindings {
  readonly isSecureContext: boolean;
  readonly mediaDevices?: MediaDevices | undefined;
  /** Pick a QR decoder for this browser, or null when none is usable. */
  readonly createDetector: () => Promise<QrDetector | null>;
  /** Point the preview element at a live stream and start it playing. */
  readonly attachPreview: (video: HTMLVideoElement, stream: MediaStream) => Promise<void>;
  /** Read the current frame as pixels, or null while the video has no frame yet. */
  readonly grabFrame: (video: HTMLVideoElement) => ImageData | null;
}

/** Longest edge the frame handed to a decoder is scaled to. */
const FRAME_MAX_EDGE = 640;

async function attachPreview(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.srcObject = stream;
  video.muted = true;
  // Without playsInline, iOS Safari takes the video fullscreen the moment it
  // plays, which hides the surrounding cancel button and failure text.
  video.playsInline = true;
  await video.play();
}

function grabFrame(video: HTMLVideoElement): ImageData | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  // Zero until the first frame is decoded; there is nothing to read yet.
  if (!sourceWidth || !sourceHeight) return null;

  // Downscaled before decoding: a pure-JS decoder's cost is per-pixel, and a QR
  // that fills a reasonable part of a 640px frame decodes just as reliably as
  // one in a 1080p frame while costing a fraction of the work per tick.
  const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/** Read the live browser's surface. Kept separate so tests supply their own. */
export function readPairingScannerBindings(): PairingScannerBindings {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
    mediaDevices: nav?.mediaDevices,
    createDetector: createQrDetector,
    attachPreview,
    grabFrame,
  };
}

/**
 * Map a getUserMedia rejection onto a failure this screen has wording for.
 *
 * The error's own message is deliberately NOT surfaced: browsers word these
 * inconsistently ("Permission denied", "Permission dismissed", "The request is
 * not allowed by the user agent"), and every one of them means the same thing
 * to the person holding the phone.
 */
export function classifyCameraError(error: unknown): ScannerFailure {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'camera-busy';
    default:
      return 'camera-failed';
  }
}

/**
 * Open the rear camera, or report why it could not be opened.
 *
 * `facingMode: 'environment'` is a hint, not an exact constraint, so a laptop
 * with only a front camera still gets a working scan rather than an
 * over-constrained rejection.
 */
export async function openScannerCamera(
  bindings: PairingScannerBindings,
): Promise<{ ok: true; stream: MediaStream } | { ok: false; failure: ScannerFailure }> {
  if (!bindings.isSecureContext) return { ok: false, failure: 'insecure-context' };
  if (typeof bindings.mediaDevices?.getUserMedia !== 'function') {
    return { ok: false, failure: 'no-camera-api' };
  }
  try {
    const stream = await bindings.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    return { ok: true, stream };
  } catch (error) {
    return { ok: false, failure: classifyCameraError(error) };
  }
}

/** Stop every track on a stream. Safe to call more than once. */
export function stopScannerCamera(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
