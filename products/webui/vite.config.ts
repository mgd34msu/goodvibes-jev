import { defineConfig, type Plugin } from 'vite';
import { builtinModules, createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Directory this config file lives in (the repo root), resolved independent
// of process.cwd(), this config is the seam every `vite build` invocation
// loads (bun run build, a wrapper script, CI, or a bare `vite build` in this
// directory), so a guard planted here cannot be routed around the way a
// guard in a wrapper script could be by calling vite directly.
const CONFIG_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Build only against this checkout's declared engine, and reject Node-only browser imports. */
function workspaceEnginePlugin(): Plugin {
  const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  return {
    name: 'goodvibes-workspace-engine',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      const require = createRequire(import.meta.url);
      const manifest = JSON.parse(readFileSync(join(CONFIG_DIR, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      if (manifest.dependencies?.['@goodvibes-jev/engine'] !== 'workspace:*') {
        this.error('WebUI must consume @goodvibes-jev/engine from this workspace');
      }
      const installed = realpathSync(require.resolve('@goodvibes-jev/engine/package.json'));
      const expected = realpathSync(join(CONFIG_DIR, '../../packages/engine/package.json'));
      if (installed !== expected) this.error('WebUI resolved an engine outside this checkout');
    },
    resolveId(source, importer) {
      if (importer && nodeBuiltins.has(source)) {
        this.error(`Node-only module ${source} reached the browser through ${importer}`);
      }
      return null;
    },
  };
}

interface GoodVibesListenerSettings {
  hostMode?: string;
  host?: string;
  port?: number;
}

interface GoodVibesTuiSettings {
  controlPlane?: GoodVibesListenerSettings;
  web?: GoodVibesListenerSettings;
}

interface GoodVibesWebBinding {
  enabled?: boolean;
  hostMode?: string;
  configuredHost?: string;
  host?: string;
  port?: number;
  url?: string;
}

function readTuiSettings(): GoodVibesTuiSettings {
  const settingsPath = process.env.GOODVIBES_TUI_SETTINGS_PATH
    ?? join(process.env.GOODVIBES_DAEMON_HOME ?? homedir(), '.goodvibes', 'tui', 'settings.json');
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as GoodVibesTuiSettings;
  } catch {
    return {};
  }
}

function readWebBindingFromCli(): GoodVibesWebBinding {
  try {
    const output = execFileSync('goodvibes', ['web', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return JSON.parse(output) as GoodVibesWebBinding;
  } catch {
    return {};
  }
}

/**
 * Whether this machine's installed `goodvibes-daemon` binary recognizes `webui` as a
 * subcommand at all, checked via its own `--help` listing before ever invoking it.
 * NOT a version-string check: some installed daemon builds treat any unrecognized
 * leading argument (including `webui`) as ignorable noise and fall straight through to
 * booting the daemon itself, which would mean `readWebBindingFromDaemon` below,
 * called from `vite`'s own config evaluation, could accidentally start a second,
 * unmanaged daemon process bound to a real port as a side effect of running `bun run
 * dev`. `--help` is side-effect-free on every observed build and always exits
 * immediately, so this is the safe way to learn whether `webui status --json` is a
 * subcommand this binary will actually route to, before running it for real.
 */
function daemonSupportsWebuiCommand(): boolean {
  try {
    const help = execFileSync('goodvibes-daemon', ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return /\bwebui\b/.test(help);
  } catch {
    return false;
  }
}

/**
 * The daemon is the authority on where the web surface is bound, `goodvibes web --json`
 * and `~/.goodvibes/tui/settings.json` (readWebBindingFromCli/readTuiSettings above) read
 * `controlPlane.*`/`web.*` keys through the TERMINAL's own CLI and settings file, which is
 * a holdover from before the daemon became its own product with its own CLI. Returns null
 * when the daemon does not answer this (no `goodvibes-daemon` on PATH, an installed daemon
 * that predates the `webui` subcommand entirely, see daemonSupportsWebuiCommand above,
 * or one whose `webui status` predates a `--json` output mode), so the caller falls back
 * to the terminal-owned path rather than fail the whole dev server boot.
 */
function readWebBindingFromDaemon(): GoodVibesWebBinding | null {
  if (!daemonSupportsWebuiCommand()) return null;
  try {
    const output = execFileSync('goodvibes-daemon', ['webui', 'status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return JSON.parse(output) as GoodVibesWebBinding;
  } catch {
    return null;
  }
}

function listenerHost(settings: GoodVibesListenerSettings | undefined, fallback: string): string {
  const configuredHost = settings?.host?.trim();
  if (settings?.hostMode === 'network') return '0.0.0.0';
  if (settings?.hostMode === 'custom') return configuredHost || fallback;
  if (settings?.hostMode === 'local') return '127.0.0.1';
  return configuredHost || fallback;
}

function localhostTarget(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

function hostnameFromUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.hostname;
  } catch {
    return '';
  }
}

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function uniqueHosts(values: string[]): string[] {
  const ignored = new Set(['', '0.0.0.0', '::', '127.0.0.1', 'localhost']);
  const hosts = new Set<string>();
  for (const value of values) {
    const host = value.trim();
    if (!host || ignored.has(host)) continue;
    hosts.add(host);
    hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

export default defineConfig(({ command, isPreview }) => {
const discoverBinding = command === 'serve' && !isPreview && process.env.GOODVIBES_WEBUI_BINDING_DISCOVERY !== '0';
const daemonWebBinding = discoverBinding ? readWebBindingFromDaemon() : null;
if (discoverBinding && !daemonWebBinding) {
  console.warn(
    '[vite] `goodvibes-daemon webui status --json` did not answer, falling back to the ' +
    'deprecated `goodvibes web --json` / TUI settings.json binding source. That path predates ' +
    'the daemon becoming its own product and is removed once every supported daemon answers ' +
    '`webui status --json`.',
  );
}
const cliWebBinding = daemonWebBinding ?? (discoverBinding ? readWebBindingFromCli() : {});
const tuiSettings = !discoverBinding || cliWebBinding.host || cliWebBinding.port ? {} : readTuiSettings();
const webHost = cliWebBinding.host ?? listenerHost(tuiSettings.web, '127.0.0.1');
const webPort = cliWebBinding.port ?? tuiSettings.web?.port ?? 3423;
const controlPlaneHost = listenerHost(tuiSettings.controlPlane, '127.0.0.1');
const controlPlanePort = tuiSettings.controlPlane?.port ?? 3421;
const daemonTarget = process.env.GOODVIBES_DAEMON_BASE_URL
  ?? process.env.VITE_GOODVIBES_BACKEND_URL
  ?? `http://${localhostTarget(controlPlaneHost)}:${controlPlanePort}`;
const devHost = process.env.GOODVIBES_WEB_HOST
  ?? process.env.VITE_GOODVIBES_WEBUI_HOST
  ?? webHost;
const devPort = Number(process.env.GOODVIBES_WEB_PORT
  ?? process.env.VITE_GOODVIBES_WEBUI_PORT
  ?? webPort);
const machineHostname = hostname();
const devAllowedHosts = uniqueHosts([
  ...csv(process.env.GOODVIBES_WEB_ALLOWED_HOSTS),
  ...csv(process.env.VITE_GOODVIBES_WEBUI_ALLOWED_HOSTS),
  hostnameFromUrl(process.env.GOODVIBES_WEB_PUBLIC_BASE_URL),
  hostnameFromUrl(cliWebBinding.url),
  machineHostname,
  `${machineHostname}.local`,
  'goodvibes.local',
]);

// This app's own build version, baked in at build/dev-server-start time from
// package.json, read here (config-eval time, Node/Bun) rather than imported as JSON
// into browser code, so no resolveJsonModule config is needed for src/. Exposed as
// `import.meta.env.VITE_WEBUI_VERSION`, same access pattern as the other VITE_-prefixed
// values this config already threads through (GOODVIBES_BASE_URL). Used to compare this
// running build against a daemon-announced client-build floor (lib/client-compatibility.ts).
const webuiVersion = (JSON.parse(readFileSync(join(CONFIG_DIR, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';

return {
  plugins: [react(), workspaceEnginePlugin()],
  define: {
    'import.meta.env.VITE_WEBUI_VERSION': JSON.stringify(webuiVersion),
  },
  server: {
    host: devHost,
    port: devPort,
    strictPort: true,
    allowedHosts: devAllowedHosts,
    proxy: {
      '/api': {
        target: daemonTarget,
        changeOrigin: true,
        ws: true,
      },
      '/login': {
        target: daemonTarget,
        changeOrigin: true,
      },
      '/status': {
        target: daemonTarget,
        changeOrigin: true,
      },
      '/task': {
        target: daemonTarget,
        changeOrigin: true,
      },
      '/config': {
        target: daemonTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/packages/engine/') || id.includes('@goodvibes-jev/engine/')) return 'goodvibes-engine';
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('react-markdown')
            || id.includes('remark-')
            || id.includes('micromark')
            || id.includes('unified')
            || id.includes('mdast')
            || id.includes('hast')
            || id.includes('unist')
            || id.includes('vfile')
          ) return 'markdown';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('lucide-react')) return 'icons';
          // onnxruntime-web keeps its OWN chunk instead of falling into the eagerly
          // loaded `vendor` one. It is imported dynamically and only when wake-word
          // detection is switched on for this origin (lib/voice/wake-runtime.ts), so
          // merging it into vendor would put an inference runtime, and the reference
          // to a 13 MB wasm binary, in front of every page load for a feature that
          // ships off. One chunk per backend build, so a tab on the wasm backend never
          // fetches the webgpu one.
          if (id.includes('onnxruntime')) return 'onnxruntime';
          // jsqr is the pairing scanner's fallback QR decoder (lib/pairing-qr-detector.ts),
          // dynamically imported only when a browser has no BarcodeDetector AND
          // someone opens the scanner. Its own chunk for the same reason
          // onnxruntime gets one: `vendor` is fetched on every page load, and
          // putting a decoder there would make every session pay for a sign-in
          // screen fallback that most of them never reach.
          if (id.includes('jsqr')) return 'qr-decoder';
          return 'vendor';
        },
      },
    },
  },
};
});
