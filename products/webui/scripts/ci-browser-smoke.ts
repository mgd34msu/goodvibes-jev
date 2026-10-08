/** CI prerequisite admission only; the complete browser suite remains required. */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// A normal exit runs Playwright's synchronous exit cleanup for its detached
// Chromium process group. The workflow's outer deadline is only a last resort.
const deadline = setTimeout(() => {
  console.error('Chromium prerequisite smoke exceeded its 20-second deadline');
  process.exit(124);
}, 20_000);
try {
  // Do not accept a system-browser override: use this lockfile's Playwright revision,
  // just as the required CI projects do. Launch validates the browser's host libraries.
  const browser = await chromium.launch({ headless: true, timeout: 15_000 });
  try {
    const font = await readFile(new URL('../node_modules/@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff2', import.meta.url));
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5_000);
    await page.setContent(`<style>
      @font-face { font-family: PrerequisiteGeist; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); }
      body { font: 16px PrerequisiteGeist; }
      </style><main>GoodVibes browser prerequisite</main>`);
    const loadedFonts = await page.evaluate(async () => {
      const fonts = await document.fonts.load('16px PrerequisiteGeist');
      return fonts.map((face) => face.status);
    });
    assert.deepEqual(loadedFonts, ['loaded'], 'The bundled WebUI font must load');
    assert.equal(await page.locator('main').innerText(), 'GoodVibes browser prerequisite');
    const screenshot = await page.screenshot();
    assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Chromium must render a PNG');
    console.log(`Chromium ${browser.version()}: host libraries, page execution, bundled font, and screenshot verified. Full browser tests remain required.`);
  } finally {
    await browser.close();
  }
} finally {
  clearTimeout(deadline);
}
