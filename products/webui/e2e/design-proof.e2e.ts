/**
 * Design proof (design doc "Build plan" step 7): every destination and major
 * state of the redesigned web UI, on the phone (390x844) and desktop (1280x800)
 * projects, passes three layout checks (e2e/support/design-proof.ts):
 *
 *   - the page never scrolls sideways;
 *   - no element overflows its own scroll container horizontally, except code,
 *     which scrolls inside its frame, and text fields, whose value scrolls
 *     inside the field;
 *   - text in the shell header and in rows is never clipped and never touches
 *     its fill's edge.
 *
 * Chat code blocks get one more check: a long line scrolls inside the frame with
 * the frame's padding intact on both sides, at the start and at the end.
 *
 * DESIGN_PROOF_SHOTS=<folder> also writes `<screen>.<project>.<theme>.png` for
 * every state in dark and light (new chat and Work in neon too).
 */
import { test, expect, type Page } from '@playwright/test';
import { DESKTOP, PHONE, openNavigation, openRow, openSettings, only } from './support/app';
import { installChatMockDaemon } from './support/chat-mock';
import { ATTEMPT_GROUP, proveScreen, signedInAs, streamToolTurn, withModels } from './support/design-proof';
import { installMockDaemon } from './support/mock-daemon';
import { MEMORY_FACT, STEERABLE_SESSION } from './support/seed';

const COMPOSER = 'textarea[aria-label="Message GoodVibes"]';
const LONG_LINE = "const response = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/messages?limit=200&include=attachments,metadata'); // end of line";

async function startChat(page: Page, options: { tools?: boolean } = {}) {
  const daemon = await installChatMockDaemon(page, { replyCode: LONG_LINE });
  await signedInAs(page, 'Mike');
  await withModels(page);
  if (options.tools) await streamToolTurn(page, daemon);
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  return daemon;
}

async function sendFirst(page: Page, text: string) {
  await page.locator(COMPOSER).fill(text);
  await page.locator('.send-button').click();
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.assistant .markdown-code-block').first()).toBeVisible({ timeout: 15_000 });
}

/**
 * A long code line clips inside the frame's padding on both sides, at the start
 * and at the end of its scroll, and only the code scrolls.
 */
async function expectCodeKeepsItsPadding(page: Page) {
  const pre = page.locator('.message.assistant .markdown-code-block pre').first();
  // The streamed reply is replaced by the stored one; wait for the stored long
  // line to be laid out (the frame overflows by the whole line) before measuring.
  await expect.poll(() => pre.evaluate((el, line) => (el.textContent ?? '').length >= line.length && el.scrollWidth > el.clientWidth, LONG_LINE)).toBe(true);
  for (const end of [false, true]) {
    const gaps = await pre.evaluate((el, atEnd) => {
      el.scrollLeft = atEnd ? el.scrollWidth : 0;
      const frame = el.closest('.markdown-code-block')!.getBoundingClientRect();
      const view = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el.querySelector('code')!);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      const textLeft = Math.max(view.left, Math.min(...rects.map((r) => r.left)));
      const textRight = Math.min(view.right, Math.max(...rects.map((r) => r.right)));
      return { scrolls: el.scrollWidth > el.clientWidth, left: textLeft - frame.left, right: frame.right - textRight };
    }, end);
    expect(gaps.scrolls, 'the long line scrolls inside its frame').toBe(true);
    expect(gaps.left, `code text ${gaps.left}px from the frame's left edge`).toBeGreaterThanOrEqual(12);
    expect(gaps.right, `code text ${gaps.right}px from the frame's right edge`).toBeGreaterThanOrEqual(12);
  }
}

test.describe('chat', () => {
  test('new chat', async ({ page }, testInfo) => {
    await startChat(page);
    await expect(page.locator('.chat-greeting')).toBeVisible();
    await proveScreen(page, testInfo, 'new-chat', { neon: true });
  });

  test('conversation, with a long code line kept inside its frame', async ({ page }, testInfo) => {
    await startChat(page, { tools: true });
    await sendFirst(page, 'Explain how promises work, including the microtask queue.');
    await expect(page.locator('.message.assistant .message-tool-activity__line').first()).toBeVisible({ timeout: 15_000 });
    await page.mouse.move(2, 2);
    await expectCodeKeepsItsPadding(page);
    await page.locator('.message.assistant .markdown-code-block pre').first().evaluate((el) => { el.scrollLeft = 0; });
    await proveScreen(page, testInfo, 'conversation');

    await page.locator('.message.assistant .message-tool-activity__summary').first().click();
    await expect(page.locator('.message.assistant .message-tool-activity[open]').first()).toBeVisible();
    await proveScreen(page, testInfo, 'conversation-tools-expanded');
  });

  test('artifacts rail', async ({ page }, testInfo) => {
    await startChat(page);
    await sendFirst(page, 'Write a one-line status fetch in JavaScript.');
    await page.locator('.message.assistant').first().hover();
    await page.locator('.message.assistant button[aria-label="View artifacts from this message"]').first().click();
    await expect(page.locator('.peek-drawer')).toBeVisible();
    if (testInfo.project.name === DESKTOP) {
      await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar', 'rail');
    }
    await proveScreen(page, testInfo, 'artifacts-rail');
  });
});

test.describe('work', () => {
  test('needs you', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.dv-page')).toBeVisible();
    await expect(page.locator('.gv-row').first()).toBeVisible();
    await proveScreen(page, testInfo, 'work-needs-you', { neon: true });
  });

  test('a session open in the detail pane', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=work&tab=sessions');
    const detail = await openRow(page, STEERABLE_SESSION.title);
    await expect(detail.getByRole('list', { name: 'Transcript' })).toBeVisible();
    await proveScreen(page, testInfo, 'work-session');
  });
});

test.describe('library', () => {
  for (const tab of ['memory', 'knowledge', 'review'] as const) {
    test(`${tab} tab`, async ({ page }, testInfo) => {
      await installMockDaemon(page);
      await page.goto(`/?view=library&tab=${tab}`);
      await expect(page.locator('.dv-page')).toBeVisible();
      await proveScreen(page, testInfo, `library-${tab}`);
    });
  }
});

test.describe('personal', () => {
  for (const tab of ['calendar', 'mail', 'occasions'] as const) {
    test(`${tab} tab`, async ({ page }, testInfo) => {
      await installMockDaemon(page, { email: 'configured' });
      await page.goto(`/?view=personal&tab=${tab}`);
      await expect(page.locator('.dv-page')).toBeVisible();
      await proveScreen(page, testInfo, `personal-${tab}`);
    });
  }
});

test.describe('settings dialog', () => {
  // The seven pages, then older section links that open a page scrolled to a
  // section further down it.
  const SECTIONS = [
    'general', 'account', 'models', 'voice', 'notifications', 'memory', 'permissions',
    'devices', 'people', 'credentials', 'usage', 'network', 'about', 'all', 'checkins',
  ] as const;
  for (const section of SECTIONS) {
    test(`${section} section`, async ({ page }, testInfo) => {
      await installMockDaemon(page);
      const dialog = await openSettings(page, section);
      // A phone opens the plain Settings entry on the page list; show the page.
      if (await dialog.locator('.settings-pane').count() === 0) {
        await dialog.getByRole('button', { name: 'General', exact: true }).click();
      }
      await expect(dialog.locator('.settings-pane')).toBeVisible();
      await proveScreen(page, testInfo, `settings-${section}`);
    });
  }

  test('the page list on a phone', async ({ page }, testInfo) => {
    only(testInfo, PHONE);
    await installMockDaemon(page);
    const dialog = await openSettings(page, 'general');
    await expect(dialog.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    await proveScreen(page, testInfo, 'settings-list');
  });
});

test.describe('overlays', () => {
  test('command palette', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await proveScreen(page, testInfo, 'palette');
  });

  test('a confirm', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=library&tab=memory');
    await page.getByRole('list', { name: 'Records' }).getByRole('button', { name: new RegExp(MEMORY_FACT.summary) }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await proveScreen(page, testInfo, 'confirm');
  });

  test('a drawer (a bottom sheet on phone)', async ({ page }, testInfo) => {
    await installMockDaemon(page, { email: 'configured' });
    await page.goto('/?view=personal&tab=mail');
    await page.getByTestId('mail-list').locator('.mail-row .gv-row__main').first().click();
    await expect(page.locator('.dv-peek')).toBeVisible();
    await proveScreen(page, testInfo, 'drawer');
  });

  test('a toast', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=checkpoints');
    const pane = page.locator('.dv-detail');
    await pane.getByRole('textbox', { name: 'Checkpoint label' }).fill('Before the proof pass');
    await pane.getByRole('button', { name: 'Snapshot' }).click();
    // On a phone, creating a checkpoint confirms first.
    if (testInfo.project.name === PHONE) await page.locator('.gv-confirm__confirm').click();
    await expect(page.locator('.toast[data-tone="success"]')).toBeVisible();
    await proveScreen(page, testInfo, 'toast');
  });

  test('the account menu', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await openNavigation(page);
    await page.getByRole('button', { name: /^Account: / }).click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu).toBeVisible();
    await proveScreen(page, testInfo, 'account-menu');
    // The theme control always shows the theme the page is painted in.
    for (const [theme, label] of [['light', 'Light'], ['dark', 'Dark']] as const) {
      await menu.getByRole('menuitemradio', { name: label }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(menu.getByRole('menuitemradio', { name: label })).toHaveAttribute('aria-checked', 'true');
    }
  });

  test('the phone drawer', async ({ page }, testInfo) => {
    only(testInfo, PHONE);
    await installMockDaemon(page);
    await page.goto('/?view=chat');
    await openNavigation(page);
    await expect(page.locator('.shell-drawer')).toBeVisible();
    await proveScreen(page, testInfo, 'phone-drawer');
  });
});

test.describe('tools, pages and gates', () => {
  test('the phone node page', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=phone');
    await expect(page.locator('.app-shell')).toBeVisible();
    await proveScreen(page, testInfo, 'phone-node');
  });

  test('the sign-in gate', async ({ page }, testInfo) => {
    await installMockDaemon(page, { signedIn: false });
    await page.goto('/');
    await expect(page.locator('.signed-out-gate')).toBeVisible();
    await proveScreen(page, testInfo, 'sign-in');
  });

  test('the pairing hand-off', async ({ page }, testInfo) => {
    await installMockDaemon(page, { signedIn: false });
    await page.goto('/?view=chat#pair=e2e-handoff-token&offers=notifications,relay');
    await expect(page.locator('.pairing-handoff')).toBeVisible();
    await proveScreen(page, testInfo, 'pairing-handoff');
  });

  test('the model workspace', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await openSettings(page, 'models');
    await page.getByRole('button', { name: 'Change model' }).click();
    const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
    await expect(dialog.locator('.model-workspace-row').first()).toBeVisible();
    await proveScreen(page, testInfo, 'model-workspace');
  });

  test('model prices', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=work&tab=agents');
    await openRow(page, 'Refactor the session spine');
    await page.locator('[data-testid="price-source-note"]').getByRole('button').click();
    await expect(page.getByRole('dialog', { name: 'Model prices' })).toBeVisible();
    await proveScreen(page, testInfo, 'pricing');
  });

  test('session changes, a hunk and rewind', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=work&tab=sessions');
    const detail = await openRow(page, 'Refactor the session spine');
    await detail.getByRole('radio', { name: 'Changes' }).click();
    await expect(page.locator('.diff-mb__hunk').first()).toBeVisible();
    await proveScreen(page, testInfo, 'session-changes');
    await page.locator('.diff-mb__hunk').first().click();
    await expect(page.locator('.hunk-sheet')).toBeVisible();
    await proveScreen(page, testInfo, 'hunk-sheet');
    await page.keyboard.press('Escape');
    await expect(page.locator('.hunk-sheet')).toHaveCount(0);
    await detail.getByRole('radio', { name: 'Rewind' }).click();
    await expect(page.locator('.session-rewind')).toBeVisible();
    await proveScreen(page, testInfo, 'session-rewind');
  });

  test('the task graph', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await openRow(page, 'Fix findings from the review');
    await expect(page.locator('.task-graph-panel')).toBeVisible();
    await proveScreen(page, testInfo, 'task-graph');
  });

  test('attempt comparison', async ({ page }, testInfo) => {
    await installMockDaemon(page);
    await page.route('**/api/control-plane/methods/fleet.attempts.list/invoke', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ groups: [ATTEMPT_GROUP] }),
    }));
    await page.goto('/?view=work');
    await openRow(page, 'Build the widget');
    await page.getByRole('button', { name: 'Compare and pick' }).click();
    await expect(page.getByRole('dialog', { name: /Compare attempts/ })).toBeVisible();
    await proveScreen(page, testInfo, 'attempt-comparison');
  });
});
