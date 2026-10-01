/**
 * Shared e2e helpers.
 */
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

export const PHONE = 'phone';
export const DESKTOP = 'desktop';

/** Skip the current test unless it is running under the named project. */
export function only(testInfo: TestInfo, project: string): void {
  test.skip(testInfo.project.name !== project, `${project}-only proof`);
}

/**
 * Assert the page does not scroll horizontally, the #1 phone smell. Allows a 1px slack.
 *
 * TWO measures, because a single one is fooled by mobile emulation:
 *
 * 1. DOCUMENT overflow: documentElement.scrollWidth against the viewport, but the
 *    reference is `min(clientWidth, visualViewport.width)`, NOT clientWidth alone. In
 *    mobile emulation an off-canvas element makes clientWidth inflate in lockstep with
 *    scrollWidth (both ~798 at a 390 viewport), so `scrollWidth <= clientWidth` is
 *    self-cancelling and stays green while the page pans sideways. visualViewport.width
 *    is the real device width (390) and does not inflate, so capping the reference at it
 *    restores a truthful signal for genuine content overflow.
 *
 * 2. OFF-CANVAS FIXED panels: no `position: fixed`, non-`display:none` element may sit
 *    ENTIRELY off the right edge, i.e. its LEFT edge is at or past the viewport width.
 *    This is the measure the scrollWidth check CANNOT provide: Chromium clamps a fixed
 *    off-canvas element out of the document's scrollWidth (it stays 390 even with a full
 *    panel parked at x=390..780), so measure 1 alone can never see a closed slide-over
 *    that was hidden with transform+visibility instead of being removed from layout. A
 *    fixed element is viewport-relative and can never be clipped by an ancestor's
 *    overflow, so a fixed box parked wholly outside the viewport is always a real
 *    horizontal-pan contributor on a device. The test keys on the LEFT edge (fully
 *    parked), NOT merely "extends past the right": an on-screen full-viewport sheet may
 *    legitimately render a hair wider than the viewport (safe-area / rounding) while
 *    still starting at x=0, that is not a pan into empty space and must not trip here.
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    // Cap the document reference at the real viewport so emulation cannot inflate it.
    const reference = Math.min(doc.clientWidth, viewportWidth);

    // A fixed element whose LEFT edge is at/past the viewport's right edge is parked
    // wholly off-canvas, the off-canvas-drawer-left-in-layout bug.
    let parkedLeft = 0;
    let parkedOffender = '';
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.left >= viewportWidth - 1 && rect.left > parkedLeft) {
        parkedLeft = rect.left;
        parkedOffender = String((el as HTMLElement).className || el.tagName).slice(0, 40);
      }
    }
    return { scrollWidth: doc.scrollWidth, reference, viewportWidth, parkedLeft, parkedOffender };
  });

  expect(
    overflow.scrollWidth,
    `page scrolls horizontally: scrollWidth ${overflow.scrollWidth} > viewport ${overflow.reference}`,
  ).toBeLessThanOrEqual(overflow.reference + 1);

  expect(
    overflow.parkedLeft,
    `a fixed panel is parked off-canvas (${overflow.parkedOffender} left=${Math.round(overflow.parkedLeft)} >= viewport ${overflow.viewportWidth}): an off-canvas panel left in the layout pans the page sideways on a device`,
  ).toBe(0);
}

/** Assert a located element's rendered box clears the 44px touch-target floor. */
export async function expectTappable(page: Page, selector: string, label = selector): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${label} has no rendered box`).not.toBeNull();
  if (!box) return;
  expect(box.width, `${label} width ${box.width} < 44`).toBeGreaterThanOrEqual(43.5);
  expect(box.height, `${label} height ${box.height} < 44`).toBeGreaterThanOrEqual(43.5);
}

/**
 * Open the settings dialog on a section by deep link (`?settings=<section>`,
 * sections.ts ids: general, account, devices, people, models, credentials,
 * usage, voice, notifications, memory, permissions, network, all, about) and
 * return the dialog. Admin and Providers are sections of this dialog now.
 */
export async function openSettings(page: Page, section = 'general'): Promise<Locator> {
  await page.goto(`/?view=chat&settings=${section}`);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Navigate to a view and wait for the shell to be present. */
export async function gotoView(page: Page, view: string): Promise<void> {
  await page.goto(`/?view=${view}`);
  await expect(page.locator('.app-shell')).toBeVisible();
}

/** Resolves after the page has painted two more frames (React has committed and run its effects). */
export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/**
 * Make the primary navigation visible. On a phone (under 900) the sidebar is a
 * drawer behind the header's menu button; on desktop it is already on screen.
 */
export async function openNavigation(page: Page): Promise<void> {
  // The shell must be up first: before it renders, the menu button is simply absent,
  // and an instant visibility check would wrongly read that as "desktop, no drawer".
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: /^Open navigation/ });
  if (await menu.isVisible()) {
    await menu.click();
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  }
}

/** Close the phone navigation drawer the way a person would: tap the scrim beside it. */
export async function closeNavigation(page: Page): Promise<void> {
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  if (!(await drawer.isVisible())) return;
  // The drawer is 85% of a 390 phone (331 wide); x=370 is always the exposed scrim.
  await page.locator('.gv-overlay > .scrim').click({ position: { x: 370, y: 422 } });
  await expect(drawer).toBeHidden();
}

/**
 * A row in a data view's list (Work, Library, Personal), by its visible text.
 * The first match: a session and the agent running in it can share a title.
 */
export function listRow(page: Page, text: string | RegExp): Locator {
  return page.locator('.dv-list .gv-row', { hasText: text }).first();
}

/** Open a data-view row's detail (clicks the row's main button). */
export async function openRow(page: Page, text: string | RegExp): Promise<Locator> {
  await listRow(page, text).first().locator('.gv-row__main').click();
  const detail = page.locator('.dv-detail');
  await expect(detail).toBeVisible();
  return detail;
}

/** The open detail pane of a data view. */
export function detailPane(page: Page): Locator {
  return page.locator('.dv-detail');
}

/**
 * A phone bottom sheet (design doc "Phone"): once its 240 ms slide-in settles it
 * spans the full viewport width and sits on the bottom edge. Polls, so a box read
 * mid-animation never decides the result.
 */
export async function expectBottomSheet(page: Page, sheet: Locator, options?: { minHeight?: number }): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await expect.poll(async () => {
    const box = await sheet.boundingBox();
    if (!box || !viewport) return 'no box';
    const bottom = Math.round(box.y + box.height);
    const tallEnough = options?.minHeight === undefined || box.height >= options.minHeight;
    return Math.round(box.width) === viewport.width && bottom === viewport.height && tallEnough
      ? 'sheet'
      : `width ${Math.round(box.width)}, bottom ${bottom}, height ${Math.round(box.height)}`;
  }).toBe('sheet');
}
