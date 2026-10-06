/** Real Chromium + durable IndexedDB + exact production native graph HTTP captures. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { nativeWorkExecutionSnapshotSchema } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import { expectNoHorizontalScroll } from "./support/app";
import {
  installNativeExecutionDaemon,
  nativeBrowserRecords,
} from "./support/native-execution-fixture";

type Daemon = Awaited<ReturnType<typeof installNativeExecutionDaemon>>;
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
const executionSection = (dialog: Locator) =>
  dialog.getByRole("region", { name: "Native execution", exact: true });
const writes = (daemon: Daemon) => daemon.writes.map((request) => request.operation);
async function receipt(dialog: Locator, daemon: Daemon, wire = daemon.capture.start) {
  const snapshot = nativeWorkExecutionSnapshotSchema.parse(JSON.parse(wire.body));
  if (snapshot.kind !== "execution" || !snapshot.receipt)
    throw new Error("Fixture has no real execution receipt");
  const section = dialog.getByRole("region", { name: "Execution receipt", exact: true });
  await expect(section).toContainText(snapshot.receipt.contractId);
  await expect(section).toContainText(snapshot.receipt.ownerAgentId);
}
function expectNoLegacyWrites(daemon: Daemon) {
  expect(
    daemon.requests.filter(
      (request) =>
        request.method !== "GET" &&
        (/^\/api\/(?:contracts|tasks|sessions)(?:\/|$)/.test(request.path) ||
          /^(?:contracts|tasks|sessions)\./.test(request.methodId ?? ""))
    )
  ).toEqual([]);
}

/** Hold the real transaction-completion notification, not a fake IndexedDB implementation. */
async function holdTargetCommit(page: Page) {
  await page.addInitScript(() => {
    const pending = new WeakSet<IDBTransaction>();
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.transaction.db.name === "goodvibes.native-execution.v1")
        pending.add(this.transaction);
      return add.apply(this, args);
    };
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    if (!descriptor?.set) throw new Error("Chromium transaction-completion descriptor unavailable");
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
                    targetCommitHeld: boolean;
                    releaseTargetCommit: () => void;
                  };
                  hooks.targetCommitHeld = true;
                  hooks.releaseTargetCommit = () => {
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

test("one Submit commits source and exact execution target before automatically starting the real native receipt", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page);
  await holdTargetCommit(page);
  const dialog = await submit(page, daemon);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { targetCommitHeld?: boolean }).targetCommitHeld)
    )
    .toBe(true);
  const stored = await nativeBrowserRecords(page);
  expect(stored.originals.map((record) => record.command)).toEqual([daemon.capture.input]);
  const { projectId, ...target } = daemon.capture.identity;
  expect(stored.targets).toEqual([
    {
      binding: stored.originals[0].binding,
      inputId: daemon.capture.input.inputId,
      requestId: daemon.capture.input.requestId,
      target,
    },
  ]);
  expect(stored.targets[0].binding.projectId).toBe(projectId);
  expect(writes(daemon)).toEqual(["capture", "admit"]);
  expect(daemon.executionRequests).toHaveLength(0);
  await expect(
    dialog.getByRole("region", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseTargetCommit: () => void }).releaseTargetCommit()
  );
  await receipt(dialog, daemon);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
  expect(daemon.executionRequests.map((request) => request.operation)).toEqual(["status", "start"]);
  expect(
    daemon.executionRequests.every(
      (request) => JSON.stringify(request.body) === JSON.stringify(daemon.capture.identity)
    )
  ).toBe(true);
  expect(
    daemon.executionRequests.every(
      (request) => request.authorization === "Bearer e2e-operator-token"
    )
  ).toBe(true);
  expect(await dialog.locator("pre").textContent()).toBe(daemon.capture.input.text);
  await expect(
    dialog.getByRole("button", { name: /^(approve|admit|start|resume execution)$/i })
  ).toHaveCount(0);
  expectNoLegacyWrites(daemon);
  await expectNoHorizontalScroll(page);
  await dialog
    .getByRole("region", { name: "Original request", exact: true })
    .scrollIntoViewIfNeeded();
  const sourceScreenshot = test.info().outputPath("native-original-and-admission.png");
  await page.screenshot({ path: sourceScreenshot, fullPage: true });
  await test.info().attach("Immutable original source and admission", {
    path: sourceScreenshot,
    contentType: "image/png",
  });
  await dialog
    .getByRole("region", { name: "Execution receipt", exact: true })
    .scrollIntoViewIfNeeded();
  const screenshot = test.info().outputPath("native-source-execution-receipt.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await test.info().attach("Real native execution receipt and bounded progress", {
    path: screenshot,
    contentType: "image/png",
  });
});

test("lost start acknowledgement survives reload and read-only reopen without a second start", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "running", {
    responses: { start: "disconnected" },
  });
  let dialog = await submit(page, daemon);
  await expect(executionSection(dialog).getByRole("alert")).toContainText("unconfirmed");
  await expect(
    dialog.getByRole("region", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  const stored = await nativeBrowserRecords(page);
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
  await page.reload();
  dialog = await open(page);
  await receipt(dialog, daemon);
  await expect(executionSection(dialog).getByRole("status")).toContainText("running");
  await dialog.getByRole("button", { name: "Inspect execution", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Inspect execution", exact: true })
  ).toBeEnabled();
  expect(await nativeBrowserRecords(page)).toEqual(stored);
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
  expectNoLegacyWrites(daemon);
});

test("retrying the saved source after a lost capture response automatically continues its exact admitted attempt", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "running", {
    responses: { capture: "disconnected" },
  });
  let dialog = await submit(page, daemon);
  await expect(dialog.getByRole("alert")).toContainText("outcome may be unknown");
  expect(writes(daemon)).toEqual(["capture"]);
  await page.reload();
  dialog = await open(page);
  await expect(dialog.getByRole("button", { name: "Retry submission", exact: true })).toBeEnabled();
  expect(writes(daemon)).toEqual(["capture"]);
  await dialog.getByRole("button", { name: "Retry submission", exact: true }).click();
  await receipt(dialog, daemon);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
  expect((await nativeBrowserRecords(page)).originals[0].command).toEqual(daemon.capture.input);
});

test("Continue request checks exact typed absence before the single start", async ({ page }) => {
  const daemon = await installNativeExecutionDaemon(page);
  // Failure before the owned start handler receives the request, not lost acknowledgement.
  const beforeStart = async (route: import("@playwright/test").Route) =>
    route.fulfill({ status: 503, json: { error: "Start did not reach the native fixture" } });
  await page.route("**/api/work-ledger/execution/start", beforeStart);
  const dialog = await submit(page, daemon);
  await expect(executionSection(dialog).getByRole("alert")).toBeVisible();
  expect(daemon.executionWrites).toHaveLength(0);
  await page.unroute("**/api/work-ledger/execution/start", beforeStart);
  await dialog.getByRole("button", { name: "Continue request", exact: true }).click();
  await receipt(dialog, daemon);
  expect(daemon.executionRequests.map((request) => request.operation)).toEqual([
    "status",
    "status",
    "start",
  ]);
  expect(daemon.executionWrites[0].body).toEqual(daemon.capture.identity);
});

for (const name of ["required", "refused"] as const) {
  test(`${name} execution stays inspect-only across reload until explicit recovery`, async ({
    page,
  }) => {
    const daemon = await installNativeExecutionDaemon(page, name);
    let dialog = await submit(page, daemon);
    await expect(executionSection(dialog).getByRole("alert")).toBeVisible();
    await expect(
      dialog.getByRole("region", { name: "Admission receipt", exact: true })
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Continue request", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Resume execution", exact: true })
    ).toBeEnabled();
    await expect(
      dialog.getByRole("heading", { name: "Execution receipt", exact: true })
    ).toHaveCount(0);
    expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
    await page.reload();
    dialog = await open(page);
    await expect(
      dialog.getByRole("button", { name: "Resume execution", exact: true })
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Inspect execution", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Resume execution", exact: true })
    ).toBeEnabled();
    expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
    await dialog.getByRole("button", { name: "Resume execution", exact: true }).click();
    await receipt(dialog, daemon, daemon.capture.resume);
    expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start", "resume"]);
    expect(daemon.executionWrites.at(-1)?.body).toEqual(daemon.capture.identity);
    expectNoLegacyWrites(daemon);
  });
}

test("pending admission can be cancelled while start waits, without inventing a receipt", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "pending-intent", { hold: ["start"] });
  const dialog = await submit(page, daemon);
  await expect.poll(() => daemon.pendingCount).toBe(1);
  await dialog.getByRole("button", { name: "Cancel execution", exact: true }).click();
  await expect(executionSection(dialog).getByRole("status")).toContainText(
    "prevented before admission"
  );
  await daemon.release("start");
  await expect(executionSection(dialog).getByRole("status")).toContainText(
    "prevented before admission"
  );
  await expect(dialog.getByRole("heading", { name: "Execution receipt", exact: true })).toHaveCount(
    0
  );
  await expect(
    dialog.getByRole("heading", { name: "Execution progress", exact: true })
  ).toHaveCount(0);
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start", "cancel"]);
  expect(daemon.executionWrites.at(-1)?.body).toEqual(daemon.capture.identity);
});

test("host cancellation remains visible when a late successful start response is delivered", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "cancelled-execution", {
    hold: ["start"],
  });
  const dialog = await submit(page, daemon);
  await expect.poll(() => daemon.pendingCount).toBe(1);
  await dialog.getByRole("button", { name: "Cancel execution", exact: true }).click();
  await expect(executionSection(dialog).getByRole("status")).toContainText(
    "Native execution is cancelled"
  );
  await receipt(dialog, daemon, daemon.capture.cancel);
  await daemon.release("start");
  await expect(executionSection(dialog).getByRole("status")).toContainText(
    "Native execution is cancelled"
  );
  await expect(dialog.getByRole("button", { name: "Resume execution", exact: true })).toHaveCount(
    0
  );
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start", "cancel"]);
});

test("New request detaches a held start without cancellation or a late receipt overwriting the new composer", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "running", { hold: ["start"] });
  const dialog = await submit(page, daemon);
  await expect.poll(() => daemon.pendingCount).toBe(1);
  await dialog.getByRole("button", { name: "New request", exact: true }).click();
  const composer = dialog.getByRole("textbox", { name: "Original request", exact: true });
  await composer.fill("A deliberately separate original source");
  await daemon.release("start");
  await expect(composer).toHaveValue("A deliberately separate original source");
  await expect(dialog.getByRole("heading", { name: "Execution receipt", exact: true })).toHaveCount(
    0
  );
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
  expect((await nativeBrowserRecords(page)).targets).toHaveLength(1);
});

for (const name of ["settlement", "settlement-required"] as const) {
  test(`${name}: a passed runner keeps publication separate; explicit verification and reconciliation preserve the old revisions`, async ({
    page,
  }) => {
    const daemon = await installNativeExecutionDaemon(page, name);
    const dialog = await submit(page, daemon);
    await receipt(dialog, daemon);
    await dialog.getByRole("button", { name: "Inspect execution", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Verify and publish", exact: true })
    ).toBeEnabled();
    await expect(executionSection(dialog).getByRole("status")).toContainText("runner passed");
    const settlement = dialog.getByRole("region", { name: "Ledger settlement", exact: true });
    await expect(settlement).toContainText(name === "settlement" ? "failed" : "required");
    await expect(settlement).toContainText("does not establish verified ledger completion");
    expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
    await dialog.getByRole("button", { name: "Verify and publish", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Reconcile publication", exact: true })
    ).toBeEnabled();
    await expect(settlement).toContainText("published");
    await expect(settlement).toContainText(
      "Publication alone does not say that the evidence passed verification"
    );
    await expect(executionSection(dialog)).toContainText("The ledger target changed");
    const published = nativeWorkExecutionSnapshotSchema.parse(
      JSON.parse(daemon.capture.resume?.body ?? "null")
    );
    if (published.kind !== "execution") throw new Error("Missing published capture");
    await expect(settlement).toContainText(published.settlement?.evidenceId ?? "Missing evidence");
    await dialog.getByRole("button", { name: "Reconcile publication", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Reconcile publication", exact: true })
    ).toBeEnabled();
    expect(daemon.executionWrites.map((request) => request.operation)).toEqual([
      "start",
      "resume",
      "resume",
    ]);
    expect(
      daemon.executionWrites.every(
        (request) => JSON.stringify(request.body) === JSON.stringify(daemon.capture.identity)
      )
    ).toBe(true);
    expect((await nativeBrowserRecords(page)).targets[0].target.expectedRevision).toEqual({
      work: 1,
      criteria: 1,
      attempt: 1,
    });
    expectNoLegacyWrites(daemon);
  });
}

test("terminal published execution is only observed on reopen and never restarts the source", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "terminal");
  let dialog = await submit(page, daemon);
  await receipt(dialog, daemon);
  await page.reload();
  dialog = await open(page);
  await expect(
    dialog.getByRole("button", { name: "Reconcile publication", exact: true })
  ).toBeEnabled();
  await expect(
    dialog.getByRole("region", { name: "Ledger settlement", exact: true })
  ).toContainText("published");
  await expect(
    dialog.getByRole("button", { name: /^(Continue request|Resume execution|Verify and publish)$/ })
  ).toHaveCount(0);
  expect(writes(daemon)).toEqual(["capture", "admit", "start"]);
});

for (const response of ["server-error", "malformed", "untyped-not-found"] as const) {
  test(`${response} status never grants permission to start execution`, async ({ page }) => {
    const daemon = await installNativeExecutionDaemon(
      page,
      "running",
      response === "untyped-not-found" ? {} : { responses: { status: response } }
    );
    if (response === "untyped-not-found")
      await page.route("**/api/work-ledger/execution/status", (route) =>
        route.fulfill({ status: 404, json: { error: "Ordinary unknown route" } })
      );
    const dialog = await submit(page, daemon);
    await expect(executionSection(dialog).getByRole("alert")).toContainText("unconfirmed");
    await dialog.getByRole("button", { name: "Continue request", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Continue request", exact: true })
    ).toBeEnabled();
    expect(daemon.executionWrites).toHaveLength(0);
    await expect(
      dialog.getByRole("region", { name: "Admission receipt", exact: true })
    ).toBeVisible();
    expectNoLegacyWrites(daemon);
  });
}

test("missing fleet authority preserves admission but blocks every execution operation", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page);
  const auth = JSON.parse(daemon.capture.auth.body) as { scopes: string[] };
  daemon.setAuthResponse({
    ...auth,
    scopes: auth.scopes.filter((scope) => scope !== "write:fleet"),
  });
  const dialog = await submit(page, daemon);
  await expect(executionSection(dialog).getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  for (const name of ["Inspect execution", "Continue request", "Cancel execution"]) {
    await dialog.getByRole("button", { name, exact: true }).click();
    await expect(dialog.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  expect(daemon.executionRequests).toHaveLength(0);
  expect(writes(daemon)).toEqual(["capture", "admit"]);
});

test("changing paired authority while start waits fences its late result and hides the prior owner's saved records", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "running", { hold: ["start"] });
  await submit(page, daemon);
  await expect.poll(() => daemon.pendingCount).toBe(1);
  daemon.setAuthResponse({
    ...(JSON.parse(daemon.capture.auth.body) as Record<string, unknown>),
    principalId: "pairing:another-native-owner",
  });
  await page.evaluate(() => {
    localStorage.setItem("goodvibes.webui.token", "another-synthetic-native-owner");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "goodvibes.webui.token", storageArea: localStorage })
    );
  });
  await expect(page.getByRole("dialog", { name: "Native request", exact: true })).toHaveCount(0);
  await daemon.release("start");
  const dialog = await open(page);
  await expect(
    dialog.getByRole("textbox", { name: "Original request", exact: true })
  ).toBeEnabled();
  await expect(
    dialog.getByRole("heading", { name: /^(Saved requests|Admission receipt|Execution receipt)$/ })
  ).toHaveCount(0);
  expect((await nativeBrowserRecords(page)).targets).toHaveLength(1);
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
});

for (const failure of ["abort", "relaxed", "unavailable"] as const) {
  test(`execution journal ${failure} cannot erase admission or permit a start`, async ({
    page,
  }) => {
    const daemon = await installNativeExecutionDaemon(page);
    await page.addInitScript((mode) => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        const result = add.apply(this, args);
        if (mode === "abort" && this.transaction.db.name === "goodvibes.native-execution.v1")
          this.transaction.abort();
        return result;
      };
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === "goodvibes.native-execution.v1" && args[1] === "readwrite") {
          if (mode === "unavailable")
            throw new DOMException(
              "Owned fixture denies durable target storage",
              "QuotaExceededError"
            );
          if (mode === "relaxed") args[2] = { durability: "relaxed" };
        }
        return transaction.apply(this, args);
      };
    }, failure);
    const dialog = await submit(page, daemon);
    await expect(executionSection(dialog).getByRole("alert")).toContainText("journal");
    await expect(
      dialog.getByRole("region", { name: "Admission receipt", exact: true })
    ).toBeVisible();
    const stored = await nativeBrowserRecords(page);
    expect(stored.originals.map((record) => record.command)).toEqual([daemon.capture.input]);
    expect(stored.targets).toEqual([]);
    expect(daemon.executionWrites).toHaveLength(0);
    expectNoLegacyWrites(daemon);
  });
}

test("a corrupt retained target blocks cancellation without rewriting the original or sending another execution mutation", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "cancelled-execution");
  const dialog = await submit(page, daemon);
  await receipt(dialog, daemon);
  const before = await nativeBrowserRecords(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("goodvibes.native-execution.v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("targets", "readwrite", { durability: "strict" });
          const store = tx.objectStore("targets"),
            read = store.getAll();
          read.onsuccess = () =>
            store.put({ ...read.result[0], unauthorizedHiddenField: "fixture-corruption" });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      })
  );
  await dialog.getByRole("button", { name: "Cancel execution", exact: true }).click();
  await expect(executionSection(dialog).getByRole("alert")).toContainText("corrupt");
  expect((await nativeBrowserRecords(page)).originals).toEqual(before.originals);
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
});

test("stale source lookup still allows reading and cancelling the same retained execution target", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "cancelled-execution");
  let dialog = await submit(page, daemon);
  await receipt(dialog, daemon);
  const before = await nativeBrowserRecords(page);
  await page.route("**/api/work-ledger/intake/get", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Native conversation intake stale", code: "NATIVE_INTAKE_STALE" },
    })
  );
  await page.reload();
  dialog = await open(page);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await receipt(dialog, daemon);
  await dialog.getByRole("button", { name: "Cancel execution", exact: true }).click();
  await expect(executionSection(dialog).getByRole("status")).toContainText(
    "Native execution is cancelled"
  );
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start", "cancel"]);
  expect(daemon.executionWrites.at(-1)?.body).toEqual(daemon.capture.identity);
  expect(await nativeBrowserRecords(page)).toEqual(before);
});

test("a second tab reads the retained execution target without resubmitting source or start", async ({
  page,
  context,
}) => {
  const daemon = await installNativeExecutionDaemon(page);
  const dialog = await submit(page, daemon);
  await receipt(dialog, daemon);
  const retained = await nativeBrowserRecords(page);
  const second = await context.newPage();
  const secondDaemon = await installNativeExecutionDaemon(second);
  secondDaemon.setIntakePhase("get");
  secondDaemon.setStatus("status");
  await second.goto("/?view=work");
  const secondDialog = await open(second);
  await receipt(secondDialog, secondDaemon);
  await expect(executionSection(secondDialog).getByRole("status")).toContainText("running");
  expect(await nativeBrowserRecords(second)).toEqual(retained);
  expect(secondDaemon.writes).toEqual([]);
  await second.close();
});

test("cancelling an exact retained target before start records prevention without a receipt", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "prevented");
  await page.route("**/api/work-ledger/execution/start", (route) =>
    route.fulfill({ status: 503, json: { error: "Start did not reach the native fixture" } })
  );
  const dialog = await submit(page, daemon);
  await expect(executionSection(dialog).getByRole("alert")).toBeVisible();
  expect(daemon.executionWrites).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel execution", exact: true }).click();
  await expect(executionSection(dialog).getByRole("status")).toContainText(
    "prevented before admission"
  );
  await expect(dialog.getByRole("heading", { name: "Execution receipt", exact: true })).toHaveCount(
    0
  );
  await expect(
    dialog.getByRole("button", { name: /^(Continue request|Resume execution|Cancel execution)$/ })
  ).toHaveCount(0);
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["cancel"]);
  expect(daemon.executionWrites[0].body).toEqual(daemon.capture.identity);
  expect((await nativeBrowserRecords(page)).targets).toHaveLength(1);
});

test("a cold prepared execution with available recovery only resumes after an explicit action", async ({
  page,
}) => {
  const daemon = await installNativeExecutionDaemon(page, "prepared");
  let dialog = await submit(page, daemon);
  await receipt(dialog, daemon);
  await expect(dialog.getByRole("button", { name: "Resume execution", exact: true })).toBeEnabled();
  await expect(executionSection(dialog).getByRole("status")).toContainText("Prepared execution");
  const retained = await nativeBrowserRecords(page);
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
  await page.reload();
  dialog = await open(page);
  await expect(dialog.getByRole("button", { name: "Resume execution", exact: true })).toBeEnabled();
  await receipt(dialog, daemon);
  await dialog.getByRole("button", { name: "Inspect execution", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Resume execution", exact: true })).toBeEnabled();
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start"]);
  await dialog.getByRole("button", { name: "Resume execution", exact: true }).click();
  await receipt(dialog, daemon, daemon.capture.resume);
  await expect(
    dialog.getByRole("button", { name: "Inspect execution", exact: true })
  ).toBeEnabled();
  expect(daemon.executionWrites.map((request) => request.operation)).toEqual(["start", "resume"]);
  expect(daemon.executionWrites.at(-1)?.body).toEqual(daemon.capture.identity);
  expect(await nativeBrowserRecords(page)).toEqual(retained);
  expectNoLegacyWrites(daemon);
});
