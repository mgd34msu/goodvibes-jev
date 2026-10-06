/** Real Chromium + strict IndexedDB + unchanged authenticated daemon capture bytes. */
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalScroll } from "./support/app";
import { installNativeIntakeDaemon as installIntakeCapture } from "./support/native-intake-fixture";

/** Intake-only recordings cannot claim execution or hosted delivery. Remove both authorities. */
async function installNativeIntakeDaemon(...args: Parameters<typeof installIntakeCapture>) {
  const daemon = await installIntakeCapture(...args);
  const auth = JSON.parse(daemon.capture.auth.body) as { scopes: string[] };
  daemon.setAuthResponse({
    ...auth,
    scopes: auth.scopes.filter((scope) => scope !== "write:fleet" && scope !== "write:sessions"),
  });
  return daemon;
}

async function open(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Native request", exact: true }).click();
  return page.getByRole("dialog", { name: "Native request", exact: true });
}

async function originals(page: Page) {
  return page.evaluate(
    () =>
      new Promise<
        {
          command: {
            inputId: string;
            requestId: string;
            text: string;
            unsupportedSources: unknown[];
          };
        }[]
      >((resolve, reject) => {
        const request = indexedDB.open("goodvibes.native-intake.v1", 1);
        request.onerror = () => reject(new Error("Journal open failed"));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("captures", "readonly");
          const read = tx.objectStore("captures").getAll();
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(new Error("Journal read failed"));
          tx.oncomplete = () => db.close();
        };
      })
  );
}

test("an absent journaled input can be left saved while composing a deliberate new request", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "work");
  // Fail before the fixture receives capture; its genuine lookup-before bytes
  // remain not-found. This is not an acknowledgement-loss simulation.
  await page.route("**/api/work-ledger/intake/capture", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Capture did not reach the owned daemon fixture" },
    })
  );
  await page.goto("/?view=work");
  const dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog.getByRole("alert").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
  // Source lookup can finish while the independent execution inspection is still busy.
  await expect(
    dialog.getByRole("status").filter({ hasText: "latest lookup found no capture" })
  ).toContainText("latest lookup found no capture");
  await dialog.getByRole("button", { name: "New request", exact: true }).click();
  const field = dialog.getByRole("textbox", { name: "Original request", exact: true });
  await expect(field).toBeEnabled();
  await field.fill("A corrected, deliberately separate request");
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog.getByRole("alert").first()).toBeVisible();
  const stored = await originals(page);
  expect(stored).toHaveLength(2);
  expect(stored.some((record) => record.command.text === daemon.capture.input.text)).toBe(true);
  expect(
    stored.some((record) => record.command.text === "A corrected, deliberately separate request")
  ).toBe(true);
  expect(new Set(stored.map((record) => record.command.inputId)).size).toBe(2);
  expect(daemon.writes).toHaveLength(0);
});

test("one Submit durably preserves exact text and admission when execution authority is unavailable", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "work", { hold: ["capture"] });
  await page.goto("/?view=work");
  const dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).dblclick();
  await expect.poll(() => daemon.pendingCount).toBe(1);
  expect((await originals(page)).map((record) => record.command)).toEqual([daemon.capture.input]);
  expect(daemon.writes).toHaveLength(1);
  await daemon.release("capture");
  await expect(
    dialog.getByRole("heading", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "Native execution", exact: true }).getByRole("alert")
  ).toContainText("Execution outcome is unconfirmed");
  expect(await dialog.locator("pre").textContent()).toBe(daemon.capture.input.text);
  expect(daemon.writes.map((request) => request.operation)).toEqual(["capture", "admit"]);
  expect(daemon.writes.map((request) => request.body)).toEqual([
    daemon.capture.input,
    daemon.capture.transition,
  ]);
  await expect(
    dialog.getByRole("button", { name: /^(approve|admit|start|reply|resume|retry submission)$/i })
  ).toHaveCount(0);
  expect(
    daemon.requests.filter(
      (request) =>
        request.method !== "GET" &&
        /^\/api\/(?:contracts|tasks|sessions|work-ledger\/(?:execution|turn))/.test(request.path)
    )
  ).toEqual([]);
  await expectNoHorizontalScroll(page);
  const screenshot = test.info().outputPath("native-source-admission.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await test
    .info()
    .attach("Native original source and admission", { path: screenshot, contentType: "image/png" });
  const receipt = dialog
    .locator(".dv-section")
    .filter({ has: page.getByRole("heading", { name: "Admission receipt", exact: true }) });
  await receipt.scrollIntoViewIfNeeded();
  await expect(receipt).toBeInViewport();
  const receiptScreenshot = test.info().outputPath("native-admission-receipt.png");
  await page.screenshot({ path: receiptScreenshot, fullPage: true });
  await test.info().attach("Native admission receipt details", {
    path: receiptScreenshot,
    contentType: "image/png",
  });
});

test("lost capture acknowledgement survives reload; reopening only inspects and retry keeps the original IDs", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "work", {
    responses: { capture: "disconnected" },
  });
  await page.goto("/?view=work");
  let dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("outcome may be unknown");
  expect(daemon.writes).toHaveLength(1);
  await page.reload();
  dialog = await open(page);
  await expect(dialog.getByRole("button", { name: "Retry submission", exact: true })).toBeEnabled();
  expect(daemon.writes).toHaveLength(1);
  expect((await originals(page))[0]?.command).toEqual(daemon.capture.input);
  await dialog.getByRole("button", { name: "Retry submission", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  expect(daemon.writes.map((request) => request.operation)).toEqual(["capture", "admit"]);
  expect(daemon.writes[1]?.body).toEqual(daemon.capture.transition);
});

test("interrupted admission does not reroll on inspect or reopen, and only explicit Resume continues it", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "recovery");
  await page.goto("/?view=work");
  let dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog.getByRole("alert").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  dialog = await open(page);
  await expect(dialog.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  expect(daemon.writes.map((request) => request.operation)).toEqual(["capture", "admit"]);
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  expect(daemon.writes.map((request) => request.operation)).toEqual(["capture", "admit", "resume"]);
});

test("cancellation during a provider wait uses the real source identity and a late admit cannot replace the tombstone", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "cancelled", { hold: ["admit"] });
  await page.goto("/?view=work");
  const dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect.poll(() => daemon.pendingCount).toBe(1);
  await dialog.getByRole("button", { name: "Cancel intake", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Intake was cancelled before work admission" })
  ).toContainText("Intake was cancelled before work admission");
  await daemon.release("admit");
  await expect(
    dialog.getByRole("status").filter({ hasText: "Intake was cancelled before work admission" })
  ).toContainText("Intake was cancelled before work admission");
  expect(daemon.writes.map((request) => request.operation)).toEqual(["capture", "admit", "cancel"]);
  expect(daemon.writes.at(-1)?.body).toEqual(daemon.capture.transition);
});

for (const name of ["turn", "blocked", "refused"] as const)
  test(`${name} is displayed as the recorded terminal disposition without a human approval fallback`, async ({
    page,
  }) => {
    const daemon = await installNativeIntakeDaemon(page, name);
    await page.goto("/?view=work");
    const dialog = await open(page);
    await dialog
      .getByRole("textbox", { name: "Original request", exact: true })
      .fill(daemon.capture.input.text);
    for (const [index, source] of daemon.capture.input.unsupportedSources.entries()) {
      await dialog.getByRole("button", { name: "Mark an unavailable source", exact: true }).click();
      if (source.kind !== "context") {
        await dialog
          .getByRole("combobox", { name: `Source ${index + 1} type`, exact: true })
          .click();
        await page
          .getByRole("option", {
            name: source.kind === "file" ? "Unread file" : "Unread image",
            exact: true,
          })
          .click();
      }
      await dialog
        .getByRole("textbox", { name: `Source ${index + 1} label`, exact: true })
        .fill(source.label);
    }
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "New request", exact: true })).toBeEnabled();
    const disposition =
      name === "turn"
        ? "Hosted conversation delivery is reported separately below"
        : name === "blocked"
          ? "blocked"
          : "Jev refused";
    await expect(dialog.getByRole("status").filter({ hasText: disposition })).toContainText(
      disposition
    );
    expect((await originals(page))[0]?.command).toEqual(daemon.capture.input);
    await expect(
      dialog.getByRole("button", {
        name: /^(approve|admit|start|reply|resume|retry submission|cancel intake)$/i,
      })
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Inspect", exact: true })).toBeEnabled();
    expect(daemon.writes.map((request) => request.operation)).toEqual(["capture", "admit"]);
    expect(
      daemon.requests.filter(
        (request) =>
          request.method !== "GET" &&
          /^\/api\/(?:contracts|tasks|sessions|work-ledger\/(?:execution|turn))/.test(request.path)
      )
    ).toEqual([]);
  });

test("unsupported authority and unavailable durable storage block submission before capture", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page);
  daemon.setAuthResponse({
    ...(JSON.parse(daemon.capture.auth.body) as Record<string, unknown>),
    principalId: "shared-token",
  });
  await page.goto("/?view=work");
  let dialog = await open(page);
  await expect(dialog.getByRole("alert")).toContainText("existing paired admin");
  await expect(dialog.getByRole("button", { name: "Submit", exact: true })).toHaveCount(0);
  expect(daemon.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  daemon.setAuthResponse(JSON.parse(daemon.capture.auth.body));
  await page.evaluate(() => {
    Object.defineProperty(IDBTransaction.prototype, "durability", {
      configurable: true,
      get: () => "relaxed",
    });
  });
  dialog = await open(page);
  await expect(dialog.getByRole("alert")).toContainText("durability");
  await expect(dialog.getByRole("button", { name: "Submit", exact: true })).toHaveCount(0);
  expect(daemon.writes).toHaveLength(0);
});

test("a stored original is visible to a second tab of the same paired owner without resubmission", async ({
  page,
  context,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "work");
  await page.goto("/?view=work");
  const dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  const second = await context.newPage();
  const secondDaemon = await installNativeIntakeDaemon(second, "work");
  secondDaemon.setLookupPhase("get");
  await second.goto("/?view=work");
  const secondDialog = await open(second);
  await expect(
    secondDialog.getByRole("heading", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  expect((await originals(second))[0]?.command).toEqual(daemon.capture.input);
  expect(secondDaemon.writes).toHaveLength(0);
  await second.close();
});

test("replacing the paired identity hides the old source and ignores its late admission response", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "work", { hold: ["admit"] });
  await page.goto("/?view=work");
  let dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect.poll(() => daemon.pendingCount).toBe(1);
  daemon.setAuthResponse({
    ...(JSON.parse(daemon.capture.auth.body) as Record<string, unknown>),
    principalId: "pairing:another-owner",
  });
  await page.evaluate(() => {
    localStorage.setItem("goodvibes.webui.token", "another-synthetic-owner");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "goodvibes.webui.token", storageArea: localStorage })
    );
  });
  await expect(page.getByRole("dialog", { name: "Native request", exact: true })).toHaveCount(0);
  await daemon.release("admit");
  dialog = await open(page);
  await expect(
    dialog.getByRole("textbox", { name: "Original request", exact: true })
  ).toBeEnabled();
  await expect(dialog.getByRole("heading", { name: "Admission receipt", exact: true })).toHaveCount(
    0
  );
  await expect(dialog.getByRole("heading", { name: "Saved requests", exact: true })).toHaveCount(0);
  expect(daemon.writes.map((request) => request.operation)).toEqual(["capture", "admit"]);
  expect((await originals(page))[0]?.command).toEqual(daemon.capture.input);
});

test("a stale original does not prevent a separately identified request under the same current owner", async ({
  page,
}) => {
  const daemon = await installNativeIntakeDaemon(page, "work");
  await page.goto("/?view=work");
  let dialog = await open(page);
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill(daemon.capture.input.text);
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Admission receipt", exact: true })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  // Explicit browser failure injection; the real daemon test proves a workspace
  // registration can stale this capture without changing owner/project identity.
  await page.route("**/api/work-ledger/intake/get", (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: "NATIVE_INTAKE_STALE", message: "Native conversation intake stale" } },
    })
  );
  dialog = await open(page);
  await expect(dialog.getByRole("alert").first()).toBeVisible();
  await expect(
    dialog.getByText("It does not cancel daemon intake", { exact: false })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "New request", exact: true }).click();
  let fresh: unknown;
  await page.route("**/api/work-ledger/intake/capture", async (route) => {
    fresh = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      json: { error: "Owned fixture stops after inspecting the fresh request" },
    });
  });
  await dialog
    .getByRole("textbox", { name: "Original request", exact: true })
    .fill("Fresh source for the current workspace scope");
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog.getByRole("alert").first()).toBeVisible();
  expect(fresh).toMatchObject({
    text: "Fresh source for the current workspace scope",
    unsupportedSources: [],
  });
  const stored = await originals(page);
  expect(stored).toHaveLength(2);
  expect(new Set(stored.map((record) => record.command.inputId)).size).toBe(2);
  expect(new Set(stored.map((record) => record.command.requestId)).size).toBe(2);
  expect(stored.some((record) => record.command.text === daemon.capture.input.text)).toBe(true);
});
