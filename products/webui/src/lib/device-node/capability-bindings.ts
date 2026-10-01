/**
 * capability-bindings.ts, what this web app can actually do on a phone.
 *
 * The SDK's device capability contract says WHAT a capability is; this file is
 * the web platform's binding for each one, getUserMedia for the cameras,
 * getDisplayMedia for the screen, geolocation for location, the async clipboard
 * for clipboard, Notification/window.open/vibrate for device commands.
 *
 * This is the only file that knows it is running in a browser. A native node
 * for the same contract replaces exactly this file and nothing else: it pairs
 * with the same announcement, pulls the same work type, and returns the same
 * result shape. That is what "a native node is a drop-in peer, not a special
 * case" means in practice.
 *
 * Availability is reported honestly. A capability whose browser API is absent,
 * or whose origin is not a secure context, is simply not announced, the host
 * then labels it "not offered" or "needs https" instead of rendering a control
 * that would fail when pressed.
 */

/** Capability ids this binding implements, mirroring the SDK contract's ids. */
export type WebNodeCapabilityId =
  | 'device.camera.rear.capture'
  | 'device.camera.front.capture'
  | 'device.screen.capture'
  | 'device.location.coarse'
  | 'device.location.precise'
  | 'device.clipboard.read'
  | 'device.clipboard.write'
  | 'device.command.notify'
  | 'device.command.open_url'
  | 'device.command.vibrate';

/** The node kind this web app announces itself as. */
export const WEB_NODE_KIND = 'web-pwa';

/** Contract revision this node speaks. */
export const WEB_NODE_CONTRACT_VERSION = 1;

/** What one capability run produced. */
export interface CapabilityRunResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly data?: unknown;
  readonly mediaBase64?: string;
  readonly mediaType?: string;
}

/** Browser surface a binding needs; injected so the bindings are testable. */
export interface BrowserBindings {
  readonly isSecureContext: boolean;
  readonly mediaDevices?: MediaDevices | undefined;
  readonly geolocation?: Geolocation | undefined;
  readonly clipboard?: Clipboard | undefined;
  readonly notificationPermission?: NotificationPermission | undefined;
  readonly canNotify: boolean;
  readonly canVibrate: boolean;
  readonly canOpenWindow: boolean;
}

/** Read the live browser's surface. Kept separate so tests supply their own. */
export function readBrowserBindings(): BrowserBindings {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
    mediaDevices: nav?.mediaDevices,
    geolocation: nav?.geolocation,
    clipboard: nav?.clipboard,
    notificationPermission: typeof Notification === 'undefined' ? undefined : Notification.permission,
    canNotify: typeof Notification !== 'undefined',
    canVibrate: typeof nav?.vibrate === 'function',
    canOpenWindow: typeof window !== 'undefined' && typeof window.open === 'function',
  };
}

/**
 * Which capabilities this browser can serve right now.
 *
 * Secure-context-gated entries are dropped rather than announced-and-broken:
 * the host renders "needs https" from its own posture, and the person never
 * meets a control that cannot work.
 */
export function announcedCapabilities(bindings: BrowserBindings): WebNodeCapabilityId[] {
  const ids: WebNodeCapabilityId[] = [];
  // Probed by type, not by truthiness: reading the method off the object to
  // test it hands around an unbound reference, which is the same mistake as
  // calling it detached from navigator.mediaDevices.
  const canCapture =
    typeof bindings.mediaDevices?.getUserMedia === 'function' && bindings.isSecureContext;
  if (canCapture) {
    ids.push('device.camera.rear.capture', 'device.camera.front.capture');
  }
  if (typeof bindings.mediaDevices?.getDisplayMedia === 'function' && bindings.isSecureContext) {
    ids.push('device.screen.capture');
  }
  if (bindings.geolocation && bindings.isSecureContext) {
    ids.push('device.location.coarse', 'device.location.precise');
  }
  if (bindings.clipboard && bindings.isSecureContext) {
    if (typeof bindings.clipboard.readText === 'function') ids.push('device.clipboard.read');
    if (typeof bindings.clipboard.writeText === 'function') ids.push('device.clipboard.write');
  }
  if (bindings.canNotify && bindings.isSecureContext) ids.push('device.command.notify');
  if (bindings.canOpenWindow) ids.push('device.command.open_url');
  if (bindings.canVibrate) ids.push('device.command.vibrate');
  return ids;
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function bytesFromBlob(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Grab one frame from a live track, scale it, and encode it as a PNG. */
async function frameFromStream(stream: MediaStream, maxWidth: number | undefined): Promise<CapabilityRunResult> {
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    // One animation frame is enough for the first decoded frame to be painted.
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });

    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = maxWidth && maxWidth > 0 && sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return { ok: false, error: 'This browser could not open a 2D canvas to encode the picture.' };
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob((result) => resolve(result), 'image/png'); });
    if (!blob) return { ok: false, error: 'This browser could not encode the captured frame.' };
    return {
      ok: true,
      mediaBase64: await bytesFromBlob(blob),
      mediaType: 'image/png',
      data: { width: canvas.width, height: canvas.height },
    };
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

async function capturePhoto(bindings: BrowserBindings, facingMode: 'environment' | 'user', maxWidth: number | undefined): Promise<CapabilityRunResult> {
  if (!bindings.mediaDevices?.getUserMedia) return { ok: false, error: 'This browser does not offer camera access.' };
  const stream = await bindings.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
  return frameFromStream(stream, maxWidth);
}

async function captureScreen(bindings: BrowserBindings): Promise<CapabilityRunResult> {
  if (typeof bindings.mediaDevices?.getDisplayMedia !== 'function') {
    return { ok: false, error: 'This browser does not offer screen capture.' };
  }
  const stream = await bindings.mediaDevices.getDisplayMedia({ video: true, audio: false });
  return frameFromStream(stream, undefined);
}

async function readLocation(bindings: BrowserBindings, precise: boolean, maxAgeSeconds: number | undefined): Promise<CapabilityRunResult> {
  const geolocation = bindings.geolocation;
  if (!geolocation) return { ok: false, error: 'This browser does not offer location.' };
  return new Promise<CapabilityRunResult>((resolve) => {
    geolocation.getCurrentPosition(
      (position) => {
        // A coarse reading is deliberately rounded here, on the device, before
        // it ever leaves it, asking for "approximate" must not ship an exact
        // fix that a host then chooses to round.
        const round = precise ? (value: number): number => value : (value: number): number => Math.round(value * 100) / 100;
        resolve({
          ok: true,
          data: {
            latitude: round(position.coords.latitude),
            longitude: round(position.coords.longitude),
            accuracyMeters: precise ? position.coords.accuracy : Math.max(position.coords.accuracy, 1000),
            precision: precise ? 'precise' : 'coarse',
            capturedAt: position.timestamp,
          },
        });
      },
      (error) => resolve({ ok: false, error: error.message || 'The phone could not get a location fix.' }),
      {
        enableHighAccuracy: precise,
        maximumAge: (maxAgeSeconds ?? 0) * 1000,
        timeout: 20_000,
      },
    );
  });
}

/**
 * Run one capability on this device.
 *
 * Authority is NOT decided here: by the time a request reaches this function
 * the host has already confirmed it with the person (or matched a durable
 * grant). What happens here is the platform action plus whatever prompt the
 * browser itself insists on.
 */
export async function runWebNodeCapability(
  capabilityId: string,
  input: Record<string, unknown>,
  bindings: BrowserBindings = readBrowserBindings(),
): Promise<CapabilityRunResult> {
  try {
    switch (capabilityId) {
      case 'device.camera.rear.capture':
        return await capturePhoto(bindings, 'environment', readNumber(input, 'maxWidth'));
      case 'device.camera.front.capture':
        return await capturePhoto(bindings, 'user', readNumber(input, 'maxWidth'));
      case 'device.screen.capture':
        return await captureScreen(bindings);
      case 'device.location.coarse':
        return await readLocation(bindings, false, readNumber(input, 'maxAgeSeconds'));
      case 'device.location.precise':
        return await readLocation(bindings, true, readNumber(input, 'maxAgeSeconds'));
      case 'device.clipboard.read': {
        if (typeof bindings.clipboard?.readText !== 'function') return { ok: false, error: 'This browser does not offer clipboard reads.' };
        const text = await bindings.clipboard.readText();
        return { ok: true, data: { text, length: text.length } };
      }
      case 'device.clipboard.write': {
        const text = readString(input, 'text');
        if (!text) return { ok: false, error: 'No text was supplied to place on the clipboard.' };
        if (typeof bindings.clipboard?.writeText !== 'function') return { ok: false, error: 'This browser does not offer clipboard writes.' };
        await bindings.clipboard.writeText(text);
        return { ok: true, data: { written: text.length } };
      }
      case 'device.command.notify': {
        const title = readString(input, 'title');
        if (!title) return { ok: false, error: 'No notification title was supplied.' };
        if (!bindings.canNotify) return { ok: false, error: 'This browser does not offer notifications.' };
        const permission = bindings.notificationPermission === 'granted'
          ? 'granted'
          : await Notification.requestPermission();
        if (permission !== 'granted') return { ok: false, error: 'Notifications are not permitted on this device.' };
        const body = readString(input, 'body');
        // eslint-disable-next-line no-new
        new Notification(title, body ? { body } : undefined);
        return { ok: true, data: { shown: true } };
      }
      case 'device.command.open_url': {
        const url = readString(input, 'url');
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http and https links are opened.' };
        if (!bindings.canOpenWindow) return { ok: false, error: 'This browser could not open a new window.' };
        window.open(url, '_blank', 'noopener,noreferrer');
        return { ok: true, data: { opened: url } };
      }
      case 'device.command.vibrate': {
        if (!bindings.canVibrate) return { ok: false, error: 'This device does not offer vibration.' };
        const duration = readNumber(input, 'durationMs') ?? 200;
        navigator.vibrate(Math.min(Math.max(duration, 1), 5000));
        return { ok: true, data: { vibratedMs: duration } };
      }
      default:
        return { ok: false, error: `${capabilityId} is not a capability this node implements.` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
