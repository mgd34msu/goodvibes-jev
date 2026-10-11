/** Production UI, real browser transport, synthetic protocol replies; no providers or secrets. */
import { expect, test, type Page } from "@playwright/test";
import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-sdk";
import { installMockDaemon } from "./support/mock-daemon";
import { nextFrames, openSettings } from "./support/app";

type CredentialRequest = BrowserJudgmentRequest<"webui.credentials.provider-key">;
type PlatformRequest = BrowserJudgmentRequest<"webui.pwa.install-platform">;
const evidence = (index = 0) => ({
  decisionId: `browser-fixture-${index}`,
  model: "synthetic-browser",
  requestedModel: "synthetic-browser",
  usage: { inputTokens: 1, outputTokens: 1 },
  latencyMs: 1,
});
const envelope = (request: CredentialRequest | PlatformRequest) => ({
  protocolVersion: 1,
  batteryVersion: 1,
  battery: request.battery,
  requestId: request.requestId,
  status: "settled",
  outcome: "act",
});
function credentialReply(request: CredentialRequest, matches: boolean[]) {
  return {
    ...envelope(request),
    value: { matches },
    readings: Object.fromEntries(
      matches.map((match, index) => [
        `key_${index}`,
        {
          kind: "yes-no",
          probability: match ? 0.99 : 0.01,
          verdict: match ? "yes" : "no",
          outcome: "act",
        },
      ])
    ),
    evidence: matches.map((_, index) => evidence(index)),
  };
}
function platformReply(request: PlatformRequest) {
  return {
    ...envelope(request),
    value: { platform: "ios-share-menu" },
    readings: {
      platform: {
        kind: "choice",
        choice: "ios-share-menu",
        confidence: 0.99,
        probabilities: { "ios-share-menu": 0.99, other: 0.01 },
        outcome: "act",
      },
    },
    evidence: [evidence()],
  };
}
async function credentials(page: Page) {
  await page.route("**/config/credentials", (route) =>
    route.fulfill({
      json: {
        available: true,
        credentials: ["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CUSTOM_ALPHA", "CUSTOM_BETA"].map(
          (key) => ({
            key,
            configured: true,
            usable: true,
            source: "synthetic",
            value: "synthetic-secret-never-rendered",
          })
        ),
      },
    })
  );
}

test("real provider detail highlights exact OpenAI and judged custom names without an Azure substring match or raw values", async ({
  page,
}) => {
  await installMockDaemon(page);
  await credentials(page);
  const requests: CredentialRequest[] = [];
  await page.route("**/api/judgment/batteries/run", async (route) => {
    const request = route.request().postDataJSON() as BrowserJudgmentRequest;
    if (request.battery !== "webui.credentials.provider-key") return route.fallback();
    requests.push(request);
    await route.fulfill({ json: credentialReply(request, [false, true]) });
  });
  await openSettings(page, "models");
  await page.getByRole("button", { name: /^openai:/i }).click();
  const panel = page.locator(".credential-status");
  const row = (key: string) =>
    panel
      .getByRole("listitem")
      .filter({
        has: page.locator(".credential-status__key", { hasText: new RegExp(`^${key}$`) }),
      });
  await expect(row("CUSTOM_BETA").locator("[aria-current]")).toHaveCount(1);
  await expect(row("OPENAI_API_KEY").locator("[aria-current]")).toHaveCount(1);
  await expect(row("AZURE_OPENAI_API_KEY").locator("[aria-current]")).toHaveCount(0);
  await expect(row("CUSTOM_ALPHA").locator("[aria-current]")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.input).toEqual({
    providerId: "openai",
    keys: ["CUSTOM_ALPHA", "CUSTOM_BETA"],
  });
  expect(JSON.stringify(requests)).not.toContain("synthetic-secret-never-rendered");
  await expect(panel).not.toContainText("synthetic-secret-never-rendered");
});

test("leaving a pending provider detail discards its reply before another provider is selected", async ({
  page,
}) => {
  await installMockDaemon(page);
  await credentials(page);
  const requests: CredentialRequest[] = [];
  const release = Promise.withResolvers<undefined>();
  await page.route("**/api/judgment/batteries/run", async (route) => {
    const request = route.request().postDataJSON() as BrowserJudgmentRequest;
    if (request.battery !== "webui.credentials.provider-key") return route.fallback();
    const isOld = requests.length === 0;
    requests.push(request);
    if (isOld) await release.promise;
    await route.fulfill({
      json: credentialReply(
        request,
        request.input.keys.map(() => isOld)
      ),
    });
  });
  try {
    await openSettings(page, "models");
    await page.getByRole("button", { name: /^openai:/i }).click();
    await expect.poll(() => requests.length).toBe(1);
    await page.getByRole("button", { name: "All providers", exact: true }).click();
    await page.getByRole("button", { name: /^anthropic:/i }).click();
    await expect.poll(() => requests.length).toBe(2);
    release.resolve(undefined);
    await nextFrames(page);
    const panel = page.locator(".credential-status");
    await expect(panel.getByRole("listitem")).toHaveCount(4);
    await expect(panel.locator("[aria-current]")).toHaveCount(0);
    expect(requests.map((request) => request.input.providerId)).toEqual(["openai", "anthropic"]);
  } finally {
    release.resolve(undefined);
  }
});

for (const captured of ["prompt", "installed"] as const) {
  test(`late platform interpretation cannot override actual browser ${captured} state`, async ({
    page,
  }) => {
    await installMockDaemon(page);
    const requests: PlatformRequest[] = [];
    const release = Promise.withResolvers<undefined>();
    await page.route("**/api/judgment/batteries/run", async (route) => {
      const request = route.request().postDataJSON() as BrowserJudgmentRequest;
      if (request.battery !== "webui.pwa.install-platform") return route.fallback();
      requests.push(request);
      await release.promise;
      await route.fulfill({ json: platformReply(request) });
    });
    try {
      await openSettings(page, "notifications");
      await expect.poll(() => requests.length).toBe(1);
      if (captured === "prompt")
        await page.evaluate(() => {
          let executions = 0;
          const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
            prompt: async () => {
              document.documentElement.dataset.syntheticPromptExecutions = String(++executions);
            },
            userChoice: Promise.resolve({ outcome: "accepted" }),
          });
          window.dispatchEvent(event);
        });
      else await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
      release.resolve(undefined);
      await nextFrames(page);
      const install = page.locator(".notifications-install");
      await expect(install).not.toContainText("To install on iOS");
      if (captured === "prompt") {
        await expect(
          install.getByRole("button", { name: "Add to Home Screen", exact: true })
        ).toBeVisible();
        await install.getByRole("button", { name: "Add to Home Screen", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-synthetic-prompt-executions", "1");
      } else {
        await expect(install).toContainText(
          "This app is installed and running from your Home Screen."
        );
        await expect(
          install.getByRole("button", { name: "Add to Home Screen", exact: true })
        ).toHaveCount(0);
      }
    } finally {
      release.resolve(undefined);
    }
  });
}

test("mock review transport returns all candidates by explicit probability", async ({ page }) => {
  await installMockDaemon(page, {
    memoryReviewProbabilities: { "mem-fact-1": 0.1, "mem-review-1": 0, "mem-persona-1": 1 },
  });
  await page.goto("/?view=memory");
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/memory/review-queue?limit=3");
    return (await response.json()) as { records: { id: string }[] };
  });
  expect(result.records.map((record) => record.id)).toEqual([
    "mem-persona-1",
    "mem-fact-1",
    "mem-review-1",
  ]);
});

test("mock review transport fails closed if even an out-of-limit candidate lacks a probability", async ({
  page,
}) => {
  await installMockDaemon(page, { memoryReviewProbabilities: { "mem-review-1": 1 } });
  await page.goto("/?view=memory");
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/memory/review-queue?limit=1");
    return { status: response.status, body: (await response.json()) as unknown };
  });
  expect(result.status).toBe(503);
  expect(result.body).not.toHaveProperty("records");
});
