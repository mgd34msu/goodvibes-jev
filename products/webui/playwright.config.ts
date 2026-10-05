import { networkInterfaces } from 'node:os';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright harness, the phone-viewport (390x844) proof standard this repo's
 * visual proofs defer to, plus a desktop project to catch regressions.
 *
 * WHAT IS SERVED: a production build of THIS repo (`vite build`, then `vite preview`),
 * the same bundle the release ships, not the vite dev server. The dev server hands
 * each page ~340 separately transformed modules; on a 4-vCPU CI runner with four
 * browsers loading them at once, the app took ~11 s to boot, past the 10 s expect
 * timeout (CI run 36775763838, tailscale-serve.e2e.ts:100). A build is a handful of
 * chunks, boots in well under a second, and is what users actually run.
 *
 * HERMETIC BY CONSTRUCTION: the preview serves on a dedicated port (4318,
 * deliberately NOT 3421 or 4444) and points its /api proxy at a
 * local STUB (scripts/e2e-daemon-stub.ts, port 59991) that answers every request with
 * a deliberate 503 { code: 'E2E_STUB' }, never a real daemon. In practice the stub is
 * almost never reached: every test installs an in-page mock (installMockDaemon /
 * installChatMockDaemon) that intercepts the wire in the browser and answers from a
 * seeded fixture. The stub exists for the one structural exception, requests made
 * while a REAL service worker controls the page (the PWA specs), which Playwright
 * page routing cannot see, so nothing ever dies as a refused connection and a clean
 * run's webServer log is silent. No real daemon, no real network beyond the local
 * preview server, no port coordination.
 */

const WEB_PORT = Number(process.env.GOODVIBES_E2E_PORT ?? 4318);
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

/**
 * The one real, GENUINE private-network address this host itself owns (an RFC 1918
 * interface, 10/8, 172.16/12, 192.168/16), for lan-origin-posture.e2e.ts. This is
 * deliberately a REAL bind + a REAL browser navigation, not a mocked window.location:
 * Chromium's own secure-context determination is a fact about the literal address the
 * page was actually served from, and no in-page mock can fake that. Undefined when the
 * host has no such interface (a loopback-only sandbox), an explicitly requested LAN proof reports unsupported in that
 * case; independent phone/desktop proofs can still run.
 */
function firstPrivateNetworkAddress(): string | undefined {
  const isPrivate = (a: string): boolean => {
    const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
    if (!m) return false;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    return false;
  };
  let interfaces: ReturnType<typeof networkInterfaces>;
  try { interfaces = networkInterfaces(); } catch { return undefined; }
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && isPrivate(addr.address)) return addr.address;
    }
  }
  return undefined;
}

/**
 * Where the one build lands. The service worker caches only built, hashed assets,
 * which is also what lets pwa-offline.e2e.ts prove the app opens offline.
 * GOODVIBES_E2E_DIST moves it, so two local runs on different ports do not
 * empty each other's build.
 */
const E2E_DIST = process.env.GOODVIBES_E2E_DIST ?? 'e2e/.artifacts/e2e-dist';

/** Env for the build and every preview: the daemon is the deliberate-503 stub. */
const PREVIEW_ENV = {
  GOODVIBES_DAEMON_BASE_URL: 'http://127.0.0.1:59991',
  GOODVIBES_WEBUI_BINDING_DISCOVERY: '0',
  // Force the config's settings/CLI probes to no-op deterministically.
  GOODVIBES_TUI_SETTINGS_PATH: '/nonexistent/goodvibes-e2e-settings.json',
};

const LAN_ORIGIN_PORT = Number(process.env.GOODVIBES_E2E_LAN_PORT ?? 4319);
const LAN_ORIGIN_HOST = firstPrivateNetworkAddress();
const LAN_ORIGIN_SPEC = '**/lan-origin-posture.e2e.ts';
const selectedProjects = process.argv.flatMap((argument, index) =>
  argument.startsWith('--project=') ? [argument.slice('--project='.length)]
    : argument === '--project' && process.argv[index + 1] ? [process.argv[index + 1]] : []);
const lanRequired = selectedProjects.length === 0 || selectedProjects.includes('lan-origin') || selectedProjects.includes('*');
// Playwright reloads this config in workers without the original CLI project
// flags. Admission belongs to the coordinator; workers inherit its selection.
if (lanRequired && !LAN_ORIGIN_HOST && process.env.TEST_WORKER_INDEX === undefined) {
  throw new Error('LAN-origin proof unsupported: no readable private-network interface is available. Select --project=phone --project=desktop for independent loopback proofs; required LAN coverage cannot pass here.');
}

export default defineConfig({
  testDir: './e2e',
  // Files are named *.e2e.ts (NOT *.spec.ts) so `bun test`, which globs *.spec.ts /
  // *.test.ts across the repo, never tries to run these Playwright suites.
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e/.artifacts/test-output',
  // Every test gets its own browser context and its own in-page mock daemon, so
  // tests are independent and run in parallel, file by file and within a file.
  // The monorepo CI browser job runs phone, desktop, and the real LAN origin.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: [['list'], ['html', { outputFolder: 'e2e/.artifacts/report', open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    } : {}),
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'phone',
      testIgnore: LAN_ORIGIN_SPEC,
      use: {
        ...devices['Pixel 7'],
        // Pin the exact hero viewport the brief specifies, overriding the device default.
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      testIgnore: LAN_ORIGIN_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    // lan-origin: the ONE project that actually serves the app from a real
    // private-network address (see firstPrivateNetworkAddress above), so the LAN-http
    // posture proof (lan-origin-posture.e2e.ts) exercises the REAL browser secure-context
    // boundary rather than a mocked window.location. Every other spec is ignored here.
    {
      name: 'lan-origin',
      testMatch: LAN_ORIGIN_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        baseURL: LAN_ORIGIN_HOST ? `http://${LAN_ORIGIN_HOST}:${LAN_ORIGIN_PORT}` : BASE_URL,
      },
    },
  ],
  webServer: [
    {
      // The deliberate answer for requests the in-page mocks cannot intercept
      // (see the header comment). Must start before the preview so the proxy
      // target is never a dead port.
      command: 'bun scripts/e2e-daemon-stub.ts',
      url: 'http://127.0.0.1:59991/__stub-alive',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Build once (a few seconds), then serve it. Its /api proxy (vite's preview
      // reuses server.proxy) points at the stub, explicitly NOT the real control
      // plane (3421) or web (4444/3423) ports.
      command: `bun run generated:check && bunx vite build --outDir ${E2E_DIST} --emptyOutDir && bunx vite preview --outDir ${E2E_DIST} --host 127.0.0.1 --port ${String(WEB_PORT)} --strictPort`,
      url: BASE_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      env: PREVIEW_ENV,
    },
    // A second preview of the same build, bound to the host's own real
    // private-network address, for the "lan-origin" project only. Never started
    // when the host has none (LAN_ORIGIN_HOST undefined; that project's baseURL
    // then remains a placeholder only in independent phone/desktop runs). No secure context
    // there, so register-sw.ts leaves the service worker unregistered, which is
    // the labeled-degradation story that spec proves.
    ...(lanRequired && LAN_ORIGIN_HOST
      ? [{
        command: `bunx vite preview --outDir ${E2E_DIST} --host ${LAN_ORIGIN_HOST} --port ${String(LAN_ORIGIN_PORT)} --strictPort`,
        url: `http://${LAN_ORIGIN_HOST}:${String(LAN_ORIGIN_PORT)}`,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe' as const,
        stderr: 'pipe' as const,
        env: PREVIEW_ENV,
      }]
      : []),
  ],
});
