/**
 * `goodvibes-agent browser …`, the scriptable mirror of the `browser` model
 * tool.
 *
 * It exists because of how the 1.18.1 browser failure was found and how long it
 * took to explain. Browser control lived behind a model turn: the only way to
 * learn whether a downloaded binary could drive a page was to ask a model to
 * try, and the only thing the owner got back was the model's paraphrase of a
 * capability line. There was no way to ask the binary itself.
 *
 * This is that way. It builds the SAME tool the model calls, not a parallel
 * implementation, and prints its JSON, so what this reports and what the model
 * gets are the same bytes by construction. `browser status` answers "is the
 * driver there, where, and what happens if it is not"; `browser provision`
 * performs the one-act setup with its steps visible; `browser open <url>` proves
 * the whole path end to end without a provider, an API key, or a network round
 * trip to a model.
 */
import { createAgentBrowserTool, BROWSER_TOOL_ACTIONS } from '../tools/agent-browser-tool.ts';
import { agentBrowserProfileRoot, agentBrowserScreenshotRoot } from '../runtime/agent-browser.ts';
import { shutdownAgentBrowserSessions } from '../tools/agent-browser-tool.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

const USAGE = [
  'Usage: goodvibes-agent browser <action> [options]',
  '',
  '  status                  Report driver, browser, and open sessions (installs nothing)',
  '  provision [--repair]    Install the browser driver and browser if they are missing',
  '  open <url> [--visible]  Open a page and report its title (headless unless --visible)',
  '  read <url> [--visible]  Open a page and print its text',
  '  <action> [--arg k=v]    Any browser tool action, with raw arguments',
  '',
  `Actions: ${BROWSER_TOOL_ACTIONS.join(', ')}`,
].join('\n');

/** `--arg key=value` pairs, for actions this command does not spell out. */
function readRawArgs(rest: readonly string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--arg') continue;
    const pair = rest[index + 1] ?? '';
    const split = pair.indexOf('=');
    if (split <= 0) continue;
    const key = pair.slice(0, split);
    const raw = pair.slice(split + 1);
    args[key] = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) && raw.trim() !== '' ? Number(raw) : raw;
  }
  return args;
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function renderStatus(payload: Record<string, unknown>): string {
  const steps = Array.isArray(payload['provisionSteps']) ? payload['provisionSteps'] : [];
  return [
    'GoodVibes Agent browser',
    `  browser available  ${payload['browserAvailable'] === true ? 'yes' : 'no'}`,
    `  driver version     ${String(payload['driverVersion'] ?? 'not resolved')}`,
    `  browser executable ${String(payload['executablePath'] ?? 'none')}`,
    `  browser source     ${String(payload['binarySource'] ?? 'none')}`,
    `  browser cache      ${String(payload['browsersPath'] ?? '')}`,
    `  display            ${payload['displayAvailable'] === true ? 'available' : 'none (headless only)'}`,
    ...(payload['problem'] ? [`  problem            ${String(payload['problem'])}`] : []),
    ...(payload['fix'] ? [`  fix                ${String(payload['fix'])}`] : []),
    ...(steps.length > 0 ? ['  steps'] : []),
    ...steps.map((step) => {
      const entry = step as { step?: unknown; ok?: unknown; detail?: unknown };
      return `    ${entry.ok === true ? 'ok  ' : 'fail'} ${String(entry.step ?? '')}: ${String(entry.detail ?? '')}`;
    }),
  ].join('\n');
}

/**
 * Runs one browser tool action and prints the result.
 *
 * The engine is shut down before returning so a CLI invocation never leaves a
 * browser process behind, and, per the engine's ownership rule, only browsers
 * this call launched are ever closed.
 */
export async function handleBrowserCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [rawAction, ...rest] = runtime.cli.commandArgs;
  const action = (rawAction ?? 'status').toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h') {
    return { output: USAGE, exitCode: 0 };
  }

  const home = runtime.homeDirectory;
  const tool = createAgentBrowserTool({
    screenshotDirectory: agentBrowserScreenshotRoot(home),
    profileRoot: agentBrowserProfileRoot(home),
    homeDirectory: home,
  });

  const positional = rest.filter((entry) => !entry.startsWith('--'));
  const visible = rest.includes('--visible');
  const args: Record<string, unknown> = (() => {
    switch (action) {
      case 'status':
        return { action: 'status' };
      case 'provision':
        return { action: 'provision', ...(rest.includes('--repair') ? { repair: true } : {}) };
      case 'open':
      case 'navigate':
        return { action: 'navigate', url: positional[0] ?? '', headless: !visible };
      case 'read':
        return { action: 'read_text', ...readRawArgs(rest) };
      default:
        return { action, ...readRawArgs(rest) };
    }
  })();

  if ((action === 'open' || action === 'navigate') && !args['url']) {
    return { output: `browser ${action} needs a URL.\n\n${USAGE}`, exitCode: 2 };
  }

  try {
    // `read` opens the page first, so a single command proves the whole path.
    if (action === 'read') {
      const url = positional[0] ?? '';
      if (!url) return { output: `browser read needs a URL.\n\n${USAGE}`, exitCode: 2 };
      const opened = await tool.execute({ action: 'navigate', url, headless: !visible });
      if (!opened.success) return { output: opened.error ?? 'navigate failed', exitCode: 1 };
    }
    const result = await tool.execute(args);
    if (!result.success) {
      return { output: result.error ?? `browser ${action} failed`, exitCode: 1 };
    }
    const payload = parsePayload(result.output ?? '');
    if (runtime.cli.flags.outputFormat === 'json') {
      return { output: JSON.stringify(payload, null, 2), exitCode: 0 };
    }
    if (action === 'status' && payload && typeof payload === 'object') {
      return { output: renderStatus(payload as Record<string, unknown>), exitCode: 0 };
    }
    return { output: JSON.stringify(payload, null, 2), exitCode: 0 };
  } finally {
    await shutdownAgentBrowserSessions();
  }
}
