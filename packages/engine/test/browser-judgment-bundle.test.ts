import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { bundleBrowserEntrypoint } from './_helpers/browser-bundle.ts';
import { BROWSER_SPEECH_SEAM_BAND } from '@goodvibes-jev/engine/daemon-sdk/browser-judgment-contract';

describe('browser judgment public boundary', () => {
  test('publishes the shared speech band through the browser-safe contract subpath', () => {
    expect(BROWSER_SPEECH_SEAM_BAND.yes).toEqual({ actAt: 0.6, confirmAt: 0.55 });
    expect(Object.isFrozen(BROWSER_SPEECH_SEAM_BAND)).toBe(true);
  });

  test('bundles the public browser judgment contract without Node builtins', async () => {
    const output = await bundleBrowserEntrypoint(fileURLToPath(import.meta.resolve('@goodvibes-jev/engine/daemon-sdk/browser-judgment-contract')));
    expect(output.length).toBeGreaterThan(0);
  });
});
