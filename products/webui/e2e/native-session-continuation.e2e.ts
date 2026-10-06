/** Production UI + Chromium IndexedDB + unchanged real paired native-turn HTTP bytes. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { detailPane, expectNoHorizontalScroll, openRow } from "./support/app";
import { nativeBrowserRecords } from "./support/native-execution-fixture";
import {
  installNativeContinuationDaemon,
  type ContinuationCase,
} from "./support/native-session-continuation-fixture";

type Fixture = Awaited<ReturnType<typeof installNativeContinuationDaemon>>;
const conversation = (detail: Locator) =>
  detail.getByRole("region", { name: "Hosted conversation", exact: true });
async function open(page: Page, fixture: Fixture) {
  await page.goto("/?view=work&tab=sessions");
  const detail = await openRow(page, fixture.title);
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
  else await detail.getByRole("button", { name: "Close hosted session", exact: true }).click();
}
function noLegacyDelivery(fixture: Fixture) {
  expect(
    fixture.requests.filter(
      (request) =>
        request.methodId &&
        /^(sessions\.(steer|followUp)|sessions\.hosted\.(create|kill)|tasks\.create|contracts\.create)$/.test(
          request.methodId
        )
    )
  ).toEqual([]);
  expect(
    fixture.requests.filter((request) =>
      /\/api\/sessions\/[^/]+\/(steer|follow-up)$/.test(request.path)
    )
  ).toEqual([]);
  expect(
    fixture.nativeRequests.every((request) => request.authorization === "Bearer e2e-operator-token")
  ).toBe(true);
  expect(
    fixture.requests.filter((request) => request.path.startsWith("/api/work-ledger/execution/"))
  ).toEqual([]);
}
async function screenshot(page: Page, name: string) {
  await expectNoHorizontalScroll(page);
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

test("same-session second and repeated third originals are exact, independently saved and inspect-only after reload", async ({
  page,
}) => {
  const fixture = await installNativeContinuationDaemon(page, { cases: ["second", "active"] });
  let detail = await open(page, fixture);
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
  detail = await openRow(page, fixture.title);
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
  await screenshot(page, "Repeated native continuation and immutable original");
});

test("double Submit and New request during an unresolved start preserve two exact originals without stale completion", async ({
  page,
}) => {
  const fixture = await installNativeContinuationDaemon(page, {
    cases: ["second", "active"],
    holdStart: true,
  });
  const detail = await open(page, fixture);
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
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
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
  const fixture = await installNativeContinuationDaemon(page, { loseStartAcknowledgement: true });
  let detail = await open(page, fixture);
  await submit(detail, fixture);
  await expect(conversation(detail).getByRole("alert")).toContainText(
    "No automatic retry was sent."
  );
  await expect(conversation(detail)).not.toContainText("The host recorded completion");
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  await conversation(detail)
    .getByRole("button", { name: "Inspect conversation", exact: true })
    .click();
  await expect(conversation(detail)).toContainText("completed");
  await close(page, detail);
  detail = await openRow(page, fixture.title);
  await expect(conversation(detail)).toContainText("completed");
  await page.reload();
  detail = await openRow(page, fixture.title);
  await expect(conversation(detail)).toContainText("completed");
  expect(fixture.writes).toHaveLength(3);
  noLegacyDelivery(fixture);
  await screenshot(page, "Lost acknowledgement reconciled by read-only inspection");
});

test("leaving during start and selecting another native session cannot retarget the saved original", async ({
  page,
}) => {
  const fixture = await installNativeContinuationDaemon(page, { holdStart: true });
  let detail = await open(page, fixture);
  await submit(detail, fixture);
  await expect.poll(() => fixture.pendingCount).toBe(1);
  const saved = await nativeBrowserRecords(page);
  expect(saved.originals.map((record) => record.command)).toEqual([fixture.capture.second.input]);
  await close(page, detail);
  detail = await openRow(page, fixture.otherTitle);
  await expect(
    detail.getByRole("textbox", { name: "Original request", exact: true })
  ).toBeVisible();
  await expect(detail.getByRole("region", { name: "Saved requests", exact: true })).toHaveCount(0);
  await fixture.releaseStart();
  await expect(
    detail.getByRole("region", { name: "Hosted conversation", exact: true })
  ).toHaveCount(0);
  await close(page, detail);
  detail = await openRow(page, fixture.title);
  await expect(conversation(detail)).toContainText("completed");
  expect(await detail.locator("pre.native-intake__source").textContent()).toBe(
    fixture.capture.second.input.text
  );
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
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
    await page.goto("/?view=work&tab=sessions");
    let detail = await openRow(page, fixture.title);
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
    expect(cancellation.map((request) => request.body)).toEqual([fixture.capture[name].identity]);
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
    detail = await openRow(page, fixture.title);
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
  await page.goto("/?view=work&tab=sessions");
  const detail = await openRow(page, fixture.title);
  await expect(
    detail.getByText(
      "Native continuation: the host queues conversation delivery behind the active turn."
    )
  ).toBeVisible();
  await submit(detail, fixture, "queuedDelivery");
  await expect(conversation(detail)).toContainText("queued");
  await expect(conversation(detail)).toContainText("excluding the active reply");
  await conversation(detail)
    .getByRole("button", { name: "Inspect conversation", exact: true })
    .click();
  await expect(conversation(detail)).toContainText("completed");
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  noLegacyDelivery(fixture);
  await screenshot(page, "Queued native continuation completed in order");
});

test("failed native-owner discovery offers no legacy composer or writes", async ({ page }) => {
  const fixture = await installNativeContinuationDaemon(page, { discoveryFailure: true });
  await page.goto("/?view=work&tab=sessions");
  const detail = await openRow(page, fixture.title);
  await expect(detail.getByRole("alert")).toContainText(
    "Native sessions require their existing paired owner"
  );
  await expect(
    detail.getByRole("textbox", { name: /Original request|Steer message|Follow-up message/ })
  ).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: "Retry session verification", exact: true })
  ).toBeVisible();
  expect(fixture.writes).toEqual([]);
  noLegacyDelivery(fixture);
  expect(await detailPane(page).count()).toBe(1);
});
