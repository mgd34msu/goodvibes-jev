/**
 * bootstrap.ts, the entry decision that runs before anything mounts.
 *
 * Two paths, chosen by the origin guard:
 *   - INSECURE non-local origin (plain http on a LAN IP): render the honest "needs HTTPS"
 *     message and STOP, never import the app graph, which would throw at module load and
 *     leave a silent blank #root (Finding 3).
 *   - otherwise: dynamically import mount-app and boot the real app.
 *
 * Kept side-effect-free at module scope (the render/mount happens only inside bootstrap())
 * so a test can drive the module-load path directly.
 */
import {
  INSECURE_ORIGIN_BODY,
  INSECURE_ORIGIN_TITLE,
  isInsecureTransportOrigin,
} from './lib/insecure-origin';

/**
 * Render the honest HTTPS-required message into the root node with self-contained inline
 * styles, it must read correctly even though the app's own stylesheet/theme never mount
 * on this path. Wording matches MicButton's secure-context family.
 */
export function renderInsecureOriginNotice(root: HTMLElement): void {
  root.textContent = '';

  const panel = document.createElement('div');
  panel.setAttribute('role', 'alert');
  panel.style.cssText = [
    'max-width:34rem',
    'margin:15vh auto 0',
    'padding:1.75rem 2rem',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'line-height:1.55',
    'color:#e8eaf2',
    'background:#161326',
    'border:1px solid #2c2942',
    'border-radius:14px',
    'box-shadow:0 12px 40px rgb(0 0 0 / 45%)',
  ].join(';');

  const heading = document.createElement('h1');
  heading.textContent = INSECURE_ORIGIN_TITLE;
  heading.style.cssText = 'margin:0 0 0.6rem;font-size:1.25rem;font-weight:700';

  const body = document.createElement('p');
  body.textContent = INSECURE_ORIGIN_BODY;
  body.style.cssText = 'margin:0;font-size:0.95rem;color:#b9bcd0';

  panel.append(heading, body);
  root.append(panel);
}

export async function bootstrap(root: HTMLElement): Promise<void> {
  if (isInsecureTransportOrigin()) {
    renderInsecureOriginNotice(root);
    return;
  }
  const { mountApp } = await import('./mount-app');
  mountApp(root);
}
