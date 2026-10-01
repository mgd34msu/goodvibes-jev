/**
 * Wake word in the browser tab, proven against a hermetic mock.
 *
 * What only a real browser can prove, and therefore what this file is for:
 *
 *  - DISABLED MEANS NO PERMISSION PROMPT. `navigator.mediaDevices.getUserMedia` is
 *    wrapped by an init script and counted. With `voice.wake.surfaces.webui` false,
 *    the shipped default, the count stays 0 for the whole page lifetime.
 *  - THE BUNDLE ACTUALLY RUNS. onnxruntime-web is dynamically imported, its wasm
 *    binary resolves from the emitted asset URL, and two inference sessions are
 *    created over bytes the mock daemon served in chunks and the tab verified against
 *    the stated sha256. If any of that were wrong the indicator would never reach
 *    'listening', which is exactly what the listening assertion catches.
 *  - THE AudioWorklet PATH WORKS. The unit suite drives the ScriptProcessor fallback
 *    because no real worklet exists under happy-dom; here there is one.
 *
 * Detection ITSELF is not asserted here: the fixture models are loadable Identity
 * graphs, so their scores are meaningless by construction (see support/onnx-fixture.ts
 * for why that is the right split). Scripted-score detection through to `voice.stt` is
 * unit-tested in src/lib/voice/wake-host.test.ts against the real engine.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { installFakeAudio, installVoiceRoutes, trackAudioContexts, waitForAudioFlow } from './support/voice-mock';
import { expectNoHorizontalScroll, nextFrames } from './support/app';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

/**
 * Count every getUserMedia call the page makes, before any app code runs. This is the
 * only honest way to assert "the tab never asked for the microphone", an in-app flag
 * would be asserting the app's own bookkeeping.
 */
async function countGetUserMedia(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { __gumCalls?: number };
    win.__gumCalls = 0;
    const devices = navigator.mediaDevices as unknown as {
      getUserMedia?: (constraints: unknown) => Promise<unknown>;
    } | undefined;
    const original = devices?.getUserMedia?.bind(devices);
    if (!devices || !original) return;
    devices.getUserMedia = (constraints: unknown) => {
      win.__gumCalls = (win.__gumCalls ?? 0) + 1;
      return original(constraints);
    };
  });
}

function gumCalls(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __gumCalls?: number }).__gumCalls ?? 0);
}

const WAKE_ON = {
  enabled: true,
  surfaces: { webui: true },
  indicator: 'statusline',
};

test('wake detection off (the shipped default): no microphone is ever requested', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page);

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  // The tab has read the wake rows it decides from, and committed that decision.
  await expect.poll(() => voice.configReads).toBeGreaterThan(0);
  await nextFrames(page);

  expect(await gumCalls(page)).toBe(0);
  await expect(page.locator('[data-testid="wake-chip"]')).toHaveCount(0);
  // And nothing was downloaded either: provisioning is an explicit act.
  expect(voice.wakeProvisionRequests).toBe(0);
  expect(voice.wakeModelReads).toHaveLength(0);
});

test('voice.wake.enabled on but this surface off: still no microphone, still no download', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, {
    wake: { provisioned: true },
    wakeConfig: { enabled: true, surfaces: { webui: false }, indicator: 'statusline' },
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => voice.configReads).toBeGreaterThan(0);
  await nextFrames(page);

  expect(await gumCalls(page)).toBe(0);
  await expect(page.locator('[data-testid="wake-chip"]')).toHaveCount(0);
  expect(voice.wakeModelReads).toHaveLength(0);
});

test('enabled for this origin: the models load, a session is created, and the tab listens', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, {
    wake: { provisioned: true },
    wakeConfig: WAKE_ON,
  });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  // The persistent chip is the proof: it only reaches 'listening' after the model
  // bytes were read, verified, turned into onnxruntime sessions, and a real
  // getUserMedia stream opened behind an AudioWorklet.
  const chip = page.locator('[data-testid="wake-chip"]');
  await expect(chip).toBeVisible({ timeout: 45_000 });
  await expect(chip).toHaveAttribute('data-wake-phase', 'listening', { timeout: 45_000 });

  expect(await gumCalls(page)).toBe(1);
  // Both ONNX components were read through the chunked verb.
  const components = new Set(voice.wakeModelReads.map((read) => read.component));
  expect([...components].sort()).toEqual(['classifier', 'embedding']);
  // Still no provisioning: they were already installed, so nothing was downloaded.
  expect(voice.wakeProvisionRequests).toBe(0);

  expect(consoleErrors.join('\n')).not.toContain('onnxruntime');
  await expectNoHorizontalScroll(page);
});

test('a multi-chunk model read reassembles and the tab still reaches listening', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, {
    // Tiny chunks, so the loop runs many times over the same fixtures the
    // single-chunk case verified.
    wake: { provisioned: true, chunkBytes: 64 },
    wakeConfig: WAKE_ON,
  });

  await page.goto('/?view=chat');
  await expect(page.locator('[data-testid="wake-chip"]'))
    .toHaveAttribute('data-wake-phase', 'listening', { timeout: 45_000 });

  const classifierReads = voice.wakeModelReads.filter((read) => read.component === 'classifier');
  expect(classifierReads.length).toBeGreaterThan(1);
  // Offsets advance monotonically by the chunk size, the loop, not a retry storm.
  expect(classifierReads.map((read) => read.offset)).toEqual(
    classifierReads.map((_read, index) => index * 64),
  );
});

test('a sha256 that does not match refuses and opens no microphone', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, {
    wake: { provisioned: true, corruptSha: true },
    wakeConfig: WAKE_ON,
  });

  await page.goto('/?view=chat');
  const chip = page.locator('[data-testid="wake-chip"]');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAttribute('data-wake-phase', 'refused', { timeout: 30_000 });

  // The honest part: a model that failed its pin never becomes a live microphone.
  expect(await gumCalls(page)).toBe(0);
});

test('the banner indicator is a persistent element, and the chip is absent for it', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, {
    wake: { provisioned: true },
    wakeConfig: { ...WAKE_ON, indicator: 'banner' },
  });
  // The page clock runs naturally until the jump below.
  await page.clock.install();

  await page.goto('/?view=chat');
  const banner = page.locator('[data-testid="wake-banner"]');
  await expect(banner).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('[data-testid="wake-chip"]')).toHaveCount(0);

  // Persistent: jump the page clock a minute ahead, which fires every pending timer
  // (any toast lifetime included) once, then let time run again.
  await page.clock.fastForward('01:00');
  await page.clock.resume();
  await expect(banner).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('voice.wake.indicator "off" shows nothing, even with the microphone open', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, {
    wake: { provisioned: true },
    wakeConfig: { ...WAKE_ON, indicator: 'off' },
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  // Wait until the microphone really did open, so this is "hidden while live" and
  // not "nothing started".
  await expect.poll(() => gumCalls(page), { timeout: 45_000 }).toBe(1);
  await expect(page.locator('[data-testid="wake-chip"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="wake-banner"]')).toHaveCount(0);
});

test('the voice popover offers the model download, and one tap provisions it once', async ({ page }) => {
  await installFakeAudio(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, { wake: { provisioned: false } });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.locator('.voice-settings-btn').click();

  const section = page.locator('[data-testid="voice-settings-wake"]');
  await expect(section).toBeVisible();

  const download = section.locator('button', { hasText: 'Download the wake-word models' });
  await expect(download).toBeVisible();
  // Never automatic: nothing is provisioned until the tap.
  expect(voice.wakeProvisionRequests).toBe(0);

  await download.click();
  await expect.poll(() => voice.wakeProvisionRequests).toBe(1);
  await expect(download).toHaveCount(0);
});

test('the per-origin opt-in writes voice.wake.surfaces.webui and really starts listening', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, {
    wake: { provisioned: true },
    // Enabled globally, off for this origin: exactly the state a user lands in.
    wakeConfig: { enabled: true, surfaces: { webui: false }, indicator: 'statusline' },
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.locator('.voice-settings-btn').click();

  const section = page.locator('[data-testid="voice-settings-wake"]');
  const optIn = section.locator('label', { hasText: 'Listen for the wake word in this browser' })
    .locator('input[type="checkbox"]');
  await expect(optIn).not.toBeChecked();
  expect(await gumCalls(page)).toBe(0);

  // click(), not check(): the box is a CONTROLLED input whose ticked state comes from
  // the daemon's own config, so it stays unticked until the write round-trips. That is
  // the behaviour under test, and check()'s immediate state assertion contradicts it.
  await optIn.click();

  await expect.poll(() => voice.configWrites).toContainEqual({
    key: 'voice.wake.surfaces.webui',
    value: true,
  });
  // Flipping the row on must actually WORK, not just persist: the box stays ticked
  // after the refetch, and the detector starts from that write alone.
  await expect(optIn).toBeChecked();
  await expect(page.locator('[data-testid="wake-chip"]'))
    .toHaveAttribute('data-wake-phase', 'listening', { timeout: 45_000 });
  expect(await gumCalls(page)).toBe(1);
});

test('a row this tab cannot honour yet is listed as a blocker, and nothing listens', async ({ page }) => {
  await countGetUserMedia(page);
  await installFakeAudio(page);
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, {
    // The wake models are provisioned; the SPEECH GATE's own artifact is not. A
    // voice-activity floor would then send frames to the classifier unscreened
    // while the row says they are being screened, so the resolver BLOCKS.
    wake: { provisioned: true, vadProvisioned: false },
    wakeConfig: { ...WAKE_ON, vadThreshold: 0.5 },
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.locator('.voice-settings-btn').click();

  await expect(page.locator('[data-testid="wake-blockers"]')).toBeVisible();

  expect(await gumCalls(page)).toBe(0);
});

test('speex is honoured rather than blocked: the tab listens with the filter on', async ({ page }) => {
  await countGetUserMedia(page);
  // Deliberately NOT installFakeAudio: that shim replaces AudioContext with a
  // playback-only fake for the TTS tests, and capture needs a real audio graph
  // (Chromium's, over the fake media device from the launch args) to reach
  // listening at all, the same setup the other listening tests use.
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, {
    wake: { provisioned: true },
    // The filter is a WebAssembly module the SDK carries, so a browser runs it.
    wakeConfig: { ...WAKE_ON, noiseSuppression: 'speex' },
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('[data-wake-phase]').first())
    .toHaveAttribute('data-wake-phase', 'listening', { timeout: 45_000 });
  expect(await gumCalls(page)).toBe(1);

  await page.locator('.voice-settings-btn').click();
  // Nothing is refused, so no blocker list is rendered at all.
  await expect(page.locator('[data-testid="wake-blockers"]')).toHaveCount(0);
});

test('a daemon without the wake verbs shows no wake section at all', async ({ page }) => {
  await installFakeAudio(page);
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, { wake: 'unavailable' });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.locator('.voice-settings-btn').click();

  // The local-voice card is there, so the popover rendered; the wake block is not.
  await expect(page.locator('[data-testid="voice-settings-local"]')).toBeVisible();
  await expect(page.locator('[data-testid="voice-settings-wake"]')).toHaveCount(0);
});

test('dictation still works while wake detection holds the microphone', async ({ page }) => {
  await countGetUserMedia(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, {
    wake: { provisioned: true },
    wakeConfig: WAKE_ON,
    transcript: 'dictated over the wake listener',
  });
  await trackAudioContexts(page);

  await page.goto('/?view=chat');
  const chip = page.locator('[data-testid="wake-chip"]');
  await expect(chip).toHaveAttribute('data-wake-phase', 'listening', { timeout: 45_000 });
  expect(await gumCalls(page)).toBe(1);

  // A press must NOT be a second concurrent stream: the arbiter stands the listener
  // down first, so the count rises by one and the chip reports the pause.
  const mic = page.locator('button[aria-label="Dictate a message"]');
  await mic.click();
  const stopMic = page.locator('button[aria-label="Stop and transcribe"]');
  await expect(stopMic).toBeVisible({ timeout: 15_000 });
  expect(await gumCalls(page)).toBe(2);

  await waitForAudioFlow(page);
  await stopMic.click();

  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toHaveValue(/dictated over the wake listener/, { timeout: 20_000 });
  await expect.poll(() => voice.sttRequests.length).toBeGreaterThan(0);
  // The dictated clip is 16 kHz mono WAV now, not a webm/opus container.
  expect(voice.sttRequests[0].body).toMatchObject({ audio: { mimeType: 'audio/wav', format: 'wav' } });

  // And the listener came back on its own once the press finished.
  await expect(chip).toHaveAttribute('data-wake-phase', 'listening', { timeout: 30_000 });
});
