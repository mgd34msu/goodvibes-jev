/**
 * pairing-qr-detector.ts, decode a QR out of one video frame.
 *
 * Two backends behind one function type, picked once when a scan starts:
 *
 *   - BarcodeDetector, the platform's own decoder. This is the primary target,
 *     Chrome on Android has it, and that is the device a person is holding when
 *     they pair a phone. Nothing is downloaded and the decode happens off the
 *     main thread.
 *   - jsQR, a pure-JS decoder, dynamically imported so it lands in its own lazy
 *     chunk (the same treatment onnxruntime-web gets in vite.config.ts) instead
 *     of riding in the eagerly loaded vendor chunk for a screen most sessions
 *     never open. Pure JS, not wasm, deliberately: a wasm decoder needs a
 *     separate binary asset fetched at runtime, which is exactly the kind of
 *     thing the service worker's cache rules and a strict CSP have to be taught
 *     about. A JS chunk is just another hashed file under /assets/, already
 *     covered by public/sw.js's isCacheableAsset.
 *
 * Both backends read an ImageData, so the scan loop has one code path: draw the
 * video frame to a canvas once, hand the pixels over. BarcodeDetector accepts
 * ImageData as an ImageBitmapSource, so this costs it nothing it was not
 * already paying.
 *
 * Nothing here reaches the network at runtime. The jsQR chunk is part of this
 * build's own output, same-origin, and the import resolves against it.
 */

/** Decode one frame. Resolves to the QR's text, or null when there is no QR in it. */
export type QrDetect = (image: ImageData) => Promise<string | null>;

/** Which backend a scan ended up on, for the diagnostic line under the preview. */
export type QrDetectorBackend = 'barcode-detector' | 'jsqr';

export interface QrDetector {
  readonly backend: QrDetectorBackend;
  readonly detect: QrDetect;
}

// The DOM lib does not declare BarcodeDetector, so the shape this file actually
// uses is declared here rather than reaching for `any`.
interface BarcodeDetectorLike {
  detect(source: ImageData): Promise<readonly { readonly rawValue?: string }[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<readonly string[]>;
}

function readBarcodeDetectorConstructor(): BarcodeDetectorConstructor | undefined {
  const scope = globalThis as { BarcodeDetector?: BarcodeDetectorConstructor };
  return typeof scope.BarcodeDetector === 'function' ? scope.BarcodeDetector : undefined;
}

async function tryBarcodeDetector(): Promise<QrDetector | null> {
  const Ctor = readBarcodeDetectorConstructor();
  if (!Ctor) return null;
  try {
    // Some builds expose the constructor but support no formats at all (no
    // decoding library shipped with the browser). Asking first avoids
    // constructing a detector that can never match anything.
    if (typeof Ctor.getSupportedFormats === 'function') {
      const formats = await Ctor.getSupportedFormats();
      if (!formats.includes('qr_code')) return null;
    }
    const detector = new Ctor({ formats: ['qr_code'] });
    return {
      backend: 'barcode-detector',
      detect: async (image) => {
        const results = await detector.detect(image);
        for (const result of results) {
          const value = typeof result.rawValue === 'string' ? result.rawValue.trim() : '';
          if (value) return value;
        }
        return null;
      },
    };
  } catch {
    return null;
  }
}

async function tryJsQr(): Promise<QrDetector | null> {
  try {
    const { default: jsQR } = await import('jsqr');
    return {
      backend: 'jsqr',
      detect: (image) => {
        // attemptBoth, not dontInvert: `goodvibes pair` renders its QR with
        // terminal block characters, which comes out light-on-dark on a dark
        // terminal theme. Halving the work here would fail exactly the QR this
        // screen tells people to scan.
        const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
        const value = found?.data.trim() ?? '';
        return Promise.resolve(value ? value : null);
      },
    };
  } catch {
    return null;
  }
}

/**
 * Pick a decoder for this browser: the platform's, else the bundled one.
 *
 * Returns null when neither is usable, which the scanner renders as its
 * "no decoder" state rather than a spinner that never resolves. In practice
 * that means the lazy chunk could not be fetched (offline, first run, nothing
 * in the cache yet).
 */
export async function createQrDetector(): Promise<QrDetector | null> {
  return (await tryBarcodeDetector()) ?? (await tryJsQr());
}
