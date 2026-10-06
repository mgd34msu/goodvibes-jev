/** Production browser bundle + Chromium IndexedDB + unchanged paired daemon/model captures. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { nativeHostedTurnLookupSchema } from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { expectNoHorizontalScroll } from "./support/app";
import {
  isLegacyExecutionMutation,
  nativeBrowserRecords,
} from "./support/native-execution-fixture";
import { installNativeHostedTurnDaemon } from "./support/native-hosted-turn-fixture";

type Daemon = Awaited<ReturnType<typeof installNativeHostedTurnDaemon>>;
const conversation = (dialog: Locator) =>
  dialog.getByRole("region", { name: "Hosted conversation", exact: true });
const writes = (daemon: Daemon) => daemon.writes.map((request) => request.operation);
async function open(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Native request", exact: true }).click();
  return page.getByRole("dialog", { name: "Native request", exact: true });
}
async function submit(page: Page, daemon: Daemon) {
  await page.goto("/?view=work");
  const dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  return dialog;
}
async function identity(dialog: Locator, daemon: Daemon, phase: "start" | "status" = "start") {
  const snapshot = nativeHostedTurnLookupSchema.parse(JSON.parse(daemon.capture[phase].body));
  if ("kind" in snapshot) throw new Error("Fixture lacks a recorded hosted turn");
  const section = conversation(dialog);
  await expect(section).toContainText(snapshot.state);
  await expect(section).toContainText(snapshot.sourceRevision);
  for (const value of [snapshot.sessionId, snapshot.brokerInputId, snapshot.correlationId]) {
    if (value) await expect(section).toContainText(value);
  }
}
function expectOnlyNativeDelivery(daemon: Daemon) {
  expect(daemon.requests.filter(isLegacyExecutionMutation)).toEqual([]);
  expect(
    daemon.requests.filter((request) => request.path.startsWith("/api/work-ledger/execution/"))
  ).toEqual([]);
  expect(
    daemon.turnRequests.every(
      (request) => JSON.stringify(request.body) === JSON.stringify(daemon.capture.identity)
    )
  ).toBe(true);
  expect(
    daemon.nativeRequests.every((request) => request.authorization === "Bearer e2e-operator-token")
  ).toBe(true);
}
async function screenshot(page: Page, name: string, label: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test
    .info()
    .attach(`${test.info().project.name}: ${label}`, { path, contentType: "image/png" });
}

/** Hold Chromium's real completion notification after its strict source transaction commits. */
async function holdOriginalCommit(page: Page) {
  await page.addInitScript(() => {
    const pending = new WeakSet<IDBTransaction>();
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.transaction.db.name === "goodvibes.native-intake.v1") {
        pending.add(this.transaction);
        (window as unknown as { originalDurability: string }).originalDurability =
          this.transaction.durability;
      }
      return add.apply(this, args);
    };
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    if (!descriptor?.set) throw new Error("Missing Chromium transaction-completion descriptor");
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      ...descriptor,
      set(this: IDBTransaction, callback: ((event: Event) => void) | null) {
        descriptor.set?.call(
          this,
          callback === null
            ? null
            : (event: Event) => {
                if (pending.has(this)) {
                  const hooks = window as unknown as {
                    originalCommitHeld: boolean;
                    releaseOriginalCommit: () => void;
                  };
                  hooks.originalCommitHeld = true;
                  hooks.releaseOriginalCommit = () => {
                    pending.delete(this);
                    callback.call(this, event);
                  };
                } else callback.call(this, event);
              }
        );
      },
    });
  });
}

test("one Submit commits the exact original before automatic hosted delivery; Inspect shows recorded completion", async ({
  page,
}) => {
  const daemon = await installNativeHostedTurnDaemon(page);
  await holdOriginalCommit(page);
  const dialog = await submit(page, daemon);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { originalCommitHeld?: boolean }).originalCommitHeld
      )
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as { originalDurability?: string }).originalDurability
    )
  ).toBe("strict");
  const retained = await nativeBrowserRecords(page);
  expect(retained.originals.map((record) => record.command)).toEqual([daemon.capture.input]);
  expect(retained.originals[0].binding).toMatchObject({
    projectId: daemon.capture.identity.projectId,
    principalId: (JSON.parse(daemon.capture.auth.body) as { principalId: string }).principalId,
    transport: "direct",
  });
  expect(retained.targets).toEqual([]);
  expect(daemon.nativeRequests).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as { releaseOriginalCommit: () => void }).releaseOriginalCommit()
  );
  await identity(dialog, daemon);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
  expect(daemon.turnRequests.map((request) => request.operation)).toEqual(["status", "start"]);
  expect(await dialog.locator("pre").textContent()).toBe(daemon.capture.input.text);
  await expect(
    dialog.getByRole("button", {
      name: /^(approve|admit|start|resume|retry submission|continue conversation request)$/i,
    })
  ).toHaveCount(0);
  await expect(conversation(dialog).getByRole("status")).toContainText(
    "running in its hosted session"
  );
  await expectNoHorizontalScroll(page);
  await dialog
    .getByRole("region", { name: "Original request", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(
    page,
    "native-hosted-original",
    "Immutable original source and one-submit admission"
  );
  await conversation(dialog).scrollIntoViewIfNeeded();
  await screenshot(
    page,
    "native-hosted-running",
    "Canonical hosted session, broker input and running delivery"
  );
  await dialog.getByRole("button", { name: "Inspect conversation", exact: true }).click();
  await expect(conversation(dialog).getByRole("status")).toContainText("host recorded completion");
  await identity(dialog, daemon, "status");
  await expect(
    dialog.getByRole("button", { name: "Inspect conversation", exact: true })
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel conversation", exact: true })
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Open hosted session", exact: true })
  ).toBeEnabled();
  expect(await nativeBrowserRecords(page)).toEqual(retained);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
  expectOnlyNativeDelivery(daemon);
  await conversation(dialog).scrollIntoViewIfNeeded();
  await screenshot(
    page,
    "native-hosted-completed",
    "Actual recorded hosted completion after read-only Inspect"
  );
});

test("closing, reopening and reloading only read the original delivery without a second start", async ({
  page,
}) => {
  const daemon = await installNativeHostedTurnDaemon(page);
  let dialog = await submit(page, daemon);
  await identity(dialog, daemon);
  const retained = await nativeBrowserRecords(page);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  dialog = await open(page);
  await identity(dialog, daemon, "status");
  await expect(dialog.getByRole("button", { name: "Inspect", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Inspect", exact: true })).toBeEnabled();
  await page.reload();
  dialog = await open(page);
  await identity(dialog, daemon, "status");
  await expect(
    dialog.getByRole("button", { name: "Inspect conversation", exact: true })
  ).toBeEnabled();
  expect(await nativeBrowserRecords(page)).toEqual(retained);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
  await expect(
    dialog.getByRole("button", { name: "Continue conversation request", exact: true })
  ).toHaveCount(0);
  expectOnlyNativeDelivery(daemon);
});

test("a lost start acknowledgement reconciles by read-only reload without replaying the broker input", async ({
  page,
}) => {
  const daemon = await installNativeHostedTurnDaemon(page, "completed", {
    loseStartAcknowledgement: true,
  });
  let dialog = await submit(page, daemon);
  await expect(conversation(dialog).getByRole("alert")).toContainText("unconfirmed");
  await expect(conversation(dialog).getByRole("alert")).toContainText(
    "No automatic retry was sent"
  );
  const retained = await nativeBrowserRecords(page);
  expect(retained.originals[0].command).toEqual(daemon.capture.input);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
  await page.reload();
  dialog = await open(page);
  await identity(dialog, daemon, "status");
  await expect(conversation(dialog).getByRole("status")).toContainText("host recorded completion");
  await expect(
    dialog.getByRole("button", { name: "Inspect conversation", exact: true })
  ).toBeEnabled();
  expect(await nativeBrowserRecords(page)).toEqual(retained);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
  expectOnlyNativeDelivery(daemon);
});

test("cancel while the pre-start status read waits records real prevention without a hosted session", async ({
  page,
}) => {
  const daemon = await installNativeHostedTurnDaemon(page, "cancelled", { hold: ["status"] });
  let dialog = await submit(page, daemon);
  await expect.poll(() => daemon.pendingCount).toBe(1);
  expect(writes(daemon)).toEqual(["capture", "admit"]);
  await dialog.getByRole("button", { name: "Cancel conversation", exact: true }).click();
  await expect(conversation(dialog).getByRole("status")).toContainText("delivery is cancelled");
  await expect(conversation(dialog).getByText("Not recorded", { exact: true })).toHaveCount(3);
  const retained = await nativeBrowserRecords(page);
  await daemon.release("status");
  await expect(conversation(dialog).getByRole("status")).toContainText("delivery is cancelled");
  await expect(
    dialog.getByRole("button", { name: "Open hosted session", exact: true })
  ).toHaveCount(0);
  expect(writes(daemon)).toEqual(["capture", "admit", "cancel"]);
  await page.reload();
  dialog = await open(page);
  await identity(dialog, daemon, "status");
  await expect(
    dialog.getByRole("button", { name: "Inspect conversation", exact: true })
  ).toBeEnabled();
  expect(await nativeBrowserRecords(page)).toEqual(retained);
  expect(writes(daemon)).toEqual(["capture", "admit", "cancel"]);
  expectOnlyNativeDelivery(daemon);
  await conversation(dialog).scrollIntoViewIfNeeded();
  await screenshot(
    page,
    "native-hosted-cancelled",
    "Recorded pre-start cancellation with no invented broker identity"
  );
});

for (const failure of ["abort", "relaxed", "unavailable"] as const) {
  test(`source journal ${failure} sends zero intake or hosted delivery operations`, async ({
    page,
  }) => {
    const daemon = await installNativeHostedTurnDaemon(page);
    await page.goto("/?view=work");
    const dialog = await open(page);
    const composer = dialog.getByRole("textbox", { name: "Original request", exact: true });
    await composer.fill(daemon.capture.input.text);
    // Inject after the empty-journal mount read, so this proves the actual Submit barrier.
    await page.evaluate((mode) => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        const result = add.apply(this, args);
        if (mode === "abort" && this.transaction.db.name === "goodvibes.native-intake.v1")
          this.transaction.abort();
        return result;
      };
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === "goodvibes.native-intake.v1" && args[1] === "readwrite") {
          if (mode === "unavailable")
            throw new DOMException(
              "Owned fixture denies durable original storage",
              "QuotaExceededError"
            );
          if (mode === "relaxed") args[2] = { durability: "relaxed" };
        }
        return transaction.apply(this, args);
      };
    }, failure);
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("source journal");
    await expect(composer).toHaveValue(daemon.capture.input.text);
    expect((await nativeBrowserRecords(page)).originals).toEqual([]);
    expect(daemon.nativeRequests).toEqual([]);
    expectOnlyNativeDelivery(daemon);
  });
}
