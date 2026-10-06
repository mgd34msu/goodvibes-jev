/** Production UI + Chromium IndexedDB + unchanged real paired native-turn HTTP bytes. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { detailPane, expectNoHorizontalScroll, openRow } from "./support/app";
import {
  isLegacyExecutionMutation,
  nativeBrowserRecords,
} from "./support/native-execution-fixture";
import {
  installNativeContinuationDaemon,
  type ContinuationCase,
} from "./support/native-session-continuation-fixture";

type Fixture = Awaited<ReturnType<typeof installNativeContinuationDaemon>>;
type ContinuationSurface = "Sessions" | "Fleet";
const surfaceTab = (surface: ContinuationSurface) => (surface === "Fleet" ? "agents" : "sessions");
const surfaceTitle = (fixture: Fixture, surface: ContinuationSurface, other = false) =>
  surface === "Fleet"
    ? other
      ? fixture.otherFleetTitle
      : fixture.fleetTitle
    : other
      ? fixture.otherTitle
      : fixture.title;
const conversation = (detail: Locator) =>
  detail.getByRole("region", { name: "Hosted conversation", exact: true });
async function open(page: Page, fixture: Fixture, surface: ContinuationSurface) {
  await page.goto(`/?view=work&tab=${surfaceTab(surface)}`);
  const detail = await openRow(page, surfaceTitle(fixture, surface));
  await expect(
    detail.getByText("Native continuation: Submit sends this original through Jev admission.")
  ).toBeVisible();
  return detail;
}
async function submit(detail: Locator, fixture: Fixture, name: ContinuationCase = "second") {
  await detail
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(fixture.capture[name].input.text);
  await detail.getByRole("button", { name: "Submit", exact: true }).click();
}
async function close(page: Page, detail: Locator) {
  const back = page.getByRole("button", { name: "All work", exact: true });
  if (await back.isVisible()) await back.click();
  else await detail.getByRole("button", { name: /^Close (hosted session|process)$/ }).click();
}
async function switchSurface(page: Page, fixture: Fixture, surface: ContinuationSurface) {
  await close(page, detailPane(page));
  await page
    .getByRole("radiogroup", { name: "Kind of work", exact: true })
    .getByRole("radio", { name: surface === "Fleet" ? "Agents" : "Sessions", exact: true })
    .click();
  return openRow(page, surfaceTitle(fixture, surface));
}
function noLegacyDelivery(fixture: Fixture) {
  // Opening/closing a hosted detail attaches/detaches the browser. Everything
  // that could deliver text or create legacy work remains forbidden, including
  // generic invokes, direct routes, and newly introduced legacy mutation verbs.
  const navigationOnly = new Set(["sessions.hosted.attach", "sessions.hosted.detach"]);
  expect(
    fixture.requests.filter(
      (request) => !navigationOnly.has(request.methodId ?? "") && isLegacyExecutionMutation(request)
    )
  ).toEqual([]);
  expect(fixture.requests.filter((request) => request.methodId === "fleet.observed.steer")).toEqual(
    []
  );
  expect(
    fixture.nativeRequests.every((request) => request.authorization === "Bearer e2e-operator-token")
  ).toBe(true);
  expect(
    fixture.requests.filter((request) => request.path.startsWith("/api/work-ledger/execution/"))
  ).toEqual([]);
}
async function screenshot(page: Page, name: string, includeOriginal = false) {
  const detail = detailPane(page);
  if (includeOriginal) {
    const original = detail.locator("pre.native-intake__source");
    await original.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" })
    );
    // Chromium rounds a 66px source block to 65.5px at a scroll boundary.
    // Allow that subpixel crop tolerance; exact text and receipt facts stay strict.
    await expect(original).toBeInViewport({ ratio: 0.99 });
    await expectNoHorizontalScroll(page);
    await test.info().attach(`${name}: exact original source crop`, {
      body: await original.screenshot(),
      contentType: "image/png",
    });
  }
  // Both session and Fleet panes scroll independently; a full-page shot alone can show
  // its header while the asserted receipt remains below the visible viewport.
  const facts = conversation(detail).locator(".dv-facts");
  await facts.scrollIntoViewIfNeeded();
  await expect(facts).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalScroll(page);
  await test.info().attach(`${name}: visible state and canonical identities`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

for (const surface of ["Sessions", "Fleet"] as const) {
  test.describe(`${surface} native continuation`, () => {
    test("same-session second and repeated third originals are exact, independently saved and inspect-only after reload", async ({
      page,
    }) => {
      const fixture = await installNativeContinuationDaemon(page, { cases: ["second", "active"] });
      let detail = await open(page, fixture, surface);
      await expect(
        detail.getByRole("textbox", { name: /Steer message|Follow-up message/ })
      ).toHaveCount(0);
      await submit(detail, fixture);
      await expect(conversation(detail)).toContainText("running");
      await expect(detail.locator("pre.native-intake__source")).toHaveText(
        fixture.capture.second.input.text
      );
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.second.input.text
      );
      await conversation(detail)
        .getByRole("button", { name: "Inspect conversation", exact: true })
        .click();
      await expect(conversation(detail)).toContainText("completed");
      await expect(conversation(detail)).toContainText(fixture.capture.sessionId);
      await detail.getByRole("button", { name: "New request", exact: true }).click();
      await submit(detail, fixture, "active");
      await expect(conversation(detail)).toContainText("running");
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
        "capture",
        "admit",
        "start",
      ]);
      const records = await nativeBrowserRecords(page);
      expect(records.originals).toHaveLength(2);
      expect(records.originals.map((record) => record.command)).toEqual(
        expect.arrayContaining([fixture.capture.second.input, fixture.capture.active.input])
      );
      expect(records.targets).toEqual([]);
      expect(
        records.originals.every(
          (record) => record.command.continuation?.sessionId === fixture.capture.sessionId
        )
      ).toBe(true);
      await page.reload();
      detail = await openRow(page, surfaceTitle(fixture, surface));
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.active.input.text
      );
      await detail
        .getByRole("button", {
          name: `Inspect input ${fixture.capture.second.input.inputId}`,
          exact: true,
        })
        .click();
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.second.input.text
      );
      expect(fixture.writes).toHaveLength(6);
      noLegacyDelivery(fixture);
      await screenshot(page, "Repeated native continuation completed receipt", true);
    });

    test("double Submit and New request during an unresolved start preserve two exact originals without stale completion", async ({
      page,
    }) => {
      const fixture = await installNativeContinuationDaemon(page, {
        cases: ["second", "active"],
        holdStart: true,
      });
      const detail = await open(page, fixture, surface);
      await detail
        .getByRole("textbox", { name: "Original request", exact: true })
        .fill(fixture.capture.second.input.text);
      await detail
        .getByRole("button", { name: "Submit", exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      await expect.poll(() => fixture.pendingCount).toBe(1);
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
      ]);
      await detail.getByRole("button", { name: "New request", exact: true }).click();
      await submit(detail, fixture, "active");
      await expect.poll(() => fixture.pendingCount).toBe(2);
      await fixture.releaseStart();
      await expect(conversation(detail)).toContainText("running");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.active.input.text
      );
      const saved = await nativeBrowserRecords(page);
      expect(saved.originals).toHaveLength(2);
      expect(saved.originals.map((record) => record.command)).toEqual(
        expect.arrayContaining([fixture.capture.second.input, fixture.capture.active.input])
      );
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
        "capture",
        "admit",
        "start",
      ]);
      await detail
        .getByRole("button", {
          name: `Inspect input ${fixture.capture.second.input.inputId}`,
          exact: true,
        })
        .click();
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.second.input.text
      );
      noLegacyDelivery(fixture);
      await screenshot(
        page,
        "Repeated clicks and interrupted New request retain exact original ownership"
      );
    });

    test("lost start acknowledgement remains unknown; Inspect and reopening never duplicate delivery", async ({
      page,
    }) => {
      const fixture = await installNativeContinuationDaemon(page, {
        loseStartAcknowledgement: true,
      });
      let detail = await open(page, fixture, surface);
      await submit(detail, fixture);
      await expect(conversation(detail).getByRole("alert")).toContainText(
        "No automatic retry was sent."
      );
      await expect(conversation(detail)).not.toContainText("The host recorded completion");
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
      ]);
      await conversation(detail)
        .getByRole("button", { name: "Inspect conversation", exact: true })
        .click();
      await expect(conversation(detail)).toContainText("completed");
      await close(page, detail);
      detail = await openRow(page, surfaceTitle(fixture, surface));
      await expect(conversation(detail)).toContainText("completed");
      await page.reload();
      detail = await openRow(page, surfaceTitle(fixture, surface));
      await expect(conversation(detail)).toContainText("completed");
      expect(fixture.writes).toHaveLength(3);
      noLegacyDelivery(fixture);
      await screenshot(page, "Lost acknowledgement reconciled by read-only inspection");
    });

    test("leaving during start and selecting another native session cannot retarget the saved original", async ({
      page,
    }) => {
      const fixture = await installNativeContinuationDaemon(page, { holdStart: true });
      let detail = await open(page, fixture, surface);
      await submit(detail, fixture);
      await expect.poll(() => fixture.pendingCount).toBe(1);
      const saved = await nativeBrowserRecords(page);
      expect(saved.originals.map((record) => record.command)).toEqual([
        fixture.capture.second.input,
      ]);
      await close(page, detail);
      detail = await openRow(page, surfaceTitle(fixture, surface, true));
      await expect(
        detail.getByRole("textbox", { name: "Original request", exact: true })
      ).toBeVisible();
      await expect(detail.getByRole("region", { name: "Saved requests", exact: true })).toHaveCount(
        0
      );
      await fixture.releaseStart();
      await expect(
        detail.getByRole("region", { name: "Hosted conversation", exact: true })
      ).toHaveCount(0);
      await close(page, detail);
      detail = await openRow(page, surfaceTitle(fixture, surface));
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.second.input.text
      );
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
      ]);
      noLegacyDelivery(fixture);
      await screenshot(page, "Interrupted continuation recovered in its original session");
    });

    for (const name of ["queuedCancel", "runningCancel"] as const) {
      test(`${name}: cancellation names the exact original and cannot become a replay`, async ({
        page,
      }) => {
        const fixture = await installNativeContinuationDaemon(page, {
          cases: [name],
          busy: name === "queuedCancel",
        });
        await page.goto(`/?view=work&tab=${surfaceTab(surface)}`);
        let detail = await openRow(page, surfaceTitle(fixture, surface));
        await expect(
          detail.getByRole("textbox", { name: "Original request", exact: true })
        ).toBeVisible();
        await submit(detail, fixture, name);
        await expect(conversation(detail)).toContainText(
          name === "queuedCancel" ? "queued" : "running"
        );
        if (name === "queuedCancel")
          await expect(conversation(detail)).toContainText("excluding the active reply");
        await conversation(detail)
          .getByRole("button", { name: "Cancel conversation", exact: true })
          .click();
        await expect(conversation(detail)).toContainText("cancelled");
        const cancellation = fixture.writes.filter((request) => request.operation === "cancel");
        expect(cancellation.map((request) => request.body)).toEqual([
          fixture.capture[name].identity,
        ]);
        await expect(
          conversation(detail).getByRole("button", { name: "Cancel conversation", exact: true })
        ).toHaveCount(0);
        await expect(
          conversation(detail).getByRole("button", {
            name: "Continue conversation request",
            exact: true,
          })
        ).toHaveCount(0);
        await page.reload();
        detail = await openRow(page, surfaceTitle(fixture, surface));
        await expect(conversation(detail)).toContainText("cancelled");
        expect(fixture.writes.map((request) => request.operation)).toEqual([
          "capture",
          "admit",
          "start",
          "cancel",
        ]);
        noLegacyDelivery(fixture);
        await screenshot(page, `${name} exact cancellation`);
      });
    }

    test("busy native continuation shows recorded FIFO completion without legacy steering", async ({
      page,
    }) => {
      const fixture = await installNativeContinuationDaemon(page, {
        cases: ["queuedDelivery"],
        busy: true,
      });
      await page.goto(`/?view=work&tab=${surfaceTab(surface)}`);
      const detail = await openRow(page, surfaceTitle(fixture, surface));
      await expect(
        detail.getByText(
          "Native continuation: the host queues conversation delivery behind any active turn."
        )
      ).toBeVisible();
      await submit(detail, fixture, "queuedDelivery");
      await expect(conversation(detail)).toContainText("queued");
      await expect(conversation(detail)).toContainText("excluding the active reply");
      await screenshot(page, "Queued native continuation before read-only completion");
      await conversation(detail)
        .getByRole("button", { name: "Inspect conversation", exact: true })
        .click();
      await expect(conversation(detail)).toContainText("completed");
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
      ]);
      noLegacyDelivery(fixture);
      await screenshot(page, "Queued native continuation completed in order");
    });

    test("failed native-owner discovery offers no legacy composer or writes", async ({ page }) => {
      const fixture = await installNativeContinuationDaemon(page, { discoveryFailure: true });
      await page.goto(`/?view=work&tab=${surfaceTab(surface)}`);
      const detail = await openRow(page, surfaceTitle(fixture, surface));
      await expect(detail.getByRole("alert")).toContainText(
        "Native sessions require their existing paired owner"
      );
      await expect(
        detail.getByRole("textbox", { name: /Original request|Steer message|Follow-up message/ })
      ).toHaveCount(0);
      await expect(
        detail.getByRole("button", { name: "Retry session verification", exact: true })
      ).toBeVisible();
      await detail.getByRole("button", { name: "Retry session verification", exact: true }).click();
      await expect(detail.getByRole("alert")).toContainText(
        "Native sessions require their existing paired owner"
      );
      expect(
        fixture.nativeRequests
          .filter((request) => request.operation === "session")
          .map((request) => request.body)
      ).toEqual([
        { sessionId: fixture.capture.sessionId },
        { sessionId: fixture.capture.sessionId },
      ]);
      expect(fixture.writes).toEqual([]);
      noLegacyDelivery(fixture);
      expect(await detailPane(page).count()).toBe(1);
    });

    test("switching surfaces during an unresolved start inspects the shared saved original without redelivery", async ({
      page,
    }) => {
      const fixture = await installNativeContinuationDaemon(page, { holdStart: true });
      let detail = await open(page, fixture, surface);
      await submit(detail, fixture);
      await expect.poll(() => fixture.pendingCount).toBe(1);
      const saved = await nativeBrowserRecords(page);
      expect(saved.originals.map((record) => record.command)).toEqual([
        fixture.capture.second.input,
      ]);

      const otherSurface = surface === "Fleet" ? "Sessions" : "Fleet";
      detail = await switchSurface(page, fixture, otherSurface);
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.second.input.text
      );
      await fixture.releaseStart();
      await expect(conversation(detail)).toContainText("completed");

      detail = await switchSurface(page, fixture, surface);
      await expect(conversation(detail)).toContainText("completed");
      expect((await nativeBrowserRecords(page)).originals).toEqual(saved.originals);
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
      ]);
      noLegacyDelivery(fixture);
      await screenshot(
        page,
        `${surface} interrupted start recovered across Fleet and Sessions`,
        true
      );
    });

    test("Fleet and Sessions share saved inputs in both directions without replay on reopen", async ({
      page,
    }) => {
      const fixture = await installNativeContinuationDaemon(page, { cases: ["second", "active"] });
      let detail = await open(page, fixture, surface);
      await submit(detail, fixture);
      await expect(conversation(detail)).toContainText("running");
      const otherSurface = surface === "Fleet" ? "Sessions" : "Fleet";
      detail = await switchSurface(page, fixture, otherSurface);
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.second.input.text
      );
      expect(fixture.writes).toHaveLength(3);

      await detail.getByRole("button", { name: "New request", exact: true }).click();
      await submit(detail, fixture, "active");
      await expect(conversation(detail)).toContainText("running");
      detail = await switchSurface(page, fixture, surface);
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.active.input.text
      );
      await detail
        .getByRole("button", {
          name: `Inspect input ${fixture.capture.second.input.inputId}`,
          exact: true,
        })
        .click();
      await expect(conversation(detail)).toContainText("completed");
      expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
        fixture.capture.second.input.text
      );
      const records = await nativeBrowserRecords(page);
      expect(records.originals).toHaveLength(2);
      expect(records.originals.map((record) => record.command)).toEqual(
        expect.arrayContaining([fixture.capture.second.input, fixture.capture.active.input])
      );
      expect(records.targets).toEqual([]);
      expect(fixture.writes.map((request) => request.operation)).toEqual([
        "capture",
        "admit",
        "start",
        "capture",
        "admit",
        "start",
      ]);
      noLegacyDelivery(fixture);
      await screenshot(page, `${surface} shared Fleet and Sessions originals`, true);
    });
  });
}
