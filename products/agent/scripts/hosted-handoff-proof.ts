#!/usr/bin/env bun
/**
 * hosted-handoff-proof.ts, this agent's client seams, against the real
 * compiled daemon binary.
 *
 * The suite drives these seams with stubs, which proves the rules. This proves
 * the WIRE: that the verbs this agent calls exist on the daemon that ships, in
 * the shape this agent calls them, and that the two things Stage B3 added
 * actually work end to end,
 *
 *   1. an inbound channel conversation is promoted to a daemon-hosted session
 *      and later messages steer into that same session, with the daemon's own
 *      list and transcript as the evidence; and
 *   2. an approval raised on the daemon reaches this process's approvals panel
 *      over `control.approval_update`, not by polling.
 *
 * Isolation, deliberately and without exception: a temporary home, a port well
 * away from 3421, its own operator token, and its own OpenAI-compatible stub
 * for the model. It never touches the machine's daemon, its state, or systemd.
 *
 * Run it against a built daemon binary:
 *   bun run scripts/hosted-handoff-proof.ts [path/to/goodvibes-daemon-<os>-<arch>]
 * Default: ~/Projects/goodvibes-daemon/dist/goodvibes-daemon-<os>-<arch>.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { SharedApprovalRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { watchApprovalUpdates } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { createAgentDaemonVerbCaller, resolveConnectedHostConnection } from '../src/runtime/client/daemon-verbs.ts';
import { createHostedConversationHandoff } from '../src/runtime/client/hosted-handoff.ts';
import { createApprovalsView } from '../src/runtime/client/approvals-view.ts';

function defaultBinary(): string {
  const names: Record<string, string> = {
    'linux-x64': 'goodvibes-daemon-linux-x64',
    'linux-arm64': 'goodvibes-daemon-linux-arm64',
    'darwin-x64': 'goodvibes-daemon-macos-x64',
    'darwin-arm64': 'goodvibes-daemon-macos-arm64',
  };
  const name = names[`${process.platform}-${process.arch}`] ?? 'goodvibes-daemon-linux-x64';
  return join(homedir(), 'Projects', 'goodvibes-daemon', 'dist', name);
}

const BINARY = process.argv[2] ?? defaultBinary();
const DAEMON_PORT = 47871;
const STUB_PORT = 47872;
const TOKEN = 'hosted-handoff-proof-token';
// Both sides of the wire read this: the daemon child below takes it as its
// token, and this process's own connected-host token resolution finds the same
// value here rather than in a file that would have to be written first.
process.env['GOODVIBES_DAEMON_TOKEN'] = TOKEN;

const home = mkdtempSync(join(tmpdir(), 'gv-handoff-proof-'));
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'note.txt'), 'a note a promoted conversation could read\n');

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail = ''): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${step}${detail ? `: ${detail}` : ''}`);
}

// --- the model a promoted conversation will actually call ---------------------
let stubCalls = 0;
const stub = Bun.serve({
  port: STUB_PORT,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'proof-model' }] });
    stubCalls += 1;
    return Response.json({
      id: 'chatcmpl-handoff-proof',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'proof-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: `promoted turn ${stubCalls} answered` },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    });
  },
});

// The daemon reads this at boot and registers it as a routable provider.
const surfaceDir = join(home, '.goodvibes', 'tui');
mkdirSync(surfaceDir, { recursive: true });
writeFileSync(join(surfaceDir, 'discovered-providers.json'), JSON.stringify([{
  name: 'proof-stub',
  host: '127.0.0.1',
  port: STUB_PORT,
  baseURL: `http://127.0.0.1:${STUB_PORT}/v1`,
  models: ['proof-model'],
  serverType: 'vllm',
  lastSeen: Date.now(),
}], null, 2));

mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
const daemon = Bun.spawn([BINARY, '--port', String(DAEMON_PORT), '--hostname', '127.0.0.1'], {
  env: {
    ...process.env,
    GOODVIBES_HOME: home,
    GOODVIBES_DAEMON_HOME: join(home, '.goodvibes', 'daemon'),
    GOODVIBES_WORKING_DIR: workspace,
    GOODVIBES_DAEMON_TOKEN: TOKEN,
  },
  cwd: workspace,
  stdout: 'pipe',
  stderr: 'pipe',
});

/**
 * The config this agent's host resolution reads: three keys, so the seams dial
 * the isolated daemon above and nothing else. A real ConfigManager would open
 * this machine's settings, which is exactly what an isolated proof must not do.
 */
const configManager = {
  get: (key: string): unknown => {
    if (key === 'controlPlane.host') return '127.0.0.1';
    if (key === 'controlPlane.port') return DAEMON_PORT;
    if (key === 'daemon.enabled') return true;
    return undefined;
  },
} as unknown as ConfigManager;

// `GOODVIBES_DAEMON_TOKEN` above is also how this process's own token resolution
// finds the token, so both sides of the wire agree without a token file.
const connectedHostAccess = { configManager, homeDirectory: home };
const verbs = createAgentDaemonVerbCaller(connectedHostAccess);

async function waitForDaemon(): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(500);
  }
  return false;
}

interface HostedSessionRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly messageCount: number;
}

try {
  const up = await waitForDaemon();
  check('the compiled daemon binary boots on an isolated home and answers /status', up, `port ${DAEMON_PORT}`);
  if (!up) throw new Error('daemon never answered');

  // A promoted conversation follows the DAEMON's model selection, the handoff
  // never names a model, because the daemon is the one running the loop. So the
  // daemon's selection is pointed at the stub before anything is promoted.
  await verbs.invoke('config.set', { key: 'provider.model', value: 'proof-stub:proof-model' });

  // ── 1. promotion is off by default, and off means no wire traffic ──────────
  let promotionEnabled = false;
  const handoff = createHostedConversationHandoff({
    verbs,
    isEnabled: () => promotionEnabled,
    workspaceRoot: () => workspace,
    clientId: 'agent-proof-client',
  });

  const inbound = (body: string): Parameters<typeof handoff.promote>[0] => ({
    sessionId: 'channel-session-1',
    task: `Continue the conversation. The owner said: ${body}`,
    body,
    surfaceKind: 'telegram',
    surfaceId: 'telegram:proof',
  });

  const whileOff = await handoff.promote(inbound('hello'));
  const listedWhileOff = await verbs.invoke<{ sessions: HostedSessionRow[] }>('sessions.hosted.list', {});
  check('with the setting off nothing is promoted and the daemon hosts nothing',
    whileOff.promoted === false && listedWhileOff.sessions.length === 0,
    `promoted=${whileOff.promoted} hosted=${listedWhileOff.sessions.length}`);

  // ── 2. the first message creates a hosted session on the real daemon ───────
  promotionEnabled = true;
  const first = await handoff.promote(inbound('say hello from a promoted conversation'));
  check('the first inbound message creates a daemon-hosted session',
    first.promoted && first.action === 'created',
    first.promoted ? first.hostedSessionId : first.reason);
  if (!first.promoted) throw new Error(`promotion refused: ${first.reason}`);

  const listed = await verbs.invoke<{ sessions: HostedSessionRow[] }>('sessions.hosted.list', {});
  const row = listed.sessions.find((session) => session.id === first.hostedSessionId);
  check('the daemon lists it, titled from the owner\'s own words',
    row !== undefined && row.title.includes('say hello'),
    `${listed.sessions.length} hosted: title ${JSON.stringify(row?.title ?? null)}`);

  // The opening prompt is a real turn against a real model.
  for (let attempt = 0; attempt < 40 && stubCalls === 0; attempt += 1) await Bun.sleep(500);
  check('the promoted conversation ran a turn against a real model', stubCalls > 0, `${stubCalls} provider call(s)`);

  // ── 3. later messages steer into the SAME session ──────────────────────────
  const second = await handoff.promote(inbound('and one more thing'));
  check('a later message steers into the same session rather than creating another',
    second.promoted && second.action === 'steered' && second.hostedSessionId === first.hostedSessionId,
    second.promoted ? `${second.action} -> ${second.hostedSessionId}` : second.reason);

  const stillOne = await verbs.invoke<{ sessions: HostedSessionRow[] }>('sessions.hosted.list', {});
  check('exactly one hosted session carries the conversation', stillOne.sessions.length === 1,
    `${stillOne.sessions.length} hosted session(s)`);

  // The steer is queued on the shared spine and collected by the hosted
  // session's intake on its own tick, so the transcript is polled rather than
  // read once, the message is on its way, not necessarily arrived.
  let history: { role: string; content: string }[] = [];
  let heardBoth = false;
  for (let attempt = 0; attempt < 40 && !heardBoth; attempt += 1) {
    const attached = await verbs.invoke<{ history: { role: string; content: string }[] }>(
      'sessions.hosted.attach', { sessionId: first.hostedSessionId, clientId: 'agent-proof-watcher' },
    );
    history = attached.history;
    heardBoth = history.some((message) => message.content.includes('say hello'))
      && history.some((message) => message.content.includes('one more thing'));
    if (!heardBoth) await Bun.sleep(500);
  }
  check('both inbound messages are in the hosted transcript', heardBoth,
    `${history.length} message(s): ${JSON.stringify(history.map((message) => message.role))}`);

  // ── 4. a killed session is started again rather than losing the message ────
  await verbs.invoke('sessions.hosted.kill', { sessionId: first.hostedSessionId });
  const afterKill = await handoff.promote(inbound('are you still there'));
  check('a message for a killed hosted session starts a new one instead of failing',
    afterKill.promoted && afterKill.action === 'recreated' && afterKill.hostedSessionId !== first.hostedSessionId,
    afterKill.promoted ? `${afterKill.action} -> ${afterKill.hostedSessionId}` : afterKill.reason);

  // ── 5. an approval raised on the daemon arrives on the panel, over SSE ─────
  const approvals = createApprovalsView({
    verbs,
    localBroker: { listApprovals: () => [] },
    // Long enough that anything appearing inside this proof arrived on the
    // stream and not on a poll tick.
    refreshIntervalMs: 600_000,
    liveRefreshIntervalMs: 600_000,
    subscribe: async ({ onUpdate, onTerminate }) => {
      const resolved = resolveConnectedHostConnection(connectedHostAccess);
      if ('reason' in resolved) return null;
      return await watchApprovalUpdates({
        baseUrl: resolved.baseUrl,
        getAuthToken: () => resolved.token,
        onUpdate,
        onTerminate,
      });
    },
  });
  approvals.start();
  for (let attempt = 0; attempt < 40 && !approvals.snapshot().liveUpdates; attempt += 1) await Bun.sleep(250);
  check('the approvals panel opened the control.approval_update stream',
    approvals.snapshot().liveUpdates, `liveUpdates=${approvals.snapshot().liveUpdates}`);

  const raised = await verbs.invoke<{ approval: SharedApprovalRecord }>('approvals.raise', {
    request: {
      callId: 'proof-call-1',
      tool: 'exec',
      args: { command: 'echo hosted' },
      category: 'execute',
      analysis: {
        classification: 'shell-command',
        riskLevel: 'low',
        summary: 'echo a word in the proof workspace',
        reasons: ['raised by the hosted-handoff proof'],
      },
    },
    sessionId: 'channel-session-1',
  });
  let sawRaise = false;
  for (let attempt = 0; attempt < 40 && !sawRaise; attempt += 1) {
    sawRaise = approvals.snapshot().approvals.some((record) => record.id === raised.approval.id);
    if (!sawRaise) await Bun.sleep(250);
  }
  check('an ask raised on the daemon appears on the panel without a re-read', sawRaise, raised.approval.id);

  await verbs.invoke('approvals.deny', { approvalId: raised.approval.id, note: 'proof' });
  let cleared = false;
  for (let attempt = 0; attempt < 40 && !cleared; attempt += 1) {
    cleared = !approvals.snapshot().approvals.some((record) => record.id === raised.approval.id);
    if (!cleared) await Bun.sleep(250);
  }
  check('a decision made elsewhere clears the row just as fast', cleared, `pending ${approvals.snapshot().approvals.length}`);
  approvals.stop();
} catch (error) {
  // A proof that stopped early is a failed proof, not a short one, record it
  // so the tally and the kept-home decision below both tell the truth.
  check('the proof ran to the end', false, error instanceof Error ? error.message : String(error));
} finally {
  daemon.kill('SIGTERM');
  await daemon.exited.catch(() => undefined);
  stub.stop(true);
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`home kept for inspection: ${home}`);
    process.exitCode = 1;
  } else {
    rmSync(home, { recursive: true, force: true });
  }
}
