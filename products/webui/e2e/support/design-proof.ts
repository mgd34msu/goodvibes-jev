/**
 * Helpers for e2e/design-proof.e2e.ts (design doc "Build plan" step 7, "Proof"):
 * the layout checks every destination and state must pass, the theme loop and the
 * optional screenshots, and the chat fixtures (a signed-in name, a model list with
 * an effort ladder, and a finished turn that used tools) the chat states need.
 *
 * Screenshots are off unless DESIGN_PROOF_SHOTS names a folder; then every state
 * is shot in dark and light (and the states that ask for it in neon too), named
 * `<screen>.<desktop|phone>.<theme>.png`. The layout checks run in every theme
 * shot, and in dark alone otherwise.
 */
import { expect, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalScroll, nextFrames } from './app';
import type { ChatMockDaemon } from './chat-mock';

export type ProofTheme = 'dark' | 'light' | 'neon';

const SHOTS_DIR = process.env.DESIGN_PROOF_SHOTS;

/** src/lib/theme.ts THEME_PREFERENCES_KEY and THEME_PREFERENCES_EVENT. */
const THEME_KEY = 'goodvibes.webui.theme';
const THEME_EVENT = 'goodvibes:webui-theme';

/**
 * Elements allowed to scroll horizontally inside themselves: code (chat code
 * blocks, artifact code, data-view code frames and any other <pre>), which
 * scrolls inside its own frame instead of wrapping, and text fields, whose
 * value scrolls inside the field's padding as the caret moves.
 */
const CODE_SCROLLERS = 'pre, code, .markdown-code-block, .artifact-code-block, .dv-code';
const SELF_SCROLLERS = `${CODE_SCROLLERS}, input, textarea`;

/** The fills whose text must never touch an edge or be clipped (shell header and rows). */
const TEXT_FILLS = '.shell-header, .gv-row, .shell-nav-item, .shell-recent__row';

/** Text must keep at least this many pixels from the inside of its fill's border. */
const EDGE_GAP = 4;

interface LayoutFinding {
  readonly kind: 'overflow' | 'clipped' | 'edge';
  readonly where: string;
  readonly detail: string;
}

/**
 * The two in-page layout checks (the page-scroll check is expectNoHorizontalScroll):
 *
 * 1. No element overflows its own scroll container horizontally: any visible
 *    element whose overflow-x is not visible and whose scrollWidth exceeds its
 *    clientWidth is a finding, except code and text fields (SELF_SCROLLERS) and deliberate
 *    single-line truncation (text-overflow: ellipsis), which shows an ellipsis
 *    rather than cutting text at the edge.
 * 2. In the shell header and in rows, no text is clipped (its own element's
 *    scrollWidth > clientWidth without an ellipsis) and no text runs within
 *    EDGE_GAP pixels of its fill's border box.
 */
export async function layoutFindings(page: Page): Promise<LayoutFinding[]> {
  return page.evaluate(({ codeScrollers, selfScrollers, textFills, edgeGap }) => {
    const findings: { kind: 'overflow' | 'clipped' | 'edge'; where: string; detail: string }[] = [];
    const describe = (el: Element): string => {
      const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      const label = el.getAttribute('aria-label') ?? '';
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${label ? `[${label.slice(0, 40)}]` : ''}`;
    };
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    };
    const truncates = (el: Element): boolean => getComputedStyle(el).textOverflow === 'ellipsis';
    const lineClamped = (el: Element): boolean => {
      const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitLineClamp?: string };
      return Boolean(cs.webkitLineClamp && cs.webkitLineClamp !== 'none');
    };

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'visible') continue;
      if (el.closest(selfScrollers)) continue;
      if (!visible(el)) continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      if (truncates(el) || lineClamped(el)) continue;
      // Name the widest descendant reaching past the container's right edge.
      const edge = el.getBoundingClientRect().right;
      let culprit = '';
      let reach = edge + 1;
      for (const child of Array.from(el.querySelectorAll('*'))) {
        const right = child.getBoundingClientRect().right;
        if (right > reach && visible(child)) { reach = right; culprit = describe(child); }
      }
      findings.push({ kind: 'overflow', where: describe(el), detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}${culprit ? `; widest: ${culprit} reaching ${Math.round(reach - edge)}px past` : ''}` });
    }

    for (const fill of Array.from(document.querySelectorAll(textFills))) {
      if (!visible(fill)) continue;
      const box = fill.getBoundingClientRect();
      const fcs = getComputedStyle(fill);
      const inner = {
        left: box.left + parseFloat(fcs.borderLeftWidth),
        right: box.right - parseFloat(fcs.borderRightWidth),
      };
      const walker = document.createTreeWalker(fill, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const parent = node.parentElement;
        if (!parent || !visible(parent) || parent.closest('.gv-sr-only') || parent.closest(codeScrollers)) continue;
        // The text's visible extent: an ellipsis-truncated element shows its own
        // box; otherwise the laid-out text itself.
        const host: Element = parent;
        let left: number;
        let right: number;
        if (truncates(host) || lineClamped(host)) {
          const r = host.getBoundingClientRect();
          left = r.left + parseFloat(getComputedStyle(host).paddingLeft);
          right = r.right - parseFloat(getComputedStyle(host).paddingRight);
        } else {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
          if (rects.length === 0) continue;
          left = Math.min(...rects.map((r) => r.left));
          right = Math.max(...rects.map((r) => r.right));
          if (host.scrollWidth > host.clientWidth + 1 && getComputedStyle(host).overflowX !== 'visible') {
            findings.push({ kind: 'clipped', where: `${describe(fill)} > ${describe(host)}`, detail: `"${node.textContent.trim().slice(0, 40)}" is cut off (scrollWidth ${host.scrollWidth} > clientWidth ${host.clientWidth})` });
          }
        }
        const gapLeft = left - inner.left;
        const gapRight = inner.right - right;
        if (gapLeft < edgeGap - 0.5 || gapRight < edgeGap - 0.5) {
          findings.push({ kind: 'edge', where: `${describe(fill)} > ${describe(host)}`, detail: `"${node.textContent.trim().slice(0, 40)}" sits ${gapLeft.toFixed(1)}px / ${gapRight.toFixed(1)}px from the fill edges` });
        }
      }
    }
    return findings;
  }, { codeScrollers: CODE_SCROLLERS, selfScrollers: SELF_SCROLLERS, textFills: TEXT_FILLS, edgeGap: EDGE_GAP });
}

async function applyTheme(page: Page, theme: ProofTheme): Promise<void> {
  // Switch through the app's own preference (storage plus the change event the
  // theme provider listens for), so the page and every theme control agree.
  // Transitions are held off for the switch: color transitions (120-240 ms)
  // would start from the previous theme's values, and a measurement or
  // screenshot taken mid-way would show neither theme.
  await page.evaluate(({ value, key, event }) => {
    const hold = document.createElement('style');
    hold.id = 'design-proof-theme-hold';
    hold.textContent = '*, *::before, *::after { transition: none !important; }';
    document.head.append(hold);
    window.localStorage.setItem(key, JSON.stringify({ theme: value, density: 'default' }));
    window.dispatchEvent(new CustomEvent(event));
  }, { value: theme, key: THEME_KEY, event: THEME_EVENT });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await nextFrames(page);
  await page.evaluate(() => document.getElementById('design-proof-theme-hold')?.remove());
  await nextFrames(page);
}

/**
 * Prove one screen: in each theme, the page does not scroll sideways, nothing
 * overflows its scroll container but code, and header and row text keeps off its
 * fill edges. With DESIGN_PROOF_SHOTS set, also screenshot it per theme.
 */
export async function proveScreen(
  page: Page,
  testInfo: TestInfo,
  screen: string,
  options: { neon?: boolean } = {},
): Promise<void> {
  const themes: ProofTheme[] = SHOTS_DIR ? ['dark', 'light', ...(options.neon ? ['neon' as const] : [])] : ['dark'];
  // Loading is over (skeleton rows and in-flight reads carry aria-busy), then
  // every entrance and transition has finished before anything is measured.
  // Polled from the page's own animation list, not a fixed sleep: a slow runner
  // waits as long as it needs, a fast one does not wait at all. Looping
  // animations (a live dot, a caret) never finish and are left out.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) => {
    if (animation.playState !== 'running') return false;
    const iterations = animation.effect?.getComputedTiming().iterations ?? 1;
    return Number.isFinite(iterations);
  }).length)).toBe(0);
  for (const theme of themes) {
    await applyTheme(page, theme);
    await expectNoHorizontalScroll(page);
    const findings = await layoutFindings(page);
    expect(findings, `${screen} (${testInfo.project.name}, ${theme}):\n${findings.map((f) => `${f.kind}: ${f.where}: ${f.detail}`).join('\n')}`).toEqual([]);
    if (SHOTS_DIR) {
      await page.screenshot({ path: `${SHOTS_DIR}/${screen}.${testInfo.project.name}.${theme}.png` });
    }
  }
  await applyTheme(page, 'dark');
}

/** Answer the auth probe as a signed-in person, so the greeting uses a name. */
export async function signedInAs(page: Page, name: string): Promise<void> {
  await page.route('**/api/control-plane/auth', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, username: name, identity: { subject: name } }),
  }));
}

/** A model list with an effort ladder, so the composer reads "Claude Opus 4.8 High". */
export async function withModels(page: Page): Promise<void> {
  const provider = {
    id: 'anthropic',
    label: 'Anthropic',
    configured: true,
    models: [
      { registryKey: 'anthropic:claude-opus-4-8', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', reasoningOptions: { levels: ['low', 'medium', 'high'], source: 'catalog' } },
      { registryKey: 'anthropic:claude-sonnet-5', id: 'claude-sonnet-5', label: 'Claude Sonnet 5', reasoningOptions: { levels: ['low', 'medium', 'high'], source: 'catalog' } },
    ],
  };
  const current = { model: { registryKey: 'anthropic:claude-opus-4-8', provider: 'anthropic', id: 'claude-opus-4-8', effort: 'high' } };
  const fulfill = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/models/current', (route) => route.fulfill(fulfill(current)));
  await page.route('**/api/models', (route) => route.fulfill(fulfill({ providers: [provider], currentModel: current.model })));
  await page.route('**/api/providers', (route) => route.fulfill(fulfill({ providers: [provider] })));
}

/**
 * Serve the chat's live event stream in the page (an open-ended fetch body, so
 * it stays connected like a real daemon's) with one finished turn that used
 * tools: two reads and a web search fold onto the reply the mock appended.
 */
export async function streamToolTurn(page: Page, daemon: ChatMockDaemon): Promise<void> {
  // Every connection for the session gets the frames: the app reconnects the
  // stream once the new chat's session exists, and the first connection can be
  // closed before it reads anything. Tool activity is keyed by message, so a
  // replay on a later connection replaces rather than duplicates it.
  await page.exposeFunction('__gvProofFrames', async (sessionId: string) => {
    let reply: { id: string } | undefined;
    for (let i = 0; i < 100 && !reply; i += 1) {
      reply = daemon.messagesOf(sessionId).find((m) => m.role === 'assistant');
      if (!reply) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!reply) return '';
    // The mock's clock starts near the epoch; stamp real times so the turn's
    // tool activity lands on a reply the view treats as current.
    for (const message of daemon.messagesOf(sessionId)) (message as { createdAt?: number }).createdAt = Date.now();
    const turnId = 'turn-proof';
    const frames = [
      { type: 'turn.started', sessionId, turnId },
      { type: 'turn.tool_call', sessionId, turnId, toolCallId: 'c1', toolName: 'read', toolInput: { file_path: 'src/lib/promise.ts' } },
      { type: 'turn.tool_result', sessionId, turnId, toolCallId: 'c1', toolName: 'read', result: 'export async function settle() { return queueMicrotask(flush); }', isError: false },
      { type: 'turn.tool_call', sessionId, turnId, toolCallId: 'c2', toolName: 'read', toolInput: { file_path: 'src/lib/queue.ts' } },
      { type: 'turn.tool_result', sessionId, turnId, toolCallId: 'c2', toolName: 'read', result: 'queueMicrotask(flush);', isError: false },
      { type: 'turn.tool_call', sessionId, turnId, toolCallId: 'c3', toolName: 'WebSearch', toolInput: { query: 'microtask queue ordering' } },
      { type: 'turn.tool_result', sessionId, turnId, toolCallId: 'c3', toolName: 'WebSearch', result: '3 results', isError: false },
      { type: 'turn.completed', sessionId, turnId, assistantMessageId: reply.id },
    ];
    return frames.map((f) => `event: companion-chat.${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
  });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const proof = window as unknown as { __gvProofFrames?: (id: string) => Promise<string> };
    // Object.assign keeps the full fetch type (bun-types adds `preconnect`).
    window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const match = /\/api\/companion\/chat\/sessions\/([^/?]+)\/events/.exec(url);
      const frames = proof.__gvProofFrames;
      if (!match || !frames) return original(input, init);
      const sessionId = decodeURIComponent(match[1]);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          signal?.addEventListener('abort', () => {
            try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* already closed */ }
          });
          const body = await frames(sessionId);
          if (body) controller.enqueue(new TextEncoder().encode(body));
          // Never closes: a live stream stays open.
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }, { preconnect: window.fetch.preconnect });
  });
}

/** A finished best-of-three attempt group, two held for a pick and one failed (attempt comparison). */
export const ATTEMPT_GROUP = {
  groupId: 'g-1', workstreamId: 'ws-1', sourceTitle: 'Build the widget', ready: true, autoAccept: false,
  candidates: [
    {
      itemId: 'i-1', attemptIndex: 0, state: 'held-merge', title: 'Use a map for the lookup', worktreePath: '/wt/a', branch: 'attempt/a',
      usage: { inputTokens: 1200, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 2, costUsd: 0.1, costState: 'priced' },
      failureReason: null,
      diff: { files: ['src/a.ts'], unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n+const y = new Map();\n const z = 3;\n', stat: '1 file' },
    },
    {
      itemId: 'i-2', attemptIndex: 1, state: 'held-merge', title: 'Use an object for the lookup', worktreePath: '/wt/b', branch: 'attempt/b',
      usage: { inputTokens: 1300, outputTokens: 2200, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 1, costUsd: 0.12, costState: 'priced' },
      failureReason: null,
      diff: { files: ['src/a.ts'], unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n+const y = {};\n const z = 3;\n', stat: '1 file' },
    },
    {
      itemId: 'i-3', attemptIndex: 2, state: 'failed', title: 'Rewrite with a class', worktreePath: '/wt/c', branch: 'attempt/c',
      usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 0, costUsd: 0.01, costState: 'priced' },
      failureReason: 'Type check failed', diff: null,
    },
  ],
  judgment: null,
};
