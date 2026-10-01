/**
 * Degraded and rarely-seen states, each asserted and then captured: the provider
 * status ladder in words, chat and steer with a dropped stream, the delete
 * affordance, and the session title's legibility against its real background in
 * both themes. Layout and theme coverage of every ordinary screen lives in
 * design-proof.e2e.ts. Runs on BOTH the phone and desktop projects; filenames
 * carry the project name. Captures land in e2e/.artifacts/screenshots/.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { openRow } from './support/app';
import { STEERABLE_SESSION } from './support/seed';

const DIR = 'e2e/.artifacts/screenshots';
const THEME_KEY = 'goodvibes.webui.theme';

async function seedTheme(page: import('@playwright/test').Page, theme: 'dark' | 'light') {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, JSON.stringify({ theme: value, density: 'default' }));
      } catch {
        /* ignore */
      }
    },
    [THEME_KEY, theme] as const,
  );
}

function shot(testInfo: import('@playwright/test').TestInfo, name: string): string {
  return `${DIR}/${name}.${testInfo.project.name}.png`;
}

test('chat degraded states (mocked stream drop)', async ({ page }, testInfo) => {
  await installMockDaemon(page, { dropStreams: true });
  await page.goto('/?view=chat');
  await expect(page.locator('.shell-main[data-view="chat"]')).toBeVisible();
  // The dropped stream surfaces its paused banner.
  await expect(page.locator('.banner.warning')).toBeVisible();
  await page.screenshot({ path: shot(testInfo, 'chat-degraded'), fullPage: true });
});

test('steer composer reflects a paused stream', async ({ page }, testInfo) => {
  await installMockDaemon(page, { dropStreams: true });
  await page.goto('/?view=work&tab=sessions');
  await openRow(page, STEERABLE_SESSION.title);
  await expect(page.getByRole('list', { name: 'Transcript' })).toBeVisible();
  await expect(page.locator('.steer-composer__stream-note')).toBeVisible();
  await page.screenshot({ path: shot(testInfo, 'steer-composer-paused'), fullPage: true });
});

test('delete-means-delete affordance', async ({ page }, testInfo) => {
  await installMockDaemon(page, { deleteAvailable: true });
  await page.goto('/?view=work&tab=sessions');
  const detail = await openRow(page, STEERABLE_SESSION.title);
  await detail.getByRole('button', { name: 'More session actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete permanently' })).toBeVisible();
  await page.screenshot({ path: shot(testInfo, 'delete-affordance'), fullPage: true });
});

/** Perceived luminance (0 dark … 255 light) of an `rgb(...)`/`rgba(...)` string. */
function luminanceOf(rgb: string): number {
  const m = rgb.match(/\d+(?:\.\d+)?/g);
  if (!m || m.length < 3) return NaN;
  const [r, g, b] = m.map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// F2 (hero legibility): the session detail's title never renders dark-on-dark or
// light-on-light. The detail pane sits on the page (no card), so the title is
// measured against the first opaque background behind it, in both themes.
for (const theme of ['dark', 'light'] as const) {
  test(`session detail title stays legible, ${theme} theme`, async ({ page }, testInfo) => {
    await seedTheme(page, theme);
    await installMockDaemon(page);
    await page.goto('/?view=work&tab=sessions');
    const detail = await openRow(page, STEERABLE_SESSION.title);
    const title = detail.locator('.dv-pane__title');
    await expect(title).toBeVisible();

    const bg = await title.evaluate((el) => {
      let node: Element | null = el;
      while (node) {
        const color = getComputedStyle(node).backgroundColor;
        if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    });
    const titleColor = await title.evaluate((el) => getComputedStyle(el).color);
    const bgLum = luminanceOf(bg);
    const fgLum = luminanceOf(titleColor);

    expect(Math.abs(bgLum - fgLum)).toBeGreaterThan(80);
    if (theme === 'light') {
      expect(bgLum).toBeGreaterThan(200);
      expect(fgLum).toBeLessThan(120);
    } else {
      expect(bgLum).toBeLessThan(120);
      expect(fgLum).toBeGreaterThan(200);
    }

    await page.screenshot({ path: shot(testInfo, `session-hero-${theme}`), fullPage: true });
  });
}
