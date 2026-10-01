/**
 * Calendar tab of Personal, events (list/get/create) + ICS import/export over the
 * daemon's calendar.* verbs, proven against a real HTTP round-trip through the mock
 * daemon (not just a unit-mocked module). Runs on both the phone and desktop
 * Playwright projects (playwright.config.ts) since no test here gates on project name.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { DESKTOP, expectBottomSheet, expectNoHorizontalScroll, only, PHONE } from './support/app';

const CALENDAR = '/?view=personal&tab=calendar';

test('configured: the agenda lists events sorted by start time, grouped by day', async ({ page }) => {
  await installMockDaemon(page, { calendar: 'configured' });
  await page.goto(CALENDAR);
  const agenda = page.getByTestId('calendar-agenda');
  await expect(agenda).toBeVisible();
  const rows = agenda.locator('.calendar-event-row');
  await expect(rows).toHaveCount(2);
  // Seed has ev-1 (Aug 1) before ev-2 (Aug 2), the view must sort by start, not
  // return-order (the seed lists ev-2 first).
  await expect(rows.nth(0).filter({ hasText: 'Team standup' })).toHaveCount(1);
  await expect(rows.nth(1).filter({ hasText: 'Design review' })).toHaveCount(1);
  // Two days, two groups.
  await expect(agenda.getByRole('heading', { level: 3 })).toHaveCount(2);
  await expectNoHorizontalScroll(page);
});

test('the agenda asks the daemon for the selected range and shows only what falls inside it', async ({ page }) => {
  await installMockDaemon(page, { calendar: 'configured' });
  const listRequest = page.waitForRequest((req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/calendar/events');
  await page.goto(CALENDAR);
  const url = new URL((await listRequest).url());
  // The default window: today through 14 days out, as whole UTC days.
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T23:59:59\.999Z$/);
  expect(Date.parse(to) - Date.parse(from)).toBeGreaterThan(14 * 86_400_000 - 1000);
  // The seeded event two months back sits outside the window and never shows.
  const rows = page.getByTestId('calendar-agenda').locator('.calendar-event-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Quarter kickoff' })).toHaveCount(0);
});

test('configured: selecting an event fetches its detail and opens it in a peek that Escape closes', async ({ page }) => {
  const daemon = await installMockDaemon(page, { calendar: 'configured' });
  await page.goto(CALENDAR);
  await page.locator('.calendar-event-row .gv-row__main').first().click();
  const detail = page.getByTestId('calendar-event-detail');
  await expect(detail).toBeVisible();
  expect(daemon.requests.some((r) => r.method === 'GET' && r.path === '/api/calendar/events/ev-1')).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Event detail' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Event detail' })).toHaveCount(0);
});

test.describe('desktop: the event peek is a right-side drawer that folds the sidebar to its rail', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, DESKTOP));

  test('opening an event folds the rail; Escape closes the drawer and restores it', async ({ page }) => {
    await installMockDaemon(page, { calendar: 'configured' });
    await page.goto(CALENDAR);
    const sidebar = page.locator('.shell-sidebar');
    await expect(sidebar).toHaveAttribute('data-form', 'expanded');
    await page.locator('.calendar-event-row .gv-row__main').first().click();
    const drawer = page.getByRole('dialog', { name: 'Event detail' });
    await expect(drawer).toBeVisible();
    // Anchored to the right edge, leaving the agenda visible beside it.
    await expect.poll(() => drawer.evaluate((el) => Math.round(el.getBoundingClientRect().right))).toBe(1280);
    await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().left)).toBeGreaterThan(640);
    await expect(sidebar).toHaveAttribute('data-form', 'rail');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(sidebar).toHaveAttribute('data-form', 'expanded');
  });
});

test.describe('phone: compact calendar controls and the event as a bottom sheet', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('one date-range button replaces the two date fields and the calendar field; the agenda starts high', async ({ page }) => {
    await installMockDaemon(page, { calendar: 'configured' });
    await page.goto(CALENDAR);
    await expect(page.getByTestId('calendar-agenda')).toBeVisible();
    // No inline date fields or calendar field on the page itself.
    await expect(page.getByRole('textbox', { name: 'Range start' })).toHaveCount(0);
    await expect(page.getByLabel('Logical calendar id')).toHaveCount(0);
    const range = page.locator('.calendar-range-button');
    await expect(range).toBeVisible();
    await expect(page.getByRole('button', { name: 'More calendar actions' })).toBeVisible();
    // The controls are one row, and the agenda begins in the top half of the screen.
    const rowHeight = await page.locator('.calendar-phone-controls').evaluate((el) => el.getBoundingClientRect().height);
    // One row: 44-tall touch targets plus the toggle's padding, never a second line.
    expect(rowHeight).toBeLessThan(60);
    const agendaTop = await page.getByTestId('calendar-agenda').evaluate((el) => el.getBoundingClientRect().top);
    expect(agendaTop).toBeLessThan(844 / 2);
    await expectNoHorizontalScroll(page);

    // The button opens a sheet with both dates and the calendar choice.
    await range.click();
    const sheet = page.getByRole('dialog', { name: 'Date range' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Range start' })).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Range end' })).toBeVisible();
    await expect(sheet.getByLabel('Logical calendar id')).toBeVisible();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);
  });

  test('an event opens as a bottom sheet that Close dismisses', async ({ page }) => {
    await installMockDaemon(page, { calendar: 'configured' });
    await page.goto(CALENDAR);
    await page.locator('.calendar-event-row .gv-row__main').first().click();
    const sheet = page.getByRole('dialog', { name: 'Event detail' });
    await expect(sheet).toBeVisible();
    await expectBottomSheet(page, sheet);
    await expect(page.getByTestId('calendar-event-detail')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await sheet.getByRole('button', { name: 'Close event' }).click();
    await expect(sheet).toHaveCount(0);
  });
});

test('the Agenda / Month toggle shows a month grid without sideways scroll', async ({ page }) => {
  await installMockDaemon(page, { calendar: 'configured' });
  await page.goto(CALENDAR);
  await expect(page.getByTestId('calendar-agenda')).toBeVisible();
  await page.getByRole('radio', { name: 'Month' }).click();
  await expect(page.getByTestId('calendar-month')).toBeVisible();
  await expect(page.getByTestId('calendar-agenda')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.getByTestId('calendar-month')).toBeVisible();
  await page.getByRole('radio', { name: 'Agenda' }).click();
  await expect(page.getByTestId('calendar-agenda')).toBeVisible();
});

test('unconfigured: the daemon\'s 412 CALENDAR_NOT_CONFIGURED offers Open settings, no create action, no error state and no agenda', async ({ page }) => {
  await installMockDaemon(page, { calendar: 'unconfigured' });
  await page.goto(CALENDAR);
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
  await expect(page.getByTestId('calendar-agenda')).toHaveCount(0);
  // No create action while the surface cannot take one.
  await expect(page.getByRole('button', { name: 'New event' })).toHaveCount(0);
  await expect(page.locator('.feedback-error-state')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('creating an event posts the form with confirm:true and closes the dialog', async ({ page }) => {
  const daemon = await installMockDaemon(page, { calendar: 'configured' });
  await page.goto(CALENDAR);
  await page.getByRole('button', { name: 'New event' }).click();
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill('Planning sync');
  await dialog.getByLabel('Start', { exact: true }).fill('2026-08-05 09:00');
  await dialog.getByLabel('End', { exact: true }).fill('2026-08-05 09:30');
  await dialog.getByRole('button', { name: 'Create event' }).click();
  await expect(dialog).toHaveCount(0);
  const creates = daemon.requests.filter((r) => r.method === 'POST' && r.path === '/api/calendar/events');
  expect(creates).toHaveLength(1);
  expect(creates[0]?.body).toMatchObject({ title: 'Planning sync', confirm: true });
});

test('exporting the range as .ics asks the daemon for the agenda\'s window', async ({ page }) => {
  const daemon = await installMockDaemon(page, { calendar: 'configured' });
  await page.goto(CALENDAR);
  await expect(page.getByTestId('calendar-agenda')).toBeVisible();
  await page.getByRole('button', { name: 'More calendar actions' }).click();
  const listed = daemon.requests.find((r) => r.method === 'GET' && r.path === '/api/calendar/events');
  await page.getByRole('menuitem', { name: 'Export range as .ics' }).click();
  await expect.poll(() => daemon.requests.filter((r) => r.method === 'GET' && r.path === '/api/calendar/ics/export').length).toBe(1);
  const exported = new URLSearchParams(daemon.requests.find((r) => r.path === '/api/calendar/ics/export')?.search);
  const agendaWindow = new URLSearchParams(listed?.search);
  expect(exported.get('from')).toBe(agendaWindow.get('from'));
  expect(exported.get('to')).toBe(agendaWindow.get('to'));
});

test('importing .ics content sends exactly the pasted content and closes the dialog', async ({ page }) => {
  const daemon = await installMockDaemon(page, { calendar: 'configured' });
  await page.goto(CALENDAR);
  await expect(page.getByTestId('calendar-agenda')).toBeVisible();
  await page.getByRole('button', { name: 'More calendar actions' }).click();
  await page.getByRole('menuitem', { name: 'Import .ics file content' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import .ics content' });
  await dialog.getByLabel('iCalendar content').fill('BEGIN:VCALENDAR\nEND:VCALENDAR');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect.poll(() => daemon.requests.filter((r) => r.method === 'POST' && r.path === '/api/calendar/ics/import')
    .map((r) => JSON.stringify(r.body))).toEqual([expect.stringContaining('BEGIN:VCALENDAR\\nEND:VCALENDAR')]);
  await expect(dialog).toHaveCount(0);
});

test.describe('phone: a long, unbroken event title never forces the page wider (MOBILE-ADAPT overflow sweep)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('the title ellipsizes instead of stretching the row or a month cell past the viewport', async ({ page }) => {
    await installMockDaemon(page, { calendar: 'configured' });
    // A single unbreakable token (no spaces), the min-content overflow class this
    // suite sweeps for: white-space:nowrap text needs min-width:0 to actually shrink.
    const longTitle = 'Quarterly-Cross-Team-Infrastructure-Migration-And-Rollback-Readiness-Review-Session';
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    await page.route('**/api/calendar/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET' || path !== '/api/calendar/events') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [{ id: 'ev-long', title: longTitle, start: today.toISOString(), end: today.toISOString() }] }),
      });
    });
    await page.goto(CALENDAR);
    await expect(page.locator('.calendar-event-row')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('radio', { name: 'Month' }).click();
    await expect(page.locator('.cal-month__event')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
