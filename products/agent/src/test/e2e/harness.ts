/**
 * End-to-end harness: the BUILT goodvibes-agent binary in a real terminal.
 *
 * Every test here drives the compiled artifact (`bun run build`, or
 * GOODVIBES_E2E_BINARY), never the source. The terminal is a tmux server this
 * harness owns (a private `-L` socket per session, killed on stop), which gives
 * a real pty, keystrokes, the rendered screen (capture-pane) and the raw byte
 * stream the program wrote (pipe-pane).
 *
 * Isolation: a fresh temp home per session (HOME points at it), a scratch git
 * workspace, a PATH with nothing extra, launch self-update off, and the daemon
 * port pinned to an unused port so the process can never reach a daemon the
 * machine is already running. The model is a scripted OpenAI-compatible server
 * in this test process (startStubModel).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const ARTIFACT_BY_PLATFORM: Record<string, string> = {
  'linux-x64': 'goodvibes-agent-linux-x64',
  'linux-arm64': 'goodvibes-agent-linux-arm64',
  'darwin-x64': 'goodvibes-agent-macos-x64',
  'darwin-arm64': 'goodvibes-agent-macos-arm64',
};

/**
 * The compiled binary under test: GOODVIBES_E2E_BINARY, else the platform
 * artifact (`bun run build:linux-x64`), else the native `bun run build` output.
 * Fails loudly when none has been built.
 */
export function resolveBinary(): string {
  const fromEnv = process.env['GOODVIBES_E2E_BINARY'];
  const candidates = fromEnv
    ? [resolve(fromEnv)]
    : [
      join(REPO_ROOT, 'dist', ARTIFACT_BY_PLATFORM[`${process.platform}-${process.arch}`] ?? 'goodvibes-agent-linux-x64'),
      join(REPO_ROOT, 'dist', 'goodvibes-agent'),
    ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`E2E: no built binary at ${candidates.join(' or ')}. Run \`bun run build\` first, or set GOODVIBES_E2E_BINARY.`);
  }
  return found;
}

/** The version the binary under test reports (`--version`), for screen assertions. */
export function binaryVersion(): string {
  const out = spawnSync(resolveBinary(), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  const match = /goodvibes-agent\s+(\S+)/.exec(out.stdout);
  if (!match) throw new Error(`E2E: --version printed no version: ${out.stdout}${out.stderr}`);
  return match[1]!;
}

function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
}

/** A TCP port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 30_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`E2E: timed out after ${timeoutMs}ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

// ── the scripted model ──────────────────────────────────────────────────────

export interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly tools: readonly unknown[];
}

/** One scripted answer: plain text, or tool calls the agent should run. */
export type ModelReply =
  | { readonly text: string }
  | { readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments: Record<string, unknown> }> };

export interface StubModel {
  readonly baseURL: string;
  readonly requests: ModelRequest[];
  stop(): void;
}

/** Text of a message's content, whether a string or content parts. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/** The last user message of a request. */
export function lastUserText(request: ModelRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    if (request.messages[i]!.role === 'user') return messageText(request.messages[i]!);
  }
  return '';
}

/**
 * An OpenAI-compatible chat-completions server on an ephemeral port. `answer`
 * decides every reply from the request; it answers the stream shape the
 * request asked for.
 */
export function startStubModel(answer: (request: ModelRequest, index: number) => ModelReply): StubModel {
  const requests: ModelRequest[] = [];
  let callId = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] });
      }
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      const body = await req.json().catch(() => ({})) as { messages?: ChatMessage[]; stream?: boolean; tools?: unknown[] };
      const request: ModelRequest = { messages: body.messages ?? [], stream: body.stream === true, tools: body.tools ?? [] };
      const index = requests.length;
      requests.push(request);
      const reply = answer(request, index);
      const created = Math.floor(Date.now() / 1000);
      const toolCalls = 'toolCalls' in reply
        ? reply.toolCalls.map((call, i) => ({
          index: i,
          id: `call_${++callId}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }))
        : undefined;
      const content = 'text' in reply ? reply.text : '';
      const finish = toolCalls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (request.stream) {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra: Record<string, unknown> = {}): string => `data: ${JSON.stringify({
          id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created, model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra,
        })}\n\n`;
        const first = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content };
        const payload = chunk(first, null) + chunk({}, finish, { usage }) + 'data: [DONE]\n\n';
        return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'chatcmpl-e2e', object: 'chat.completion', created, model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: toolCalls ? null : content, tool_calls: toolCalls }, finish_reason: finish }],
        usage,
      });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => { void server.stop(true); },
  };
}

// ── the daemon's front door ─────────────────────────────────────────────────

export interface DaemonDoor {
  readonly port: number;
  /** Every request that reached the door while a daemon was behind it: path with query. */
  readonly seen: string[];
  /** Forward to a daemon on `upstreamPort` (null: nothing is listening, connections are refused). */
  open(upstreamPort: number): void;
  /** Close the door: the port refuses connections, as when the daemon is gone. */
  close(): void;
  stop(): void;
}

/**
 * The configured daemon port, held by the test: while open it forwards every
 * HTTP request to a real daemon on another port and records its path; while
 * closed nothing listens there. The Agent sees one daemon that goes away and
 * comes back; the test sees exactly which calls the Agent made and when.
 */
export function createDaemonDoor(port: number): DaemonDoor {
  const seen: string[] = [];
  let server: ReturnType<typeof Bun.serve> | null = null;
  const door: DaemonDoor = {
    port,
    seen,
    open(upstreamPort) {
      door.close();
      server = Bun.serve({
        port,
        hostname: '127.0.0.1',
        // The Agent holds a long-lived event stream open through the door.
        idleTimeout: 0,
        async fetch(req) {
          const url = new URL(req.url);
          seen.push(`${req.method} ${url.pathname}${url.search}`);
          const target = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`;
          const headers = new Headers(req.headers);
          headers.delete('host');
          const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
          try {
            const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
            return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
          } catch {
            return new Response('upstream unavailable', { status: 502 });
          }
        },
      });
    },
    close() {
      if (server) {
        void server.stop(true);
        server = null;
      }
    },
    stop() { door.close(); },
  };
  return door;
}

// ── the isolated home ───────────────────────────────────────────────────────

export interface E2EHome {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly daemonPort: number;
  /** The daemon's own state directory inside the isolated home. */
  readonly daemonHome: string;
  /** Write a settings key (dot path) into the Agent's settings file. */
  setAgentSetting(key: string, value: unknown): void;
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object') node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function mergeJson(path: string, key: string, value: unknown): void {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  setDotted(current, key, value);
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}

/**
 * A fresh home with the scripted model registered as a custom provider and
 * selected, onboarding already finished, launch self-update off, and the daemon
 * port pinned to an unused port. The scratch workspace is new to this home, so
 * the first-start workspace question is asked (see answerWorkspaceQuestion).
 */
export async function makeHome(model: StubModel): Promise<E2EHome> {
  const root = mkdtempSync(join(tmpdir(), 'gv-agent-e2e-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const agentDir = join(home, '.goodvibes', 'agent');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  mkdirSync(join(agentDir, 'providers'), { recursive: true });
  mkdirSync(daemonHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = E2E Owner\n\temail = e2e@example.test\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: workspace, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), '# e2e workspace\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  writeFileSync(join(agentDir, 'providers', 'e2e-stub.json'), JSON.stringify({
    name: 'e2e-stub',
    displayName: 'E2E Stub',
    type: 'openai-compat',
    baseURL: model.baseURL,
    apiKey: 'e2e-not-a-secret',
    models: [{
      id: 'stub-model',
      displayName: 'Stub Model',
      contextWindow: 64_000,
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    }],
  }, null, 2));
  const now = Date.now();
  writeFileSync(join(agentDir, 'onboarding-complete.json'), JSON.stringify({ version: 1, checkedAt: now, updatedAt: now, source: 'wizard' }));
  const daemonPort = await freePort();
  const settingsPath = join(agentDir, 'settings.json');
  const e2eHome: E2EHome = {
    root, home, workspace, daemonPort, daemonHome,
    setAgentSetting: (key, value) => mergeJson(settingsPath, key, value),
  };
  e2eHome.setAgentSetting('provider.model', 'e2e-stub:stub-model');
  e2eHome.setAgentSetting('update.auto', false);
  // The daemon's settings file owns controlPlane.*; the Agent reads it there.
  mergeJson(join(daemonHome, 'settings.json'), 'controlPlane.host', '127.0.0.1');
  mergeJson(join(daemonHome, 'settings.json'), 'controlPlane.port', daemonPort);
  return e2eHome;
}

/** The environment the binary runs in: the isolated home and nothing ambient. */
export function isolatedEnv(e2eHome: E2EHome, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: e2eHome.home,
    GOODVIBES_WORKING_DIR: e2eHome.workspace,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: join(e2eHome.root, 'tmp'),
    ...extra,
  };
}

// ── the terminal ────────────────────────────────────────────────────────────

let sessionCounter = 0;

export interface AgentSession {
  /** The rendered screen, one string per row. */
  screen(): string;
  /** Everything the program wrote to the terminal so far, escape sequences included. */
  rawOutput(): string;
  /** What the binary wrote to stderr. */
  stderr(): string;
  type(text: string): void;
  key(name: string): void;
  waitForScreen(what: string, predicate: (screen: string) => boolean, timeoutMs?: number): Promise<string>;
  /** True while the binary is still running in the pane. */
  alive(): boolean;
  stop(): void;
}

/** Launch the built binary in a private tmux server at `cols` x `rows`. */
export function launchAgent(e2eHome: E2EHome, options: { cols?: number; rows?: number; env?: Record<string, string> } = {}): AgentSession {
  if (!tmuxAvailable()) throw new Error('E2E: tmux is required (apt-get install tmux)');
  const binary = resolveBinary();
  mkdirSync(join(e2eHome.root, 'tmp'), { recursive: true });
  const socket = `gv-agent-e2e-${process.pid}-${++sessionCounter}`;
  const rawPath = join(e2eHome.root, `${socket}.raw`);
  const stderrPath = join(e2eHome.root, `${socket}.stderr`);
  writeFileSync(rawPath, '');
  const env = isolatedEnv(e2eHome, options.env);
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: e2eHome.home, TMUX_TMPDIR: '/tmp' } });

  // `env -i` so nothing from this process (NODE_ENV=test, a desktop bus, real
  // credentials) reaches the binary; `exec` so the pane's process IS the binary.
  const command = ['exec', 'env', '-i', ...envArgs.map(shellQuote), shellQuote(binary), `2>${shellQuote(stderrPath)}`].join(' ');
  const started = tmux('new-session', '-d', '-s', 'main', '-x', String(options.cols ?? 100), '-y', String(options.rows ?? 30), '-c', e2eHome.workspace, command);
  if (started.status !== 0) throw new Error(`E2E: tmux new-session failed: ${started.stderr}`);
  tmux('set-option', '-t', 'main', 'remain-on-exit', 'on');
  tmux('pipe-pane', '-o', '-t', 'main', `cat >> ${shellQuote(rawPath)}`);

  const readStderr = (): string => (existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '');
  const session: AgentSession = {
    screen: () => tmux('capture-pane', '-p', '-t', 'main').stdout,
    rawOutput: () => readFileSync(rawPath, 'utf8'),
    stderr: readStderr,
    type: (text) => { tmux('send-keys', '-t', 'main', '-l', '--', text); },
    key: (name) => { tmux('send-keys', '-t', 'main', name); },
    waitForScreen: async (what, predicate, timeoutMs = 30_000) => {
      try {
        return await waitFor(what, () => {
          const screen = session.screen();
          return predicate(screen) ? screen : false;
        }, timeoutMs);
      } catch (error) {
        throw new Error(`${String(error)}\n--- screen ---\n${session.screen()}\n--- stderr ---\n${readStderr().slice(-2000)}`);
      }
    },
    alive: () => tmux('display-message', '-p', '-t', 'main', '#{pane_dead}').stdout.trim() === '0',
    stop: () => {
      tmux('kill-server');
      // kill-server can leave the socket file behind; it is this session's own.
      rmSync(join('/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
    },
  };
  return session;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The input area is on screen: its placeholder text. */
export function inputAreaVisible(screen: string): boolean {
  return screen.includes('Ask anything, or type / for commands');
}

/** The first-start question, as it is drawn: a modal titled with the question. */
export const WORKSPACE_QUESTION = 'Register this workspace for automatic checkpoints?';

/**
 * Wait for the first-start workspace question and answer it: Enter on the
 * preselected "Not here", or move up and Enter for "Register". Returns once the
 * modal is gone and the input area is back.
 */
export async function answerWorkspaceQuestion(session: AgentSession, answer: 'decline' | 'register'): Promise<string> {
  const asked = await session.waitForScreen('the workspace question', (s) => screenText(s).includes(WORKSPACE_QUESTION), 30_000);
  if (answer === 'register') session.key('Up');
  session.key('Enter');
  await session.waitForScreen('the question answered', (s) => !screenText(s).includes(WORKSPACE_QUESTION) && inputAreaVisible(s), 15_000);
  return asked;
}

/** Words of the screen joined across wraps, for assertions on text that may wrap. */
export function screenText(screen: string): string {
  return screen.split('\n').map((line) => line.trim()).join(' ').replace(/\s+/g, ' ');
}

/** Remove a home made by makeHome. */
export function removeHome(e2eHome: E2EHome | null): void {
  if (e2eHome) rmSync(e2eHome.root, { recursive: true, force: true });
}
