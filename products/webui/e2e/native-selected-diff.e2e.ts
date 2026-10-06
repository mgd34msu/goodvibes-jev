/** Production UI + Chromium IndexedDB + unchanged real checkpoint/native HTTP bytes. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { detailPane, expectNoHorizontalScroll, nextFrames, openRow } from "./support/app";
import {
  isLegacyExecutionMutation,
  nativeBrowserRecords,
} from "./support/native-execution-fixture";
import {
  installSelectedDiffDaemon,
  selectedDiffPreview,
  type DiffCaseName,
} from "./support/native-selected-diff-fixture";
import { installMockDaemon } from "./support/mock-daemon";

type Fixture = Awaited<ReturnType<typeof installSelectedDiffDaemon>>;
const commentDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Comment on this change", exact: true });
const conversation = (dialog: Locator) =>
  dialog.getByRole("region", { name: "Hosted conversation", exact: true });
const fact = (dialog: Locator, label: string) =>
  dialog
    .locator(".dv-facts__row")
    .filter({ has: dialog.page().getByText(label, { exact: true }) })
    .locator("dd");
async function openChanges(page: Page, fixture: Fixture, navigate = true) {
  if (navigate) await page.goto("/?view=work&tab=sessions");
  const detail = await openRow(page, fixture.session.title);
  await detail.getByRole("radio", { name: "Changes", exact: true }).click();
  await expect(page.locator(".diff-mb__hunk").first()).toBeVisible();
  return detail;
}
async function openComment(page: Page, hunk = 0, filePath = "selected-change.ts") {
  await page
    .locator(".diff-mb__file")
    .filter({ has: page.getByText(filePath, { exact: true }) })
    .locator(".diff-mb__hunk")
    .nth(hunk)
    .click();
  await page
    .getByRole("dialog", { name: "Review this change", exact: true })
    .getByRole("button", { name: "Comment on this change", exact: true })
    .click();
  const dialog = commentDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}
async function submit(dialog: Locator, fixture: Fixture, name: DiffCaseName = "session") {
  await dialog
    .getByRole("textbox", { name: "Original comment", exact: true })
    .fill(fixture.capture[name].command.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
}
async function closeComment(page: Page) {
  await commentDialog(page)
    .locator(".gv-dialog__footer")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(commentDialog(page)).toHaveCount(0);
}
function noLegacyWrites(fixture: Fixture) {
  expect(fixture.failures).toEqual([]);
  expect(fixture.requests.filter(isLegacyExecutionMutation)).toEqual([]);
  expect(fixture.requests.filter((request) => request.methodId === "fleet.observed.steer")).toEqual(
    []
  );
  expect(
    fixture.nativeRequests.every((request) => request.authorization === "Bearer e2e-operator-token")
  ).toBe(true);
}
async function originalAndFacts(dialog: Locator, fixture: Fixture, name: DiffCaseName = "session") {
  const command = fixture.capture[name].command;
  const selector = command.continuation?.selectedDiff;
  if (!selector) throw new Error("Missing selected hunk selector");
  expect(await dialog.locator("pre.native-intake__source").textContent()).toBe(command.text);
  await expect(fact(dialog, "Continuation session")).toHaveText(fixture.capture.sessionId);
  await expect(fact(dialog, "Selected change scope")).toHaveText(
    selector.kind === "session"
      ? "Session-stamped checkpoint aggregate"
      : "Workspace checkpoint to captured working tree"
  );
  await expect(fact(dialog, "Selected diff revision")).toHaveText(selector.revision);
  await expect(fact(dialog, "Selected file / hunk")).toHaveText(
    `${selector.fileIndex + 1} / ${selector.hunkIndex + 1}`
  );
  await expect(fact(dialog, "Completed context revision")).not.toBeEmpty();
  await expect(dialog.getByRole("button", { name: /^Approve/i })).toHaveCount(0);
}
async function screenshot(page: Page, label: string) {
  const dialog = commentDialog(page);
  const original = dialog.locator("pre.native-intake__source");
  await original.scrollIntoViewIfNeeded();
  await expect(original).toBeInViewport({ ratio: 0.99 });
  await test.info().attach(`${label}: exact original comment`, {
    body: await original.screenshot(),
    contentType: "image/png",
  });
  const facts = dialog.locator(".native-intake > .dv-facts");
  await facts.scrollIntoViewIfNeeded();
  await expect(facts).toBeInViewport({ ratio: 0.99 });
  await expectNoHorizontalScroll(page);
  await test.info().attach(`${label}: visible source identities`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  const state =
    (await conversation(dialog).count()) > 0
      ? fact(dialog, "Conversation state")
      : fact(dialog, "State");
  await state.scrollIntoViewIfNeeded();
  await expect(state).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalScroll(page);
  await test.info().attach(`${label}: visible recorded state`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

test("session hunk keeps exact original separate from the complete >40-line source; deliberate identical comments get independent identities", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { cases: ["session", "repeated"] });
  await openChanges(page, fixture);
  let dialog = await openComment(page);
  const preview = dialog.locator('pre[aria-label="Selected change"]');
  const source = selectedDiffPreview(fixture.capture);
  expect(source.split("\n").length).toBeGreaterThan(40);
  await expect(preview).toHaveText(source);
  expect(await preview.textContent()).toBe(source);
  await preview.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await preview.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(120);
  await preview.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      preview.evaluate((element) => {
        const text = element.firstChild;
        if (!(text instanceof Text)) return false;
        let end = text.length;
        while (end > 0 && /[\r\n]/.test(text.data[end - 1])) end--;
        const start = text.data.lastIndexOf("\n", end - 1) + 1;
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, end);
        const line = range.getBoundingClientRect();
        const viewport = element.getBoundingClientRect();
        return (
          line.height > 0 && line.top >= viewport.top - 1 && line.bottom <= viewport.bottom + 1
        );
      })
    )
    .toBe(true);
  await test.info().attach("Complete selected source beyond the former excerpt boundary", {
    body: await preview.screenshot(),
    contentType: "image/png",
  });
  await submit(dialog, fixture);
  await expect(conversation(dialog)).toContainText("running");
  await originalAndFacts(dialog, fixture);
  await conversation(dialog)
    .getByRole("button", { name: "Inspect conversation", exact: true })
    .click();
  await expect(conversation(dialog)).toContainText("completed");
  await dialog.getByRole("button", { name: "New request", exact: true }).click();
  expect(fixture.capture.repeated.command.text).toBe(fixture.capture.session.command.text);
  await submit(dialog, fixture, "repeated");
  await expect(conversation(dialog)).toContainText("running");
  const stored = await nativeBrowserRecords(page);
  expect(stored.originals.map((record) => record.command)).toEqual(
    expect.arrayContaining([fixture.capture.session.command, fixture.capture.repeated.command])
  );
  expect(stored.originals).toHaveLength(2);
  expect(stored.targets).toEqual([]);
  expect(fixture.capture.repeated.command.inputId).not.toBe(
    fixture.capture.session.command.inputId
  );
  expect(fixture.writes.map((request) => request.operation)).toEqual([
    "capture",
    "admit",
    "start",
    "capture",
    "admit",
    "start",
  ]);
  await closeComment(page);
  dialog = await openComment(page);
  await expect(conversation(dialog)).toContainText("completed");
  await dialog
    .getByRole("button", {
      name: `Inspect input ${fixture.capture.session.command.inputId}`,
      exact: true,
    })
    .click();
  await originalAndFacts(dialog, fixture);
  await page.reload();
  await openChanges(page, fixture, false);
  dialog = await openComment(page);
  await expect(conversation(dialog)).toContainText("completed");
  expect(fixture.writes).toHaveLength(6);
  noLegacyWrites(fixture);
  await screenshot(page, "Repeated selected session comment retained without replay");
});

test("workspace baseline comment follows Jev work admission into the exact native execution, with no approval or hosted redelivery", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { cases: ["workspace"] });
  const detail = await openChanges(page, fixture);
  await detail.getByRole("button", { name: "View workspace changes", exact: true }).click();
  const selector = fixture.capture.workspace.command.continuation?.selectedDiff;
  if (selector?.kind !== "workspace") throw new Error("Missing workspace selector");
  const checkpoints = JSON.parse(fixture.capture.checkpoints.body) as {
    checkpoints: { id: string; label: string }[];
  };
  const baseline = checkpoints.checkpoints.find((item) => item.id === selector.baselineId);
  if (!baseline)
    throw new Error("Selected workspace baseline is not in the genuine checkpoint list");
  const baselinePicker = detail.getByRole("combobox", {
    name: "Diff baseline checkpoint",
    exact: true,
  });
  await baselinePicker.click();
  await page
    .getByRole("option")
    .filter({ hasText: baseline.label || baseline.id })
    .click();
  await expect(baselinePicker).toContainText(baseline.label || baseline.id);
  const dialog = await openComment(page);
  expect(await dialog.locator('pre[aria-label="Selected change"]').textContent()).toBe(
    selectedDiffPreview(fixture.capture, "workspace")
  );
  await submit(dialog, fixture, "workspace");
  const execution = dialog.getByRole("region", { name: "Native execution", exact: true });
  await expect(execution).toBeVisible();
  const executionStart = fixture.capture.workspace.start;
  if (!executionStart) throw new Error("Missing genuine native work start");
  const receipt = JSON.parse(executionStart.body) as {
    receipt?: { contractId: string; ownerAgentId: string };
  };
  if (!receipt.receipt) throw new Error("Work recording must contain an actual execution receipt");
  await expect(execution).toContainText(receipt.receipt.contractId);
  await expect(execution).toContainText(receipt.receipt.ownerAgentId);
  await originalAndFacts(dialog, fixture, "workspace");
  await expect(conversation(dialog)).toHaveCount(0);
  expect(fixture.writes.map((request) => request.methodId)).toEqual([
    "workLedger.intake.capture",
    "workLedger.intake.admit",
    "workLedger.execution.start",
  ]);
  const records = await nativeBrowserRecords(page);
  expect(records.originals.map((record) => record.command)).toEqual([
    fixture.capture.workspace.command,
  ]);
  expect(records.targets).toHaveLength(1);
  noLegacyWrites(fixture);
  await screenshot(page, "Workspace hunk admitted to native work");
});

test("native selected-hunk submission works when browser crypto.subtle is unavailable", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page);
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "subtle", { configurable: true, get: () => undefined });
  });
  await openChanges(page, fixture);
  expect(await page.evaluate(() => crypto.subtle === undefined)).toBe(true);
  const dialog = await openComment(page);
  await submit(dialog, fixture);
  await expect(conversation(dialog)).toContainText("running");
  await originalAndFacts(dialog, fixture);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  noLegacyWrites(fixture);
});

test("double Submit while delivery is unresolved sends one exact original; Close never cancels or replays it", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { hold: "start" });
  await openChanges(page, fixture);
  let dialog = await openComment(page);
  await dialog
    .getByRole("textbox", { name: "Original comment", exact: true })
    .fill(fixture.capture.session.command.text);
  await dialog
    .getByRole("button", { name: "Submit", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect.poll(() => fixture.pendingCount).toBe(1);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  expect((await nativeBrowserRecords(page)).originals.map((record) => record.command)).toEqual([
    fixture.capture.session.command,
  ]);
  await closeComment(page);
  await fixture.release();
  await nextFrames(page);
  await expect(commentDialog(page)).toHaveCount(0);
  dialog = await openComment(page);
  await expect(conversation(dialog)).toContainText("completed");
  expect(fixture.writes).toHaveLength(3);
  noLegacyWrites(fixture);
});

test("lost acknowledgement is unknown until read-only Inspect; close, reload and reopen cannot repeat delivery", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { loseStartAcknowledgement: true });
  await openChanges(page, fixture);
  let dialog = await openComment(page);
  await submit(dialog, fixture);
  await expect(conversation(dialog).getByRole("alert")).toContainText(
    "No automatic retry was sent."
  );
  await expect(conversation(dialog)).not.toContainText("The host recorded completion");
  await conversation(dialog)
    .getByRole("button", { name: "Inspect conversation", exact: true })
    .click();
  await expect(conversation(dialog)).toContainText("completed");
  await closeComment(page);
  await page.reload();
  await openChanges(page, fixture, false);
  dialog = await openComment(page);
  await expect(conversation(dialog)).toContainText("completed");
  await originalAndFacts(dialog, fixture);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  noLegacyWrites(fixture);
  await screenshot(page, "Lost hunk delivery acknowledgement reconciled by inspection");
});

test("queued cancellation targets only the selected original and reopening remains read-only", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, {
    cases: ["queuedCancel"],
    busy: true,
    hold: "cancel",
  });
  await openChanges(page, fixture);
  let dialog = await openComment(page);
  await submit(dialog, fixture, "queuedCancel");
  await expect(conversation(dialog)).toContainText("queued");
  await conversation(dialog)
    .getByRole("button", { name: "Cancel conversation", exact: true })
    .click();
  await expect.poll(() => fixture.pendingCount).toBe(1);
  const cancellation = fixture.capture.queuedCancel.cancel;
  if (!cancellation) throw new Error("Missing genuine queued cancellation");
  expect(
    fixture.writes
      .filter((request) => request.operation === "cancel")
      .map((request) => request.body)
  ).toEqual([cancellation.requestBody]);
  await closeComment(page);
  await fixture.release();
  dialog = await openComment(page);
  await expect(conversation(dialog)).toContainText("cancelled");
  await expect(
    conversation(dialog).getByRole("button", { name: "Continue conversation request", exact: true })
  ).toHaveCount(0);
  await expect(
    conversation(dialog).getByRole("button", { name: "Cancel conversation", exact: true })
  ).toHaveCount(0);
  expect(fixture.writes.map((request) => request.operation)).toEqual([
    "capture",
    "admit",
    "start",
    "cancel",
  ]);
  noLegacyWrites(fixture);
  await screenshot(page, "Exact queued selected-source cancellation");
});

test("queued selected-hunk delivery completes after the earlier turn without changing the exact original or source", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { cases: ["queuedDelivery"], busy: true });
  await openChanges(page, fixture);
  const dialog = await openComment(page);
  await submit(dialog, fixture, "queuedDelivery");
  await expect(conversation(dialog)).toContainText("queued");
  await originalAndFacts(dialog, fixture, "queuedDelivery");
  expect(await dialog.locator('pre[aria-label="Selected change"]').textContent()).toBe(
    selectedDiffPreview(fixture.capture, "queuedDelivery")
  );
  await screenshot(page, "Selected-hunk continuation queued behind the active turn");
  await conversation(dialog)
    .getByRole("button", { name: "Inspect conversation", exact: true })
    .click();
  await expect(conversation(dialog)).toContainText("completed");
  await originalAndFacts(dialog, fixture, "queuedDelivery");
  expect((await nativeBrowserRecords(page)).originals.map((record) => record.command)).toEqual([
    fixture.capture.queuedDelivery.command,
  ]);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  noLegacyWrites(fixture);
  await screenshot(page, "Selected-hunk FIFO continuation completed with its frozen source");
});

test("Cancel intake during unresolved capture preserves the source and never advances to admission or delivery", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { cases: ["cancel"], hold: "capture" });
  await openChanges(page, fixture);
  const dialog = await openComment(page);
  await submit(dialog, fixture, "cancel");
  await expect.poll(() => fixture.pendingCount).toBe(1);
  await dialog.getByRole("button", { name: "Cancel intake", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /cancelled/i })).toBeVisible();
  await fixture.release();
  await nextFrames(page);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "cancel"]);
  expect((await nativeBrowserRecords(page)).originals.map((record) => record.command)).toEqual([
    fixture.capture.cancel.command,
  ]);
  noLegacyWrites(fixture);
});

test("stale checkpoint selection is refused by the host and retained for inspection without fallback or automatic recapture", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { cases: ["stale"] });
  await openChanges(page, fixture);
  const dialog = await openComment(page);
  await submit(dialog, fixture, "stale");
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(fixture.capture.stale.capture.status).toBeGreaterThanOrEqual(400);
  await expect(dialog.getByRole("alert")).toContainText(/stale|changed|revision|captur/i);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture"]);
  expect((await nativeBrowserRecords(page)).originals.map((record) => record.command)).toEqual([
    fixture.capture.stale.command,
  ]);
  await expect(conversation(dialog)).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Native execution", exact: true })).toHaveCount(
    0
  );
  noLegacyWrites(fixture);
  await expectNoHorizontalScroll(page);
});

test("Escape, Close and history navigation discard an unsent comment with no mutation and no resurrected sheet", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page);
  await page.goto("/?view=library");
  await openChanges(page, fixture);
  let dialog = await openComment(page);
  await dialog
    .getByRole("textbox", { name: "Original comment", exact: true })
    .fill("Unsent original");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  dialog = await openComment(page);
  await expect(dialog.getByRole("textbox", { name: "Original comment", exact: true })).toHaveValue(
    ""
  );
  await closeComment(page);
  dialog = await openComment(page);
  await dialog.getByRole("textbox", { name: "Original comment", exact: true }).fill("Still unsent");
  await page.goBack();
  await expect(page).toHaveURL(/view=library/);
  await expect(commentDialog(page)).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/view=work/);
  await expect(commentDialog(page)).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect((await nativeBrowserRecords(page)).originals).toEqual([]);
  noLegacyWrites(fixture);
});

test("selecting another hunk during unresolved delivery cannot adopt or retarget the saved original", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { hold: "start" });
  await openChanges(page, fixture);
  let dialog = await openComment(page);
  await submit(dialog, fixture);
  await expect.poll(() => fixture.pendingCount).toBe(1);
  await closeComment(page);
  expect(await page.locator(".diff-mb__hunk").count()).toBeGreaterThan(1);
  dialog = await openComment(page, 1);
  await expect(
    dialog.getByRole("textbox", { name: "Original comment", exact: true })
  ).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Saved requests", exact: true })).toHaveCount(0);
  await fixture.release();
  await expect(conversation(dialog)).toHaveCount(0);
  await closeComment(page);
  dialog = await openComment(page);
  await expect(conversation(dialog)).toContainText("completed");
  await originalAndFacts(dialog, fixture);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  noLegacyWrites(fixture);
});

test("refreshing a changed host diff does not attach an older selected-source receipt to the new revision", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page);
  const detail = await openChanges(page, fixture);
  let dialog = await openComment(page);
  await submit(dialog, fixture);
  await expect(conversation(dialog)).toContainText("running");
  const saved = await nativeBrowserRecords(page);
  await closeComment(page);
  fixture.setChangedSessionDiff(true);
  await detail.getByRole("button", { name: "Refresh session changes", exact: true }).click();
  await expect
    .poll(() => fixture.invocations("sessions.changes.get").length)
    .toBeGreaterThanOrEqual(2);
  const changed = JSON.parse(fixture.capture.changedSessionDiff.body) as { to: string };
  await expect(detail.locator(".session-changes__captured")).toContainText(changed.to);
  dialog = await openComment(page);
  await expect(
    dialog.getByRole("textbox", { name: "Original comment", exact: true })
  ).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Saved requests", exact: true })).toHaveCount(0);
  await expect(conversation(dialog)).toHaveCount(0);
  expect((await nativeBrowserRecords(page)).originals).toEqual(saved.originals);
  await closeComment(page);
  await detail.getByRole("radio", { name: "Transcript", exact: true }).click();
  await expect(conversation(detail)).toContainText("completed");
  await originalAndFacts(detail, fixture);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  noLegacyWrites(fixture);
});

test("changing sessions after closing unresolved delivery cannot carry the selected hunk into the new session", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { hold: "start" });
  await openChanges(page, fixture);
  await submit(await openComment(page), fixture);
  await expect.poll(() => fixture.pendingCount).toBe(1);
  await closeComment(page);
  const back = page.getByRole("button", { name: "All work", exact: true });
  if (await back.isVisible()) await back.click();
  else
    await detailPane(page)
      .getByRole("button", { name: "Close session detail", exact: true })
      .click();
  const other = await openRow(page, fixture.other.title);
  await other.getByRole("radio", { name: "Changes", exact: true }).click();
  await expect(other).toContainText("No captured changes for this session");
  await fixture.release();
  await expect(commentDialog(page)).toHaveCount(0);
  await expect(other.getByRole("region", { name: "Saved requests", exact: true })).toHaveCount(0);
  expect((await nativeBrowserRecords(page)).originals.map((record) => record.command)).toEqual([
    fixture.capture.session.command,
  ]);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  noLegacyWrites(fixture);
});

test("connection identity changing during delivery invalidates the sheet without adopting late completion or resending", async ({
  page,
}) => {
  const fixture = await installSelectedDiffDaemon(page, { hold: "start" });
  await openChanges(page, fixture);
  const dialog = await openComment(page);
  await submit(dialog, fixture);
  await expect.poll(() => fixture.pendingCount).toBe(1);
  const retained = await nativeBrowserRecords(page);
  expect(retained.originals.map((record) => record.command)).toEqual([
    fixture.capture.session.command,
  ]);
  fixture.setDiscoveryFailure(true);
  await page.evaluate(() => {
    localStorage.setItem("goodvibes.webui.token", "other-paired-proof-token");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "goodvibes.webui.token", storageArea: localStorage })
    );
  });
  // The production WorkView keys its whole content to the connection lifetime.
  // Its remount removes selection and the sheet before the held result arrives.
  await expect(dialog).toHaveCount(0);
  await expect(detailPane(page)).toHaveCount(0);
  await fixture.release();
  await nextFrames(page);
  await expect(commentDialog(page)).toHaveCount(0);
  await expect(detailPane(page)).toHaveCount(0);
  expect(await nativeBrowserRecords(page)).toEqual(retained);
  expect(fixture.writes.map((request) => request.operation)).toEqual(["capture", "admit", "start"]);
  expect(fixture.failures).toEqual([]);
  expect(fixture.requests.filter(isLegacyExecutionMutation)).toEqual([]);
});

test("failed native verification offers retry and no legacy comment control", async ({ page }) => {
  const fixture = await installSelectedDiffDaemon(page, { discoveryFailure: true });
  await openChanges(page, fixture);
  const dialog = await openComment(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "Native sessions require their existing paired owner"
  );
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Send steer|Queue follow-up/ })).toHaveCount(0);
  fixture.setDiscoveryFailure(false);
  await dialog.getByRole("button", { name: "Retry session verification", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Original comment", exact: true })
  ).toBeVisible();
  expect(fixture.writes).toEqual([]);
  noLegacyWrites(fixture);
});

for (const surface of ["Sessions", "Fleet"] as const) {
  test(`${surface} can inspect a selected-hunk original while Work New excludes it`, async ({
    page,
  }) => {
    const fixture = await installSelectedDiffDaemon(page);
    const detail = await openChanges(page, fixture);
    const dialog = await openComment(page);
    await submit(dialog, fixture);
    await expect(conversation(dialog)).toContainText("running");
    await closeComment(page);
    let target = detail;
    if (surface === "Sessions") {
      await detail.getByRole("radio", { name: "Transcript", exact: true }).click();
    } else {
      const back = page.getByRole("button", { name: "All work", exact: true });
      if (await back.isVisible()) await back.click();
      else await detail.getByRole("button", { name: "Close session detail", exact: true }).click();
      await page
        .getByRole("radiogroup", { name: "Kind of work", exact: true })
        .getByRole("radio", { name: "Agents", exact: true })
        .click();
      target = await openRow(page, fixture.fleetTitle);
    }
    await expect(conversation(target)).toContainText("completed");
    expect(await target.locator("pre.native-intake__source").textContent()).toBe(
      fixture.capture.session.command.text
    );
    await expect(
      target.getByRole("button", {
        name: `Inspect input ${fixture.capture.session.command.inputId}`,
        exact: true,
      })
    ).toBeVisible();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Native request", exact: true }).click();
    const fresh = page.getByRole("dialog", { name: "Native request", exact: true });
    await expect(
      fresh.getByRole("textbox", { name: "Original request", exact: true })
    ).toBeVisible();
    await expect(fresh.getByRole("region", { name: "Saved requests", exact: true })).toHaveCount(0);
    expect(fixture.writes.map((request) => request.operation)).toEqual([
      "capture",
      "admit",
      "start",
    ]);
    noLegacyWrites(fixture);
  });
}

test("explicitly legacy session preserves the existing prefixed steer and Cancel behavior", async ({
  page,
}) => {
  const fixture = await installMockDaemon(page);
  await page.goto("/?view=work&tab=sessions");
  const detail = await openRow(page, "Refactor the session spine");
  await detail.getByRole("radio", { name: "Changes", exact: true }).click();
  let dialog = await openComment(page, 0, "src/example.ts");
  await expect(
    dialog.getByRole("textbox", { name: "Comment on the selected change", exact: true })
  ).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Original comment", exact: true })).toHaveCount(
    0
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(fixture.requests.filter(isLegacyExecutionMutation)).toEqual([]);
  dialog = await openComment(page, 0, "src/example.ts");
  await dialog
    .getByRole("textbox", { name: "Comment on the selected change", exact: true })
    .fill("  Keep the existing API.  ");
  await dialog.getByRole("button", { name: "Send steer", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const writes = fixture.requests.filter(isLegacyExecutionMutation);
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe("/api/sessions/s-agent-live/steer");
  expect(writes[0].body).toMatchObject({ body: expect.stringContaining("Keep the existing API.") });
  expect(writes[0].body).toMatchObject({ body: expect.stringContaining("src/example.ts") });
  expect(
    fixture.requests.filter((request) => request.path === "/api/work-ledger/intake/capture")
  ).toEqual([]);
  await expect(detail).toContainText("Comment sent:");
  await expectNoHorizontalScroll(page);
});
