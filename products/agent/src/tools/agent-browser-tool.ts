import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { BrowserEngine, BrowserSessionError, StaleElementError, UntrustedEffectError } from '@goodvibes-jev/engine/sdk/platform/browser';
import type { BrowserExtractField, BrowserTarget, UntrustedContentPort } from '@goodvibes-jev/engine/sdk/platform/browser';
import { createAgentBrowserEngine } from '../runtime/agent-browser.ts';
import { declareToolCapability } from './agent-tool-capability-declarations.ts';

/**
 * The `browser` tool: real browser control, in this process, through Playwright.
 *
 * It is deliberately NOT an MCP passthrough. Nothing has to be installed,
 * configured, or authorized by hand first, the first call provisions a browser
 * if one is missing and then does the work. Two properties are structural
 * rather than advisory:
 *
 *   - a browser the agent attached to can never be closed by the agent;
 *   - every input action targets an element resolved from a snapshot of a page
 *     this tool controls, so nothing can type into whatever window has focus.
 */

const READ_ONLY_ACTIONS = ['status', 'tabs', 'snapshot', 'read_text'] as const;

const BROWSER_ACTIONS = [
  'status',
  'provision',
  'launch',
  'attach',
  'release',
  'close',
  'navigate',
  'snapshot',
  'click',
  'type',
  'select',
  'press',
  'scroll',
  'wait_for',
  'read_text',
  'screenshot',
  'tabs',
  'new_tab',
  'switch_tab',
  'close_tab',
  'back',
  'forward',
  'extract',
] as const;

export const BROWSER_TOOL_READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(READ_ONLY_ACTIONS);
export const BROWSER_TOOL_ACTIONS: readonly string[] = BROWSER_ACTIONS;

/** Narrows caller input to the fields the extraction contract defines. */
function readExtractFields(value: unknown): readonly BrowserExtractField[] {
  const allowed: readonly BrowserExtractField[] = ['text', 'html', 'value', 'attributes'];
  const requested = readStringArray(value);
  return allowed.filter((field) => requested.includes(field));
}

interface BrowserToolArgs {
  readonly action?: unknown;
  readonly sessionId?: unknown;
  readonly pageId?: unknown;
  readonly url?: unknown;
  readonly ref?: unknown;
  readonly selector?: unknown;
  readonly text?: unknown;
  readonly key?: unknown;
  readonly values?: unknown;
  readonly fields?: unknown;
  readonly all?: unknown;
  readonly cdpEndpoint?: unknown;
  readonly profileName?: unknown;
  readonly headless?: unknown;
  readonly submit?: unknown;
  readonly replace?: unknown;
  readonly fullPage?: unknown;
  readonly path?: unknown;
  readonly direction?: unknown;
  readonly amount?: unknown;
  readonly limit?: unknown;
  readonly maxChars?: unknown;
  readonly timeoutMs?: unknown;
  readonly repair?: unknown;
  readonly button?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function output(payload: Record<string, unknown>): { success: true; output: string } {
  return { success: true, output: JSON.stringify(payload) };
}

function failure(message: string, fix: string | null = null): { success: false; error: string } {
  return { success: false, error: fix ? `${message} ${fix}` : message };
}

function requireString(value: unknown, field: string, action: string): string {
  const text = readString(value);
  if (!text) {
    throw new BrowserSessionError(`browser action:"${action}" needs ${field}.`, `Pass ${field}:"…".`);
  }
  return text;
}

export interface AgentBrowserToolOptions {
  readonly engine?: BrowserEngine;
  /**
   * Directory screenshots are written to. The composition root owns this path:
   * it must be somewhere the agent's own read path can open, which rules out
   * hidden directories.
   */
  readonly screenshotDirectory?: string;
  /** Directory holding saved browser profiles. */
  readonly profileRoot?: string;
  /** Home directory owning the managed browser cache. */
  readonly homeDirectory?: string;
  /**
   * The untrusted-content contract handed to the engine. Defaults to the
   * agent's process-wide session ledger; tests inject their own so one test's
   * page read cannot make the next test's outward action refuse.
   */
  readonly untrusted?: UntrustedContentPort;
}

/**
 * Engines created by a registered browser tool, so app shutdown can close the
 * browsers this agent started. Attached browsers are untouched by this, the
 * session manager's shutdown only ends what it launched.
 */
const liveEngines = new Set<BrowserEngine>();

export async function shutdownAgentBrowserSessions(): Promise<void> {
  for (const live of [...liveEngines]) {
    liveEngines.delete(live);
    try {
      await live.shutdown();
    } catch {
      // A browser that already exited is not a shutdown failure.
    }
  }
}

export function createAgentBrowserTool(options: AgentBrowserToolOptions = {}): Tool {
  // A lazily created engine: registering the tool must never start a browser or
  // touch the network. Provisioning happens on the first call that needs it.
  let engine = options.engine ?? null;
  const resolveEngine = (): BrowserEngine => {
    if (!engine) {
      const screenshotDirectory = options.screenshotDirectory;
      const profileRoot = options.profileRoot;
      if (!screenshotDirectory || !profileRoot) {
        throw new BrowserSessionError(
          'The browser tool was registered without the directories it writes to.',
          'Register it with screenshotDirectory and profileRoot from the runtime paths.',
        );
      }
      // Built through the agent's one browser composition point, so the
      // storage root, the untrusted-content port, the host-script advice and
      // the session-write ledger are bound in exactly one place rather than
      // once per construction site.
      engine = createAgentBrowserEngine({
        screenshotDirectory,
        profileRoot,
        homeDirectory: options.homeDirectory ?? profileRoot,
        ...(options.untrusted ? { untrusted: options.untrusted } : {}),
      });
      liveEngines.add(engine);
    }
    return engine;
  };

  return {
    definition: {
      name: 'browser',
      description: 'Drive a real browser: open, read, click, type, and sign in.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...BROWSER_ACTIONS],
            description: 'What to do. status reports availability and open sessions.',
          },
          url: { type: 'string', description: 'URL for navigate or new_tab. http, https, file, or about only.' },
          ref: { type: 'string', description: 'Element ref from the latest snapshot of this page.' },
          selector: { type: 'string', description: 'CSS selector for extract. Reaches into open shadow DOM.' },
          text: { type: 'string', description: 'Text to type, or the text wait_for should wait for.' },
          key: { type: 'string', description: 'Key name for action:"press", such as Enter or Escape.' },
          values: { type: 'array', items: { type: 'string' }, description: 'Option values for action:"select".' },
          fields: {
            type: 'array',
            items: { type: 'string', enum: ['text', 'html', 'value', 'attributes'] },
            description: 'What to read for action:"extract". Defaults to text.',
          },
          all: { type: 'boolean', description: 'For action:"extract": read every match rather than the first.' },
          sessionId: { type: 'string', description: 'Browser session to act on. Defaults to the open session.' },
          pageId: { type: 'string', description: 'Page/tab to act on. Defaults to the active tab.' },
          cdpEndpoint: { type: 'string', description: 'Remote debugging endpoint of a running browser, for attach.' },
          profileName: { type: 'string', description: 'Saved profile to launch with. Keeps logins across runs.' },
          headless: { type: 'boolean', description: 'Launch with no visible window. Sign-ins need a visible one.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          replace: { type: 'boolean', description: 'Replace the field contents rather than appending. Default true.' },
          fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the visible area.' },
          path: { type: 'string', description: 'Where to write the screenshot. Defaults to a readable folder.' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction when no ref is given.' },
          amount: { type: 'number', description: 'Scroll distance in pixels.' },
          limit: { type: 'number', description: 'Maximum elements to include in a snapshot.' },
          maxChars: { type: 'number', description: 'Maximum characters to return from action:"read_text".' },
          timeoutMs: { type: 'number', description: 'How long this one call may take. Never affects the browser.' },
          repair: { type: 'boolean', description: 'For provision: reinstall even if a browser is cached.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for action:"click".' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'write_fs', 'state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = rawArgs as BrowserToolArgs;
      const action = readString(args.action).toLowerCase().replace(/-/g, '_');
      if (!action) {
        return failure(`browser needs an action. Use one of: ${BROWSER_ACTIONS.join(', ')}.`);
      }
      const target: BrowserTarget = {
        sessionId: readString(args.sessionId) || undefined,
        pageId: readString(args.pageId) || undefined,
      };
      const timeoutMs = readNumber(args.timeoutMs);
      // Launch arguments carried on an ordinary call, so the session opened
      // implicitly by the first navigate matches what was asked for.
      const launch = {
        ...(readString(args.profileName) ? { profileName: readString(args.profileName) } : {}),
        ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
      };
      try {
        const browser = resolveEngine();
        switch (action) {
          case 'status':
            return output(await browser.status());
          case 'provision':
            return output({ provision: await browser.provision({ repair: args.repair === true }) });
          case 'launch':
            return output(await browser.launch({
              profileName: readString(args.profileName) || undefined,
              ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
            }));
          case 'attach': {
            const cdpEndpoint = readString(args.cdpEndpoint);
            if (!cdpEndpoint) {
              // Naming a missing parameter is honest only if the caller can
              // actually supply it. The owner's regular, already-running
              // browser exposes no remote-debugging port by default, so there
              // is no cdpEndpoint to hand over for it, attach only works for
              // a browser the owner deliberately started with one.
              throw new BrowserSessionError(
                'browser action:"attach" needs cdpEndpoint, and there is no way to get one for the owner\'s regular already-running browser, it exposes no remote-debugging port unless started with one.',
                'Only use attach for a browser the owner deliberately started with --remote-debugging-port=<port> --user-data-dir=<a profile that is not already open>. For anything else, use action:"launch" instead, it opens the agent\'s own managed, isolated profile.',
              );
            }
            return output(await browser.attach({ cdpEndpoint }));
          }
          case 'release':
            return output(browser.release(requireString(args.sessionId, 'sessionId', 'release')));
          case 'close':
            return output(await browser.close(requireString(args.sessionId, 'sessionId', 'close')));
          case 'navigate':
            return output(await browser.navigate(target, {
              url: requireString(args.url, 'url', 'navigate'),
              launch,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'snapshot':
            return output(await browser.snapshot(target, { ...(readNumber(args.limit) === undefined ? {} : { limit: readNumber(args.limit) }) }));
          case 'click':
            return output(await browser.click(target, {
              ref: requireString(args.ref, 'ref', 'click'),
              ...(args.button === 'right' || args.button === 'middle' || args.button === 'left' ? { button: args.button } : {}),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'type':
            return output(await browser.type(target, {
              ref: requireString(args.ref, 'ref', 'type'),
              text: typeof args.text === 'string' ? args.text : '',
              ...(args.submit === true ? { submit: true } : {}),
              ...(args.replace === false ? { replace: false } : {}),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'select':
            return output(await browser.select(target, {
              ref: requireString(args.ref, 'ref', 'select'),
              values: readStringArray(args.values),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'press':
            return output(await browser.press(target, {
              ref: requireString(args.ref, 'ref', 'press'),
              key: requireString(args.key, 'key', 'press'),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'scroll':
            return output(await browser.scroll(target, {
              ...(readString(args.ref) ? { ref: readString(args.ref) } : {}),
              ...(args.direction === 'up' || args.direction === 'down' ? { direction: args.direction } : {}),
              ...(readNumber(args.amount) === undefined ? {} : { amount: readNumber(args.amount) }),
            }));
          case 'wait_for':
            return output(await browser.waitFor(target, {
              ...(readString(args.text) ? { text: readString(args.text) } : {}),
              ...(readString(args.url) ? { url: readString(args.url) } : {}),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'read_text':
            return output(await browser.readText(target, { ...(readNumber(args.maxChars) === undefined ? {} : { maxChars: readNumber(args.maxChars) }) }));
          case 'screenshot':
            return output(await browser.screenshot(target, {
              ...(args.fullPage === true ? { fullPage: true } : {}),
              ...(readString(args.path) ? { path: readString(args.path) } : {}),
            }));
          case 'tabs':
            return output(await browser.tabs(target));
          case 'new_tab':
            return output(await browser.newTab(target, { launch, ...(readString(args.url) ? { url: readString(args.url) } : {}) }));
          case 'switch_tab':
            return output(browser.switchTab(target, { pageId: requireString(args.pageId, 'pageId', 'switch_tab') }));
          case 'close_tab':
            return output(await browser.closeTab(target, { pageId: requireString(args.pageId, 'pageId', 'close_tab') }));
          case 'back':
            return output(await browser.goBack(target));
          case 'forward':
            return output(await browser.goForward(target));
          case 'extract':
            return output(await browser.extract(target, {
              ...(readString(args.ref) ? { ref: readString(args.ref) } : {}),
              ...(readString(args.selector) ? { selector: readString(args.selector) } : {}),
              ...(readStringArray(args.fields).length > 0 ? { fields: readExtractFields(args.fields) } : {}),
              ...(args.all === true ? { all: true } : {}),
              ...(readNumber(args.limit) === undefined ? {} : { limit: readNumber(args.limit) }),
            }));
          default:
            return failure(`Unknown browser action: ${action}. Use one of: ${BROWSER_ACTIONS.join(', ')}.`);
        }
      } catch (error) {
        if (error instanceof BrowserSessionError || error instanceof StaleElementError || error instanceof UntrustedEffectError) {
          return failure(error.message, error.fix);
        }
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentBrowserTool(registry: ToolRegistry, options: AgentBrowserToolOptions = {}): void {
  if (!registry.has('browser')) registry.register(createAgentBrowserTool(options));
  // Stated, not inferred: readiness surfaces read this declaration instead of
  // guessing from tool descriptions.
  declareToolCapability('browser', 'browser-control');
}
