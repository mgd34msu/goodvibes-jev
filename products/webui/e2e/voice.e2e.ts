/**
 * Voice journey, TTS playback and mic dictation, proven end to end against a hermetic
 * mock (no real voice provider, no real audio, no 3421/4444). Mic uses Playwright's fake
 * media device; playback uses an injected fake AudioContext. Every assertion is on the
 * STATE, never on real sound.
 *
 * Honest-state matrix covered here:
 *   - read-aloud available -> play, then stop (instant deliberate interrupt).
 *   - no voice provider configured -> disabled read-aloud with a bring-your-own-key refusal.
 *   - dictation available -> transcript lands in the composer for REVIEW BEFORE SENDING.
 *   - no STT provider configured -> disabled mic with an honest pointer.
 *   - microphone blocked -> honest "try again" pointer, not a dead button.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { installFakeAudio, installVoiceRoutes, trackAudioContexts, waitForAudioFlow } from './support/voice-mock';
import { expectNoHorizontalScroll, only, PHONE, expectBottomSheet } from './support/app';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function seedAssistantReply(page: import('@playwright/test').Page): Promise<void> {
  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toBeVisible();
  await composer.fill('Say hello');
  await page.locator('.send-button').click();
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });
}

test('reads a reply aloud with the shared voice, then stops on demand', async ({ page }) => {
  await installFakeAudio(page);
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page);

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await seedAssistantReply(page);

  const speak = page.locator('.message.assistant button[aria-label="Read this reply aloud"]').first();
  await expect(speak).toBeVisible();
  await speak.click();

  // Playing: the control becomes an instant-interrupt Stop.
  const stop = page.locator('.message.assistant button[aria-label="Stop reading aloud"]').first();
  await expect(stop).toBeVisible();

  // The synthesis request went out under the SHARED voice (provider + voice from config.get).
  await expect.poll(() => voice.ttsRequests.length).toBeGreaterThan(0);
  expect(voice.ttsRequests[0].body).toMatchObject({ providerId: 'elevenlabs', voiceId: 'rachel' });

  // Deliberate interrupt returns to the read-aloud affordance.
  await stop.click();
  await expect(page.locator('.message.assistant button[aria-label="Read this reply aloud"]').first()).toBeVisible();

  await expectNoHorizontalScroll(page);
});

test('offers an honest refusal when no voice provider is configured', async ({ page }) => {
  await installFakeAudio(page);
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, {
    providers: [{ id: 'elevenlabs', label: 'ElevenLabs', configured: false, capabilities: ['tts', 'stt'] }],
  });

  await page.goto('/?view=chat');
  await seedAssistantReply(page);

  const speak = page.locator('.message.assistant button[aria-label*="Read aloud unavailable"]').first();
  await expect(speak).toBeVisible();
  await expect(speak).toBeDisabled();
});

test('dictation transcribes into the composer for review before sending', async ({ page }) => {
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, { transcript: 'dictated hello world' });
  await trackAudioContexts(page);

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const mic = page.locator('button[aria-label="Dictate a message"]');
  await expect(mic).toBeVisible();
  await mic.click();

  const stopMic = page.locator('button[aria-label="Stop and transcribe"]');
  await expect(stopMic).toBeVisible();
  await waitForAudioFlow(page); // the fake device has produced real samples
  await stopMic.click();

  // The transcript fills the draft, it is NOT auto-sent (review before send).
  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toHaveValue(/dictated hello world/, { timeout: 15_000 });
  await expect(page.locator('.message.user')).toHaveCount(0);
  await expect.poll(() => voice.sttRequests.length).toBeGreaterThan(0);

  await expectNoHorizontalScroll(page);
});

test('with no speech-to-text provider, tapping the mic toggles its explanation instead of recording', async ({ page }) => {
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, {
    // A TTS-only provider, dictation genuinely unavailable.
    providers: [{ id: 'vydra', label: 'Vydra', configured: true, capabilities: ['tts', 'voice-list'] }],
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const mic = page.locator('button[aria-label*="no speech-to-text provider"]');
  await expect(mic).toBeVisible();
  // A permanent unavailability keeps the composer clear: no bubble until the
  // crossed mic is tapped, then the reason shows, and a second tap hides it again.
  await expect(page.locator('.voice-mic-note')).toHaveCount(0);
  await mic.click();
  await expect(page.locator('.voice-mic-note')).toBeVisible();
  await expect(page.locator('button[aria-label="Stop and transcribe"]')).toHaveCount(0);
  await mic.click();
  await expect(page.locator('.voice-mic-note')).toHaveCount(0);
});

test('a blocked microphone surfaces a note and never starts a transcription', async ({ page }) => {
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
      },
    });
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const mic = page.locator('button[aria-label="Dictate a message"]');
  await expect(mic).toBeVisible();
  await mic.click();

  await expect(page.locator('.voice-mic-note')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('button[aria-label="Stop and transcribe"]')).toHaveCount(0);
  expect(voice.sttRequests).toHaveLength(0);
});

test('the provider selection offers every reported provider, and picking local writes tts.provider', async ({ page }) => {
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, {
    providers: [
      { id: 'elevenlabs', label: 'ElevenLabs', configured: true, capabilities: ['tts', 'tts-stream', 'stt', 'voice-list'] },
      { id: 'local', label: 'Local engines (free, offline)', configured: true, capabilities: ['tts', 'tts-stream', 'stt'] },
    ],
  });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  await page.locator('.voice-settings-btn').click();
  const providerSelect = page.locator('.voice-settings-popover').getByRole('combobox', { name: 'Provider' });
  await expect(providerSelect).toBeVisible();
  await providerSelect.click();
  const list = page.getByRole('listbox', { name: 'Provider' });
  await expect(list.getByRole('option')).toHaveCount(2);

  // Selecting local writes tts.provider through the same shared-config path.
  await list.getByRole('option', { name: 'Local engines (free, offline)' }).click();
  await expect.poll(() => voice.configWrites).toContainEqual({ key: 'tts.provider', value: 'local' });
  // Picking from the list leaves the voice dialog open.
  await expect(page.locator('.voice-settings-popover')).toBeVisible();
});

test.describe('Voice settings: phone: a bottom sheet, not a floating popover (MOBILE-ADAPT)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('opens as a full-width bottom sheet with an explicit close affordance', async ({ page }) => {
    await installChatMockDaemon(page);
    await installVoiceRoutes(page);
    await page.goto('/?view=chat');
    await expect(page.locator('.app-shell')).toBeVisible();

    const trigger = page.locator('.voice-settings-btn');
    await expect(trigger).toBeVisible();
    await trigger.click();

    // A kit dialog: on a phone, a full-width bottom sheet with a grabber.
    const sheet = page.locator('.voice-settings-popover');
    await expect(sheet).toBeVisible();
    await expectBottomSheet(page, sheet);
    await expectNoHorizontalScroll(page);

    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
  });
});
